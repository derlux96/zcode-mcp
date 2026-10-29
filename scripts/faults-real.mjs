#!/usr/bin/env node
// Stage 6: real fault injection. Independent, self-cleaning scenarios against
// the REAL ZCode through the real MCP server over stdio; each reports
// ok / failed / skipped with a reason. Spends real ZCode quota: only with --real.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isMain } from '../src/is-main.mjs';
import { safeSignal, waitFor, sleep } from '../test/helpers.mjs';
import {
  startCli, tempDir, initRepo, realServer, stopServer, runJob, followJob, readJobStatus,
  parseResultText, changedPaths, assertNothingLeft, writeReport, isAbortKind, TERMINAL,
} from './real-lib.mjs';
import { SMOKE_TASKS, checkOracle } from './smoke-real.mjs';

const CREATE = SMOKE_TASKS.find((t) => t.id === 'create-file');
const CAP_MS = 5 * 60 * 1000;

const ok = (reason = '') => ({ status: 'ok', reason });
const failed = (reason) => ({ status: 'failed', reason });
const skipped = (reason) => ({ status: 'skipped', reason });

// --- pure judges -------------------------------------------------------------

// Kept: our own variables (real binary, temp MCP home/state) and the app bundle's
// read-only builtin provider config.
const KEEP_ENV = ['ZCODE_BIN', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_MCP_HOME', 'ZCODE_MCP_STATE'];
const CLEAR_ENV = ['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];

/**
 * Env overrides for invalid-api-key: HOME = an empty temp dir; every other ZCODE_*
 * variable and the XDG dirs are removed (undefined: Node's spawn drops them).
 * leaks = variables that would still point into the real ~/.zcode afterwards.
 */
export function authIsolationEnv(env, realHome, fakeHome) {
  const overrides = { HOME: fakeHome };
  for (const k of CLEAR_ENV) overrides[k] = undefined;
  for (const k of Object.keys(env)) if (k.startsWith('ZCODE_') && !KEEP_ENV.includes(k)) overrides[k] = undefined;
  const real = join(realHome, '.zcode');
  const merged = { ...env, ...overrides };
  const leaks = Object.entries(merged)
    .filter(([, v]) => typeof v === 'string' && v.split(':').some((part) => part === real || part.startsWith(`${real}/`)))
    .map(([k]) => k);
  return { overrides, leaks };
}

/** Lines of `ps -axo command` -> is the ZCode desktop app (not our CLI child) running? */
export function isZCodeAppRunning(lines) {
  return lines.some((l) => {
    const c = l.trim();
    return c === 'ZCode' || /ZCode\.app\/Contents\/MacOS\/ZCode$/.test(c) || /ZCode\.app\/Contents\/Frameworks\/ZCode Helper/.test(c);
  });
}

/** A job whose ZCode process was killed must end terminal, not completed, with an error_kind. */
export function judgeKill({ state, errorKind }) {
  if (!TERMINAL.includes(state)) return failed(`job did not reach a terminal state (state ${state})`);
  if (state === 'completed') return failed('job reported completed although its ZCode process was killed');
  if (!errorKind) return failed(`job ended ${state} without error_kind`);
  return ok(`ended ${state} (${errorKind})`);
}

/** input: { rejected } when zcode_run refused, else { state, errorKind, error }. */
export function judgeAuth({ rejected, state, errorKind, error, hint }) {
  if (rejected) return skipped(`ZCode could not be started with an empty HOME: ${rejected}`);
  if (state === 'completed') return skipped('ZCode authenticated despite an empty HOME (credentials live outside HOME); an invalid key cannot be simulated without touching real credentials');
  if (errorKind === 'auth') return ok(`ended ${state} with error_kind auth`);
  // ZCode's CLI prints "Model creation failed" for a missing login/provider (kind model).
  if (errorKind === 'model' && (hint || /model creation failed|login/i.test(error || ''))) return ok(`ended ${state} with error_kind model (${hint ? 'login/provider hint' : String(error).trim().slice(0, 80)}): no usable login/provider`);
  return failed(`expected error_kind auth (or model with a Model creation failed/login error), got ${errorKind || 'none'} (state ${state}): ${error || ''}`.trim());
}

export function judgeNonGit(p, fileOk) {
  if (p.state !== 'completed') return failed(`job ended ${p.state} (${p.errorKind || 'no error_kind'})`);
  if (!p.changesUnavailable) return failed('response does not say "changes: unavailable"');
  if ((p.warnings || []).includes('no_changes')) return failed('no_changes warning in a non-git directory');
  if (!fileOk) return failed('the requested file was not created');
  return ok();
}

export function judgeDirty(p, { dirty, created }) {
  if (p.state !== 'completed') return failed(`job ended ${p.state} (${p.errorKind || 'no error_kind'})`);
  const paths = changedPaths(p.changedFiles);
  if (paths.includes(dirty)) return failed(`pre-existing ${dirty} is reported as changed by the job`);
  if (!paths.includes(created)) return failed(`changed_files lacks ${created}: ${paths.join(', ') || 'none'}`);
  return ok();
}

/** results: [{ state, worktreeBranch, effectOk }], branchCount: zcode/* branches in the repo. */
export function judgeParallel(results, branchCount) {
  const bad = results.filter((r) => r.state !== 'completed');
  if (bad.length) return failed(`job(s) ended ${bad.map((r) => r.state).join(', ')}`);
  if (results.some((r) => !r.effectOk)) return failed('a worktree lacks its file');
  const branches = new Set(results.map((r) => r.worktreeBranch));
  if (branches.size !== results.length) return failed(`branches not distinct: ${[...branches].join(', ')}`);
  if (branchCount !== results.length) return failed(`expected ${results.length} zcode/ branches, found ${branchCount}`);
  return ok();
}

export function judgeUnwritable({ isError, text }, jobDirs) {
  if (!isError) return failed(`zcode_run did not fail: ${String(text).slice(0, 200)}`);
  if (!/not writable/.test(text)) return failed(`unexpected error: ${String(text).slice(0, 200)}`);
  if (jobDirs !== 0) return failed(`${jobDirs} job dir(s) were created`);
  return ok();
}

// --- scenario plumbing -------------------------------------------------------

class AbortSuite extends Error {}

/** One scenario's temp home, dirs, servers and jobs; cleanup stops only what it started. */
class Scope {
  constructor(root, name) {
    this.root = root;
    this.home = join(root, 'scenarios', name);
    mkdirSync(this.home, { recursive: true });
    this.dirs = [];
    this.clients = [];
    this.jobIds = [];
  }

  dir(prefix) {
    const d = tempDir(prefix);
    this.dirs.push(d);
    return d;
  }

  async server(env = {}) {
    const c = await realServer(this.home, env);
    this.clients.push(c);
    return c;
  }

  track(id) { if (id) this.jobIds.push(id); return id; }

  /** Throws AbortSuite on auth/quota (callers that expect auth catch nothing here). */
  guard(p) {
    if (isAbortKind(p.errorKind)) throw new AbortSuite(`error_kind ${p.errorKind}: ${p.error || ''}`);
    return p;
  }

  async cleanup() {
    const live = this.clients.find((c) => !c.hasExited);
    for (const id of this.jobIds) {
      const s = readJobStatus(this.home, id);
      if (live && s && !TERMINAL.includes(s.state)) await live.callTool('zcode_cancel', { job_id: id }, { timeoutMs: 60000 }).catch(() => {});
    }
    for (const c of this.clients) await stopServer(c);
    try {
      await assertNothingLeft([basename(this.root), ...this.dirs.map((d) => basename(d))], this.home, this.jobIds);
      return null;
    } catch (error) {
      return error.message;
    } finally {
      for (const d of this.dirs) rmSync(d, { recursive: true, force: true });
    }
  }
}

async function createJob(scope, client, cwd, extra = {}) {
  const r = await runJob(client, { prompt: CREATE.prompt, cwd, ...extra }, { waitMs: 20000, capMs: CAP_MS });
  scope.track(r.jobId);
  return r;
}

export const SCENARIOS = [
  {
    name: 'kill-zcode-mid-run',
    async run(scope) {
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      const c = await scope.server();
      const started = await c.callTool('zcode_run', {
        prompt: 'Run the shell command `sleep 45` and wait for it, then create after-sleep.txt containing done.', cwd: repo, wait_ms: 0,
      });
      const jobId = scope.track(parseResultText(started.text).jobId);
      if (!jobId) return failed(`zcode_run did not start a job: ${started.text.slice(0, 200)}`);
      const s = await waitFor(() => {
        const x = readJobStatus(scope.home, jobId);
        return x && (TERMINAL.includes(x.state) || (x.state === 'running' && Number.isInteger(x.childPid))) ? x : null;
      }, { timeoutMs: 120000, intervalMs: 500, what: 'the job to record its ZCode child' });
      if (TERMINAL.includes(s.state)) return failed(`job ended ${s.state} before it could be killed`);
      await sleep(8000);
      const killed = s.childPgid === s.childPid
        && safeSignal(s.childPid, 'SIGKILL', { expectStart: s.childStart, group: true });
      if (!killed) return failed(`could not signal the recorded ZCode child ${s.childPid} (gone or identity changed)`);
      const r = await followJob(c, jobId, { capMs: CAP_MS });
      return { ...judgeKill(scope.guard(r.parsed)), details: { killedPgid: s.childPid, final: r.text.slice(0, 600) } };
    },
  },
  {
    name: 'invalid-api-key',
    async run(scope) {
      // An empty temp HOME: ZCode finds no login. The real ~/.zcode is never touched.
      const fakeHome = scope.dir('zcode-faults-emptyhome-');
      const { overrides, leaks } = authIsolationEnv(process.env, process.env.HOME || homedir(), fakeHome);
      const applied = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v === undefined ? '(removed)' : v]));
      if (leaks.length) return { ...skipped(`environment still points into the real ~/.zcode after isolation: ${leaks.join(', ')}`), details: { overrides: applied } };
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      const c = await scope.server(overrides);
      const r = await createJob(scope, c, repo);
      if (r.rejected) return { ...judgeAuth({ rejected: r.text.slice(0, 300) }), details: { overrides: applied, text: r.text.slice(0, 600) } };
      return { ...judgeAuth(r.parsed), details: { overrides: applied, final: r.text.slice(0, 600) } };
    },
  },
  {
    name: 'parallel-worktree-jobs',
    async run(scope) {
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      const c = await scope.server();
      const ids = [];
      for (const n of ['a', 'b']) {
        const r = await c.callTool('zcode_run', {
          prompt: `Create a file named wt-${n}.txt containing exactly: ${n}. Do not change any other file.`,
          cwd: repo, isolate_worktree: true, wait_ms: 0,
        });
        const id = scope.track(parseResultText(r.text).jobId);
        if (!id) return failed(`job ${n} did not start: ${r.text.slice(0, 300)}`);
        ids.push([n, id]);
      }
      const finals = await Promise.all(ids.map(([, id]) => followJob(c, id, { capMs: CAP_MS })));
      const results = finals.map((f, i) => {
        const p = scope.guard(f.parsed);
        const n = ids[i][0];
        const file = p.worktreeDir && join(p.worktreeDir, `wt-${n}.txt`);
        return { state: p.state, worktreeBranch: p.worktreeBranch, effectOk: !!file && existsSync(file) };
      });
      const branches = execFileSync('git', ['branch', '--list', 'zcode/*'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((l) => l.trim()).length;
      return { ...judgeParallel(results, branches), details: { results, branches } };
    },
  },
  {
    name: 'zcode-app-open',
    async run(scope) {
      const lines = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n');
      if (!isZCodeAppRunning(lines)) return skipped('the ZCode desktop app is not running');
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      const c = await scope.server();
      const r = await createJob(scope, c, repo);
      if (r.rejected) return failed(`zcode_run rejected: ${r.text.slice(0, 300)}`);
      const p = scope.guard(r.parsed);
      const o = checkOracle(CREATE, repo);
      if (p.state !== 'completed') return failed(`job ended ${p.state} (${p.errorKind})`);
      return o.ok ? ok('job completed while the desktop app was running') : failed(o.reason);
    },
  },
  {
    name: 'path-with-spaces-and-symlink',
    async run(scope) {
      const base = scope.dir('zcode-faults-space-');
      const real = initRepo(join(base, 'dir with spaces', 'repo x'));
      const link = join(base, 'link to repo');
      symlinkSync(real, link);
      const c = await scope.server();
      const r = await createJob(scope, c, link);
      if (r.rejected) return failed(`zcode_run rejected: ${r.text.slice(0, 300)}`);
      const p = scope.guard(r.parsed);
      if (p.state !== 'completed') return failed(`job ended ${p.state} (${p.errorKind})`);
      const o = checkOracle(CREATE, real);
      if (!o.ok) return failed(o.reason);
      if (!changedPaths(p.changedFiles).includes('created.txt')) return failed(`changed_files lacks created.txt: ${(p.changedFiles || []).join(', ')}`);
      return ok();
    },
  },
  {
    name: 'non-git-dir',
    async run(scope) {
      const dir = scope.dir('zcode-faults-plain-');
      const c = await scope.server();
      const r = await createJob(scope, c, dir);
      if (r.rejected) return failed(`zcode_run rejected: ${r.text.slice(0, 300)}`);
      const fileOk = checkOracle({ ...CREATE, treeUnchanged: false }, dir).ok;
      return judgeNonGit(scope.guard(r.parsed), fileOk);
    },
  },
  {
    name: 'dirty-tree-baseline',
    async run(scope) {
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      writeFileSync(join(repo, 'dirty.txt'), 'uncommitted work\n');
      const c = await scope.server();
      const r = await createJob(scope, c, repo);
      if (r.rejected) return failed(`zcode_run rejected: ${r.text.slice(0, 300)}`);
      const p = scope.guard(r.parsed);
      return { ...judgeDirty(p, { dirty: 'dirty.txt', created: 'created.txt' }), details: { changedFiles: p.changedFiles } };
    },
  },
  {
    name: 'unwritable-job-dir',
    async run(scope) {
      const repo = initRepo(scope.dir('zcode-faults-repo-'));
      chmodSync(scope.home, 0o500);
      try {
        const c = await scope.server();
        const r = await c.callTool('zcode_run', { prompt: CREATE.prompt, cwd: repo, wait_ms: 0 });
        scope.track(parseResultText(r.text).jobId);
        const jobsDir = join(scope.home, 'jobs');
        const jobDirs = existsSync(jobsDir) ? readdirSync(jobsDir).filter((n) => n.startsWith('job_')).length : 0;
        return { ...judgeUnwritable(r, jobDirs), details: { text: r.text.slice(0, 300) } };
      } finally {
        chmodSync(scope.home, 0o700);
      }
    },
  },
];

export function selectScenarios(only) {
  if (only === undefined) return SCENARIOS.slice();
  const s = SCENARIOS.find((x) => x.name === only);
  if (!s) throw new Error(`unknown scenario ${only} (known: ${SCENARIOS.map((x) => x.name).join(', ')})`);
  return [s];
}

const USAGE = `usage: node scripts/faults-real.mjs --real [--only <name>] [--dry-run]

Real fault-injection scenarios against the installed ZCode (each independent,
self-cleaning; report ok / failed / skipped per scenario):
${SCENARIOS.map((s) => `  ${s.name}`).join('\n')}
Spends real ZCode quota. Stops at the first auth/quota error (except in
invalid-api-key, which runs ZCode with an empty temp HOME and expects it).
Report: $ZCODE_MCP_HOME/reports/faults-*.json. --dry-run lists the selection.
`;

async function main() {
  const flags = startCli(process.argv.slice(2), { boolean: ['dry-run'], value: ['only'] }, USAGE);
  let selected;
  try { selected = selectScenarios(flags.only); } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (flags['dry-run']) { process.stdout.write(`${JSON.stringify({ scenarios: selected.map((s) => s.name) }, null, 2)}\n`); return 0; }
  const root = tempDir('zcode-faults-home-');
  const report = { name: 'faults-real', startedAt: new Date().toISOString(), home: root, scenarios: [] };
  let aborted = null;
  for (const sc of selected) {
    if (aborted) { report.scenarios.push({ name: sc.name, status: 'skipped', reason: aborted }); continue; }
    const scope = new Scope(root, sc.name);
    const t = Date.now();
    let res;
    try {
      res = await sc.run(scope);
    } catch (error) {
      if (error instanceof AbortSuite) {
        aborted = `aborted after ${error.message}; fix ZCode login/quota first`;
        res = failed(aborted);
      } else res = failed(`script error: ${error && error.message}`);
    }
    const leftover = await scope.cleanup();
    if (leftover) res = { ...res, status: 'failed', reason: `${res.reason ? `${res.reason}; ` : ''}leftover: ${leftover}` };
    report.scenarios.push({ name: sc.name, durationMs: Date.now() - t, ...res });
    process.stderr.write(`[faults] ${sc.name}: ${res.status}${res.reason ? ` (${res.reason})` : ''}\n`);
  }
  report.finishedAt = new Date().toISOString();
  report.aborted = aborted;
  report.ok = !aborted && report.scenarios.every((s) => s.status !== 'failed');
  writeReport(root, 'faults', report);
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`faults-real: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

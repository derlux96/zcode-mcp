// Shared plumbing for the real-binary suites (smoke-real, soak-real, faults-real):
// argument parsing, result-text parsing, temp repos, the real MCP server over
// stdio, polling a job to its end, leftover checks and the JSON report.
// Pure functions first; everything below `--- side effects ---` touches disk or processes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioClient, assertNoLeftoverProcesses, waitFor } from '../test/helpers.mjs';
import { getProcessIdentity } from '../src/procid.mjs';

export const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled', 'lost'];
export const OUTPUT_MARKER_PREFIX = '--- zcode output';

/** argv -> { flags, errors }. spec = { boolean: [...], value: [...] } (names without --). */
export function parseFlags(argv, spec) {
  const flags = {};
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) { errors.push(`unexpected argument ${arg}`); continue; }
    const [, name, inline] = m;
    if (spec.boolean.includes(name)) flags[name] = true;
    else if (spec.value.includes(name)) {
      const v = inline ?? argv[i + 1];
      if (v === undefined || (inline === undefined && v.startsWith('--'))) { errors.push(`--${name} needs a value`); continue; }
      flags[name] = v;
      if (inline === undefined) i++;
    } else errors.push(`unknown flag --${name}`);
  }
  return { flags, errors };
}

/**
 * Parses the header of a zcode_run/zcode_status/zcode_result text. Only lines
 * before the untrusted output marker are read, so output cannot forge them.
 */
export function parseResultText(text) {
  const s = String(text ?? '');
  const idx = s.indexOf(`\n${OUTPUT_MARKER_PREFIX}`);
  const head = idx >= 0 ? s.slice(0, idx) : s;
  let output = '';
  if (idx >= 0) {
    const rest = s.slice(idx + 1);
    const nl = rest.indexOf('\n');
    output = nl >= 0 ? rest.slice(nl + 1) : '';
  }
  const line = (key) => { const m = new RegExp(`^${key}: (.*)$`, 'm').exec(head); return m ? m[1] : null; };
  const status = line('status');
  const files = line('changed_files');
  let changedFiles = null;
  if (files !== null && files !== '(unavailable)') changedFiles = files === 'none' ? [] : files.split(', ');
  return {
    state: status ? status.split(/\s/)[0] : null,
    jobId: line('job_id'),
    sessionId: (line('session_id') || '').split(/\s/)[0] || null,
    warnings: (line('warnings') || '').split(', ').filter(Boolean),
    errorKind: line('error_kind'),
    error: line('error'),
    changedFiles,
    changesUnavailable: /^changes: unavailable/m.test(head),
    worktreeBranch: line('worktree_branch'),
    worktreeDir: line('worktree_dir'),
    output,
  };
}

/** "?? new.txt" / "M README.md" -> "new.txt" / "README.md". */
export function changedPaths(entries) {
  return (entries || []).map((e) => e.replace(/^\S+\s+/, ''));
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length, Math.max(1, rank)) - 1];
}

/** True for the error kinds after which a real suite must stop spending quota. */
export const isAbortKind = (kind) => kind === 'auth' || kind === 'quota';

// --- side effects ----------------------------------------------------------

/**
 * Common entry: --help prints usage (exit 0), missing --real prints usage (exit 2).
 * Returns the parsed flags when the suite may run.
 */
export function startCli(argv, spec, usage) {
  const { flags, errors } = parseFlags(argv, { boolean: ['real', 'help', ...spec.boolean], value: spec.value });
  if (flags.help) { process.stdout.write(usage); process.exit(0); }
  if (errors.length) { process.stderr.write(`${errors.join('\n')}\n\n${usage}`); process.exit(2); }
  if (!flags.real && !flags['dry-run']) { process.stderr.write(usage); process.exit(2); }
  return flags;
}

export const tempDir = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Inits a git repo in `dir` (created when missing) with `files` and one commit. */
export function initRepo(dir, files = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'smoke@example.com']);
  git(dir, ['config', 'user.name', 'Smoke']);
  writeFiles(dir, { 'README.md': '# smoke\n', ...files });
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

export function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

export function gitStatus(dir) {
  return git(dir, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
}

/** The real MCP server over stdio: real ZCode discovery (no fake binary), temp home. */
export async function realServer(home, env = {}) {
  const client = new StdioClient({
    home,
    env: { ZCODE_BIN: process.env.ZCODE_BIN, ZCODE_MCP_STATE: join(home, 'sessions.json'), ...env },
  });
  client.home = home;
  const id = getProcessIdentity(client.pid);
  client.identity = id && !id.unknown ? id.start : null;
  await client.initialize();
  return client;
}

export async function stopServer(client) {
  if (!client || client.hasExited) return;
  client.closeStdin();
  const t = setTimeout(() => client.kill('SIGKILL'), 5000);
  await client.exited;
  clearTimeout(t);
}

export function readJobStatus(home, jobId) {
  try { return JSON.parse(readFileSync(join(home, 'jobs', jobId, 'status.json'), 'utf8')); } catch { return null; }
}

/** ms from `t0` to the first protocol event recorded in events.log, or null. */
export function firstActivityMs(home, jobId, t0) {
  try {
    const first = readFileSync(join(home, 'jobs', jobId, 'events.log'), 'utf8').split('\n')[0];
    const ts = Date.parse(first.split(' ')[0]);
    return Number.isFinite(ts) ? ts - t0 : null;
  } catch { return null; }
}

/**
 * zcode_run with wait_ms, then followJob. A rejected start (no job_id) returns
 * { rejected: true, text }. onPoll(parsed, text) sees every intermediate answer.
 */
export async function runJob(client, args, { waitMs = 20000, ...opts } = {}) {
  const t0 = Date.now();
  const first = await client.callTool('zcode_run', { wait_ms: waitMs, ...args }, { timeoutMs: waitMs + 120000 });
  const parsed = parseResultText(first.text);
  if (!parsed.jobId) return { t0, rejected: true, isError: first.isError, text: first.text, parsed };
  return followJob(client, parsed.jobId, { ...opts, t0, initial: parsed });
}

/**
 * Polls zcode_status (wait_ms) until the job is terminal or capMs after t0;
 * at the cap the job is cancelled. Returns the final zcode_result text, parsed,
 * and the job's status.json.
 */
export async function followJob(client, jobId, { t0 = Date.now(), capMs = 600000, statusWaitMs = 30000, onPoll, initial } = {}) {
  let parsed = initial || { state: null };
  let capped = false;
  while (!TERMINAL.includes(parsed.state)) {
    if (Date.now() - t0 > capMs) {
      capped = true;
      await client.callTool('zcode_cancel', { job_id: jobId }, { timeoutMs: 60000 });
      break;
    }
    const r = await client.callTool('zcode_status', { job_id: jobId, wait_ms: statusWaitMs }, { timeoutMs: statusWaitMs + 60000 });
    parsed = parseResultText(r.text);
    if (onPoll) onPoll(parsed, r.text);
    if (r.isError && !parsed.state) break; // unknown job: nothing left to poll
  }
  const final = await client.callTool('zcode_result', { job_id: jobId }, { timeoutMs: 60000 });
  const status = readJobStatus(client.home, jobId);
  return { t0, jobId, capped, text: final.text, isError: final.isError, parsed: parseResultText(final.text), status };
}

/** Entries left in <home>/locks (a finished run must leave none); [] when the dir is missing. */
export function leftoverLocks(home) {
  try { return readdirSync(join(home, 'locks')).sort(); } catch { return []; }
}

/**
 * Throws when a runner/server of this run (markers) or a recorded ZCode child is
 * still alive, or when a directory lock is left in <home>/locks (spec §13: 0 processes, 0 locks).
 */
export async function assertNothingLeft(markers, home, jobIds) {
  await assertNoLeftoverProcesses(markers, { timeoutMs: 5000 });
  const locks = leftoverLocks(home);
  if (locks.length) throw new Error(`leftover locks in ${join(home, 'locks')}: ${locks.join(', ')}`);
  for (const jobId of jobIds) {
    const s = readJobStatus(home, jobId);
    if (!s || !Number.isInteger(s.childPid)) continue;
    await waitFor(() => {
      const id = getProcessIdentity(s.childPid);
      return !id || (!id.unknown && id.start !== s.childStart);
    }, { timeoutMs: 5000, what: `ZCode child ${s.childPid} of ${jobId} to be gone` });
  }
}

/** Prints the report as JSON to stdout and writes $home/reports/<name>-<timestamp>.json. */
export function writeReport(home, name, report) {
  const dir = join(home, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, reportFile: file }, null, 2)}\n`);
  return file;
}

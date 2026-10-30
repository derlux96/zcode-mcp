#!/usr/bin/env node
// Stage 4: real smoke matrix. Six tiny tasks x three paths against the REAL
// ZCode through the real MCP server over stdio. The script checks the EFFECT
// on disk (and the answer for the read-only task), never the model's claims.
// Spends real ZCode quota: run only with --real.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMain } from '../src/is-main.mjs';
import {
  startCli, tempDir, initRepo, writeFiles, gitStatus, realServer, stopServer, runJob,
  firstActivityMs, assertNothingLeft, writeReport, percentile, isAbortKind,
} from './real-lib.mjs';

const USAGE = `usage: node scripts/smoke-real.mjs --real [--dry-run]

Runs six tiny tasks on each of three paths (protocol default model,
protocol zai-coding-plan/GLM-5.3-Flash with low reasoning, CLI mode yolo)
against the real ZCode, each in a fresh temp git repo, and checks the effect.
Spends real ZCode quota. Exit 0 only with 0 false successes, every oracle
passing and no leftover processes. Report: $ZCODE_MCP_HOME/reports/smoke-*.json
(ZCODE_MCP_HOME is a fresh temp dir per run). --dry-run prints the matrix only.
`;

const SUM = 'module.exports = (a, b) => a + b;\n';
const SUM_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst sum = require('./sum.js');\ntest('sum', () => assert.strictEqual(sum(2, 3), 5));\n";
const FACTS = 'Project facts.\nThe secret code is 7341.\n';

const def = (t) => {
  const task = { setup: {}, want: {}, mustNotExist: [], treeUnchanged: false, ...t };
  task.expect = (dir) => checkOracle(task, dir).ok;
  return task;
};

/** SmokeTask = { id, prompt, expect(dir), setup, want, mustNotExist, treeUnchanged, outputIncludes?, kind? } */
export const SMOKE_TASKS = [
  def({
    id: 'create-file',
    prompt: 'Create a file named created.txt in the current directory containing exactly this single line: smoke-create-ok\nDo not create or change any other file.',
    want: { 'created.txt': 'smoke-create-ok' },
  }),
  def({
    id: 'change-file',
    prompt: 'In the file config.txt replace the line mode=old with mode=new. Change nothing else in the file and do not touch any other file.',
    setup: { 'config.txt': 'mode=old\n' },
    want: { 'config.txt': 'mode=new' },
  }),
  def({
    id: 'run-tests',
    prompt: 'Run the project\'s tests with the command `node --test` in the current directory. If all tests pass, write exactly the word PASS into a new file test-result.txt; if any test fails, write exactly FAIL. Do not modify sum.js or sum.test.js.',
    setup: { 'sum.js': SUM, 'sum.test.js': SUM_TEST },
    want: { 'test-result.txt': 'PASS', 'sum.js': SUM, 'sum.test.js': SUM_TEST },
  }),
  def({
    id: 'multi-file',
    prompt: 'Make two edits: in a.txt replace alpha=1 with alpha=2, and in b.txt replace beta=1 with beta=2. Change nothing else.',
    setup: { 'a.txt': 'alpha=1\n', 'b.txt': 'beta=1\n' },
    want: { 'a.txt': 'alpha=2', 'b.txt': 'beta=2' },
  }),
  def({
    id: 'impossible',
    kind: 'impossible',
    prompt: 'Edit the existing file missing/does-not-exist.txt: replace the word foo with bar. If that file does not exist, do NOT create it and do not create or change any other file; just report that the file does not exist.',
    mustNotExist: ['missing/does-not-exist.txt'],
    treeUnchanged: true,
  }),
  def({
    id: 'read-only',
    kind: 'read-only',
    prompt: 'Read facts.txt and answer: what is the secret code? Reply with the number. Do not create, modify or delete any file.',
    setup: { 'facts.txt': FACTS },
    treeUnchanged: true,
    outputIncludes: '7341',
  }),
];

export const SMOKE_PATHS = [
  { id: 'protocol-default', args: {} },
  { id: 'protocol-flash', args: { model: 'zai-coding-plan/GLM-5.3-Flash', reasoning_level: 'low' } },
  { id: 'cli-yolo', args: { mode: 'yolo' } },
];

export function setupTask(task, dir) {
  writeFiles(dir, task.setup);
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
const show = (s) => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s);

/** Pure effect check of `task` in `dir` (reads files and git status only). */
export function checkOracle(task, dir) {
  const reasons = [];
  for (const [name, content] of Object.entries(task.want || {})) {
    const full = join(dir, name);
    if (!existsSync(full)) { reasons.push(`missing file ${name}`); continue; }
    const got = norm(readFileSync(full, 'utf8'));
    if (got === norm(content)) continue;
    const before = task.setup && task.setup[name];
    if (before !== undefined && got === norm(before)) reasons.push(`${name} unchanged`);
    else reasons.push(`wrong content in ${name}: got ${show(got)}, want ${show(norm(content))}`);
  }
  for (const name of task.mustNotExist || []) {
    if (existsSync(join(dir, name))) reasons.push(`invented file ${name}`);
  }
  if (task.treeUnchanged) {
    const st = gitStatus(dir);
    if (st) reasons.push(`working tree changed: ${st.split('\n').join(', ')}`);
  }
  return reasons.length ? { ok: false, reason: reasons.join('; ') } : { ok: true };
}

/**
 * Verdict of one run. run = { state, errorKind, warnings, output }.
 * FALSE SUCCESS: the job says `completed` but the effect (or the answer) is wrong.
 */
export function judgeRun(task, run, oracle) {
  const warnings = run.warnings || [];
  if (run.state === 'completed') {
    if (!oracle.ok) return { ok: false, falseSuccess: true, reason: `completed but ${oracle.reason}` };
    if (task.outputIncludes && !String(run.output || '').includes(task.outputIncludes)) {
      return { ok: false, falseSuccess: true, reason: `completed but the output does not contain ${task.outputIncludes}` };
    }
    // Ruling: an impossible task reported completed without no_changes is a false success.
    if (task.kind === 'impossible' && !warnings.includes('no_changes')) {
      return { ok: false, falseSuccess: true, reason: 'completed without the no_changes warning' };
    }
    return { ok: true, falseSuccess: false };
  }
  if (task.kind === 'impossible' && run.state === 'failed') {
    return oracle.ok ? { ok: true, falseSuccess: false } : { ok: false, falseSuccess: false, reason: `failed and ${oracle.reason}` };
  }
  return { ok: false, falseSuccess: false, reason: `job ended ${run.state} (${run.errorKind || 'no error_kind'})` };
}

/** Counts and latency percentiles of one path's run records. */
export function summarizePath(records) {
  const runs = records.filter((r) => !r.skipped);
  const lat = runs.map((r) => r.latencyMs);
  const first = runs.map((r) => r.firstActivityMs);
  return {
    runs: runs.length,
    passed: runs.filter((r) => r.verdict && r.verdict.ok).length,
    failed: runs.filter((r) => !r.verdict || !r.verdict.ok).length,
    falseSuccesses: runs.filter((r) => r.verdict && r.verdict.falseSuccess).length,
    skipped: records.length - runs.length,
    latencyP50Ms: percentile(lat, 50),
    latencyP95Ms: percentile(lat, 95),
    firstActivityP50Ms: percentile(first, 50),
    firstActivityP95Ms: percentile(first, 95),
  };
}

const RUN_CAP_MS = 10 * 60 * 1000;

async function runOne(client, home, path, task, repos) {
  const repo = tempDir('zcode-smoke-repo-');
  repos.push(repo);
  initRepo(repo, task.setup);
  const rec = { path: path.id, task: task.id, repo };
  try {
    const r = await runJob(client, { prompt: task.prompt, cwd: repo, ...path.args }, { waitMs: 20000, capMs: RUN_CAP_MS });
    if (r.rejected) {
      Object.assign(rec, { state: 'rejected', error: r.text.slice(0, 500), verdict: { ok: false, falseSuccess: false, reason: 'zcode_run rejected the task' } });
      return rec;
    }
    const p = r.parsed;
    const finished = Date.parse(r.status && r.status.finishedAt);
    Object.assign(rec, {
      jobId: r.jobId,
      state: p.state,
      errorKind: p.errorKind,
      error: p.error,
      warnings: p.warnings,
      sessionId: p.sessionId,
      capped: r.capped,
      latencyMs: (Number.isFinite(finished) ? finished : Date.now()) - r.t0,
      firstActivityMs: firstActivityMs(home, r.jobId, r.t0),
    });
    rec.oracle = checkOracle(task, repo);
    rec.verdict = judgeRun(task, { ...p }, rec.oracle);
  } catch (error) {
    Object.assign(rec, { state: 'error', error: String(error.message), verdict: { ok: false, falseSuccess: false, reason: `script error: ${error.message}` } });
  }
  return rec;
}

async function main() {
  const flags = startCli(process.argv.slice(2), { boolean: ['dry-run'], value: [] }, USAGE);
  if (flags['dry-run']) {
    process.stdout.write(`${JSON.stringify({ paths: SMOKE_PATHS, tasks: SMOKE_TASKS.map(({ id, prompt }) => ({ id, prompt })) }, null, 2)}\n`);
    return 0;
  }
  const home = tempDir('zcode-smoke-home-');
  const repos = [];
  const records = [];
  const report = { name: 'smoke-real', startedAt: new Date().toISOString(), home, paths: SMOKE_PATHS };
  let client = await realServer(home);
  let aborted = null;
  try {
    const check = await client.callTool('zcode_check', { include_models: true }, { timeoutMs: 90000 });
    report.check = check.text;
    if (!/"ok": true/.test(check.text)) aborted = 'zcode_check did not report ok: true';
    for (const path of SMOKE_PATHS) {
      for (const task of SMOKE_TASKS) {
        if (aborted) { records.push({ path: path.id, task: task.id, skipped: aborted }); continue; }
        if (client.hasExited) client = await realServer(home);
        const rec = await runOne(client, home, path, task, repos);
        records.push(rec);
        process.stderr.write(`[smoke] ${path.id} ${task.id}: ${rec.state} ${rec.verdict.ok ? 'ok' : `FAIL ${rec.verdict.reason}`} (${rec.latencyMs ?? '?'} ms)\n`);
        if (isAbortKind(rec.errorKind)) aborted = `aborted after error_kind ${rec.errorKind} (${rec.error || 'no message'}); fix ZCode login/quota first`;
      }
    }
  } finally {
    await stopServer(client);
  }
  const jobIds = records.map((r) => r.jobId).filter(Boolean);
  try {
    await assertNothingLeft([basename(home), ...repos.map((r) => basename(r))], home, jobIds);
    report.leftover = { ok: true };
  } catch (error) {
    report.leftover = { ok: false, error: error.message };
  }
  for (const r of repos) rmSync(r, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.aborted = aborted;
  report.runs = records;
  report.perPath = Object.fromEntries(SMOKE_PATHS.map((p) => [p.id, summarizePath(records.filter((r) => r.path === p.id))]));
  report.falseSuccesses = records.filter((r) => r.verdict && r.verdict.falseSuccess).length;
  report.failedOracles = records.filter((r) => !r.skipped && !(r.verdict && r.verdict.ok)).length;
  report.ok = !aborted && report.falseSuccesses === 0 && report.failedOracles === 0 && report.leftover.ok;
  writeReport(home, 'smoke', report);
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`smoke-real: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

// Runner: transient provider errors continue the same session (protocol path).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';
import { createJobDir, readStatus, readResult } from '../src/jobstore.mjs';
import { runJob, runnerEnvOptions } from '../src/job-runner.mjs';
import { validateRunArgs } from '../src/runner.mjs';
import { startJob, listJobs } from '../src/jobs.mjs';
import { DEFAULT_CONTINUE_PROMPT } from '../src/appserver.mjs';

const fakeAppServer = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));
const temps = [];
const ENV_KEYS = ['FAKE_APPSERVER_MODE', 'FAKE_APPSERVER_LOG', 'FAKE_APPSERVER_COUNTER', 'FAKE_APPSERVER_FAIL_TIMES', 'FAKE_APPSERVER_RETRY_AFTER', 'FAKE_APPSERVER_HANG_AFTER', 'FAKE_APPSERVER_EXIT_AFTER_FAIL'];

before(() => {
  const home = makeTempDir('zcode-home-');
  temps.push(home);
  process.env.ZCODE_MCP_HOME = home;
  process.env.ZCODE_MCP_STATE = join(home, 'sessions.json');
  process.env.ZCODE_BIN = fakeBin;
  process.env.ZCODE_APPSERVER_BIN = fakeAppServer;
});

afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

after(() => {
  for (const k of ['ZCODE_MCP_HOME', 'ZCODE_MCP_STATE', 'ZCODE_BIN', 'ZCODE_APPSERVER_BIN']) delete process.env[k];
  for (const d of temps) removeDir(d);
});

function setup(mode, extra = {}) {
  const cwd = makeTempDir('zcode-cwd-');
  temps.push(cwd);
  const log = join(cwd, 'rx.log');
  Object.assign(process.env, { FAKE_APPSERVER_MODE: mode, FAKE_APPSERVER_LOG: log, FAKE_APPSERVER_COUNTER: join(cwd, 'sends'), ...extra });
  const sends = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.method === 'session/send') : []);
  return { cwd, sends };
}

function mkJob(params, extra = {}) {
  return createJobDir({ params: { prompt: 'do it', timeout_ms: 30000, ...params }, path: 'protocol', baseline: null, ...extra });
}

async function waitFor(pred, timeoutMs = 10000, stepMs = 10) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

test('recovered after one 429: completed, history, warning, continue sent into the same session', async () => {
  const { cwd, sends } = setup('fail-429-then-ok');
  const { dir } = mkJob({ cwd });
  const retryPatches = [];
  await runJob(dir, { retryDelaysMs: [30], onStatus: (_s, p) => { if ('retry' in p) retryPatches.push(p.retry); } });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.output, 'fake model task done after 2 turn(s)');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.deepEqual(res.warnings, ['recovered_after_transient_errors:1']);
  assert.equal(res.retryOutcome, 'recovered');
  assert.equal(res.retries.length, 1);
  const [r] = res.retries;
  assert.equal(r.attempt, 1);
  assert.ok(r.delayMs >= 27 && r.delayMs <= 33, `jittered delay ${r.delayMs}`);
  assert.equal(r.reason, 'HTTP 429 Too Many Requests: rate limit reached for requests');
  assert.match(r.at, /^\d{4}-\d\d-\d\dT.*Z$/);
  // status.retry set before the wait, cleared when the next turn started.
  assert.equal(retryPatches[0].attempt, 1);
  assert.equal(retryPatches[0].maxRetries, 6);
  assert.equal(typeof retryPatches[0].nextAt, 'string');
  assert.equal(retryPatches[0].delayMs, r.delayMs);
  assert.match(retryPatches[0].reason, /HTTP 429/);
  assert.ok(retryPatches.includes(null), 'retry cleared');
  const st = readStatus(dir);
  assert.equal(st.retry, null);
  assert.equal(st.state, 'completed');
  const s = sends();
  assert.equal(s.length, 2);
  assert.equal(s[1].params.content, DEFAULT_CONTINUE_PROMPT);
  assert.equal(s[1].params.sessionId, 'sess_fakeB1');
  // progress and events.log carry the retry line.
  const events = readFileSync(join(dir, 'events.log'), 'utf8');
  assert.match(events, /retrying in 0s \(attempt 1\/6\): HTTP 429 Too Many Requests/);
  assert.ok(st.progress.some((l) => /^retrying in 0s \(attempt 1\/6\): /.test(l)));
});

test('recovered after three network failures', async () => {
  const { cwd, sends } = setup('fail-network-then-ok', { FAKE_APPSERVER_FAIL_TIMES: '3' });
  const { dir } = mkJob({ cwd });
  await runJob(dir, { retryDelaysMs: [10, 20] });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, ['recovered_after_transient_errors:3']);
  assert.deepEqual(res.retries.map((r) => r.attempt), [1, 2, 3]);
  assert.ok(res.retries.every((r) => r.reason === 'TypeError: fetch failed'));
  assert.equal(sends().length, 4);
});

test('exhaustion reports the real message and errorKind plus the history', async () => {
  const { cwd, sends } = setup('fail-429-always');
  const { dir } = mkJob({ cwd, max_transient_retries: 3 });
  await runJob(dir, { retryDelaysMs: [5] });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'quota');
  assert.equal(res.errorMessage, 'HTTP 429 Too Many Requests: rate limit reached for requests');
  assert.equal(res.retries.length, 3);
  assert.equal(res.retryOutcome, 'exhausted');
  assert.deepEqual(res.warnings, ['transient_retries_exhausted:3']);
  assert.equal(sends().length, 4);
  assert.equal(readStatus(dir).retry, null);
});

for (const [mode, kind] of [['fail-auth', 'auth'], ['fail-model-request-failed', 'unknown']]) {
  test(`${mode}: not transient, ends at once with exactly one session/send`, async () => {
    const { cwd, sends } = setup(mode);
    const { dir } = mkJob({ cwd });
    await runJob(dir, { retryDelaysMs: [5] });
    const res = readResult(dir);
    assert.equal(res.state, 'failed');
    assert.equal(res.errorKind, kind);
    assert.deepEqual(res.retries, []);
    assert.equal(res.retryOutcome, null);
    assert.deepEqual(res.warnings, []);
    assert.equal(sends().length, 1);
  });
}

test('max_transient_retries 0 disables the retry', async () => {
  const { cwd, sends } = setup('fail-429-then-ok');
  const { dir } = mkJob({ cwd, max_transient_retries: 0 });
  await runJob(dir, { retryDelaysMs: [5] });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'quota');
  assert.deepEqual(res.warnings, []);
  assert.equal(sends().length, 1);
});

test('deadline clipping: a backoff that would pass timeout_ms is not started', async () => {
  const { cwd, sends } = setup('fail-429-always');
  const { dir } = mkJob({ cwd, timeout_ms: 2000 });
  await runJob(dir, { retryDelaysMs: [50, 5000] });
  const res = readResult(dir);
  assert.equal(res.state, 'failed', 'the real failure, not a timeout');
  assert.equal(res.errorKind, 'quota');
  assert.equal(res.retries.length, 1);
  assert.equal(res.retryOutcome, 'exhausted');
  assert.deepEqual(res.warnings, ['transient_retries_exhausted:1', 'retry_budget_exhausted']);
  assert.equal(sends().length, 2);
});

test('the protocol job deadline covers the wait after a continue (timeout_total)', async () => {
  const { cwd } = setup('fail-429-always', { FAKE_APPSERVER_HANG_AFTER: '1' });
  const { dir } = mkJob({ cwd, timeout_ms: 1500 });
  const t0 = Date.now();
  await runJob(dir, { retryDelaysMs: [300] });
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  assert.equal(res.errorKind, 'timeout_total');
  assert.equal(res.retries.length, 1);
  assert.ok(Date.now() - t0 < 1500 + 5000);
});

test('no idle timeout during a backoff longer than idle_timeout_ms', async () => {
  const { cwd } = setup('fail-429-then-ok');
  const { dir } = mkJob({ cwd, idle_timeout_ms: 1000 });
  await runJob(dir, { retryDelaysMs: [1600] });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, ['recovered_after_transient_errors:1']);
});

test('heartbeats continue during a backoff and status.retry is visible while waiting', async () => {
  const { cwd } = setup('fail-429-then-ok');
  const { dir } = mkJob({ cwd });
  const done = runJob(dir, { retryDelaysMs: [800], heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.retry ? readStatus(dir) : null));
  assert.equal(st.state, 'running');
  assert.equal(st.retry.attempt, 1);
  assert.ok(Date.parse(st.retry.nextAt) > Date.now() - 100);
  const beat = st.heartbeatAt;
  await waitFor(() => readStatus(dir)?.retry && readStatus(dir).heartbeatAt !== beat, 2000);
  await done;
  assert.equal(readResult(dir).state, 'completed');
});

test('cancel during the backoff ends cancelled within a second and leaves no process', async () => {
  const { cwd } = setup('fail-429-always');
  const { dir } = mkJob({ cwd, timeout_ms: 0 }); // no deadline: the 60 s backoff starts
  const done = runJob(dir, { retryDelaysMs: [60000], heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.retry ? readStatus(dir) : null));
  const t0 = Date.now();
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  assert.ok(Date.now() - t0 < 3000, `cancelled after ${Date.now() - t0} ms (the backoff is 60 s)`);
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(res.retries.length, 1);
  assert.equal(res.retryOutcome, 'cancelled');
  assert.equal(readStatus(dir).retry, null);
  await waitFor(() => !alive(st.childPid), 2000);
});

// --- validation and plumbing ---

test('validateRunArgs: max_transient_retries is an integer 0..20, unset by default', () => {
  const cwd = makeTempDir('zcode-cwd-');
  temps.push(cwd);
  const base = { prompt: 'x', cwd };
  assert.equal(validateRunArgs(base).value.maxTransientRetries, undefined);
  assert.equal(validateRunArgs({ ...base, max_transient_retries: 0 }).value.maxTransientRetries, 0);
  assert.equal(validateRunArgs({ ...base, max_transient_retries: 20 }).value.maxTransientRetries, 20);
  for (const bad of [-1, 21, 1.5, '3', null, true]) {
    const v = validateRunArgs({ ...base, max_transient_retries: bad });
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.match(v.error, /max_transient_retries must be an integer between 0 and 20/);
  }
});

test('startJob stores max_transient_retries in job.json and rejects it on the CLI path', async () => {
  const cwd = makeTempDir('zcode-cwd-');
  temps.push(cwd);
  const before = listJobs().length;
  const cli = await startJob({ prompt: 'x', cwd, mode: 'build', max_transient_retries: 2 });
  assert.equal(cli.ok, false);
  assert.match(cli.error, /max_transient_retries applies only in protocol mode/);
  assert.match(cli.error, /resume/);
  assert.equal(listJobs().length, before, 'nothing was created');
  const spawned = [];
  const fakeSpawn = () => { spawned.push(1); return { pid: 999999, on() {}, unref() {} }; };
  const ok = await startJob({ prompt: 'x', cwd, max_transient_retries: 2 }, { spawn: fakeSpawn });
  assert.equal(ok.ok, true);
  const job = JSON.parse(readFileSync(join(process.env.ZCODE_MCP_HOME, 'jobs', ok.jobId, 'job.json'), 'utf8'));
  assert.equal(job.params.max_transient_retries, 2);
  removeDir(join(process.env.ZCODE_MCP_HOME, 'jobs', ok.jobId));
  removeDir(join(process.env.ZCODE_MCP_HOME, 'locks'));
});

test('runnerEnvOptions: ZCODE_MCP_TEST_RETRY_DELAYS_MS only with NODE_ENV=test', () => {
  assert.equal(runnerEnvOptions({ ZCODE_MCP_TEST_RETRY_DELAYS_MS: '10,20' }).retryDelaysMs, undefined);
  assert.deepEqual(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_TEST_RETRY_DELAYS_MS: '10, 20' }).retryDelaysMs, [10, 20]);
  assert.equal(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_TEST_RETRY_DELAYS_MS: '10,x' }).retryDelaysMs, undefined);
  assert.equal(runnerEnvOptions({ NODE_ENV: 'test' }).retryDelaysMs, undefined);
});

// --- review fixes ---

test('balance class (R31): a status-only 1113 payload is retried twice, then fails quota with the real message', async () => {
  const { cwd, sends } = setup('fail-status-1113-always');
  const { dir } = mkJob({ cwd });
  await runJob(dir, { retryDelaysMs: [10, 20, 30] });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'quota');
  assert.equal(res.errorMessage, '[1113][Insufficient balance or no resource package. Please recharge.][req_fake]');
  assert.equal(res.retries.length, 2);
  assert.equal(res.retryOutcome, 'exhausted');
  assert.deepEqual(res.warnings, ['transient_retries_exhausted:2']);
  assert.equal(sends().length, 3);
  assert.match(readFileSync(join(dir, 'events.log'), 'utf8'), /retrying in 0s \(attempt 1\/2\): \[1113\]/);
});

test('real layout: localized 429 with the English cause in underlyingErrorMessage recovers', async () => {
  const { cwd } = setup('fail-zh-429-then-ok');
  const { dir } = mkJob({ cwd });
  await runJob(dir, { retryDelaysMs: [5] });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.retries[0].reason, '模型请求失败 | Model request failed | HTTP 429 Too Many Requests');
});

test('real model_not_found payload: errorKind model from detail, message keeps both texts, not retried', async () => {
  const { cwd, sends } = setup('fail-zh-model-creation');
  const { dir } = mkJob({ cwd });
  await runJob(dir, { retryDelaysMs: [5] });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'model');
  assert.equal(res.errorMessage, 'Provider Registry 中不存在 Model: glm-test/small | Model creation failed');
  assert.equal(sends().length, 1);
});

test('an app-server that dies during a backoff ends the job at once (failed, crash)', async () => {
  const { cwd } = setup('fail-429-always', { FAKE_APPSERVER_EXIT_AFTER_FAIL: '1' });
  const { dir } = mkJob({ cwd, timeout_ms: 0 });
  const t0 = Date.now();
  await runJob(dir, { retryDelaysMs: [60000] });
  assert.ok(Date.now() - t0 < 15000);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.equal(res.retries.length, 1);
  assert.equal(res.retryOutcome, 'failed');
});

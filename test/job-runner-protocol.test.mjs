import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin } from './helpers.mjs';
import { createJobDir, readStatus, readResult } from '../src/jobstore.mjs';
import { captureBaseline } from '../src/changes.mjs';
import { SessionStore } from '../src/state.mjs';
import { runJob, describeEvent } from '../src/job-runner.mjs';
import { runTaskWithModel, AppServerError } from '../src/appserver.mjs';

const fakeAppServer = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));
const temps = [];

before(() => {
  const home = makeTempDir('zcode-home-');
  temps.push(home);
  process.env.ZCODE_MCP_HOME = home;
  process.env.ZCODE_MCP_STATE = join(home, 'sessions.json');
  process.env.ZCODE_BIN = fakeBin;
  process.env.ZCODE_APPSERVER_BIN = fakeAppServer;
});

afterEach(() => {
  delete process.env.FAKE_APPSERVER_MODE;
  delete process.env.FAKE_ZCODE_MODE;
});

after(() => {
  for (const k of ['ZCODE_MCP_HOME', 'ZCODE_MCP_STATE', 'ZCODE_BIN', 'ZCODE_APPSERVER_BIN']) delete process.env[k];
  for (const d of temps) removeDir(d);
});

function tempCwd() {
  const d = makeTempDir('zcode-cwd-');
  temps.push(d);
  return d;
}

function mkJob(params, extra = {}) {
  return createJobDir({
    params: { prompt: 'do it', timeout_ms: 30000, ...params },
    path: 'protocol',
    baseline: null,
    ...extra,
  });
}

async function waitFor(pred, timeoutMs = 10000, stepMs = 20) {
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

test('protocol job without model uses settings.model.current and completes with a sess_ id', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const cwd = tempCwd();
  const log = join(cwd, 'rx.log');
  process.env.FAKE_APPSERVER_LOG = log;
  let dir;
  try {
    ({ dir } = mkJob({ cwd }));
    await runJob(dir);
  } finally {
    delete process.env.FAKE_APPSERVER_LOG;
  }
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(res.output, 'fake model task done');
  assert.equal(res.exitCode, null);
  assert.equal(res.stderr, '');
  assert.equal(res.errorKind, null);
  assert.equal(res.timeoutKind, null);
  assert.deepEqual(res.warnings, []);
  assert.equal(readFileSync(res.outputLogPath, 'utf8'), 'fake model task done');
  assert.equal(statSync(res.outputLogPath).mode & 0o777, 0o600);
  const sent = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .find((m) => m.method === 'session/send');
  assert.deepEqual(sent.params.modelSelection, { providerId: 'glm-test', modelId: 'small', options: { reasoningLevel: 'high' } });
  const st = readStatus(dir);
  assert.equal(st.state, 'completed');
  assert.equal(st.sessionId, 'sess_fakeB1');
  assert.ok(Number.isInteger(st.childPid));
  assert.equal(st.childPgid, st.childPid);
  assert.equal(typeof st.childStart, 'string');
  assert.equal(typeof st.lastActivityAt, 'string');
  const entry = new SessionStore(process.env.ZCODE_MCP_STATE).list().find((e) => e.id === 'sess_fakeB1');
  assert.ok(entry);
  assert.equal(entry.kind, 'session');
});

test('explicit job.model is used', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const cwd = tempCwd();
  const log = join(cwd, 'rx.log');
  process.env.FAKE_APPSERVER_LOG = log;
  let dir;
  try {
    ({ dir } = mkJob({ cwd, reasoning_level: 'max' }, { model: { providerId: 'glm-test', modelId: 'big' } }));
    await runJob(dir);
  } finally {
    delete process.env.FAKE_APPSERVER_LOG;
  }
  assert.equal(readResult(dir).state, 'completed');
  const sent = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .find((m) => m.method === 'session/send');
  assert.deepEqual(sent.params.modelSelection, { providerId: 'glm-test', modelId: 'big', options: { reasoningLevel: 'max' } });
});

test('idle timeout ends a silent protocol job with state timeout and timeoutKind idle', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const { dir } = mkJob({ cwd: tempCwd(), idle_timeout_ms: 600 });
  const t0 = Date.now();
  await runJob(dir);
  assert.ok(Date.now() - t0 < 10000);
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  assert.equal(res.timeoutKind, 'idle');
  assert.equal(res.errorKind, 'timeout_idle');
  assert.equal(res.sessionId, null);
  assert.equal(readStatus(dir).state, 'timeout');
  assert.equal(alive(readStatus(dir).childPid), false);
});

test('a chatty job survives an idle limit shorter than its runtime', async () => {
  process.env.FAKE_APPSERVER_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd(), idle_timeout_ms: 1000 });
  const t0 = Date.now();
  await runJob(dir);
  assert.ok(Date.now() - t0 >= 1400, 'the run outlasted the idle limit');
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.timeoutKind, null);
});

test('total timeout_ms ends the job with timeoutKind total', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const { dir } = mkJob({ cwd: tempCwd(), timeout_ms: 500 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  assert.equal(res.timeoutKind, 'total');
  assert.equal(res.errorKind, 'timeout_total');
});

test('rate-limit ends failed with errorKind quota', async () => {
  process.env.FAKE_APPSERVER_MODE = 'rate-limit';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'quota');
  assert.equal(res.errorMessage, '429 rate limit');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(res.timeoutKind, null);
});

test('auth-fail ends failed with errorKind auth', async () => {
  process.env.FAKE_APPSERVER_MODE = 'auth-fail';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'auth');
});

test('cancel file aborts a protocol job: state cancelled, app-server process gone', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  assert.ok(Number.isInteger(st.childPid) && st.childPid !== process.pid);
  assert.equal(alive(st.childPid), true);
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.timeoutKind, 'cancelled');
  assert.equal(readStatus(dir).state, 'cancelled');
  await waitFor(() => !alive(st.childPid), 2000);
});

test('fallback to CLI with warning idle_detection_unavailable when the catalog is empty', async () => {
  process.env.FAKE_APPSERVER_MODE = 'no-model';
  const { dir } = mkJob({ cwd: tempCwd(), idle_timeout_ms: 600 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.sessionId, 'sess_fake123'); // from the CLI fake
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.warnings, ['idle_detection_unavailable']);
  assert.deepEqual(readStatus(dir).warnings, ['idle_detection_unavailable']);
});

test('progress keeps the last 5 describeEvent lines and events.log has them', async () => {
  process.env.FAKE_APPSERVER_MODE = 'tools';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  assert.equal(readResult(dir).state, 'completed');
  const expected = ['tool T3 scheduled', 'tool T4 scheduled', 'tool T5 scheduled', 'turn.started', 'turn.completed'];
  assert.deepEqual(readStatus(dir).progress, expected);
  const logFile = join(dir, 'events.log');
  assert.equal(statSync(logFile).mode & 0o777, 0o600);
  const lines = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 8);
  for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT\S+Z \S/);
  assert.deepEqual(lines.map((l) => l.slice(l.indexOf(' ') + 1)), [
    'tool T0 scheduled', 'tool T1 scheduled', 'tool T2 scheduled', ...expected,
  ]);
});

test('describeEvent unit cases', () => {
  assert.equal(describeEvent({ type: 'tool.updated', payload: { toolName: 'Write', kind: 'scheduled' } }), 'tool Write scheduled');
  assert.equal(describeEvent({ type: 'turn.started', payload: {} }), 'turn.started');
  assert.equal(describeEvent({ type: 'turn.completed', payload: { response: 'x' } }), 'turn.completed');
  assert.equal(describeEvent({ type: 'turn.failed', payload: { error: {} } }), 'turn.failed');
  assert.equal(describeEvent({ type: 'checkpoint.created' }), 'checkpoint.created');
  assert.equal(describeEvent({ type: 'model.streaming', payload: { delta: 'x' } }), null);
  assert.equal(describeEvent({ type: 'session.updated' }), null);
  assert.equal(describeEvent({}), null);
  assert.equal(describeEvent(null), null);
});

test('a flood of 2000 model.streaming events causes only a handful of status writes', async () => {
  process.env.FAKE_APPSERVER_MODE = 'flood';
  const { dir } = mkJob({ cwd: tempCwd() });
  let activityWrites = 0;
  await runJob(dir, {
    heartbeatMs: 60000,
    onStatus: (_s, patch) => { if (patch.lastActivityAt && !patch.state) activityWrites++; },
  });
  assert.equal(readResult(dir).state, 'completed');
  assert.ok(activityWrites >= 1, 'activity was recorded');
  assert.ok(activityWrites <= 4, `only a handful of activity writes, saw ${activityWrites}`);
});

test('reasoning level substitution produces the warning', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const { dir } = mkJob({ cwd: tempCwd() }, { model: { providerId: 'fake-openrouter', modelId: 'nimbus-xl' } });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, ['reasoning_level_substituted:high->xhigh']);
});

test('completed protocol job without changes in a git cwd carries warning no_changes', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const cwd = makeGitRepo();
  temps.push(cwd);
  const { dir } = mkJob({ cwd }, { baseline: captureBaseline(cwd) });
  await runJob(dir);
  assert.deepEqual(readResult(dir).warnings, ['no_changes']);
});

test('a startup failure is retried once, then the job fails', async () => {
  process.env.FAKE_APPSERVER_MODE = 'die';
  const { dir } = mkJob({ cwd: tempCwd() });
  const childPids = new Set();
  await runJob(dir, { onStatus: (_s, patch) => { if (patch.childPid) childPids.add(patch.childPid); } });
  assert.equal(childPids.size, 2, 'two app-server spawns');
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(typeof res.errorMessage, 'string');
  assert.equal(readStatus(dir).state, 'failed');
});

// --- appserver.mjs extensions used by the runner ---

test('runTaskWithModel: onEvent sees every session/event in order, onSpawn gets the child', async () => {
  process.env.FAKE_APPSERVER_MODE = 'tools';
  const seen = [];
  let spawned = null;
  const res = await runTaskWithModel({
    binPath: fakeAppServer, cwd: tempCwd(), prompt: 'x', timeoutMs: 5000, killGroup: true,
    onSpawn: (child) => { spawned = child.pid; },
    onEvent: (e) => seen.push(e.type === 'tool.updated' ? e.payload.toolName : e.type),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.model, { providerId: 'glm-test', modelId: 'small' });
  assert.ok(Number.isInteger(spawned));
  assert.deepEqual(seen, ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'turn.started', 'model.streaming', 'turn.completed']);
  assert.equal(alive(spawned), false);
});

test('runTaskWithModel: no current model and empty catalog rejects with code no-model', async () => {
  process.env.FAKE_APPSERVER_MODE = 'no-model';
  await assert.rejects(
    runTaskWithModel({ binPath: fakeAppServer, cwd: tempCwd(), prompt: 'x', timeoutMs: 5000 }),
    (err) => err instanceof AppServerError && err.code === 'no-model',
  );
});

test('runTaskWithModel: aborting the signal rejects with code aborted and kills the group', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const ctl = new AbortController();
  let pid = null;
  const p = runTaskWithModel({
    binPath: fakeAppServer, cwd: tempCwd(), prompt: 'x', timeoutMs: 10000, killGroup: true,
    signal: ctl.signal, onSpawn: (c) => { pid = c.pid; },
    onEvent: () => {},
  });
  await waitFor(() => pid);
  setTimeout(() => ctl.abort(), 400);
  await assert.rejects(p, (err) => err instanceof AppServerError && err.code === 'aborted');
  await waitFor(() => !alive(pid), 2000);
});

test('runTaskWithModel: only one of providerId/modelId is a TypeError', async () => {
  await assert.rejects(
    runTaskWithModel({ binPath: fakeAppServer, cwd: tempCwd(), prompt: 'x', providerId: 'glm-test' }),
    TypeError,
  );
});

test('a cancel whose app-server exit is seen before the runner aborts still ends cancelled', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.childPgid ? readStatus(dir) : null));
  await new Promise((r) => setTimeout(r, 500)); // past session/send: no startup retry
  writeFileSync(join(dir, 'cancel'), '');
  process.kill(-st.childPgid, 'SIGKILL'); // only the app-server group, not the runner
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.timeoutKind, 'cancelled');
  assert.equal(readStatus(dir).state, 'cancelled');
});

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin, safeSignal } from './helpers.mjs';
import { createJobDir, readStatus, readResult } from '../src/jobstore.mjs';
import { captureBaseline } from '../src/changes.mjs';
import { SessionStore } from '../src/state.mjs';
import { runJob, describeEvent, STOP_GRACE_MS, DEFAULT_INPUT_TIMEOUT_MS, INPUT_TIMEOUT_ANSWER } from '../src/job-runner.mjs';
import { writeInboxEntry, readAck } from '../src/inbox.mjs';
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
  delete process.env.FAKE_APPSERVER_LOG;
  delete process.env.FAKE_APPSERVER_UNSUPPORTED;
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
  // I4: once the app-server has exited its pgid is cleared and the exit recorded.
  assert.equal(st.childPgid, null);
  assert.equal(typeof st.childExitedAt, 'string');
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
  // M6: the session existed (session/create succeeded): its real id is kept and resumable.
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(readStatus(dir).state, 'timeout');
  assert.equal(alive(readStatus(dir).childPid), false);
  const entry = new SessionStore(process.env.ZCODE_MCP_STATE).list().at(-1);
  assert.equal(entry.id, 'sess_fakeB1');
  assert.equal(entry.kind, 'session');
  assert.equal(entry.status, 'timeout');
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

test('an unanswered session/send is a failed request, not the total timeout (I2)', async () => {
  process.env.FAKE_APPSERVER_MODE = 'nosendack';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir, { requestTimeoutMs: 300 });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'unknown');
  assert.equal(res.errorMessage, 'session/send timed out after 300 ms without a response');
  assert.equal(res.timeoutKind, null);
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(readStatus(dir).state, 'failed');
});

test('a cancelled protocol job keeps the real session id (M6)', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  await new Promise((r) => setTimeout(r, 500)); // past session/create
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
});

test('rate-limit ends failed with errorKind quota (transient retries disabled)', async () => {
  process.env.FAKE_APPSERVER_MODE = 'rate-limit';
  const { dir } = mkJob({ cwd: tempCwd(), max_transient_retries: 0 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'quota');
  // The fake's payload carries detail 'Model creation failed' next to the message.
  assert.equal(res.errorMessage, '429 rate limit | Model creation failed');
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

test('runTaskWithModel: error codes name the case, never the message (I2)', async () => {
  const cases = [
    ['nosendack', { requestTimeoutMs: 300 }, 'request_timeout', /session\/send timed out after 300 ms/],
    ['slowhang', { idleTimeoutMs: 300 }, 'idle', /no activity for 300 ms/],
    ['slowhang', { timeoutMs: 400 }, 'turn_timeout', /timed out after 400 ms/],
  ];
  for (const [mode, opts, code, message] of cases) {
    process.env.FAKE_APPSERVER_MODE = mode;
    await assert.rejects(
      runTaskWithModel({ binPath: fakeAppServer, cwd: tempCwd(), prompt: 'x', timeoutMs: 10000, ...opts }),
      (err) => {
        assert.ok(err instanceof AppServerError);
        assert.equal(err.code, code, mode);
        assert.match(err.message, message);
        assert.equal(err.startup, undefined, 'after session/send: not a startup error');
        assert.equal(err.sessionId, 'sess_fakeB1'); // M6
        return true;
      },
    );
  }
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
  // only the app-server group, not the runner
  assert.equal(safeSignal(st.childPgid, 'SIGKILL', { expectStart: st.childStart, group: true }), true);
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.timeoutKind, 'cancelled');
  assert.equal(readStatus(dir).state, 'cancelled');
});

test('secrets in the model output are redacted in result.json and output.log', async () => {
  process.env.FAKE_APPSERVER_MODE = 'secret';
  const cwd = tempCwd();
  const { dir } = mkJob({ cwd });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.ok(res.output.includes('[REDACTED]'));
  assert.ok(!res.output.includes('sk-abc123def456ghi789jkl'));
  const log = readFileSync(join(dir, 'output.log'), 'utf8');
  assert.ok(log.includes('[REDACTED]'));
  assert.ok(!log.includes('sk-abc123def456ghi789jkl'));
});

// --- job control: inbox, graceful cancel, needs_input ---

function logged(log) {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Status once onControl has fired (capabilities are written then).
const controlReady = (dir) => waitFor(() => (readStatus(dir)?.capabilities ? readStatus(dir) : null));

test('job-control constants', () => {
  assert.equal(STOP_GRACE_MS, 10000);
  assert.equal(DEFAULT_INPUT_TIMEOUT_MS, 1800000);
  assert.equal(INPUT_TIMEOUT_ANSWER, 'No answer available, decide yourself and continue');
});

test('an inbox entry on a running protocol job is sent as a steer and acked accepted', async () => {
  process.env.FAKE_APPSERVER_MODE = 'chatty';
  const cwd = tempCwd();
  const log = join(cwd, 'rx.log');
  process.env.FAKE_APPSERVER_LOG = log;
  const { dir } = mkJob({ cwd });
  const done = runJob(dir, { heartbeatMs: 50 });
  await controlReady(dir);
  const seq = writeInboxEntry(dir, { kind: 'send', text: 'use port 8080' });
  const t0 = Date.now();
  const ack = await waitFor(() => readAck(dir, seq), 2000);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(ack.status, 'accepted');
  await done;
  assert.equal(readResult(dir).state, 'completed');
  const cmd = logged(log).find((m) => m.method === 'v4/command');
  assert.ok(cmd, 'a steer was sent');
  assert.equal(cmd.params.payload.text, 'use port 8080');
  assert.equal(readStatus(dir).capabilities.steer, true);
});

test('a question parks the job in needs_input; an inbox entry answers it', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ask';
  const { dir } = mkJob({ cwd: tempCwd() });
  const patches = [];
  const done = runJob(dir, { heartbeatMs: 50, onStatus: (_s, patch) => patches.push(patch) });
  const st = await waitFor(() => (readStatus(dir)?.state === 'needs_input' ? readStatus(dir) : null));
  assert.equal(st.question, 'Which port?');
  const deadline = Date.parse(st.inputDeadline);
  assert.ok(Number.isFinite(deadline));
  assert.ok(deadline > Date.now() + DEFAULT_INPUT_TIMEOUT_MS - 60000, 'default input timeout');
  assert.equal(st.capabilities.userInput, true);
  const seq = writeInboxEntry(dir, { kind: 'send', text: '8080' });
  const ack = await waitFor(() => readAck(dir, seq), 2000);
  assert.equal(ack.status, 'accepted');
  await done;
  const back = patches.find((p) => p.state === 'running' && 'question' in p);
  assert.deepEqual({ question: back.question, inputDeadline: back.inputDeadline }, { question: null, inputDeadline: null });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.match(res.output, /8080/);
  const fin = readStatus(dir);
  assert.equal(fin.question, null);
  assert.equal(fin.inputDeadline, null);
});

test('an unanswered question is answered with the input-timeout text after input_timeout_ms', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ask';
  const { dir } = mkJob({ cwd: tempCwd(), input_timeout_ms: 300 });
  const states = [];
  await runJob(dir, { heartbeatMs: 50, onStatus: (_s, patch) => { if (patch.state) states.push(patch.state); } });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.ok(res.output.includes(INPUT_TIMEOUT_ANSWER));
  assert.ok(states.includes('needs_input'));
});

test('the status question is one line and redacted', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ask';
  process.env.FAKE_APPSERVER_ASK_QUESTION = JSON.stringify('key sk-abc123def456ghi789jkl\nnext   line');
  try {
    const { dir } = mkJob({ cwd: tempCwd(), input_timeout_ms: 300 });
    let question = null;
    await runJob(dir, { heartbeatMs: 50, onStatus: (_s, patch) => { if (patch.state === 'needs_input') question = patch.question; } });
    assert.equal(typeof question, 'string');
    assert.ok(!question.includes('\n'));
    assert.ok(!question.includes('sk-abc123def456ghi789jkl'));
    assert.match(question, /\[REDACTED\] next line$/);
  } finally {
    delete process.env.FAKE_APPSERVER_ASK_QUESTION;
  }
});

test('cancel on the protocol path sends session/stop first and ends cancelled with the session id', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const cwd = tempCwd();
  const log = join(cwd, 'rx.log');
  process.env.FAKE_APPSERVER_LOG = log;
  const { dir } = mkJob({ cwd });
  const done = runJob(dir, { heartbeatMs: 50 });
  await controlReady(dir);
  await waitFor(() => logged(log).some((m) => m.method === 'session/send'));
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  assert.ok(logged(log).some((m) => m.method === 'session/stop'), 'session/stop was sent');
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(readStatus(dir).capabilities.stop, true);
});

test('cancel without session/stop support falls back to the kill at once', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  process.env.FAKE_APPSERVER_UNSUPPORTED = 'stop';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await controlReady(dir);
  await new Promise((r) => setTimeout(r, 300)); // past session/send
  const t0 = Date.now();
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  assert.ok(Date.now() - t0 < 3000, 'killed without the grace wait');
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(readStatus(dir).capabilities.stop, false);
  await waitFor(() => !alive(st.childPid), 2000);
});

test('a stop that does not end the turn is followed by the kill after the grace period', async () => {
  // nosendack: session/stop is answered, but the unanswered session/send keeps
  // the task waiting, so only the grace timer ends it.
  process.env.FAKE_APPSERVER_MODE = 'nosendack';
  const cwd = tempCwd();
  const log = join(cwd, 'rx.log');
  process.env.FAKE_APPSERVER_LOG = log;
  const { dir } = mkJob({ cwd });
  const done = runJob(dir, { heartbeatMs: 50, stopGraceMs: 600 });
  await controlReady(dir);
  await waitFor(() => logged(log).some((m) => m.method === 'session/send'));
  const t0 = Date.now();
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const took = Date.now() - t0;
  assert.ok(took >= 600, `waited the grace period (${took} ms)`);
  assert.ok(took < 5000, `then killed (${took} ms)`);
  assert.ok(logged(log).some((m) => m.method === 'session/stop'));
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
  assert.equal(readStatus(dir).capabilities.stop, true);
});

test('cancel while needs_input ends the job cancelled', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ask';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  await waitFor(() => readStatus(dir)?.state === 'needs_input');
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.sessionId, 'sess_fakeB1');
  const st = readStatus(dir);
  assert.equal(st.state, 'cancelled');
});

test('an inbox entry written before the session exists is handled only once control is up', async () => {
  process.env.FAKE_APPSERVER_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  const seq = writeInboxEntry(dir, { kind: 'send', text: 'early note' });
  let ackedEarly = false;
  const done = runJob(dir, {
    heartbeatMs: 50,
    onStatus: (s) => { if (!s.capabilities && readAck(dir, seq)) ackedEarly = true; },
  });
  const ack = await waitFor(() => readAck(dir, seq), 5000);
  assert.equal(ack.status, 'accepted');
  await done;
  assert.equal(ackedEarly, false);
  assert.equal(readResult(dir).state, 'completed');
});

test('entries still pending when the job ends are acked rejected finished', async () => {
  process.env.FAKE_APPSERVER_MODE = 'die';
  const { dir } = mkJob({ cwd: tempCwd() });
  const seq = writeInboxEntry(dir, { kind: 'send', text: 'too late' });
  await runJob(dir);
  assert.equal(readResult(dir).state, 'failed');
  const ack = readAck(dir, seq);
  assert.equal(ack.status, 'rejected');
  assert.equal(ack.reason, 'finished');
});

test('without steer support an inbox entry is acked not_supported', async () => {
  process.env.FAKE_APPSERVER_MODE = 'chatty';
  process.env.FAKE_APPSERVER_UNSUPPORTED = 'steer';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  await controlReady(dir);
  const seq = writeInboxEntry(dir, { kind: 'send', text: 'hello' });
  const ack = await waitFor(() => readAck(dir, seq), 2000);
  assert.equal(ack.status, 'not_supported');
  await done;
  assert.equal(readStatus(dir).capabilities.steer, false);
});

test('redaction runs before the output cap: a key straddling the cap is not partly leaked', async () => {
  const { OUTPUT_CAP } = await import('../src/runner.mjs');
  process.env.FAKE_APPSERVER_MODE = 'ok';
  // The cap keeps 'sk-abc123def45' (11 chars after sk-): too short for the sk- rule on its own.
  process.env.FAKE_APPSERVER_RESPONSE = JSON.stringify('x'.repeat(OUTPUT_CAP - 15) + ' sk-abc123def456ghi789jkl tail');
  try {
    const { dir } = mkJob({ cwd: tempCwd() });
    await runJob(dir);
    const res = readResult(dir);
    assert.equal(res.state, 'completed');
    assert.ok(!res.output.includes('sk-abc'), 'partial key leaked past the cap: ' + res.output.slice(-120));
    assert.ok(res.output.includes('[REDACTED]'));
    assert.match(res.output, /output truncated at/);
  } finally {
    delete process.env.FAKE_APPSERVER_RESPONSE;
  }
});

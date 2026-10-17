// runTaskWithModel: continue the same session after a transient provider error.
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient, AppServerError, runTaskWithModel, DEFAULT_CONTINUE_PROMPT } from '../src/appserver.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const fakeBin = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));
const temps = [];
const ENV_KEYS = ['FAKE_APPSERVER_MODE', 'FAKE_APPSERVER_LOG', 'FAKE_APPSERVER_COUNTER', 'FAKE_APPSERVER_FAIL_TIMES', 'FAKE_APPSERVER_RETRY_AFTER', 'FAKE_APPSERVER_HANG_AFTER'];

afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
after(() => { for (const d of temps) removeDir(d); });

function setup(mode, extra = {}) {
  const cwd = makeTempDir('zcode-retry-');
  temps.push(cwd);
  const log = join(cwd, 'rx.log');
  Object.assign(process.env, { FAKE_APPSERVER_MODE: mode, FAKE_APPSERVER_LOG: log, FAKE_APPSERVER_COUNTER: join(cwd, 'sends'), ...extra });
  const sends = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.method === 'session/send') : []);
  return { cwd, sends };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Records the waits instead of sleeping.
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('recovers after one 429: the continue message goes into the same session with the same model', async () => {
  const { cwd, sends } = setup('fail-429-then-ok');
  const s = fakeSleep();
  const infos = [];
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'build it', providerId: 'glm-test', modelId: 'big', reasoningLevel: 'max', timeoutMs: 10000,
    transientRetry: { delaysMs: [1000, 2000], jitter: 0, sleep: s.sleep, onRetry: (i) => infos.push(i) },
  });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake model task done after 2 turn(s)');
  assert.equal(res.retryStop, null);
  assert.equal(res.retries.length, 1);
  assert.deepEqual(s.waits, [1000]);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].attempt, 1);
  assert.equal(infos[0].maxRetries, 6);
  assert.equal(infos[0].delayMs, 1000);
  assert.match(infos[0].reason, /1113/);
  assert.match(infos[0].at, /^\d{4}-\d\d-\d\dT/);
  const sent = sends();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].params.content, 'build it');
  assert.equal(sent[1].params.content, DEFAULT_CONTINUE_PROMPT);
  assert.equal(sent[1].params.sessionId, sent[0].params.sessionId);
  assert.deepEqual(sent[1].params.modelSelection, sent[0].params.modelSelection);
  assert.deepEqual(sent[1].params.modelSelection, { providerId: 'glm-test', modelId: 'big', options: { reasoningLevel: 'max' } });
});

test('the default continue prompt is the documented text', () => {
  assert.equal(DEFAULT_CONTINUE_PROMPT, 'The previous attempt was interrupted by a temporary provider error (rate limit or network). Continue the task exactly where you stopped. Do not redo work that is already finished; re-run the tests if you were in the middle of testing.');
});

test('recovers after three network failures; the delays walk the schedule', async () => {
  const { cwd, sends } = setup('fail-network-then-ok', { FAKE_APPSERVER_FAIL_TIMES: '3' });
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000,
    transientRetry: { delaysMs: [10, 20], jitter: 0, sleep: s.sleep, continuePrompt: 'go on' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.retries.length, 3);
  assert.deepEqual(res.retries.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(s.waits, [10, 20, 20]);
  assert.deepEqual(sends().map((m) => m.params.content), ['x', 'go on', 'go on', 'go on']);
});

test('stale event cursor: the wait after a continue never resolves with the old turn.failed', async () => {
  // One failure then success: a wait that matched the buffered turn.failed again
  // would burn every retry on the stale event and end failed.
  const { cwd, sends } = setup('fail-429-then-ok');
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000,
    transientRetry: { maxRetries: 3, delaysMs: [5], jitter: 0, sleep: s.sleep },
  });
  assert.equal(res.ok, true);
  assert.equal(sends().length, 2);
});

test('waitForEvent { since } skips buffered events up to that ordinal', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-429-then-ok';
  const cwd = makeTempDir('zcode-retry-');
  temps.push(cwd);
  const client = new AppServerClient({ binPath: fakeBin, cwd, timeoutMs: 5000 });
  try {
    await client.settle();
    const created = await client.request('session/create', { workspace: { workspacePath: cwd, workspaceKey: cwd } });
    const sessionId = created.session.sessionId;
    await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    assert.equal(client.eventOrdinal, 0);
    await client.request('session/send', { sessionId, content: 'x' });
    const first = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000 });
    assert.equal(first.type, 'turn.failed');
    // Without since the buffered (stale) event is returned again: existing behaviour.
    assert.equal(await client.waitForEvent('turn.failed', { timeoutMs: 1000 }), first);
    const cursor = client.eventOrdinal;
    assert.ok(cursor >= 3);
    await assert.rejects(
      client.waitForEvent('turn.failed', { timeoutMs: 300, since: cursor }),
      (err) => err.code === 'turn_timeout',
    );
    await client.request('session/send', { sessionId, content: 'continue' });
    const second = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
    assert.equal(second.type, 'turn.completed');
  } finally {
    await client.close();
  }
});

test('exhaustion returns the last real failure with the retry history', async () => {
  const { cwd, sends } = setup('fail-429-always');
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000,
    transientRetry: { maxRetries: 2, delaysMs: [5], jitter: 0, sleep: s.sleep },
  });
  assert.equal(res.ok, false);
  assert.equal(res.failed, true);
  assert.match(res.error.message, /\[1113\] Insufficient balance/);
  assert.equal(res.retries.length, 2);
  assert.equal(res.retryStop, 'exhausted');
  assert.equal(sends().length, 3);
});

for (const mode of ['fail-auth', 'fail-model-request-failed']) {
  test(`${mode} is not transient: exactly one session/send, no wait`, async () => {
    const { cwd, sends } = setup(mode);
    const s = fakeSleep();
    let retried = 0;
    const res = await runTaskWithModel({
      binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000,
      transientRetry: { delaysMs: [5], sleep: s.sleep, onRetry: () => { retried++; } },
    });
    assert.equal(res.ok, false);
    assert.equal(res.retries.length, 0);
    assert.equal(res.retryStop, null);
    assert.equal(retried, 0);
    assert.deepEqual(s.waits, []);
    assert.equal(sends().length, 1);
  });
}

test('maxRetries 0 disables the retry', async () => {
  const { cwd, sends } = setup('fail-429-then-ok');
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000, transientRetry: { maxRetries: 0, sleep: s.sleep },
  });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /1113/);
  assert.equal(res.retryStop, null);
  assert.equal(sends().length, 1);
});

test('a numeric retry-after replaces the scheduled delay, capped at the largest delay', async () => {
  const { cwd } = setup('fail-429-then-ok', { FAKE_APPSERVER_FAIL_TIMES: '2', FAKE_APPSERVER_RETRY_AFTER: '3' });
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000,
    transientRetry: { delaysMs: [100, 3500], jitter: 0.1, sleep: s.sleep },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(s.waits, [3000, 3000]);
  const capped = setup('fail-429-then-ok', { FAKE_APPSERVER_FAIL_TIMES: '1', FAKE_APPSERVER_RETRY_AFTER: '60' });
  const s2 = fakeSleep();
  await runTaskWithModel({
    binPath: fakeBin, cwd: capped.cwd, prompt: 'x', timeoutMs: 10000,
    transientRetry: { delaysMs: [100, 2000], jitter: 0, sleep: s2.sleep },
  });
  assert.deepEqual(s2.waits, [2000]);
});

test('a backoff past the deadline is not started: the last failure is returned', async () => {
  const { cwd, sends } = setup('fail-429-always');
  const s = fakeSleep();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 3000,
    transientRetry: { delaysMs: [100, 5000], jitter: 0, sleep: s.sleep },
  });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /1113/);
  assert.equal(res.retryStop, 'deadline');
  assert.deepEqual(s.waits, [100], 'the 5 s backoff would pass the 3 s deadline');
  assert.equal(sends().length, 2);
});

test('real backoffs inside the deadline: the task recovers', async () => {
  const { cwd } = setup('fail-429-then-ok', { FAKE_APPSERVER_FAIL_TIMES: '2' });
  const t0 = Date.now();
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 1500, idleTimeoutMs: 100000,
    transientRetry: { delaysMs: [400], jitter: 0 },
  });
  assert.equal(res.ok, true, 'recovered within the deadline');
  assert.ok(Date.now() - t0 >= 800);
});

test('the job deadline caps the wait after a continue (turn_timeout names timeout_ms)', async () => {
  const { cwd } = setup('fail-429-always', { FAKE_APPSERVER_HANG_AFTER: '1' });
  const t0 = Date.now();
  await assert.rejects(
    runTaskWithModel({
      binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 1500, idleTimeoutMs: 100000,
      transientRetry: { delaysMs: [400], jitter: 0 },
    }),
    (err) => {
      assert.equal(err.code, 'turn_timeout');
      assert.match(err.message, /timed out after 1500 ms/);
      assert.equal(err.retries.length, 1);
      return true;
    },
  );
  const took = Date.now() - t0;
  assert.ok(took < 1500 + 1200, `the deadline counts from the first send, backoff included (took ${took} ms)`);
});

test('the idle timer is not armed during a backoff longer than the idle limit', async () => {
  const { cwd } = setup('fail-429-then-ok');
  const res = await runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 10000, idleTimeoutMs: 300,
    transientRetry: { delaysMs: [900], jitter: 0 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.retries.length, 1);
});

test('cancel during the backoff rejects aborted promptly, clears the timer and leaves no process', async () => {
  const { cwd } = setup('fail-429-always');
  const ctl = new AbortController();
  let pid = null;
  const t0 = Date.now();
  const p = runTaskWithModel({
    binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 0, killGroup: true, signal: ctl.signal,
    onSpawn: (c) => { pid = c.pid; },
    transientRetry: { delaysMs: [60000], jitter: 0, onRetry: () => setTimeout(() => ctl.abort(), 50) },
  });
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof AppServerError);
    assert.equal(err.code, 'aborted');
    assert.equal(err.sessionId, 'sess_fakeB1');
    assert.equal(err.retries.length, 1);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, 'ended well before the 60 s backoff');
  assert.equal(alive(pid), false);
});

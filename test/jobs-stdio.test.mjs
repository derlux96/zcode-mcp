// Stage 2 of the test strategy: protocol and job lifecycle through real stdio
// servers, real detached job runners and the fake zcode / app-server.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { TestScope, fakeAppserverBin, assertNoLeftoverProcesses, waitFor, sleep } from './helpers.mjs';

let scope;
const fresh = () => { scope = new TestScope(); return scope; };
afterEach(async () => {
  if (scope) { const s = scope; scope = null; await s.cleanup(); }
});

const jobIdOf = (text) => {
  const m = /job_id: (job_[0-9a-z]+_[0-9a-f]{6})/.exec(text);
  assert.ok(m, `no job_id in: ${text}`);
  return m[1];
};
const blockingIdOf = (text) => (/blocking_job_id: (job_\S+)/.exec(text) || [])[1];

async function startJob(s, client, args) {
  const r = await client.callTool('zcode_run', { wait_ms: 0, mode: 'yolo', prompt: 'task', ...args });
  assert.equal(r.isError, false, r.text);
  return s.track(jobIdOf(r.text));
}

const awaitState = (client, jobId, state, timeoutMs = 20000) => waitFor(async () => {
  const r = await client.callTool('zcode_result', { job_id: jobId });
  return r.text.startsWith(`status: ${state}`) ? r : null;
}, { timeoutMs, intervalMs: 150, what: `job ${jobId} to be ${state}` });

test('kill -9 of the server mid-job still ends the job and the result is retrievable after restart', async () => {
  const s = fresh();
  const cwd = s.cwd();
  const a = s.client({ FAKE_ZCODE_MODE: 'slow-start' });
  await a.initialize();
  const jobId = await startJob(s, a, { cwd });
  a.kill('SIGKILL');
  await a.exited;
  const b = s.client({ FAKE_ZCODE_MODE: 'slow-start' });
  await b.initialize();
  const done = await awaitState(b, jobId, 'completed');
  assert.match(done.text, /sess_slow001/);
  assert.match(done.text, /slow start done/);
});

test('closing stdin does not kill a running job', async () => {
  const s = fresh();
  const a = s.client({ FAKE_ZCODE_MODE: 'chatty' });
  await a.initialize();
  const jobId = await startJob(s, a, { cwd: s.cwd() });
  a.closeStdin();
  const exit = await Promise.race([a.exited, sleep(5000).then(() => null)]);
  assert.ok(exit, 'server did not exit after stdin closed');
  assert.equal(exit.code, 0);
  const b = s.client();
  await b.initialize();
  const done = await awaitState(b, jobId, 'completed');
  assert.match(done.text, /sess_chatty1/);
});

test('two servers starting a job in the same cwd: exactly one wins', async () => {
  for (let round = 0; round < 5; round++) {
    const s = fresh();
    const cwd = s.cwd();
    const a = s.client({ FAKE_ZCODE_MODE: 'silent' });
    const b = s.client({ FAKE_ZCODE_MODE: 'silent' });
    await Promise.all([a.initialize(), b.initialize()]);
    const args = { prompt: 'race', cwd, mode: 'yolo', wait_ms: 0 };
    const results = await Promise.all([a.callTool('zcode_run', args), b.callTool('zcode_run', args)]);
    const winners = results.filter((r) => !r.isError);
    const losers = results.filter((r) => r.isError);
    assert.equal(winners.length, 1, `round ${round}: ${results.map((r) => r.text).join(' || ')}`);
    assert.equal(losers.length, 1, `round ${round}`);
    const winner = s.track(jobIdOf(winners[0].text));
    assert.equal(blockingIdOf(losers[0].text), winner, losers[0].text);
    const cancelled = await a.callTool('zcode_cancel', { job_id: winner });
    assert.match(cancelled.text, /^status: cancelled/);
    const { cleanup } = s;
    scope = null;
    await cleanup.call(s);
  }
});

test('four parallel zcode_run calls in different cwds: three run, one is rejected', async () => {
  const s = fresh();
  const a = s.client({ FAKE_ZCODE_MODE: 'silent' });
  await a.initialize();
  const results = await Promise.all([0, 1, 2, 3].map(() => a.callTool('zcode_run', { prompt: 'cap', cwd: s.cwd(), mode: 'yolo', wait_ms: 0 })));
  const ok = results.filter((r) => !r.isError);
  const rejected = results.filter((r) => r.isError);
  for (const r of ok) s.track(jobIdOf(r.text));
  assert.equal(ok.length, 3, results.map((r) => r.text).join(' || '));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].text, /too many running jobs/);
});

test('malformed JSON line and unknown method keep the server alive', async () => {
  const s = fresh();
  const a = s.client();
  await a.initialize();
  a.writeRaw('this is not json {');
  a.writeRaw('{"truncated": ');
  a.writeRaw(JSON.stringify({ jsonrpc: '2.0', foo: 'bar' })); // object without id: a notification
  await assert.rejects(a.request('no/such/method', {}), (e) => e.code === -32601);
  const unknownTool = await a.request('tools/call', { name: 'zcode_nope', arguments: {} }).then(
    (r) => ({ r }), (e) => ({ e }),
  );
  assert.ok(unknownTool.e ? unknownTool.e.code === -32602 || unknownTool.e.code === -32601 : unknownTool.r.isError === true, JSON.stringify(unknownTool));
  const check = await a.callTool('zcode_check', {});
  assert.equal(check.isError, false, check.text);
  assert.equal(a.hasExited, undefined);
  assert.ok(a.messages.some((m) => m.error && m.id === null && m.error.code === -32700), 'parse errors are answered');
});

test('the helper detects a leftover process carrying a marker', async () => {
  const marker = `zcode-leftover-marker-${process.pid}-${Date.now()}`;
  const child = spawn('sh', ['-c', `sleep 30; true # ${marker}`], { stdio: 'ignore' });
  try {
    await assert.rejects(assertNoLeftoverProcesses([marker], { timeoutMs: 300 }), (e) => e.message.includes(marker) && e.message.includes('sleep 30'));
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
  }
  await assertNoLeftoverProcesses([marker]);
});

test('notifications/cancelled while zcode_run waits: no response is emitted and the job continues', async () => {
  const s = fresh();
  const a = s.client({ FAKE_ZCODE_MODE: 'chatty' });
  await a.initialize();
  const { id, promise } = a.requestWithId('tools/call', {
    name: 'zcode_run', arguments: { prompt: 'wait', cwd: s.cwd(), mode: 'yolo', wait_ms: 60000 },
  }, { timeoutMs: 3000 });
  promise.catch(() => {});
  const jobId = s.track(await waitFor(async () => {
    const list = await a.callTool('zcode_status', {});
    return (/(job_[0-9a-z]+_[0-9a-f]{6})/.exec(list.text) || [])[1];
  }, { what: 'job to appear' }));
  a.notify('notifications/cancelled', { requestId: id });
  await assert.rejects(promise, /timed out/); // 3 s, well past the chatty job's end
  assert.ok(!a.messages.some((m) => m.id === id), 'a cancelled request gets no response');
  const done = await awaitState(a, jobId, 'completed');
  assert.match(done.text, /sess_chatty1/);
});

test("a second server sees the first server's jobs in zcode_status", async () => {
  const s = fresh();
  const a = s.client({ FAKE_ZCODE_MODE: 'silent' });
  const b = s.client({ FAKE_ZCODE_MODE: 'silent' });
  await Promise.all([a.initialize(), b.initialize()]);
  const jobId = await startJob(s, a, { cwd: s.cwd() });
  await waitFor(async () => (await b.callTool('zcode_status', { job_id: jobId })).text.startsWith('status: running'), { what: 'job to run' });
  const list = await b.callTool('zcode_status', {});
  assert.match(list.text, new RegExp(`${jobId} \\| (starting|running)`));
  const one = await b.callTool('zcode_status', { job_id: jobId });
  assert.match(one.text, /^status: running/);
  const cancelled = await b.callTool('zcode_cancel', { job_id: jobId });
  assert.match(cancelled.text, /^status: cancelled/);
});

test("a job started by a killed server shows lost after its runner is killed, and the next server's reaper finalizes it", async () => {
  const s = fresh();
  const a = s.client({ FAKE_ZCODE_MODE: 'silent' });
  await a.initialize();
  const jobId = await startJob(s, a, { cwd: s.cwd() });
  const st = await waitFor(() => { const x = s.jobStatus(jobId); return x && Number.isInteger(x.childPgid) && Number.isInteger(x.pid) ? x : null; }, { what: 'runner and child pids' });
  a.kill('SIGKILL');
  await a.exited;
  process.kill(st.pid, 'SIGKILL');
  process.kill(-st.childPgid, 'SIGKILL');
  const b = s.client({ FAKE_ZCODE_MODE: 'silent' });
  await b.initialize();
  const status = await b.callTool('zcode_status', { job_id: jobId });
  assert.match(status.text, /^status: lost/, status.text);
  const result = await b.callTool('zcode_result', { job_id: jobId });
  assert.match(result.text, /^status: lost/);
  assert.equal(result.isError, true);
  await waitFor(() => (s.jobStatus(jobId) || {}).state === 'lost', { what: 'reaper to record lost' });
});

test('protocol-path job end to end through stdio', async () => {
  const s = fresh();
  const a = s.client({ ZCODE_APPSERVER_BIN: fakeAppserverBin });
  await a.initialize();
  const r = await a.callTool('zcode_run', { prompt: 'protocol task', cwd: s.cwd(), wait_ms: 5000 });
  s.track(jobIdOf(r.text));
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^status: completed \(protocol\)/);
  assert.match(r.text, /sess_/);
  assert.match(r.text, /fake model task done/);
});

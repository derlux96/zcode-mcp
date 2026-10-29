// AppServerClient and runTaskWithModel against an in-process fake child
// (spawnFn): exact control over the wire, timing and process state, and no
// real process is ever spawned or signalled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  AppServerClient,
  AppServerError,
  runTaskWithModel,
  resolveModel,
  entryReasoningLevels,
} from '../src/appserver.mjs';
import { makeTempDir, removeDir, sleep } from './helpers.mjs';

// Above Linux's pid_max: should a kill path ever signal it (as a group), the
// kernel answers ESRCH and nothing real is hit.
const FAKE_PID = 999999999;

class FakeChild extends EventEmitter {
  constructor({ pid = FAKE_PID, onMessage = null, exitOnKill = true } = {}) {
    super();
    this.pid = pid;
    this.signals = [];
    this.received = [];
    this.exitOnKill = exitOnKill;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let buf = '';
    this.stdin = new Writable({
      write: (chunk, enc, cb) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          this.received.push(msg);
          if (onMessage) onMessage(msg, this);
        }
        cb();
      },
    });
  }

  send(obj) { this.stdout.write(`${JSON.stringify(obj)}\n`); }

  raw(text) { this.stdout.write(text); }

  event(params) { this.send({ method: 'session/event', params }); }

  kill(sig) {
    this.signals.push(sig);
    if (this.exitOnKill) this.exit(null, sig);
    return true;
  }

  exit(code = 0, signal = null) {
    if (this.gone) return;
    this.gone = true;
    setImmediate(() => this.emit('close', code, signal));
  }
}

function clientWith(child, opts = {}) {
  const spawned = [];
  const client = new AppServerClient({
    binPath: '/fake/zcode',
    cwd: '/fake/cwd',
    timeoutMs: 2000,
    spawnFn: (cmd, args, o) => { spawned.push({ cmd, args, opts: o }); return child; },
    ...opts,
  });
  return { client, spawned };
}

// Settles a promise against a deadline: 'pending' when it is still open then.
async function within(promise, ms) {
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r({ state: 'pending' }), ms); });
  try {
    return await Promise.race([
      promise.then((value) => ({ state: 'resolved', value }), (error) => ({ state: 'rejected', error })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// --- resolveModel / entryReasoningLevels ---

test('resolveModel: a blank spec never matches, even an entry with an empty modelId', () => {
  const catalog = [{ ref: { providerId: 'p', modelId: '' } }, { ref: { providerId: 'q', modelId: '/' } }];
  assert.equal(resolveModel(catalog, ''), null);
  assert.equal(resolveModel(catalog, '  '), null);
  assert.equal(resolveModel(catalog, '/'), null);
});

test('resolveModel: a slash at either end is part of a plain modelId; a one-letter provider still splits', () => {
  const catalog = [
    { ref: { providerId: 'p', modelId: '/lead' } },
    { ref: { providerId: 'q', modelId: 'trail/' } },
    { ref: { providerId: '', modelId: 'lead' } },
    { ref: { providerId: 'trail', modelId: '' } },
    { ref: { providerId: 'a', modelId: 'm' } },
    { ref: { providerId: 'z', modelId: 'a/m' } },
  ];
  assert.deepEqual(resolveModel(catalog, '/lead'), { providerId: 'p', modelId: '/lead' });
  assert.deepEqual(resolveModel(catalog, 'trail/'), { providerId: 'q', modelId: 'trail/' });
  assert.deepEqual(resolveModel(catalog, 'a/m'), { providerId: 'a', modelId: 'm' });
});

test('entryReasoningLevels: strings and {value} strings in order; null and other entries are skipped', () => {
  const entry = { reasoning: { levels: [null, 'low', { value: 'medium' }, { value: 5 }, { label: 'x' }, 7, { value: 'xhigh' }] } };
  assert.deepEqual(entryReasoningLevels(entry), ['low', 'medium', 'xhigh']);
  assert.deepEqual(entryReasoningLevels({ reasoning: { levels: [{ value: 'low', label: 'Low' }] } }), ['low']);
  assert.deepEqual(entryReasoningLevels(null), []);
});

// --- constructor ---

test('constructor: binPath and cwd must be non-empty strings (nothing is spawned)', () => {
  let spawns = 0;
  const spawnFn = () => { spawns += 1; return new FakeChild(); };
  for (const bad of [{ binPath: '', cwd: '/c' }, { cwd: '/c' }, { binPath: '/b', cwd: '' }, { binPath: '/b' }]) {
    assert.throws(() => new AppServerClient({ ...bad, spawnFn }), TypeError);
  }
  assert.equal(spawns, 0);
});

test('constructor: without killGroup the child is not detached; with it, it is', async () => {
  const plain = clientWith(new FakeChild());
  assert.equal(plain.spawned[0].opts.detached, undefined);
  await plain.client.close();
  const group = clientWith(new FakeChild(), { killGroup: true });
  assert.equal(group.spawned[0].opts.detached, true);
  group.client.child.exit(); // gone before close: close() does not signal the fake pid as a live child
  await group.client.exited;
});

test('onSpawn is called with the child only when it has a pid', async () => {
  const seen = [];
  const a = new FakeChild();
  const { client } = clientWith(a, { onSpawn: (c) => seen.push(c) });
  assert.deepEqual(seen, [a]);
  await client.close();
  const b = new FakeChild();
  b.pid = undefined; // a failed spawn has no pid
  const second = clientWith(b, { onSpawn: (c) => seen.push(c) });
  assert.equal(seen.length, 1);
  await second.client.close();
});

// --- wire handling ---

test('request ids start at 1 and count up', async () => {
  const child = new FakeChild({ onMessage: (m, c) => c.send({ id: m.id, result: { echo: m.id } }) });
  const { client } = clientWith(child);
  assert.deepEqual(await client.request('a/b', {}), { echo: 1 });
  assert.deepEqual(await client.request('a/b', {}), { echo: 2 });
  assert.deepEqual(child.received.map((m) => m.id), [1, 2]);
  await client.close();
});

test('stdout: empty lines, null, primitives and arrays are skipped; the next line still counts', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  const p = client.request('a/b', {});
  child.raw('\n\n');
  child.raw('null\n5\n"text"\n[1,2]\n');
  child.raw(`${JSON.stringify({ id: 1, result: 'ok' })}\n`);
  assert.equal(await p, 'ok');
  await client.close();
});

test('an error response keeps a falsy error.data as is', async () => {
  const child = new FakeChild({ onMessage: (m, c) => c.send({ id: m.id, error: { code: -1, message: 'no', data: 0 } }) });
  const { client } = clientWith(child);
  await assert.rejects(client.request('a/b', {}), (err) => err instanceof AppServerError && err.code === -1 && err.data === 0);
  await client.close();
});

test('only session/event notifications with object params become events', async () => {
  const seen = [];
  const child = new FakeChild();
  const { client } = clientWith(child, { onEvent: (p) => seen.push(p) });
  child.send({ method: 'startup/storageState', params: { type: 'turn.completed' } });
  child.send({ method: 'session/event', params: 5 });
  child.send({ method: 'session/event', params: 'turn.completed' });
  child.send({ method: 'session/event', params: null });
  child.event({ type: 'turn.started' });
  await client.waitForEvent('turn.started', { timeoutMs: 1000 });
  assert.deepEqual(seen, [{ type: 'turn.started' }]);
  assert.equal(client.eventOrdinal, 1);
  await client.close();
});

test('a requestUserInput with non-object params is parked with params {}', async () => {
  const asked = [];
  const child = new FakeChild();
  const { client } = clientWith(child, { onUserInput: (req) => asked.push(req) });
  child.send({ id: 'ask-1', method: 'interaction/requestUserInput', params: 'Which port?' });
  child.event({ type: 'turn.started' });
  await client.waitForEvent('turn.started', { timeoutMs: 1000 });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].params, {});
  assert.deepEqual(client.parkedUserInput, [{ protocolId: 'ask-1', params: {} }]);
  await client.close();
});

test('request({timeoutMs: 0}) times out at once instead of using the client default', async () => {
  const { client } = clientWith(new FakeChild(), { timeoutMs: 30000 });
  const r = await within(client.request('a/b', {}, { timeoutMs: 0 }), 1000);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 'request_timeout');
  await client.close();
});

// --- waitForEvent ---

test('waitForEvent finds the first buffered event (index 0)', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  child.event({ type: 'turn.completed', n: 1 });
  child.event({ type: 'model.streaming' });
  await client.waitForEvent('model.streaming', { timeoutMs: 1000 });
  const r = await within(client.waitForEvent('turn.completed', { timeoutMs: 0 }), 500);
  assert.deepEqual(r, { state: 'resolved', value: { type: 'turn.completed', n: 1 } });
  await client.close();
});

test('waitForEvent rejects at once once the child exited (not closed) or the client is closing (child alive)', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  child.exit(1);
  await client.exited;
  const r = await within(client.waitForEvent('turn.completed', { timeoutMs: 0 }), 500);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 'child_exited');
  await client.close();

  const stubborn = new FakeChild({ exitOnKill: false });
  const second = clientWith(stubborn);
  const closing = second.client.close();
  const w = await within(second.client.waitForEvent('turn.completed', { timeoutMs: 0 }), 500);
  assert.equal(w.state, 'rejected');
  assert.equal(w.error.code, 'closed');
  const q = await within(second.client.request('a/b', {}), 500);
  assert.equal(q.state, 'rejected');
  assert.equal(q.error.code, 'closed');
  assert.equal(stubborn.received.length, 0, 'nothing is sent while closing');
  stubborn.exit();
  await closing;
});

test('waitForEvent({timeoutMs: 1}) is a 1 ms cap, not "no cap"', async () => {
  const { client } = clientWith(new FakeChild());
  const r = await within(client.waitForEvent('turn.completed', { timeoutMs: 1 }), 1000);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 'turn_timeout');
  await client.close();
});

test('the idle timer fires when nothing is parked', async () => {
  const { client } = clientWith(new FakeChild());
  const r = await within(client.waitForEvent('turn.completed', { timeoutMs: 0, idleTimeoutMs: 50 }), 1000);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 'idle');
  await client.close();
});

test('a finished wait leaves no idle timer behind when more traffic arrives', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  const timers = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;
  const p = client.waitForEvent('turn.completed', { timeoutMs: 0, idleTimeoutMs: 60000 });
  child.event({ type: 'turn.completed' });
  await p;
  const before = timers();
  child.event({ type: 'model.streaming' });
  await client.waitForEvent('model.streaming', { timeoutMs: 0 });
  assert.equal(timers(), before);
  await client.close();
});

// --- settle ---

test('settle waits for a quiet window after the last line', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  const t0 = Date.now();
  setTimeout(() => child.send({ method: 'startup/storageState', params: {} }), 40);
  await client.settle({ quietMs: 120, maxMs: 2000 });
  assert.ok(Date.now() - t0 >= 150, `settled after ${Date.now() - t0} ms`);
  await client.close();
});

test('settle is capped by maxMs while the child keeps talking, and returns at once when it exited', async () => {
  const child = new FakeChild();
  const { client } = clientWith(child);
  const chatter = setInterval(() => child.send({ method: 'startup/storageState', params: {} }), 10);
  try {
    const t0 = Date.now();
    const r = await within(client.settle({ quietMs: 100, maxMs: 200 }), 1500);
    assert.equal(r.state, 'resolved');
    assert.ok(Date.now() - t0 >= 190, `settled after ${Date.now() - t0} ms`);
  } finally {
    clearInterval(chatter);
  }
  child.exit();
  await client.exited;
  const r = await within(client.settle({ quietMs: 5000, maxMs: 5000 }), 500);
  assert.equal(r.state, 'resolved');
  await client.close();
});

// --- runTaskWithModel against a scripted child ---

// Answers create/subscribe/send; every send ends in turn.failed with
// errors[n] (the last one repeats) unless `script.stop` answers session/stop.
function scriptedChild({ errors = [{ message: 'boom' }], stop = null } = {}) {
  let sends = 0;
  return new FakeChild({
    onMessage: (m, c) => {
      if (m.method === 'session/create') {
        c.send({ id: m.id, result: { session: { sessionId: 's1' }, settings: { model: { current: { providerId: 'p', modelId: 'm' }, available: [] } } } });
      } else if (m.method === 'session/subscribe') {
        c.send({ id: m.id, result: {} });
      } else if (m.method === 'session/send') {
        const error = errors[Math.min(sends, errors.length - 1)];
        sends += 1;
        c.send({ id: m.id, result: {} });
        if (error) setImmediate(() => c.event({ type: 'turn.failed', payload: { error } }));
      } else if (m.method === 'session/stop' && stop) {
        c.send({ id: m.id, ...stop });
      } else if (m.id !== undefined) {
        c.send({ id: m.id, result: {} });
      }
    },
  });
}

async function runScripted(child, opts = {}) {
  const cwd = makeTempDir();
  try {
    return await runTaskWithModel({ binPath: '/fake/zcode', cwd, prompt: 'go', timeoutMs: 0, spawnFn: () => child, ...opts });
  } finally {
    removeDir(cwd);
  }
}

test('the returned turn error keeps a falsy code', async () => {
  const res = await runScripted(scriptedChild({ errors: [{ code: 0, message: 'x' }] }), { transientRetry: { maxRetries: 0 } });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 0);
});

test('stop(): -32601 with any message, or "unknown method" with any code, means not_supported', async () => {
  for (const error of [{ code: -32601, message: 'nope' }, { code: -32000, message: 'Unknown method session/stop' }]) {
    let control;
    const child = scriptedChild({ errors: [null], stop: { error } });
    const run = runScripted(child, { onControl: (c) => { control = c; } });
    while (!child.received.some((m) => m.method === 'session/send')) await sleep(5);
    assert.equal(await control.stop(), 'not_supported');
    assert.equal(control.capabilities.stop, false);
    child.event({ type: 'turn.completed', payload: { response: 'done' } });
    assert.equal((await run).ok, true);
  }
});

const transient = () => ({ transient: true, klass: 'test' });

async function firstRetry(transientRetry) {
  const delays = [];
  const res = await runScripted(scriptedChild(), {
    transientRetry: { classify: transient, sleep: async () => {}, onRetry: (r) => delays.push(r.delayMs), ...transientRetry },
  });
  return { res, delays };
}

test('retry options: an empty or non-array delaysMs falls back to the default delays', async () => {
  for (const delaysMs of [[], '100']) {
    const { delays } = await firstRetry({ maxRetries: 1, delaysMs, jitter: 0 });
    assert.deepEqual(delays, [30000], `delaysMs ${JSON.stringify(delaysMs)}`);
  }
});

test('retry options: a delay of 0 is valid', async () => {
  const { delays } = await firstRetry({ maxRetries: 2, delaysMs: [0], jitter: 0 });
  assert.deepEqual(delays, [0, 0]);
});

test('retry options: a negative maxRetries falls back to the default (6)', async () => {
  const { res, delays } = await firstRetry({ maxRetries: -1, delaysMs: [1], jitter: 0 });
  assert.equal(delays.length, 6);
  assert.equal(res.retryStop, 'exhausted');
});

test('retry options: a non-finite jitter falls back to 0.1', async () => {
  const { delays } = await firstRetry({ maxRetries: 1, delaysMs: [1000], jitter: Infinity });
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 900 && delays[0] <= 1100, `delay ${delays[0]}`);
});

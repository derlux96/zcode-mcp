import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  AppServerClient,
  AppServerError,
  runTaskWithModel,
  resolveModel,
  resolveReasoningLevel,
  resolveBin,
  getModelCatalog,
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../src/appserver.mjs';
import { DEFAULT_TIMEOUT_MS } from '../src/runner.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const fakeBin = new URL('./fake-appserver.cjs', import.meta.url).pathname;

const createParams = (cwd) => ({ workspace: { workspacePath: cwd, workspaceKey: cwd } });

async function withMode(mode, fn) {
  const prev = process.env.FAKE_APPSERVER_MODE;
  process.env.FAKE_APPSERVER_MODE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FAKE_APPSERVER_MODE;
    else process.env.FAKE_APPSERVER_MODE = prev;
  }
}

// --- runTaskWithModel end-to-end against the fake ---

test('runTaskWithModel happy path: sessionId, response, and exact wire params', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const res = await runTaskWithModel({
        binPath: fakeBin,
        cwd,
        prompt: 'say hi',
        providerId: 'glm-test',
        modelId: 'small',
        reasoningLevel: 'low',
        timeoutMs: 5000,
      });
      assert.equal(res.ok, true);
      assert.equal(res.sessionId, 'sess_fakeB1');
      assert.equal(res.response, 'fake model task done');
      assert.equal(res.failed, false);
      assert.equal(res.error, null);
      assert.ok(Array.isArray(res.catalog), 'catalog rides along for callers');

      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const create = received.find((m) => m.method === 'session/create');
      assert.deepEqual(create.params.workspace, { workspacePath: cwd, workspaceKey: cwd });
      const subscribe = received.find((m) => m.method === 'session/subscribe');
      assert.deepEqual(subscribe.params, { sessionId: 'sess_fakeB1', deliveryKind: 'desktop-continuous' });
      const send = received.find((m) => m.method === 'session/send');
      assert.equal(send.params.sessionId, 'sess_fakeB1');
      assert.equal(send.params.content, 'say hi');
      assert.deepEqual(send.params.modelSelection, {
        providerId: 'glm-test',
        modelId: 'small',
        options: { reasoningLevel: 'low' },
      });
      // Unknown server-initiated requests are answered with {id, result:{}}
      // (notes §2: the auth-header probe arrives at send; any answer is fine).
      const authAnswer = received.find((m) => m.id === 'server-3');
      assert.deepEqual(authAnswer, { id: 'server-3', result: {} });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('turn.failed maps to ok:false with the payload error', async () => {
  await withMode('fail', async () => {
    const cwd = makeTempDir();
    try {
      const res = await runTaskWithModel({
        binPath: fakeBin,
        cwd,
        prompt: 'x',
        providerId: 'glm-test',
        modelId: 'small',
        timeoutMs: 5000,
      });
      assert.equal(res.ok, false);
      assert.equal(res.failed, true);
      assert.equal(res.sessionId, 'sess_fakeB1');
      assert.equal(res.response, null);
      assert.equal(res.error.code, 'model_not_found');
      assert.equal(res.error.message, 'fake model failure');
    } finally {
      removeDir(cwd);
    }
  });
});

test('slowhang: the turn wait times out and rejects', async () => {
  await withMode('slowhang', async () => {
    const cwd = makeTempDir();
    try {
      await assert.rejects(
        runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', providerId: 'glm-test', modelId: 'small', timeoutMs: 400 }),
        /timed out/i,
      );
    } finally {
      removeDir(cwd);
    }
  });
});

// --- the bidirectional server-request trap ---

test('the fake enforces the trap: a silent client gets the connection failed', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    let child;
    try {
      // A raw client that sends session/create but never answers the
      // server-initiated request: the fake must fail the connection within
      // its 2 s enforcement window (mirrors the real 15 s server timeout).
      child = spawn(process.execPath, [fakeBin, 'app-server', '--stdio'], { cwd });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'session/create', params: createParams(cwd) })}\n`);
      const race = await Promise.race([
        exited.then((code) => ({ code })),
        new Promise((r) => setTimeout(() => r({ code: null, slow: true }), 4000)),
      ]);
      assert.ok(!race.slow, 'fake should have failed the connection within 2 s');
      assert.notEqual(race.code, 0);
      assert.match(stderr, /unanswered/);
    } finally {
      if (child) child.kill('SIGKILL');
      removeDir(cwd);
    }
  });
});

test('AppServerClient answers the trap: session/create completes with id and catalog', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      const created = await client.request('session/create', createParams(cwd));
      assert.equal(created.session.sessionId, 'sess_fakeB1');
      assert.ok(Array.isArray(created.settings.model.available));
      assert.ok(created.settings.model.available.some((e) => e.ref.providerId === 'glm-test' && e.ref.modelId === 'small'));
      assert.equal(client.events.length, 0, 'no session/event before subscribe/send');
    } finally {
      await client.close();
      assert.equal(client.isRunning(), false);
      removeDir(cwd);
    }
  });
});

// --- client lifecycle: timeout, kill, child death ---

test('waitForEvent times out without killing the child; close() then kills it', async () => {
  await withMode('slowhang', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await client.request('session/create', createParams(cwd));
      await client.request('session/subscribe', { sessionId: 'sess_fakeB1', deliveryKind: 'desktop-continuous' });
      await assert.rejects(client.waitForEvent('turn.completed', { timeoutMs: 300 }), /timed out/);
      assert.equal(client.isRunning(), true, 'a wait timeout alone must not kill the child');
      await client.close();
      assert.equal(client.isRunning(), false);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('event buffer saturation does not blind live waiters (2005 events before turn.completed)', async () => {
  await withMode('flood', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await client.request('session/create', createParams(cwd));
      await client.request('session/subscribe', { sessionId: 'sess_fakeB1', deliveryKind: 'desktop-continuous' });
      // The waiter must be live while the flood streams: send triggers 2005
      // model.streaming events before turn.completed, pushing the buffer past
      // its cap into shift-on-push — the condition that used to strand
      // waiters whose scan start pinned at the cap.
      const ack = client.request('session/send', { sessionId: 'sess_fakeB1', content: 'flood me' });
      const event = await client.waitForEvent('turn.completed', { timeoutMs: 5000 });
      await ack;
      assert.equal(event.type, 'turn.completed');
      assert.equal(event.payload.response, 'fake model task done');
      // Saturation actually held: buffer capped at 2000, oldest dropped,
      // turn.completed is the newest entry. 2005 flood + 3 turn events -
      // 2000 cap = 8 dropped, so evt_flood_8 is the oldest survivor.
      assert.equal(client.events.length, 2000);
      assert.equal(client.events[client.events.length - 1].type, 'turn.completed');
      assert.equal(client.events[0].eventId, 'evt_flood_8');
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('child death mid-request rejects cleanly', async () => {
  await withMode('die', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await assert.rejects(client.request('session/create', createParams(cwd)), /exited|not running/);
      assert.equal(client.isRunning(), false);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('error responses reject with AppServerError carrying code and message', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await assert.rejects(
        client.request('bogus/method', {}),
        (err) => err instanceof AppServerError && err.code === -32601 && /Method not found/.test(err.message),
      );
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('per-request timeout rejects while the child stays usable', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await assert.rejects(client.request('noop/hang', {}, { timeoutMs: 250 }), /timed out/);
      assert.equal(client.isRunning(), true);
      const created = await client.request('session/create', createParams(cwd));
      assert.equal(created.session.sessionId, 'sess_fakeB1');
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

// --- resolveModel ---

test('resolveModel resolves both spec syntaxes; misses return null', () => {
  const catalog = [
    { ref: { providerId: 'glm-test', modelId: 'small' }, label: 'small', providerLabel: 'GLM Test' },
    { ref: { providerId: 'glm-test', modelId: 'big' }, label: 'big', providerLabel: 'GLM Test' },
    { ref: { providerId: 'fake-openrouter', modelId: 'nimbus-xl' }, label: 'nimbus-xl', providerLabel: 'Fake OpenRouter' },
    // same bare modelId under a second provider: first catalog entry wins
    { ref: { providerId: 'other-provider', modelId: 'small' }, label: 'small', providerLabel: 'Other' },
  ];
  assert.deepEqual(resolveModel(catalog, 'small'), { providerId: 'glm-test', modelId: 'small' });
  assert.deepEqual(resolveModel(catalog, 'glm-test/big'), { providerId: 'glm-test', modelId: 'big' });
  assert.deepEqual(resolveModel(catalog, 'nimbus-xl'), { providerId: 'fake-openrouter', modelId: 'nimbus-xl' });
  assert.equal(resolveModel(catalog, 'glm-test/nope'), null);
  assert.equal(resolveModel(catalog, 'unknown-model'), null);
  assert.equal(resolveModel(null, 'small'), null);
  assert.equal(resolveModel(catalog, ''), null);
});

// --- catalog-aware reasoning substitution (Controller Ruling 14) ---

test('resolveReasoningLevel unit behavior across catalog shapes', () => {
  const nimbus = { ref: { providerId: 'fake-openrouter', modelId: 'nimbus-xl' }, reasoning: { levels: [{ value: 'low' }, { value: 'medium' }, { value: 'xhigh' }], defaultLevel: 'xhigh' } };
  const offered = resolveReasoningLevel([nimbus], 'fake-openrouter', 'nimbus-xl', 'low');
  assert.deepEqual(offered, { level: 'low', substitution: null });
  const missing = resolveReasoningLevel([nimbus], 'fake-openrouter', 'nimbus-xl', 'high');
  assert.deepEqual(missing, { level: 'xhigh', substitution: { requested: 'high', used: 'xhigh' } });
  // Entry without levels info (or absent from the catalog): pass through.
  const plain = { ref: { providerId: 'fake-local', modelId: 'plain' } };
  assert.deepEqual(resolveReasoningLevel([plain], 'fake-local', 'plain', 'high'), { level: 'high', substitution: null });
  assert.deepEqual(resolveReasoningLevel(null, 'glm-test', 'small', 'high'), { level: 'high', substitution: null });
  // defaultLevel not itself offered: unusable, keep the request verbatim.
  const broken = { ref: { providerId: 'p', modelId: 'm' }, reasoning: { levels: [{ value: 'low' }], defaultLevel: 'turbo' } };
  assert.deepEqual(resolveReasoningLevel([broken], 'p', 'm', 'high'), { level: 'high', substitution: null });
});

test('runTaskWithModel substitutes the entry default when the level is not offered', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const res = await runTaskWithModel({
        binPath: fakeBin,
        cwd,
        prompt: 'x',
        providerId: 'fake-openrouter',
        modelId: 'nimbus-xl',
        reasoningLevel: 'high', // nimbus-xl offers low|medium|xhigh only
        timeoutMs: 5000,
      });
      assert.equal(res.ok, true);
      assert.deepEqual(res.reasoningSubstitution, { requested: 'high', used: 'xhigh' });
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection, {
        providerId: 'fake-openrouter',
        modelId: 'nimbus-xl',
        options: { reasoningLevel: 'xhigh' },
      });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('runTaskWithModel passes an explicit xhigh through unchanged', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const res = await runTaskWithModel({
        binPath: fakeBin,
        cwd,
        prompt: 'x',
        providerId: 'fake-openrouter',
        modelId: 'nimbus-xl',
        reasoningLevel: 'xhigh',
        timeoutMs: 5000,
      });
      assert.equal(res.ok, true);
      assert.equal(res.reasoningSubstitution, null);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection.options, { reasoningLevel: 'xhigh' });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('runTaskWithModel never substitutes an offered level; no levels info passes through', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const offered = await runTaskWithModel({
        binPath: fakeBin, cwd, prompt: 'x',
        providerId: 'fake-openrouter', modelId: 'nimbus-xl',
        reasoningLevel: 'low', timeoutMs: 5000,
      });
      assert.equal(offered.ok, true);
      assert.equal(offered.reasoningSubstitution, null);
      const noInfo = await runTaskWithModel({
        binPath: fakeBin, cwd, prompt: 'x',
        providerId: 'fake-local', modelId: 'plain',
        reasoningLevel: 'high', timeoutMs: 5000, // plain carries no levels info
      });
      assert.equal(noInfo.ok, true);
      assert.equal(noInfo.reasoningSubstitution, null);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const sends = received.filter((m) => m.method === 'session/send');
      assert.deepEqual(sends[0].params.modelSelection.options, { reasoningLevel: 'low' });
      assert.deepEqual(sends[1].params.modelSelection.options, { reasoningLevel: 'high' });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

// --- getModelCatalog ---

test('getModelCatalog returns the create-response catalog without running a turn', async () => {
  await withMode('ok', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'cat.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const catalog = await getModelCatalog({ binPath: fakeBin, cwd, timeoutMs: 5000 });
      assert.ok(Array.isArray(catalog));
      assert.deepEqual(
        catalog.map((e) => `${e.ref.providerId}/${e.ref.modelId}`),
        ['glm-test/small', 'glm-test/big', 'fake-openrouter/nimbus-xl', 'fake-local/plain'],
      );
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(received.some((m) => m.method === 'session/create'), 'create fetches the catalog');
      assert.equal(received.some((m) => m.method === 'session/send'), false, 'no turn is run');
      assert.equal(received.some((m) => m.method === 'session/subscribe'), false, 'no subscribe needed');
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('getModelCatalog rejects cleanly when the child dies', async () => {
  await withMode('die', async () => {
    const cwd = makeTempDir();
    try {
      await assert.rejects(getModelCatalog({ binPath: fakeBin, cwd }), AppServerError);
    } finally {
      removeDir(cwd);
    }
  });
});

test('getModelCatalog validates cwd like runTaskWithModel', async () => {
  await assert.rejects(getModelCatalog({ binPath: fakeBin, cwd: 'relative' }), TypeError);
  await assert.rejects(getModelCatalog({ binPath: fakeBin, cwd: '/nowhere/at/all' }), TypeError);
});

// --- helpers and defaults ---

test('resolveBin prefers ZCODE_APPSERVER_BIN, then discovery via ZCODE_BIN', () => {
  assert.equal(resolveBin({ ZCODE_APPSERVER_BIN: fakeBin }), fakeBin);
  assert.equal(resolveBin({ ZCODE_BIN: fakeBin }), fakeBin);
});

test('timeout defaults align with runner defaults', () => {
  assert.equal(DEFAULT_TASK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 30000);
});

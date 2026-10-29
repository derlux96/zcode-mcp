import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  buildUserInputAnswer,
  buildUserInputDecline,
  describeUserInputQuestion,
} from '../src/appserver.mjs';
import { DEFAULT_TIMEOUT_MS } from '../src/runner.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const fakeBin = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));

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
        (err) => {
          assert.match(err.message, /timed out/i);
          assert.equal(err.startup, undefined, 'after session/send: not a startup error');
          assert.equal(err.sessionId, 'sess_fakeB1');
          return true;
        },
      );
    } finally {
      removeDir(cwd);
    }
  });
});

// --- argument checks, startup errors, model choice ---

test('runTaskWithModel checks its arguments before spawning anything', async () => {
  const cwd = makeTempDir();
  try {
    const cases = [
      [{ prompt: '  ' }, 'prompt must be a non-empty string'],
      [{ providerId: 'p' }, 'modelId must be a non-empty string'],
      [{ providerId: ' ', modelId: 'm' }, 'providerId must be a non-empty string'],
      [{ providerId: 'p', modelId: ' ' }, 'modelId must be a non-empty string'],
      [{ cwd: 'relative' }, 'cwd must be an absolute path'],
      [{ cwd: '/nowhere/at/all' }, 'cwd does not exist or is not a directory: /nowhere/at/all'],
      [{ reasoningLevel: ' ' }, 'reasoningLevel must be a non-empty string'],
    ];
    for (const [args, message] of cases) {
      await assert.rejects(runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 5000, ...args }), { name: 'TypeError', message });
    }
  } finally {
    removeDir(cwd);
  }
});

test('errors before session/send carry startup: true (not no-model); no sessionId before session/create', async () => {
  const cwd = makeTempDir();
  try {
    await withMode('die', () => assert.rejects(runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 5000 }), (err) => {
      assert.ok(err instanceof AppServerError);
      assert.equal(err.startup, true);
      assert.equal('sessionId' in err, false);
      return true;
    }));
    await withMode('no-model', () => assert.rejects(runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 5000 }), (err) => {
      assert.equal(err.code, 'no-model');
      assert.equal(err.startup, undefined, 'retrying cannot help');
      assert.equal(err.sessionId, 'sess_fakeB1');
      return true;
    }));
    const refused = new AppServerError('spawn refused');
    await assert.rejects(runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', onSpawn: () => { throw refused; } }), (err) => {
      assert.equal(err, refused);
      assert.equal(err.startup, true);
      return true;
    });
  } finally {
    removeDir(cwd);
  }
});

test('without providerId/modelId: the session current model, else the first catalog entry', async () => {
  const ref = (providerId, modelId) => ({ ref: { providerId, modelId } });
  const picked = async (settings) => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    Object.assign(process.env, { FAKE_APPSERVER_MODE: 'ok', FAKE_APPSERVER_LOG: log, FAKE_APPSERVER_MODEL_SETTINGS: JSON.stringify(settings) });
    try {
      const res = await runTaskWithModel({ binPath: fakeBin, cwd, prompt: 'x', timeoutMs: 5000 }).catch((err) => err);
      if (res instanceof Error) return res.code;
      const { providerId, modelId } = readLog(log).find((m) => m.method === 'session/send').params.modelSelection;
      return `${providerId}/${modelId}`;
    } finally {
      for (const k of ['FAKE_APPSERVER_MODE', 'FAKE_APPSERVER_LOG', 'FAKE_APPSERVER_MODEL_SETTINGS']) delete process.env[k];
      removeDir(cwd);
    }
  };
  assert.equal(await picked({ current: { providerId: 'cur', modelId: 'm' }, available: [ref('p0', 'm0'), ref('p1', 'm1')] }), 'cur/m');
  assert.equal(await picked({ available: [ref('p0', 'm0')] }), 'p0/m0');
  assert.equal(await picked({ current: { providerId: 'cur' }, available: [ref('p0', 'm0'), ref('p1', 'm1')] }), 'p0/m0', 'an incomplete current model is skipped');
  assert.equal(await picked({ current: { modelId: 'm' }, available: [{ ref: { providerId: 'p0' } }] }), 'no-model', 'an incomplete first entry is no model');
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
  await assert.rejects(getModelCatalog({ binPath: fakeBin, cwd: 'relative' }), { name: 'TypeError', message: 'cwd must be an absolute path' });
  await assert.rejects(getModelCatalog({ binPath: fakeBin, cwd: '/nowhere/at/all' }), { name: 'TypeError', message: 'cwd does not exist or is not a directory: /nowhere/at/all' });
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

// --- parked interaction/requestUserInput (mode ask) ---

async function askSession(client, cwd) {
  const created = await client.request('session/create', createParams(cwd));
  const sessionId = created.session.sessionId;
  await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  const cursor = client.eventOrdinal;
  await client.request('session/send', { sessionId, content: 'go' });
  return cursor;
}

test('requestUserInput is parked, onUserInput fires once, respond() completes the turn', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    const asked = [];
    let client;
    const got = new Promise((resolve) => {
      client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: (req) => { asked.push(req); resolve(req); } });
    });
    try {
      const cursor = await askSession(client, cwd);
      const req = await got;
      assert.equal(req.question, 'Which port? [options: 3000 (Recommended) | 8080]');
      assert.equal(req.requestId, 'perm_fake1');
      assert.equal(req.protocolId, 'server-ask');
      assert.equal(client.pendingUserInput, 1);
      client.respond(req.protocolId, buildUserInputAnswer(req.params, '8080'));
      assert.equal(client.pendingUserInput, 0);
      const ev = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
      assert.equal(ev.type, 'turn.completed');
      assert.equal(ev.payload.response, 'answers: {"Which port?":"8080"}');
      assert.equal(asked.length, 1);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('a parked requestUserInput does not trip the idle timeout', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      const cursor = await askSession(client, cwd);
      const req = await got;
      const wait = client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 10000, idleTimeoutMs: 300, since: cursor });
      const early = await Promise.race([wait.then(() => 'done', (e) => `rejected: ${e.message}`), new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
      assert.equal(early, 'still waiting');
      client.respond(req.protocolId, buildUserInputAnswer(req.params, 'x'));
      assert.equal((await wait).type, 'turn.completed');
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('without onUserInput, requestUserInput is answered with a valid cancel (other unknown requests get {})', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      const cursor = await askSession(client, cwd);
      const ev = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
      assert.equal(ev.type, 'turn.completed');
      assert.equal(ev.payload.response, 'AskUserQuestion was cancelled');
      assert.equal(client.pendingUserInput, 0);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('mode ask: interaction/browserList is still answered {} (the 2 s trap would kill the fake otherwise)', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      await askSession(client, cwd);
      const req = await got;
      await new Promise((r) => setTimeout(r, 2300)); // past the trap window
      assert.equal(client.isRunning(), true);
      client.respond(req.protocolId, {});
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

// --- requestUserInput wire shapes (ZCode 0.17.0 AskUserQuestion) ---

const askQ = (question, labels = []) => ({ question, header: 'H', multiSelect: false, options: labels.map((label) => ({ label, value: label, description: 'd' })) });

test('buildUserInputAnswer: accept with content.answers keyed by every question text', () => {
  assert.deepEqual(buildUserInputAnswer({ questions: [askQ('Which port?', ['3000', '8080'])] }, '8080'),
    { action: 'accept', content: { answers: { 'Which port?': '8080' } } });
  assert.deepEqual(buildUserInputAnswer({ questions: [askQ('A?'), askQ('B?')] }, 'x'),
    { action: 'accept', content: { answers: { 'A?': 'x', 'B?': 'x' } } });
});

test('buildUserInputAnswer: falls back to params.input.questions, then to content.answer', () => {
  assert.deepEqual(buildUserInputAnswer({ input: { questions: [{ question: 'Q?', options: [] }] } }, 'y'),
    { action: 'accept', content: { answers: { 'Q?': 'y' } } });
  assert.deepEqual(buildUserInputAnswer({ prompt: 'p' }, 'z'), { action: 'accept', content: { answer: 'z' } });
  assert.deepEqual(buildUserInputAnswer(undefined, 'z'), { action: 'accept', content: { answer: 'z' } });
  // questions without a string text cannot be keyed
  assert.deepEqual(buildUserInputAnswer({ questions: [{ question: { t: 1 } }] }, 'z'), { action: 'accept', content: { answer: 'z' } });
});

test('describeUserInputQuestion: one line per question with options, joined with " / "', () => {
  assert.equal(describeUserInputQuestion({ questions: [askQ('Which port?', ['3000 (Recommended)', '8080'])] }), 'Which port? [options: 3000 (Recommended) | 8080]');
  assert.equal(describeUserInputQuestion({ questions: [askQ('A?', ['a', 'b', 'c']), askQ('B?')] }), 'A? [options: a | b | c] / B?');
  assert.equal(describeUserInputQuestion({ input: { questions: [{ question: 'In?', options: [{ label: 'x' }] }] } }), 'In? [options: x]');
  // params.questions wins over params.input.questions
  assert.equal(describeUserInputQuestion({ questions: [askQ('Top?')], input: { questions: [askQ('In?')] } }), 'Top?');
});

test('describeUserInputQuestion: option labels are strings, else label, else value; empty ones are left out', () => {
  assert.equal(describeUserInputQuestion({ questions: [{ question: 'Q?', options: ['s', null, { value: 'v' }, { label: 'l', value: 'x' }, {}, { label: '' }, 7] }] }), 'Q? [options: s | v | l]');
  assert.equal(describeUserInputQuestion({ questions: [{ question: 'Q?', options: [null, {}, ''] }] }), 'Q?');
  // empty question entries are skipped; an empty params.questions falls back to params.input.questions
  assert.equal(describeUserInputQuestion({ questions: [null, askQ('A?')] }), 'A?');
  assert.equal(describeUserInputQuestion({ questions: [], input: { questions: [askQ('In?')] } }), 'In?');
});

test('buildUserInputDecline: the reason only when it is a non-empty string', () => {
  assert.deepEqual(buildUserInputDecline('busy'), { action: 'decline', reason: 'busy' });
  assert.deepEqual(buildUserInputDecline(''), { action: 'decline' });
  assert.deepEqual(buildUserInputDecline(undefined), { action: 'decline' });
});

test('describeUserInputQuestion: without questions falls back to question / prompt / message', () => {
  assert.equal(describeUserInputQuestion({ question: 'q', prompt: 'p' }), 'q');
  assert.equal(describeUserInputQuestion({ prompt: 'p', message: 'm' }), 'p');
  assert.equal(describeUserInputQuestion({ message: 'm' }), 'm');
  assert.equal(describeUserInputQuestion({ questions: [], prompt: 'p' }), 'p');
  assert.equal(describeUserInputQuestion({ question: { x: 1 } }), '');
  assert.equal(describeUserInputQuestion(null), '');
});

test('mode ask without questions: the prompt is the question and content.answer is valid', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    process.env.FAKE_APPSERVER_ASK_NO_QUESTIONS = '1';
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      const cursor = await askSession(client, cwd);
      const req = await got;
      assert.equal(req.question, 'Tool AskUserQuestion requires user interaction');
      client.respond(req.protocolId, buildUserInputAnswer(req.params, '8080'));
      const ev = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
      assert.equal(ev.payload.response, 'answers: {}');
    } finally {
      delete process.env.FAKE_APPSERVER_ASK_NO_QUESTIONS;
      await client.close();
      removeDir(cwd);
    }
  });
});

test('fake: the old {requestId, answer} shape fails ZCode\'s strict answer schema', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      const cursor = await askSession(client, cwd);
      const req = await got;
      client.respond(req.protocolId, { requestId: req.requestId, answer: '8080' });
      const ev = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
      assert.match(ev.payload.response, /^permission request failed/);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

// --- respond() / parked-input hygiene (Task 3 review items) ---

function readLog(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('respond() sends only for a parked id and reports whether it sent', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      const cursor = await askSession(client, cwd);
      const req = await got;
      assert.equal(client.respond('not-parked', { answer: 'x' }), false);
      assert.equal(client.respond(req.protocolId, buildUserInputAnswer(req.params, '1')), true);
      assert.equal(client.respond(req.protocolId, buildUserInputAnswer(req.params, '2')), false);
      await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 5000, since: cursor });
      const answers = readLog(log).filter((m) => m.method === undefined && (m.id === 'not-parked' || m.id === 'server-ask'));
      assert.deepEqual(answers.map((m) => m.id), ['server-ask']);
      assert.deepEqual(answers[0].result, { action: 'accept', content: { answers: { 'Which port?': '1' } } });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      await client.close();
      removeDir(cwd);
    }
  });
});

test('parked input is cleared when the child exits', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      await askSession(client, cwd);
      const req = await got;
      assert.equal(client.pendingUserInput, 1);
      client.child.kill('SIGKILL');
      await client.exited;
      assert.equal(client.pendingUserInput, 0);
      assert.equal(client.respond(req.protocolId, {}), false);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('parked input is cleared when the client closes', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      await askSession(client, cwd);
      const req = await got;
      assert.equal(client.pendingUserInput, 1);
      await client.close();
      assert.equal(client.pendingUserInput, 0);
      assert.equal(client.respond(req.protocolId, {}), false);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

test('a non-string question text is left out, never "[object Object]"', async () => {
  await withMode('ask', async () => {
    const cwd = makeTempDir();
    process.env.FAKE_APPSERVER_ASK_QUESTION = JSON.stringify({ text: 'Which port?' });
    let parked;
    const got = new Promise((resolve) => { parked = resolve; });
    const client = new AppServerClient({ binPath: fakeBin, cwd, onUserInput: parked });
    try {
      await askSession(client, cwd);
      const req = await got;
      assert.equal(req.question, '[options: 3000 (Recommended) | 8080]');
      assert.ok(!req.question.includes('[object Object]'));
      client.respond(req.protocolId, {});
    } finally {
      delete process.env.FAKE_APPSERVER_ASK_QUESTION;
      await client.close();
      removeDir(cwd);
    }
  });
});

// --- onControl: stop / steer / answer ---

// Runs a task; onControl hands the control to `drive(control, ctx)` (not awaited by the run).
async function runWithControl(mode, drive, opts = {}, env = {}) {
  const cwd = makeTempDir();
  const log = join(cwd, 'rx.log');
  Object.assign(process.env, { FAKE_APPSERVER_MODE: mode, FAKE_APPSERVER_LOG: log, ...env });
  let driven = null;
  let control = null;
  try {
    const run = runTaskWithModel({
      binPath: fakeBin, cwd, prompt: 'x', providerId: 'glm-test', modelId: 'small', timeoutMs: 10000, idleTimeoutMs: 0,
      transientRetry: { delaysMs: [10], jitter: 0, sleep: async () => {} },
      ...opts,
      onControl: (c) => { control = c; driven = drive(c); },
    });
    const res = await run.then((r) => r, (e) => e);
    return { res, control, driven: await driven, log: readLog(log) };
  } finally {
    delete process.env.FAKE_APPSERVER_MODE;
    delete process.env.FAKE_APPSERVER_LOG;
    for (const k of Object.keys(env)) delete process.env[k];
    removeDir(cwd);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('onControl is called once, after subscribe and before the first send', async () => {
  const calls = [];
  const { log } = await runWithControl('ok', (c) => { calls.push(c); });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].capabilities, { stop: null, steer: null, userInput: null });
  const methods = log.filter((m) => typeof m.method === 'string').map((m) => m.method);
  assert.deepEqual(methods, ['session/create', 'session/subscribe', 'session/send']);
});

test('stop() in slowhang: accepted, the turn fails aborted and is not retried', async () => {
  const { res, control, driven, log } = await runWithControl('slowhang', async (c) => { await sleep(200); return c.stop(); });
  assert.equal(driven, 'accepted');
  assert.equal(res.ok, false);
  assert.equal(res.failed, true);
  assert.equal(res.error.code, 'aborted');
  assert.equal(res.retries.length, 0);
  assert.equal(control.capabilities.stop, true);
  const stop = log.find((m) => m.method === 'session/stop');
  assert.equal(stop.params.sessionId, 'sess_fakeB1');
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
});

test('stop() in chatty ends the streaming turn the same way', async () => {
  const { res, driven } = await runWithControl('chatty', async (c) => { await sleep(300); return c.stop(); });
  assert.equal(driven, 'accepted');
  assert.equal(res.failed, true);
  assert.equal(res.error.message, '429 rate limit');
  assert.equal(res.retries.length, 0);
});

test('FAKE_APPSERVER_UNSUPPORTED=stop,steer: both answer not_supported and the capabilities turn false', async () => {
  const { res, control, driven, log } = await runWithControl('chatty', async (c) => {
    await sleep(100);
    const s1 = await c.stop();
    const st1 = await c.steer('x');
    const s2 = await c.stop();
    const st2 = await c.steer('y');
    return { s1, st1, s2, st2 };
  }, {}, { FAKE_APPSERVER_UNSUPPORTED: 'stop,steer' });
  assert.equal(res.ok, true);
  assert.equal(driven.s1, 'not_supported');
  assert.deepEqual(driven.st1, { status: 'not_supported' });
  assert.equal(driven.s2, 'not_supported');
  assert.deepEqual(driven.st2, { status: 'not_supported' });
  assert.deepEqual(control.capabilities, { stop: false, steer: false, userInput: null });
  // the second calls short-circuit without a request
  assert.equal(log.filter((m) => m.method === 'session/stop').length, 1);
  assert.deepEqual(log.filter((m) => m.method === 'v4/command').map((m) => m.params.type), ['sendText']);
});

test('steer() in chatty: requestedDelivery guide, drained mid-turn, one turn and no follow-up', async () => {
  const { res, control, driven, log } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    const a = await c.steer('use port 8080');
    const b = await c.steer('and log it');
    return [a, b];
  });
  assert.equal(res.ok, true);
  // ZCode acks every accepted steer 'queue' (pending list); the requested delivery is reported
  assert.deepEqual(driven[0], { status: 'accepted', delivery: 'guide' });
  assert.deepEqual(driven[1], { status: 'accepted', delivery: 'guide' });
  assert.equal(control.capabilities.steer, true);
  assert.equal(res.response, 'fake model task done\nsteered: use port 8080 | and log it');
  assert.equal(res.undeliveredSteers, undefined);
  const all = log.filter((m) => m.method === 'v4/command');
  assert.deepEqual(all.map((m) => m.params.type), ['sendText', 'sendText'], 'no setFollowupMode, no setAutoDrain');
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
  const p = all[0].params;
  assert.equal(p.type, 'sendText');
  assert.equal(p.sessionId, 'sess_fakeB1');
  assert.equal(p.clientId, 'zcode-delegate');
  assert.match(p.commandId, /^steer-sess_fakeB1-\d+/);
  assert.equal(typeof p.issuedAt, 'number');
  assert.notEqual(all[0].params.commandId, all[1].params.commandId);
});

test('regression: the steer wire payload is {text, requestedDelivery:guide} with no delivery.requested', async () => {
  const { log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('use port 8080'); });
  const p = log.find((m) => m.method === 'v4/command' && m.params.type === 'sendText').params;
  assert.deepEqual(p.payload, { text: 'use port 8080', requestedDelivery: 'guide' });
  assert.equal(p.payload.delivery, undefined);
  assert.equal(p.baseRevision, undefined, 'sendText is no CAS command');
});

test('steer() with no turn in flight is rejected with the server reasonCode', async () => {
  // nosendack never puts a turn in flight (deterministic, unlike racing the send in 'ok')
  const { driven } = await runWithControl('nosendack', async (c) => c.steer('too early'), { requestTimeoutMs: 1000 });
  assert.deepEqual(driven, { status: 'rejected', reason: 'idle' });
});

test('after the run, stop() answers not_supported and steer() rejected closed', async () => {
  const { control } = await runWithControl('ok', () => {});
  assert.equal(await control.stop(), 'not_supported');
  assert.deepEqual(await control.steer('late'), { status: 'rejected', reason: 'closed' });
  assert.deepEqual(control.answer('late'), { status: 'rejected', reason: 'no_question' });
});

test('decline() declines the parked question with a reason and the turn goes on', async () => {
  let ctl;
  const { res, log } = await runWithControl('ask', (c) => { ctl = c; }, {
    onUserInput: () => { queueMicrotask(() => { ctl.decline('nobody here'); }); },
  });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'AskUserQuestion was declined: nobody here');
  const answer = log.find((m) => m.method === undefined && m.id === 'server-ask');
  assert.deepEqual(answer.result, { action: 'decline', reason: 'nobody here' });
});

test('decline() with nothing parked is rejected no_question', async () => {
  const { driven } = await runWithControl('ok', (c) => c.decline('x'));
  assert.deepEqual(driven, { status: 'rejected', reason: 'no_question' });
});

test('answer() with nothing parked is rejected no_question', async () => {
  const { driven } = await runWithControl('ok', (c) => c.answer('x'));
  assert.deepEqual(driven, { status: 'rejected', reason: 'no_question' });
});

test('answer() replies to the parked question via onUserInput and the turn completes', async () => {
  const asked = [];
  let ctl;
  const { res, control } = await runWithControl('ask', (c) => { ctl = c; }, {
    onUserInput: (q) => { asked.push(q); queueMicrotask(() => { asked.push(ctl.answer('8080')); }); },
  });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'answers: {"Which port?":"8080"}');
  assert.equal(asked[0].question, 'Which port? [options: 3000 (Recommended) | 8080]');
  assert.deepEqual(asked[1], { status: 'accepted' });
  assert.equal(control.capabilities.userInput, true);
});

// --- steers the turn ended before draining (ZCode holds them, autoDrain false) ---

const steerTypes = (log) => log.filter((m) => m.method === 'v4/command').map((m) => m.params.type);
const casOf = (log, type) => log.filter((m) => m.method === 'v4/command' && m.params.type === type).map((m) => m.params);

test('a steer never drained: setAutoDrain with baseRevision (stale retry) runs it as a follow-up turn', async () => {
  const { res, driven, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('use port 8080'); },
    {}, { FAKE_APPSERVER_NO_DRAIN: '1' });
  assert.deepEqual(driven, { status: 'accepted', delivery: 'guide' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake follow-up turn: use port 8080');
  assert.equal(res.undeliveredSteers, undefined);
  assert.deepEqual(steerTypes(log), ['sendText', 'setAutoDrain', 'setAutoDrain']);
  const sendAck = log.find((m) => m.method === 'v4/command' && m.params.type === 'sendText');
  assert.ok(sendAck);
  const [first, second] = casOf(log, 'setAutoDrain');
  assert.deepEqual(first.payload, { autoDrain: true });
  // the sendText ack's revision (2: send + accepted steer), then the turn end made it stale
  assert.equal(first.baseRevision, 2);
  assert.equal(second.baseRevision, 3, 'retried once with the revisionAtDecision of the stale answer');
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
  assert.equal(res.usage.inputTokens, 200, 'usage of both turns is summed');
  assert.equal(res.usage.modelRequestCount, 2);
});

test('setAutoDrain stale twice: falls back to sendText startNow + clearQueueAndSend', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('late note'); },
    {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_CAS_STALE: '2' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake startNow turn: late note');
  assert.deepEqual(steerTypes(log), ['sendText', 'setAutoDrain', 'setAutoDrain', 'sendText']);
});

test('setAutoDrain rejected: one sendText startNow + clearQueueAndSend carries the held steers', async () => {
  const { res, driven, log } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    return [await c.steer('first'), await c.steer('second')];
  }, {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_AUTODRAIN_REJECT: '1' });
  assert.deepEqual(driven.map((d) => d.status), ['accepted', 'accepted']);
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake startNow turn: first\n\nsecond');
  // setAutoDrain twice: stale after the turn end, then the rejection
  assert.deepEqual(steerTypes(log), ['sendText', 'sendText', 'setAutoDrain', 'setAutoDrain', 'sendText']);
  const fallback = casOf(log, 'sendText')[2];
  assert.deepEqual(fallback.payload, { text: 'first\n\nsecond', requestedDelivery: 'startNow', heldQueueDisposition: 'clearQueueAndSend' });
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
  assert.equal(res.usage.modelRequestCount, 2);
});

test('setAutoDrain unsupported: the clearQueueAndSend fallback is used the same way', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('hint'); },
    {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_UNSUPPORTED: 'autodrain' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake startNow turn: hint');
  assert.deepEqual(steerTypes(log), ['sendText', 'setAutoDrain', 'sendText'], 'method not found: no stale retry');
});

test('setAutoDrain and startNow both refused: the held steers go out as a session/send, joined by a blank line', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    return [await c.steer('first'), await c.steer('second')];
  }, {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_UNSUPPORTED: 'autodrain', FAKE_APPSERVER_STARTNOW_REJECT: '1' });
  assert.equal(res.ok, true);
  const sends = log.filter((m) => m.method === 'session/send');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].params.content, 'first\n\nsecond');
  assert.deepEqual(sends[1].params.modelSelection, sends[0].params.modelSelection);
});

test('setAutoDrain accepted but no turn starts: falls back to startNow after the wait', async () => {
  const t0 = Date.now();
  const { res, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('late note'); },
    { autoDrainWaitMs: 300 }, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_AUTODRAIN_NOOP: '1' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake startNow turn: late note');
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
  assert.ok(Date.now() - t0 < 8000);
});

test('one steer drained, a later one held: only the held one is delivered as a follow-up', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    const a = await c.steer('early');
    await sleep(100);
    const b = await c.steer('late');
    return [a, b];
  }, {}, { FAKE_APPSERVER_DRAIN_LIMIT: '1' });
  assert.equal(res.ok, true);
  assert.equal(res.response, 'fake follow-up turn: late');
  assert.equal(casOf(log, 'setAutoDrain').length >= 1, true);
});

test('a held steer is not delivered after a stop; it is reported as undelivered', async () => {
  const { res, log } = await runWithControl('slowhang', async (c) => {
    await sleep(200);
    const st = await c.steer('never mind');
    await c.stop();
    return st;
  }, {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_STOP_COMPLETES: '1' });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.deepEqual(res.undeliveredSteers, ['never mind']);
  assert.deepEqual(steerTypes(log), ['sendText']);
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
});

// --- how turn.steerDrained events mark steers delivered ---

test('a turn.steerDrained without drainedInputs marks the oldest open steer', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('hint'); },
    { autoDrainWaitMs: 300 }, { FAKE_APPSERVER_DRAIN_PAYLOAD: 'null' });
  assert.equal(res.response, 'fake model task done\nsteered: hint');
  assert.deepEqual(steerTypes(log), ['sendText'], 'no follow-up');
});

test('drains are matched by text: a later steer drained first leaves the earlier one held', async () => {
  const { res } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    return [await c.steer('first'), await c.steer('second')];
  }, {}, { FAKE_APPSERVER_DRAIN_SKIP: '1', FAKE_APPSERVER_AUTODRAIN_REJECT: '1' });
  assert.equal(res.response, 'fake startNow turn: first');
});

test('a repeated drain of a delivered steer is not counted for a later steer', async () => {
  const { res } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    const a = await c.steer('early');
    await sleep(100);
    return [a, await c.steer('late')];
  }, {}, { FAKE_APPSERVER_DRAIN_TWICE: '1', FAKE_APPSERVER_DRAIN_LIMIT: '1' });
  assert.equal(res.response, 'fake follow-up turn: late');
});

test('a drain that arrives before its steer is acked is credited to that steer only', async () => {
  const { res } = await runWithControl('chatty', async (c) => {
    await sleep(200);
    return [await c.steer('early'), await c.steer('late')];
  }, {}, { FAKE_APPSERVER_STEER_ACK_DELAY_MS: '100', FAKE_APPSERVER_DRAIN_LIMIT: '1', FAKE_APPSERVER_AUTODRAIN_REJECT: '1' });
  assert.equal(res.response, 'fake startNow turn: late');
});

test('CAS before any known revision sends baseRevision 0; an accepted CAS is not repeated', async () => {
  const { res, log } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('hint'); },
    {}, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_SENDTEXT_NO_REVISION: '1', FAKE_APPSERVER_CAS_FRESH: '1' });
  assert.equal(res.response, 'fake follow-up turn: hint');
  assert.deepEqual(steerTypes(log), ['sendText', 'setAutoDrain']);
  assert.equal(casOf(log, 'setAutoDrain')[0].baseRevision, 0);
});

test('a stop while a late steer is unacknowledged: stopped, the steer reported undelivered', async () => {
  let ctl;
  const { res, log } = await runWithControl('ask', (c) => { ctl = c; }, {
    onUserInput: () => { queueMicrotask(() => { ctl.steer('late'); ctl.answer('8080'); }); },
    onEvent: (e) => { if (e.type === 'turn.completed') setTimeout(() => { ctl.stop(); }, 50); },
  }, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_STEER_ACK_DELAY_MS: '500' });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.deepEqual(res.undeliveredSteers, ['late']);
  assert.deepEqual(steerTypes(log), ['sendText']);
});

test('a stop during the auto-drain wait ends the task stopped, without another turn', async () => {
  let ctl;
  const { res, log } = await runWithControl('chatty', async (c) => { ctl = c; await sleep(200); return c.steer('hint'); }, {
    autoDrainWaitMs: 1500,
    onEvent: (e) => { if (e.type === 'turn.completed') setTimeout(() => { ctl.stop(); }, 300); },
  }, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_AUTODRAIN_NOOP: '1' });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.deepEqual(steerTypes(log), ['sendText', 'setAutoDrain', 'setAutoDrain']);
  assert.equal(log.filter((m) => m.method === 'session/send').length, 1);
});

test('the task deadline caps the auto-drain wait', async () => {
  const t0 = Date.now();
  const { res } = await runWithControl('chatty', async (c) => { await sleep(200); return c.steer('hint'); },
    { timeoutMs: 3000, autoDrainWaitMs: 20000 }, { FAKE_APPSERVER_NO_DRAIN: '1', FAKE_APPSERVER_AUTODRAIN_NOOP: '1' });
  assert.equal(res.code, 'turn_timeout');
  assert.match(res.message, /timed out after 3000 ms/);
  assert.ok(Date.now() - t0 < 8000, 'not the 20 s auto-drain wait');
});

test('fake CAS rules: no baseRevision is rejected invalidPayload, a stale one answers the current revision', async () => {
  await withMode('slowhang', async () => {
    const cwd = makeTempDir();
    const client = new AppServerClient({ binPath: fakeBin, cwd });
    try {
      await client.settle();
      const created = await client.request('session/create', createParams(cwd));
      const sessionId = created.session.sessionId;
      const cmd = (type, payload, extra = {}) => client.request('v4/command',
        { commandId: `c-${type}-${Math.random()}`, clientId: 't', sessionId, ...extra, type, payload, issuedAt: Date.now() });
      const missing = await cmd('setAutoDrain', { autoDrain: true });
      assert.equal(missing.status, 'rejected');
      assert.equal(missing.reasonCode, 'proto.invalidPayload');
      assert.equal(missing.message, 'CAS commands require baseRevision and baseLogEpoch');
      assert.equal(missing.revisionAtDecision, 0);
      const stale = await cmd('setFollowupMode', { mode: 'guide' }, { baseRevision: 7 });
      assert.deepEqual(stale, { status: 'stale', reasonCode: 'proto.staleRevision', revisionAtDecision: 0 });
      const ok = await cmd('setFollowupMode', { mode: 'guide' }, { baseRevision: stale.revisionAtDecision });
      assert.deepEqual(ok, { status: 'accepted', revisionAtDecision: 1 });
      await client.request('session/send', { sessionId, content: 'go' });
      // the old delivery.requested shape is ignored: the item is queued, acked 'queue'
      const steer = await cmd('sendText', { text: 'x', delivery: { requested: 'guide' } });
      assert.equal(steer.status, 'accepted');
      assert.equal(steer.result.delivery, 'queue');
      assert.equal(steer.revisionAtDecision, 3);
    } finally {
      await client.close();
      removeDir(cwd);
    }
  });
});

// zcode_check: probe_model (one tiny real model request) and the provider config check.
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createProtocol } from '../src/protocol.mjs';
import { buildTools } from '../src/mcp-server.mjs';
import { SessionStore } from '../src/state.mjs';
import { PROBE_PROMPT, probeModel } from '../src/model-probe.mjs';
import { makeTempDir, removeDir, fakeBin, fakeAppserverBin, assertNoLeftoverProcesses, TestScope } from './helpers.mjs';

const temps = [];
const SAVED = {};
const ENV = ['ZCODE_MCP_HOME', 'ZCODE_MCP_STATE', 'ZCODE_BIN', 'ZCODE_APPSERVER_BIN', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'FAKE_APPSERVER_MODE', 'FAKE_APPSERVER_LOG'];
const LOGIN_HINT = 'hint: often caused by a missing, expired or misconfigured ZCode login/provider — check ~/.zcode/v2/provider_config.json (baseUrl, key) or run zcode login';
let ctx;
let nextId = 1;

function tempDir(prefix) {
  const d = makeTempDir(prefix);
  temps.push(d);
  return d;
}

before(() => {
  for (const k of ENV) SAVED[k] = process.env[k];
  process.env.ZCODE_BIN = fakeBin;
});

// Per test: a private copy of the fake app-server (its path is the process marker),
// an empty temp root for the probe's work dir, a provider config fixture path.
beforeEach(() => {
  const home = tempDir('zcode-home-');
  const binDir = tempDir('zcode-fakebin-');
  const bin = join(binDir, 'fake-appserver.cjs');
  copyFileSync(fakeAppserverBin, bin);
  const tmpRoot = tempDir('zcode-probe-root-');
  const log = join(home, 'rx.log');
  Object.assign(process.env, {
    ZCODE_MCP_HOME: home,
    ZCODE_MCP_STATE: join(home, 'sessions.json'),
    ZCODE_APPSERVER_BIN: bin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(home, 'provider_config.json'),
    FAKE_APPSERVER_LOG: log,
  });
  const proto = createProtocol({
    tools: buildTools({
      store: new SessionStore(process.env.ZCODE_MCP_STATE),
      reapFn: async () => ({ lost: [], deleted: [], killed: [] }),
      probe: { tmpRoot, timeoutMs: 3000, idleTimeoutMs: 3000 },
    }),
  });
  ctx = { proto, tmpRoot, marker: basename(binDir), log, home };
});

afterEach(async () => {
  // Nothing of the probe may survive: no app-server process, no work dir.
  await assertNoLeftoverProcesses([ctx.marker]);
  assert.deepEqual(readdirSync(ctx.tmpRoot), [], 'the probe work dir was removed');
  delete process.env.FAKE_APPSERVER_MODE;
});

after(() => {
  for (const k of ENV) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
  }
  for (const d of temps) removeDir(d);
});

async function check(args = {}, proto = ctx.proto) {
  const reply = await proto.handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'zcode_check', arguments: args } });
  const text = reply.result.content[0].text;
  return { text, isError: reply.result.isError === true, payload: JSON.parse(text.split('\nmodels:')[0].split('\n[warning]')[0]) };
}

const sends = () => (existsSync(ctx.log) ? readFileSync(ctx.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.method === 'session/send') : []);

test('zcode_check schema documents probe_model and its cost', async () => {
  const reply = await ctx.proto.handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' });
  const prop = reply.result.tools.find((t) => t.name === 'zcode_check').inputSchema.properties.probe_model;
  assert.equal(prop.type, 'boolean');
  assert.match(prop.description, /one tiny model request/i);
  assert.match(prop.description, /up to ~75 s/);
});

test('without probe_model there is no modelProbe and no app-server spawn', async () => {
  const { payload } = await check({});
  assert.equal(payload.ok, true);
  assert.equal('modelProbe' in payload, false);
  assert.equal(existsSync(ctx.log), false);
});

test('probe_model must be a boolean', async () => {
  const reply = await ctx.proto.handleMessage({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'zcode_check', arguments: { probe_model: 'yes' } } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /probe_model must be a boolean/);
});

test('probe ok: one tiny send with the probe prompt, model reported, no warning', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.ok, true);
  assert.equal(payload.modelProbe.ok, true);
  assert.equal(payload.modelProbe.model, 'glm-test/small');
  assert.equal(typeof payload.modelProbe.durationMs, 'number');
  assert.equal('error' in payload.modelProbe, false);
  assert.ok(!payload.warnings.some((w) => w.startsWith('model probe failed')));
  const s = sends();
  assert.equal(s.length, 1);
  assert.equal(s[0].params.content, PROBE_PROMPT);
  assert.equal(PROBE_PROMPT, 'Reply with exactly the single word OK. Do not use any tools.');
});

test('probe auth failure: errorKind auth, a warning, top-level ok unchanged', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-auth';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.ok, true, 'ok stays "binary reachable"');
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(payload.modelProbe.errorKind, 'auth');
  assert.equal(payload.modelProbe.error, 'HTTP 401 Unauthorized: invalid api key');
  assert.equal(payload.modelProbe.model, 'glm-test/small');
  assert.ok(payload.warnings.includes('model probe failed: auth: HTTP 401 Unauthorized: invalid api key'), payload.warnings.join('|'));
});

test('probe 429: never retried (exactly one send), errorKind quota', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-429-always';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(payload.modelProbe.errorKind, 'quota');
  assert.match(payload.modelProbe.error, /HTTP 429/);
  assert.equal(sends().length, 1);
});

test('probe "Model creation failed" carries the login/provider hint', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-model-creation';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.modelProbe.errorKind, 'model');
  assert.equal(payload.modelProbe.hint, LOGIN_HINT);
});

test('a slow model ends the probe with errorKind timeout', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const t0 = Date.now();
  const { payload } = await check({ probe_model: true });
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(payload.modelProbe.errorKind, 'timeout');
  assert.match(payload.warnings.join('|'), /model probe failed: timeout: /);
});

test('no app-server at all: modelProbe ok false with an error, the check still answers', async () => {
  process.env.ZCODE_APPSERVER_BIN = join(ctx.home, 'no-such-zcode');
  const { payload, isError } = await check({ probe_model: true });
  assert.equal(isError, false);
  assert.equal(payload.ok, true);
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(typeof payload.modelProbe.error, 'string');
  assert.ok(payload.modelProbe.error.length > 0 && payload.modelProbe.error.length <= 300);
  assert.equal(payload.modelProbe.model, null);
});

test('providers are always reported; a trailing dot adds a warning', async () => {
  writeFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify({
    config: { providerConfigRules: { providerRules: [{ providerId: 'zai-coding-plan', enabled: true, config: { access: { type: 'k', apiKey: 'sk-NOPE' }, api: { type: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4.' } } }] } },
  }));
  const { payload, text } = await check({});
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers, [{ id: 'zai-coding-plan', enabled: true, baseUrl: 'https://api.z.ai/api/coding/paas/v4.', apiType: 'openai', accessType: 'k' }]);
  assert.ok(payload.warnings.includes('provider zai-coding-plan: baseUrl "https://api.z.ai/api/coding/paas/v4." ends with "." — probably a typo'));
  assert.ok(!text.includes('sk-NOPE'));
});

test('a missing provider config is no error: providers [] and no warning', async () => {
  const { payload } = await check({});
  assert.deepEqual(payload.providers, []);
  assert.deepEqual(payload.warnings, []);
});

test('stdio: zcode_check probe_model leaves no process and no temp dir behind', async () => {
  const scope = new TestScope();
  try {
    const binDir = scope.cwd(); // its name is a cleanup marker
    const bin = join(binDir, 'fake-appserver.cjs');
    copyFileSync(fakeAppserverBin, bin);
    const tmp = scope.cwd();
    mkdirSync(join(tmp, 'keep'));
    const c = scope.client({ ZCODE_APPSERVER_BIN: bin, TMPDIR: tmp, FAKE_APPSERVER_MODE: 'ok', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(scope.home, 'none.json') });
    await c.initialize();
    const { text } = await c.callTool('zcode_check', { probe_model: true }, { timeoutMs: 60000 });
    const payload = JSON.parse(text);
    assert.equal(payload.modelProbe.ok, true, text);
    assert.deepEqual(readdirSync(tmp), ['keep'], 'the probe dir under TMPDIR is gone');
  } finally {
    await scope.cleanup(); // asserts that no process carrying a marker survived
  }
});

// --- review fixes ---

test('real model_not_found payload (localized message, detail "Model creation failed") gets kind model and the hint', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-zh-model-creation';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.modelProbe.errorKind, 'model');
  assert.equal(payload.modelProbe.error, 'Provider Registry 中不存在 Model: glm-test/small | Model creation failed');
  assert.equal(payload.modelProbe.hint, LOGIN_HINT);
});

test('status-only 1113 payload: kind quota, real message, one send', async () => {
  process.env.FAKE_APPSERVER_MODE = 'fail-status-1113-always';
  const { payload } = await check({ probe_model: true });
  assert.equal(payload.modelProbe.errorKind, 'quota');
  assert.match(payload.modelProbe.error, /^\[1113\]\[Insufficient balance/);
  assert.equal(sends().length, 1);
});

function checkHandler(probe) {
  const tools = buildTools({ store: new SessionStore(process.env.ZCODE_MCP_STATE), reapFn: async () => ({ lost: [], deleted: [], killed: [] }), probe });
  return tools.find((t) => t.name === 'zcode_check').handler;
}

test('the probe has a total budget that includes start-up', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const handler = checkHandler({ tmpRoot: ctx.tmpRoot, totalMs: 1200, timeoutMs: 60000, idleTimeoutMs: 60000 });
  const t0 = Date.now();
  const payload = JSON.parse((await handler({ probe_model: true }, {})).content[0].text);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(payload.modelProbe.errorKind, 'timeout');
  assert.match(payload.modelProbe.error, /total budget of 1200 ms/);
});

test('cancelling the zcode_check request ends the probe', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const handler = checkHandler({ tmpRoot: ctx.tmpRoot, timeoutMs: 60000, idleTimeoutMs: 60000 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 800);
  const t0 = Date.now();
  const payload = JSON.parse((await handler({ probe_model: true }, { signal: ctl.signal })).content[0].text);
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(payload.modelProbe.ok, false);
  assert.equal(payload.modelProbe.errorKind, 'cancelled');
});

test('the probe hint comes from the full error text, not the 300-char excerpt', async () => {
  const long = `Provider Registry 中不存在 Model: ${'很长的说明'.repeat(80)}`;
  const run = async () => ({ ok: false, model: { providerId: 'p', modelId: 'm' }, error: { code: 'model_not_found', message: long, detail: 'Model creation failed' } });
  const probe = await probeModel({ run, tmpRoot: ctx.tmpRoot });
  assert.equal(probe.errorKind, 'model');
  assert.ok(probe.error.length <= 300);
  assert.ok(!/Model creation failed/.test(probe.error), 'the excerpt lost the English cause');
  assert.equal(probe.hint, LOGIN_HINT);
  const ok = await probeModel({ run: async () => ({ ok: false, model: null, error: { message: 'HTTP 401 Unauthorized' } }), tmpRoot: ctx.tmpRoot });
  assert.equal('hint' in ok, false);
});

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol } from '../src/protocol.mjs';
import { buildTools } from '../src/mcp-server.mjs';
import { SessionStore } from '../src/state.mjs';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';

let store;
let proto;
const call = (name, args) => proto.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const textOf = (reply) => reply.result.content[0].text;

beforeEach(() => {
  const dir = makeTempDir('zcode-tools-');
  process.env.ZCODE_BIN = fakeBin;
  process.env.ZCODE_MCP_STATE = `${dir}/sessions.json`;
  store = new SessionStore(process.env.ZCODE_MCP_STATE);
  proto = createProtocol({ tools: buildTools({ store }) });
});

test('exposes exactly the three spec tools with object schemas', async () => {
  const reply = await proto.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['zcode_check', 'zcode_run', 'zcode_sessions']);
  for (const t of reply.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  const run = reply.result.tools.find((t) => t.name === 'zcode_run');
  assert.deepEqual(run.inputSchema.required, ['prompt', 'cwd']);
});

test('zcode_check reports ok with the fake binary', async () => {
  const reply = await call('zcode_check', {});
  assert.match(textOf(reply), /"ok": true/);
  assert.match(textOf(reply), /0\.16\.9/);
});

test('zcode_run happy path: status, session_id, state entry', async () => {
  const cwd = makeTempDir('zcode-run-');
  const reply = await call('zcode_run', { prompt: 'say hi', cwd });
  const text = textOf(reply);
  assert.match(text, /status: completed/);
  assert.match(text, /session_id: sess_fake123/);
  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'sess_fake123');
  assert.equal(entries[0].kind, 'session');
  assert.equal(entries[0].status, 'completed');
  removeDir(cwd);
});

test('zcode_run records a non-resumable run-id when CLI prints no session id', async () => {
  const cwd = makeTempDir('zcode-run-');
  process.env.FAKE_ZCODE_MODE = 'nosession';
  try {
    const reply = await call('zcode_run', { prompt: 'x', cwd });
    assert.match(textOf(reply), /not resumable/);
    const entries = store.list();
    assert.equal(entries[0].kind, 'run');
    assert.match(entries[0].id, /^run_/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('zcode_run rejects relative cwd with isError and a diagnosis', async () => {
  const reply = await call('zcode_run', { prompt: 'x', cwd: 'relative/path' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /absolute/);
});

test('zcode_run refuses to resume server-generated run-ids', async () => {
  const cwd = makeTempDir('zcode-run-');
  const reply = await call('zcode_run', { prompt: 'x', cwd, resume: 'run_deadbeef_abc123' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /not resumable/);
  removeDir(cwd);
});

test('zcode_run with isolate_worktree in a non-repo returns isError with a git hint', async () => {
  const cwd = makeTempDir('zcode-norepo-');
  const reply = await call('zcode_run', { prompt: 'x', cwd, isolate_worktree: true });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /git/i);
  removeDir(cwd);
});

test('zcode_sessions lists recorded entries and flags run-ids', async () => {
  const cwd = makeTempDir('zcode-run-');
  await call('zcode_run', { prompt: 'first task', cwd });
  const reply = await call('zcode_sessions', {});
  assert.match(textOf(reply), /sess_fake123/);
  assert.match(textOf(reply), /first task/);
  const filtered = await call('zcode_sessions', { cwd: '/nowhere' });
  assert.match(textOf(filtered), /no sessions/i);
  removeDir(cwd);
});

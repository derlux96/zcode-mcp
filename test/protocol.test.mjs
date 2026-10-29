import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProtocol } from '../src/protocol.mjs';

const echoTool = {
  name: 'echo',
  description: 'echoes text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (args) => ({ content: [{ type: 'text', text: args.text }] }),
};

const makeProto = () => createProtocol({ tools: [echoTool] });

test('initialize returns tools capability and negotiated protocol version', async () => {
  const p = makeProto();
  const reply = await p.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.equal(reply.result.protocolVersion, '2025-03-26');
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result.serverInfo.name, 'zcode-delegate');
});

test('initialize falls back to 2025-06-18 for unknown versions', async () => {
  const p = makeProto();
  const reply = await p.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});

test('notifications return null (no reply written)', async () => {
  const p = makeProto();
  assert.equal(await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('ping returns empty result', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

test('tools/list returns name/description/inputSchema only', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(reply.result.tools, [{
    name: 'echo',
    description: 'echoes text',
    inputSchema: echoTool.inputSchema,
  }]);
});

test('tools/call dispatches to the handler', async () => {
  const reply = await makeProto().handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hi' } },
  });
  assert.deepEqual(reply.result.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(reply.result.isError, undefined);
});

test('tools/call with unknown tool name returns -32602', async () => {
  const reply = await makeProto().handleMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  assert.equal(reply.error.code, -32602);
});

test('unknown method returns -32601', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 7, method: 'foo/bar' });
  assert.equal(reply.error.code, -32601);
});

test('handler exceptions become -32603, not a crash', async () => {
  const boom = { ...echoTool, handler: async () => { throw new Error('boom'); } };
  const reply = await createProtocol({ tools: [boom] }).handleMessage({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'x' } },
  });
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /boom/);
});

test('serverInfo.version equals package.json version', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} });
  assert.equal(reply.result.serverInfo.version, pkg.version);
});

test('tool handlers receive an AbortSignal in ctx', async () => {
  let seen = null;
  const spy = { ...echoTool, handler: async (args, ctx) => { seen = ctx; return { content: [] }; } };
  await createProtocol({ tools: [spy] }).handleMessage({
    jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } },
  });
  assert.ok(seen && seen.signal instanceof AbortSignal);
  assert.equal(seen.signal.aborted, false);
});

test('notifications/cancelled aborts the in-flight call and no response is emitted', async () => {
  let aborted = false;
  const slow = {
    ...echoTool,
    handler: (args, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; resolve({ content: [{ type: 'text', text: 'late' }] }); });
    }),
  };
  const p = createProtocol({ tools: [slow] });
  const pending = p.handleMessage({
    jsonrpc: '2.0', id: 'req-1', method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } },
  });
  // Unknown ids are ignored; the call stays in flight.
  assert.equal(await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'other' } }), null);
  assert.equal(aborted, false);
  assert.equal(await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'req-1', reason: 'user' } }), null);
  assert.equal(aborted, true);
  assert.equal(await pending, null);
});

test('a cancelled call whose handler throws emits no response either', async () => {
  const p = createProtocol({
    tools: [{ ...echoTool, handler: (args, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }],
  });
  const pending = p.handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } });
  await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } });
  assert.equal(await pending, null);
  // The finished call is no longer tracked: a late cancel for the same id is a no-op.
  assert.equal(await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } }), null);
});

test('messages that are not JSON-RPC 2.0 get Invalid Request when they carry an id, else nothing', async () => {
  const p = makeProto();
  const bad = await p.handleMessage({ jsonrpc: '1.0', id: 7, method: 'ping' });
  assert.deepEqual(bad.error, { code: -32600, message: 'Invalid Request' });
  assert.equal(bad.id, 7);
  assert.equal(await p.handleMessage({ jsonrpc: '1.0', method: 'ping' }), null);
  assert.equal(await p.handleMessage(null), null);
  assert.equal(await p.handleMessage(5), null);
});

test('unknown tool error names the tool; a call without params names undefined', async () => {
  const p = makeProto();
  const r = await p.handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } });
  assert.deepEqual(r.error, { code: -32602, message: 'Unknown tool: nope' });
  const r2 = await p.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call' });
  assert.deepEqual(r2.error, { code: -32602, message: 'Unknown tool: undefined' });
});

test('a thrown non-Error or message-less error still becomes -32603 with a readable message', async () => {
  const throwing = (v) => ({ name: 't', description: '', inputSchema: { type: 'object' }, handler: async () => { throw v; } });
  const r1 = await createProtocol({ tools: [throwing(null)] }).handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't' } });
  assert.deepEqual(r1.error, { code: -32603, message: 'null' });
  const r2 = await createProtocol({ tools: [throwing(new Error(''))] }).handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 't' } });
  assert.deepEqual(r2.error, { code: -32603, message: 'Error' });
});

test('a finished call does not drop a newer in-flight call that reuses its id', async () => {
  let releaseFirst;
  let calls = 0;
  const slow = {
    name: 's', description: '', inputSchema: { type: 'object' },
    handler: (args, { signal }) => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) releaseFirst = () => resolve({ content: [] });
      else signal.addEventListener('abort', () => resolve({ content: [] }));
    }),
  };
  const p = createProtocol({ tools: [slow] });
  const first = p.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 's' } });
  await new Promise((r) => setImmediate(r));
  const second = p.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 's' } });
  await new Promise((r) => setImmediate(r));
  releaseFirst();
  assert.ok(await first);
  await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(await second, null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

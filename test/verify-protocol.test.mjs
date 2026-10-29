import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, answerShapes, summarizeProbeEvents, truncateText, answerReachedOutput, runControlProbes } from '../scripts/verify-protocol.mjs';

test('analyzeEvents: unique sorted types, max gap, denied tools', () => {
  const r = analyzeEvents([
    { type: 'tool.call', ts: 1000 },
    { type: 'turn.started', ts: 1200 },
    { type: 'tool.call', ts: 4200 },
    { type: 'permission.resolved', ts: 4300, decision: 'deny', toolName: 'Write' },
    { type: 'permission.resolved', ts: 4400, decision: 'deny', toolName: 'Write' },
    { type: 'permission.resolved', ts: 4500, decision: 'allow', toolName: 'Read' },
  ]);
  assert.deepEqual(r.types, ['permission.resolved', 'tool.call', 'turn.started']);
  assert.equal(r.maxGapMs, 3000);
  assert.deepEqual(r.deniedTools, ['Write']);
});

test('analyzeEvents: empty / no timestamps', () => {
  assert.deepEqual(analyzeEvents([]), { types: [], maxGapMs: 0, deniedTools: [] });
  assert.equal(analyzeEvents([{ type: 'a' }, { type: 'b' }]).maxGapMs, 0);
});

test('analyzeEvents: real events carry `timestamp`, not `ts`', () => {
  const r = analyzeEvents([{ type: 'a', timestamp: 10 }, { type: 'b', timestamp: 510 }]);
  assert.equal(r.maxGapMs, 500);
});

test('answerShapes: documented order, de-duplicated, capped at 4', () => {
  const params = { requestId: 'r1' };
  const shapes = answerShapes(params, '8080');
  assert.equal(shapes.length, 4);
  assert.deepEqual(shapes[0].result, { requestId: 'r1', answer: '8080' });
  assert.deepEqual(shapes.slice(1).map((s) => s.result), [{ answer: '8080' }, { text: '8080' }, { response: { text: '8080' } }]);
  assert.deepEqual(shapes.map((s) => s.name), ['buildUserInputAnswer', '{ answer }', '{ text }', '{ response: { text } }']);
});

test('answerShapes: drops a shape identical to the first', () => {
  // no requestId -> buildUserInputAnswer yields { requestId: undefined, answer } which JSON-equals { answer }
  const shapes = answerShapes({}, 'x');
  assert.equal(shapes.length, 3);
  assert.deepEqual(shapes.map((s) => s.name), ['buildUserInputAnswer', '{ text }', '{ response: { text } }']);
});

test('summarizeProbeEvents: terminal error, steer events', () => {
  const r = summarizeProbeEvents([
    { type: 'turn.started' },
    { type: 'turn.steerQueued' },
    { type: 'turn.steerDrained' },
    { type: 'turn.failed', payload: { error: { code: 'aborted', message: 'stopped' } } },
  ]);
  assert.deepEqual(r.types, ['turn.failed', 'turn.started', 'turn.steerDrained', 'turn.steerQueued']);
  assert.equal(r.steerQueued, true);
  assert.equal(r.steerDrained, true);
  assert.deepEqual(r.terminal, { type: 'turn.failed', errorCode: 'aborted', errorMessage: 'stopped', response: null });
});

test('summarizeProbeEvents: completed has response, no steer, empty input safe', () => {
  const r = summarizeProbeEvents([{ type: 'turn.completed', payload: { response: 'done' } }]);
  assert.equal(r.steerQueued, false);
  assert.equal(r.terminal.type, 'turn.completed');
  assert.equal(r.terminal.errorCode, null);
  assert.equal(r.terminal.response, 'done');
  assert.equal(summarizeProbeEvents(null).terminal, null);
});

test('truncateText / answerReachedOutput', () => {
  assert.equal(truncateText('a'.repeat(2500), 2000).length, 2000);
  assert.equal(truncateText(undefined, 10), '');
  assert.equal(answerReachedOutput('port 8080 chosen', '8080'), true);
  assert.equal(answerReachedOutput('nothing', '8080'), false);
  assert.equal(answerReachedOutput(null, '8080'), false);
});

test('runControlProbes against the fake app-server (ask mode)', { timeout: 60000 }, async () => {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fake-appserver.cjs');
  const saved = { b: process.env.ZCODE_APPSERVER_BIN, m: process.env.FAKE_APPSERVER_MODE };
  process.env.ZCODE_APPSERVER_BIN = fake;
  process.env.FAKE_APPSERVER_MODE = 'ask';
  try {
    const r = await runControlProbes(process.cwd(), { turnTimeoutMs: 8000, idleTimeoutMs: 8000, stopAfterMs: 100 });
    assert.deepEqual(Object.keys(r), ['steer', 'stop', 'userInput']);
    assert.ok(r.userInput.requestUserInput, JSON.stringify(r.userInput));
    assert.equal(r.userInput.workedShape, 'buildUserInputAnswer');
    assert.ok(r.stop.stopResult || r.stop.error);
  } finally {
    for (const [k, v] of [['ZCODE_APPSERVER_BIN', saved.b], ['FAKE_APPSERVER_MODE', saved.m]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

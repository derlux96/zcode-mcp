import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents } from '../scripts/verify-protocol.mjs';

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

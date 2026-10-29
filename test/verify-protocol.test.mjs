import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEvents, answerShapes, summarizeProbeEvents, truncateText, answerReachedOutput, runControlProbes, startSession, probeSteer, probeAutoDrain, STEER_MARKER, DRAIN_MARKER } from '../scripts/verify-protocol.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('answerShapes: buildUserInputAnswer first, then answer_0, then answer (ZCode 0.17.0 fallbacks)', () => {
  const params = { requestId: 'perm_1', questions: [{ question: 'Which port?', options: [] }] };
  const shapes = answerShapes(params, '8080');
  assert.deepEqual(shapes.map((s) => s.result), [
    { action: 'accept', content: { answers: { 'Which port?': '8080' } } },
    { action: 'accept', content: { answer_0: '8080' } },
    { action: 'accept', content: { answer: '8080' } },
  ]);
  assert.deepEqual(shapes.map((s) => s.name), ['buildUserInputAnswer', '{ content: { answer_0 } }', '{ content: { answer } }']);
  assert.ok(shapes.length <= 4);
});

test('answerShapes: drops a shape identical to the first', () => {
  // no questions -> buildUserInputAnswer yields {action:'accept', content:{answer}}, equal to the third shape
  const shapes = answerShapes({}, 'x');
  assert.deepEqual(shapes.map((s) => s.name), ['buildUserInputAnswer', '{ content: { answer_0 } }']);
  assert.deepEqual(shapes[0].result, { action: 'accept', content: { answer: 'x' } });
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
    const r = await runControlProbes(process.cwd(), { turnTimeoutMs: 8000, idleTimeoutMs: 8000, stopAfterMs: 100, autoDrainWaitMs: 300 });
    assert.deepEqual(Object.keys(r), ['steer', 'autoDrain', 'stop', 'userInput']);
    assert.ok(r.userInput.requestUserInput, JSON.stringify(r.userInput));
    assert.equal(r.userInput.workedShape, 'buildUserInputAnswer');
    assert.ok(r.stop.stopResult || r.stop.error);
  } finally {
    for (const [k, v] of [['ZCODE_APPSERVER_BIN', saved.b], ['FAKE_APPSERVER_MODE', saved.m]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('startSession: closes the spawned app-server when setup fails', { timeout: 30000 }, async () => {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fake-appserver.cjs');
  const saved = { b: process.env.ZCODE_APPSERVER_BIN, d: process.env.FAKE_APPSERVER_CREATE_DELAY_MS };
  process.env.ZCODE_APPSERVER_BIN = fake;
  process.env.FAKE_APPSERVER_CREATE_DELAY_MS = '5000';
  let child = null;
  try {
    await assert.rejects(startSession(process.cwd(), { timeoutMs: 300, onSpawn: (c) => { child = c; } }));
    assert.ok(child && child.pid, 'child was spawned');
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('exit', r));
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'child exited');
  } finally {
    for (const [k, v] of [['ZCODE_APPSERVER_BIN', saved.b], ['FAKE_APPSERVER_CREATE_DELAY_MS', saved.d]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

async function withFakeEnv(env, fn) {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fake-appserver.cjs');
  const all = { ZCODE_APPSERVER_BIN: fake, ...env };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  Object.assign(process.env, all);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const probeOpts = { turnTimeoutMs: 8000, idleTimeoutMs: 8000, steerAfterMs: 200, queueAfterMs: 200, autoDrainWaitMs: 2000 };

test('probeSteer: requestedDelivery guide (no setFollowupMode), drained mid-turn, marker in the answer', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vp-'));
  const log = join(dir, 'rx.log');
  try {
    const r = await withFakeEnv({ FAKE_APPSERVER_MODE: 'chatty', FAKE_APPSERVER_LOG: log }, () => probeSteer(process.cwd(), probeOpts));
    assert.equal(r.v4CommandResult.status, 'accepted');
    assert.equal(r.v4CommandResult.result.delivery, 'queue', 'ZCode acks a guide steer queue');
    assert.equal(typeof r.v4CommandResult.revisionAtDecision, 'number');
    assert.equal(r.steerDrained, true);
    assert.equal(r.markerInAnswer, true);
    assert.match(r.response, new RegExp(`steered: After the number 20 write the word ${STEER_MARKER} once\\.`));
    const cmds = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.method === 'v4/command');
    assert.deepEqual(cmds.map((m) => m.params.type), ['sendText']);
    assert.equal(cmds[0].params.payload.requestedDelivery, 'guide');
    assert.equal(cmds[0].params.payload.delivery, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeSteer: an undrained steer is reported without a marker', { timeout: 30000 }, async () => {
  const r = await withFakeEnv({ FAKE_APPSERVER_MODE: 'chatty', FAKE_APPSERVER_NO_DRAIN: '1' }, () => probeSteer(process.cwd(), probeOpts));
  assert.equal(r.steerQueued, true);
  assert.equal(r.steerDrained, false);
  assert.equal(r.markerInAnswer, false);
});

test('probeAutoDrain: the held item runs after setAutoDrain with baseRevision, stale retried once', { timeout: 30000 }, async () => {
  const r = await withFakeEnv({ FAKE_APPSERVER_MODE: 'chatty' }, () => probeAutoDrain(process.cwd(), probeOpts));
  assert.equal(r.first.v4CommandResult.status, 'accepted');
  assert.equal(r.first.steerDrained, false);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].baseRevision, r.first.v4CommandResult.revisionAtDecision);
  assert.equal(r.attempts[0].result.status, 'stale');
  assert.equal(r.attempts[1].baseRevision, r.attempts[0].result.revisionAtDecision);
  assert.equal(r.staleRetried, true);
  assert.equal(r.result.status, 'accepted');
  assert.equal(r.secondTurn, true);
  assert.ok(r.types.includes('turn.started'));
  assert.equal(r.terminal.type, 'turn.completed');
  assert.equal(r.response, `fake follow-up turn: Reply with only the word ${DRAIN_MARKER}.`);
  assert.equal(r.markerInAnswer, true);
});

test('probeAutoDrain: setAutoDrain that starts no turn records secondTurn false', { timeout: 30000 }, async () => {
  const r = await withFakeEnv({ FAKE_APPSERVER_MODE: 'chatty', FAKE_APPSERVER_AUTODRAIN_NOOP: '1' },
    () => probeAutoDrain(process.cwd(), { ...probeOpts, autoDrainWaitMs: 300 }));
  assert.equal(r.result.status, 'accepted');
  assert.equal(r.secondTurn, false);
  assert.equal(r.terminal, null);
  assert.equal(r.markerInAnswer, false);
});

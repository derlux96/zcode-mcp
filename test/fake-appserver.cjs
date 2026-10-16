#!/usr/bin/env node
// Fake ZCode app-server speaking the SERVER side of the app-server protocol
// (v1.1 mode B) for deterministic tests of src/appserver.mjs.
//
// All wire shapes are transcribed from .superpowers/v1.1/protocol-notes.md —
// do not "fix" them from memory; the notes are the source of truth.
//
// Spawn contract: node <this file> app-server --stdio
//
// FAKE_APPSERVER_MODE:
//   ok        startup noise -> session/create (response held until the
//             runtime-preferences trap is answered) -> ack session/send ->
//             session/event turn.completed ("fake model task done")
//   fail      same as ok, but the turn ends in turn.failed with
//             payload.error.message "fake model failure"
//   slowhang  answers create + subscribe, acks send, then never emits the
//             turn event (client timeout path)
//   flood     acks send, then emits 2005 model.streaming session/event
//             notifications before turn.completed — exceeds the client's
//             EVENT_BUFFER_CAP (2000) while a waiter is live (regression
//             for event-buffer saturation blinding live waiters)
//   die       startup noise, then exit(1) immediately without ever reading
//             input (child-death path; nothing is answered)
//
// FAKE_APPSERVER_LOG: path; every received message is appended as one JSON
// line (lets tests assert exact wire params the client sent).
//
// Trap enforcement: server-initiated requests must be answered with their
// documented result within 2 s or this process FAILS the connection
// (exit 1) — mirroring the real server, where an unanswered
// session/requestRuntimePreferences hangs session/create until its 15 s
// timeout. Answers to session/requestRuntimePreferences must be exactly
// {nativeSearchEnhancementsEnabled:false} (strict schema server-side).
'use strict';

const { appendFileSync } = require('node:fs');
const readline = require('node:readline');

const MODE = process.env.FAKE_APPSERVER_MODE || 'ok';
const LOG_PATH = process.env.FAKE_APPSERVER_LOG || '';
const SESSION_ID = 'sess_fakeB1';

if (!process.argv.includes('app-server')) {
  // Executed directly (e.g. by `node --test` discovery, which runs every
  // file under test/) instead of spawned as an app-server: no-op, exit 0.
  process.stderr.write('[fake-appserver] not spawned with the "app-server" subcommand; nothing to do\n');
  process.exitCode = 0;
  return;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function failConnection(reason) {
  process.stderr.write(`[fake-appserver] connection failed: ${reason}\n`);
  process.exit(1);
}

// Model catalog (notes §10: rides on session/create at
// settings.model.available; two providers, three models).
const CATALOG = [
  {
    ref: { providerId: 'glm-test', modelId: 'small' },
    label: 'small',
    providerLabel: 'GLM Test',
    contextWindow: 200000,
    maxOutputTokens: 65536,
    reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }], defaultLevel: 'high' },
    properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
  },
  {
    ref: { providerId: 'glm-test', modelId: 'big' },
    label: 'big',
    providerLabel: 'GLM Test',
    contextWindow: 1000000,
    maxOutputTokens: 524288,
    reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'high' },
    properties: { inputFormat: { supportsText: true, supportsImage: true, supportsVideo: true, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
  },
  {
    ref: { providerId: 'fake-openrouter', modelId: 'nimbus-xl' },
    label: 'nimbus-xl',
    providerLabel: 'Fake OpenRouter',
    contextWindow: 1000000,
    maxOutputTokens: 524288,
    reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'xhigh', label: 'xhigh' }, { value: 'max', label: 'max' }], defaultLevel: 'max' },
    properties: { inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
  },
];

// --- server-initiated requests (the bidirectional trap, notes §2) ---
const openServerRequests = new Map(); // id -> validate(msg) while awaiting an answer

function sendServerRequest(id, method, params, validate) {
  openServerRequests.set(id, validate);
  setTimeout(() => {
    if (openServerRequests.has(id)) failConnection(`server request ${id} unanswered after 2s`);
  }, 2000);
  send({ id, method, params });
}

function isPrefsAnswer(msg) {
  return !!(msg && msg.result && typeof msg.result === 'object' && msg.result.nativeSearchEnhancementsEnabled === false);
}

function isAnyResult(msg) {
  return !!(msg && msg.result && typeof msg.result === 'object');
}

let pendingCreate = null; // create request whose response waits on the trap
let created = false;

function answerArrived(msg) {
  const validate = openServerRequests.get(msg.id);
  if (validate === undefined) return false;
  openServerRequests.delete(msg.id);
  if (!validate(msg)) {
    failConnection(`server request ${msg.id} answered with an invalid result: ${JSON.stringify(msg.result ?? null)}`);
    return true;
  }
  if (pendingCreate) {
    const req = pendingCreate;
    pendingCreate = null;
    sendCreateResponse(req);
  }
  return true;
}

// --- request handlers ---

function handleCreate(req) {
  pendingCreate = req;
  sendServerRequest('server-1', 'session/requestRuntimePreferences', { sessionId: SESSION_ID, scope: 'runtime-materialization' }, isPrefsAnswer);
}

function sendCreateResponse(req) {
  created = true;
  const ws = (req.params && req.params.workspace) || {};
  send({
    id: req.id,
    result: {
      messages: [],
      projection: { activeToolCalls: [], backgroundJobs: [], contextUsed: 0, contextWindow: 200000, mode: 'build', pendingPermissions: [], sessionId: SESSION_ID, status: 'idle', target: null, totalTokenCount: 0, turnCount: 0 },
      protocol: { name: 'ZCode Protocol', version: 1 },
      runtime: { eventSeq: 0, pendingRequestIds: [], goalVerifications: [], goalVerificationTimeline: [], stateRevision: 0 },
      session: {
        createdAt: 1792184652807,
        mode: 'build',
        model: { providerId: 'glm-test', modelId: 'small' },
        traceId: 'ebd62caf-0000-4000-8000-000000000001',
        sessionId: SESSION_ID,
        sessionKind: 'interactive',
        status: 'idle',
        target: null,
        title: '',
        updatedAt: 1792184652807,
        workspace: { workspacePath: ws.workspacePath ?? '', workspaceKey: ws.workspaceKey ?? '' },
      },
      settings: {
        mode: { current: 'build' },
        model: {
          available: CATALOG,
          current: { providerId: 'glm-test', modelId: 'small', options: { reasoningLevel: 'high' } },
          lastUsed: { providerId: 'glm-test', modelId: 'small' },
        },
        permission: { mode: 'build' },
        thoughtLevel: { available: [], current: 'high', enabled: true },
      },
      slashCommands: [],
    },
  });
}

function notActive(req) {
  send({ id: req.id, error: { code: -32004, message: `Session is not active: ${SESSION_ID}` } });
}

function handleSubscribe(req) {
  if (!created) return notActive(req);
  send({ id: req.id, result: { eventSeq: 0, events: [], sessionId: SESSION_ID } });
}

// Keep above the client's EVENT_BUFFER_CAP (2000): the flood must push the
// event buffer into shift-on-push saturation before turn.completed lands.
const FLOOD_EVENTS = 2005;

function handleSend(req) {
  if (!created) return notActive(req);
  // Send is ACK-only (notes §5): acceptance says nothing about the turn.
  send({ id: req.id, result: { accepted: true, sessionId: SESSION_ID, stateRevision: 1 } });
  if (MODE === 'slowhang') return;
  if (MODE === 'flood') {
    setTimeout(() => {
      for (let i = 0; i < FLOOD_EVENTS; i++) {
        send({
          method: 'session/event',
          params: {
            deliveryKind: 'desktop-continuous',
            sessionId: SESSION_ID,
            turnId: 'turn_fake1',
            traceId: 'ebd62caf-0000-4000-8000-000000000001',
            eventId: `evt_flood_${i}`,
            seq: 100 + i,
            timestamp: 1792184703100,
            type: 'model.streaming',
            payload: { assistantMessageId: 'msg_fake0001', delta: 'x', done: false, kind: 'reasoning_delta' },
          },
        });
      }
      emitTurn(req);
    }, 25);
    return;
  }
  // Notes §2: a second prefs request (scope user-execution) arrives at first
  // send, plus the MCP auth-header probe (any answer is fine there).
  sendServerRequest('server-2', 'session/requestRuntimePreferences', { sessionId: SESSION_ID, scope: 'user-execution' }, isPrefsAnswer);
  sendServerRequest('server-3', 'interaction/requestOfficialMcpAuthHeaders', { mcpKey: 'image_search', pluginId: 'image-search@zcode-plugins-official', requestId: 'official-mcp-auth:1', targetOrigin: 'https://zcode.z.ai', workspace: { workspacePath: '/tmp/zt/ws', workspaceKey: '/tmp/zt/ws' } }, isAnyResult);
  setTimeout(() => emitTurn(req), 25);
}

function emitTurn(req) {
  const input = (req.params && req.params.content) || '';
  const base = { deliveryKind: 'desktop-continuous', sessionId: SESSION_ID, turnId: 'turn_fake1', traceId: 'ebd62caf-0000-4000-8000-000000000001' };
  send({
    method: 'session/event',
    params: {
      ...base,
      eventId: 'evt_fake_0001',
      seq: 10,
      timestamp: 1792184703000,
      type: 'turn.started',
      payload: { executionStartedAt: 1792184703000, turnNumber: 0, input, messageId: 'msg_fake0001', inputId: 'in_fake0001', foregroundExecutionId: 'fg_fake0001', queryId: 'q_fake0001', intent: { kind: 'task' } },
    },
  });
  send({
    method: 'session/event',
    params: {
      ...base,
      eventId: 'evt_fake_0002',
      seq: 11,
      timestamp: 1792184703100,
      type: 'model.streaming',
      payload: { assistantMessageId: 'msg_fake0001', delta: 'fake ', done: false, kind: 'reasoning_delta' },
    },
  });
  const tail = MODE === 'fail'
    ? {
        eventId: 'evt_fake_0003',
        seq: 12,
        timestamp: 1792184703455,
        type: 'turn.failed',
        payload: {
          error: { type: 'unknown_error', code: 'model_not_found', message: 'fake model failure', detail: 'Model creation failed', underlyingErrorMessage: 'fake model failure', stack: 'Error: Model creation failed\n    at fake (zcode.cjs:1:1)' },
          turnPhase: 'model_creation',
          inputId: 'in_fake0001',
        },
      }
    : {
        eventId: 'evt_fake_0003',
        seq: 12,
        timestamp: 1792184703455,
        type: 'turn.completed',
        payload: {
          response: 'fake model task done',
          tokenCount: 32485,
          usage: { source: 'provider', modelRequestCount: 1, inputTokens: 32467, outputTokens: 18, totalTokens: 32485, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 14, webFetchRequests: 0, webSearchRequests: 0 },
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: 12532,
          resultType: 'success',
          cacheStats: { totalMessages: 9, cachedMessages: 5, lastCacheHit: false },
          inputId: 'in_fake0001',
        },
      };
  send({ method: 'session/event', params: { ...base, ...tail } });
}

// --- startup noise (notes §1: ~5 startup/storageState notifications) ---
send({ method: 'startup/storageState', params: { stage: 'workspaceScan', workspaces: 1 } });
send({ method: 'startup/storageState', params: { stage: 'mcpPlugins', plugins: 4 } });
send({ method: 'startup/storageState', params: { stage: 'sessionsIndexed', sessions: 0 } });
setTimeout(() => send({ method: 'startup/storageState', params: { stage: 'warmed' } }), 80);
setTimeout(() => send({ method: 'process/resourceSample', params: { cpu: 0.42, rssMb: 512 } }), 160);

if (MODE === 'die') {
  // Exit before reading any input (a delayed exit would lose the race
  // against the prefs-trap round-trip and legitimately answer create).
  process.exit(1);
}

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // tolerate stray non-JSON lines
  }
  if (!msg || typeof msg !== 'object') return;
  if (LOG_PATH) appendFileSync(LOG_PATH, `${JSON.stringify(msg)}\n`);
  if (msg.method === undefined) {
    answerArrived(msg); // response to a server-initiated request
    return;
  }
  if (msg.id === undefined) return; // client notification (not expected) — ignore
  switch (msg.method) {
    case 'session/create': handleCreate(msg); break;
    case 'session/subscribe': handleSubscribe(msg); break;
    case 'session/send': handleSend(msg); break;
    case 'noop/hang': break; // deliberately never answered: per-request timeout path
    default:
      send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});

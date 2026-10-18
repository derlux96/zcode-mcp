#!/usr/bin/env node
// Fake ZCode app-server speaking the SERVER side of the app-server protocol
// (v1.1 mode B) for deterministic tests of src/appserver.mjs.
//
// All wire shapes are transcribed from docs/superpowers/refs/v1.1-protocol-notes.md —
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
//   rate-limit  like fail, but the error message is "429 rate limit"
//   auth-fail   like fail, but the error message is "project_token_login_failed"
//   chatty    acks send, then emits a model.streaming session/event every
//             150 ms for 1.5 s before turn.completed (idle-timeout tests)
//   tools     acks send, then emits six tool.updated session/events
//             (toolName T0..T5, kind 'scheduled') before the ok turn
//   no-model  like ok, but session/create carries no current model and an
//             empty catalog (runner falls back to the CLI path)
//   nosendack answers create + subscribe, but never answers session/send
//             (request-timeout path after the session exists)
//   die       startup noise, then exit(1) immediately without ever reading
//             input (child-death path; nothing is answered)
//   fail-429-then-ok      the first FAKE_APPSERVER_FAIL_TIMES (default 1) turns
//             fail with an HTTP 429 rate-limit text, every later turn completes
//   fail-network-then-ok  same, with "TypeError: fetch failed"
//   fail-zh-429-then-ok   same, in the real layout: localized message, the
//             English cause only in detail/underlyingErrorMessage
//   fail-429-always       every turn fails with the HTTP 429 rate-limit text
//   fail-1113-always      every turn fails with Z.ai's 1113/HTTP 429 balance text
//   fail-status-1113-always  every turn fails with only statusCode 429 +
//             statusMessage "[1113][Insufficient balance …]" (retryable:false)
//   fail-zh-model-creation  the real model_not_found payload (localized message,
//             detail "Model creation failed")
//   fail-auth             every turn fails with an HTTP 401 invalid api key
//   fail-model-request-failed  every turn fails with the generic
//             "Model request failed." (what a wrong baseUrl produces)
//   fail-model-creation   every turn fails with "Model creation failed"
//
// Turn counting for the fail-* modes: FAKE_APPSERVER_COUNTER names a file that
// holds the number of session/send requests seen so far (read, incremented and
// written per send, so tests can read it); without it the count lives in memory.
// FAKE_APPSERVER_RETRY_AFTER: seconds, added as "retry-after" to the turn.failed
// error payload of the fail-* modes. FAKE_APPSERVER_HANG_AFTER: n; sends after
// the n-th are acknowledged but their turn never ends (deadline tests).
// FAKE_APPSERVER_EXIT_AFTER_FAIL=1: exit(1) 100 ms after a failed turn
// (the app-server dies during the backoff).
//
// FAKE_APPSERVER_CREATE_DELAY_MS: delays every session/create response
// (slow model catalog lookups).
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

const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
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
// settings.model.available; three providers, four models).
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
    // Mirrors the live registry gotcha (notes §7): levels EXCLUDE 'high'
    // (our default) and defaultLevel is 'xhigh', so a requested 'high'
    // must be substituted (Controller Ruling 14).
    ref: { providerId: 'fake-openrouter', modelId: 'nimbus-xl' },
    label: 'nimbus-xl',
    providerLabel: 'Fake OpenRouter',
    contextWindow: 1000000,
    maxOutputTokens: 524288,
    reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'xhigh', label: 'xhigh' }], defaultLevel: 'xhigh' },
    properties: { inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true } },
  },
  {
    // No reasoning block: entries without levels info must pass any level
    // through and list without the parenthetical.
    ref: { providerId: 'fake-local', modelId: 'plain' },
    label: 'plain',
    providerLabel: 'Fake Local',
    contextWindow: 128000,
    maxOutputTokens: 16384,
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
    const delay = Number(process.env.FAKE_APPSERVER_CREATE_DELAY_MS) || 0;
    if (delay > 0) setTimeout(() => sendCreateResponse(req), delay);
    else sendCreateResponse(req);
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
        model: MODE === 'no-model'
          ? { available: [] }
          : {
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

const MSG_429 = 'HTTP 429 Too Many Requests: rate limit reached for requests';
const MSG_1113 = 'HTTP 429: [1113] Insufficient balance or no resource package. Please recharge.';
const ZH_NOT_FOUND = 'Provider Registry 中不存在 Model: glm-test/small';
const plain = (message) => ({ type: 'provider_error', code: null, message });
// mode -> [turn.failed payload.error, failures before the turns complete (null = FAIL_TIMES, Infinity = always)]
const FAIL_MODES = {
  'fail-429-then-ok': [plain(MSG_429), null],
  'fail-network-then-ok': [plain('TypeError: fetch failed'), null],
  'fail-zh-429-then-ok': [{ type: 'provider_error', code: 'provider_error', message: '模型请求失败', detail: 'Model request failed', underlyingErrorMessage: 'HTTP 429 Too Many Requests' }, null],
  'fail-429-always': [plain(MSG_429), Infinity],
  'fail-1113-always': [plain(MSG_1113), Infinity],
  'fail-status-1113-always': [{ type: 'provider_error', statusCode: 429, statusMessage: '[1113][Insufficient balance or no resource package. Please recharge.][req_fake]', retryable: false }, Infinity],
  'fail-auth': [plain('HTTP 401 Unauthorized: invalid api key'), Infinity],
  'fail-model-request-failed': [plain('Model request failed.'), Infinity],
  'fail-model-creation': [plain('Model creation failed'), Infinity],
  'fail-zh-model-creation': [{ type: 'unknown_error', code: 'model_not_found', message: ZH_NOT_FOUND, detail: 'Model creation failed', underlyingErrorMessage: ZH_NOT_FOUND, stack: 'Error: Model creation failed\n    at fake (zcode.cjs:1:1)' }, Infinity],
};

let memSends = 0;
function countSend() {
  const file = process.env.FAKE_APPSERVER_COUNTER;
  if (!file) return ++memSends;
  let n = 0;
  try { n = Number(readFileSync(file, 'utf8')) || 0; } catch { /* first send */ }
  n += 1;
  writeFileSync(file, String(n));
  return n;
}

// The failure for send number n of a fail-* mode, or null when this turn completes.
function scriptedFailure(n) {
  const entry = FAIL_MODES[MODE];
  if (!entry) return null;
  const times = entry[1] === null ? (Number(process.env.FAKE_APPSERVER_FAIL_TIMES) || 1) : entry[1];
  if (n > times) return null;
  const error = { ...entry[0] };
  const ra = Number(process.env.FAKE_APPSERVER_RETRY_AFTER);
  if (ra > 0) error['retry-after'] = ra;
  return error;
}

function handleSend(req) {
  if (!created) return notActive(req);
  if (MODE === 'nosendack') return;
  const n = countSend();
  // Send is ACK-only (notes §5): acceptance says nothing about the turn.
  send({ id: req.id, result: { accepted: true, sessionId: SESSION_ID, stateRevision: n } });
  if (MODE === 'slowhang') return;
  if (FAIL_MODES[MODE]) {
    // Later sends continue the same session: no second prefs/auth probe.
    if (n === 1) {
      sendServerRequest('server-2', 'session/requestRuntimePreferences', { sessionId: SESSION_ID, scope: 'user-execution' }, isPrefsAnswer);
    }
    const hangAfter = Number(process.env.FAKE_APPSERVER_HANG_AFTER);
    if (hangAfter > 0 && n > hangAfter) return;
    const failure = scriptedFailure(n);
    setTimeout(() => {
      emitTurn(req, { n, failure });
      if (failure && process.env.FAKE_APPSERVER_EXIT_AFTER_FAIL === '1') setTimeout(() => process.exit(1), 100);
    }, 25);
    return;
  }
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
  if (MODE === 'tools') {
    for (let i = 0; i < 6; i++) {
      send({
        method: 'session/event',
        params: {
          deliveryKind: 'desktop-continuous',
          sessionId: SESSION_ID,
          turnId: 'turn_fake1',
          traceId: 'ebd62caf-0000-4000-8000-000000000001',
          eventId: `evt_tool_${i}`,
          seq: 50 + i,
          timestamp: Date.now(),
          type: 'tool.updated',
          payload: { toolName: `T${i}`, toolCallId: `call_${i}`, kind: 'scheduled' },
        },
      });
    }
    setTimeout(() => emitTurn(req), 25);
    return;
  }
  if (MODE === 'chatty') {
    let n = 0;
    const t = setInterval(() => {
      send({
        method: 'session/event',
        params: {
          deliveryKind: 'desktop-continuous',
          sessionId: SESSION_ID,
          turnId: 'turn_fake1',
          traceId: 'ebd62caf-0000-4000-8000-000000000001',
          eventId: `evt_chatty_${n}`,
          seq: 100 + n,
          timestamp: Date.now(),
          type: 'model.streaming',
          payload: { assistantMessageId: 'msg_fake0001', delta: 'x', done: false, kind: 'reasoning_delta' },
        },
      });
      if (++n === 10) {
        clearInterval(t);
        emitTurn(req);
      }
    }, 150);
    return;
  }
  // Notes §2: a second prefs request (scope user-execution) arrives at first
  // send, plus the MCP auth-header probe (any answer is fine there).
  sendServerRequest('server-2', 'session/requestRuntimePreferences', { sessionId: SESSION_ID, scope: 'user-execution' }, isPrefsAnswer);
  sendServerRequest('server-3', 'interaction/requestOfficialMcpAuthHeaders', { mcpKey: 'image_search', pluginId: 'image-search@zcode-plugins-official', requestId: 'official-mcp-auth:1', targetOrigin: 'https://zcode.z.ai', workspace: { workspacePath: '/tmp/zt/ws', workspaceKey: '/tmp/zt/ws' } }, isAnyResult);
  setTimeout(() => emitTurn(req), 25);
}

function emitTurn(req, scripted = null) {
  const input = (req.params && req.params.content) || '';
  const n = scripted ? scripted.n : 1;
  const base = { deliveryKind: 'desktop-continuous', sessionId: SESSION_ID, turnId: `turn_fake${n}`, traceId: 'ebd62caf-0000-4000-8000-000000000001' };
  send({
    method: 'session/event',
    params: {
      ...base,
      eventId: scripted ? `evt_fake_${n}_1` : 'evt_fake_0001',
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
      eventId: scripted ? `evt_fake_${n}_2` : 'evt_fake_0002',
      seq: 11,
      timestamp: 1792184703100,
      type: 'model.streaming',
      payload: { assistantMessageId: 'msg_fake0001', delta: 'fake ', done: false, kind: 'reasoning_delta' },
    },
  });
  const FAILURES = { fail: 'fake model failure', 'rate-limit': '429 rate limit', 'auth-fail': 'project_token_login_failed' };
  const failMsg = FAILURES[MODE];
  if (scripted) {
    const tail = scripted.failure
      ? { type: 'turn.failed', payload: { error: scripted.failure, turnPhase: 'model_request', inputId: `in_fake${n}` } }
      : { type: 'turn.completed', payload: { response: `fake model task done after ${n} turn(s)`, resultType: 'success', inputId: `in_fake${n}` } };
    send({ method: 'session/event', params: { ...base, eventId: `evt_fake_${n}_3`, seq: 10 * n + 2, timestamp: Date.now(), ...tail } });
    return;
  }
  const tail = failMsg !== undefined
    ? {
        eventId: 'evt_fake_0003',
        seq: 12,
        timestamp: 1792184703455,
        type: 'turn.failed',
        payload: {
          error: { type: 'unknown_error', code: 'model_not_found', message: failMsg, detail: 'Model creation failed', underlyingErrorMessage: failMsg, stack: 'Error: Model creation failed\n    at fake (zcode.cjs:1:1)' },
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

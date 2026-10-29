// Mode B core: ZCode app-server protocol client with per-call model selection.
//
// Speaks the newline-delimited JSON protocol of
// `zcode app-server --stdio`. Every wire shape here is transcribed from
// docs/protocol/app-server-protocol.md (spike-verified against v3.15.3):
//   - no handshake step, but heavy startup notifications (ignore them and
//     match responses by id)
//   - the protocol is bidirectional: the server sends requests TO the
//     client. session/requestRuntimePreferences MUST be answered with
//     {nativeSearchEnhancementsEnabled:false} or session/create hangs
//     (15 s server-side timeout). Unknown server requests are answered
//     with {id, result:{}} so they can never wedge a session.
//   - interaction/requestUserInput (AskUserQuestion) answers follow ZCode's
//     strict schema {action, content?, reason?} (verified on 0.17.0)
//   - session/create takes workspace:{workspacePath,workspaceKey} (both
//     required; no top-level cwd key)
//   - session/subscribe gates session/event delivery
//   - session/send is ACK-only; the real outcome arrives as a
//     session/event notification (turn.completed / turn.failed)
//   - modelSelection requires options.reasoningLevel at send time
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { discoverZCode } from './discover.mjs';
import { signalGroup } from './procid.mjs';
import { buildSpawnEnv, DEFAULT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from './runner.mjs';
import { classifyTransient, describeTurnError, retryAfterMs, retryDelayMs } from './transient.mjs';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const DEFAULT_CONTINUE_PROMPT = 'The previous attempt was interrupted by a temporary provider error (rate limit or network). Continue the task exactly where you stopped. Do not redo work that is already finished; re-run the tests if you were in the middle of testing.';

const NODE_SCRIPT_RE = /\.(?:c|m)?js$/;
const EVENT_BUFFER_CAP = 2000;
const CLOSE_KILL_GRACE_MS = 3000;

// AppServerError.code names the case; callers branch on it, never on the message:
//   'request_timeout'  a request got no response in time
//   'idle'             no protocol activity while waiting for the turn
//   'turn_timeout'     the absolute cap while waiting for the turn
//   'aborted'          the caller's signal aborted the task
//   'no-model'         no model to select (runTaskWithModel)
//   'child_exited'     the app-server child exited or failed to start
//   'closed'           the client was closed
//   number             a JSON-RPC error response (its error.code)
export class AppServerError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'AppServerError';
    this.code = code;
    this.data = data;
  }
}

/** Binary for the app-server child: explicit override first, discovery second. */
export function resolveBin(env = process.env) {
  if (env.ZCODE_APPSERVER_BIN) return env.ZCODE_APPSERVER_BIN;
  return discoverZCode({ env });
}

/**
 * Resolve a user model spec against a settings.model.available catalog
 * (the array embedded in session/create responses, notes §10).
 *   "modelId"           -> first catalog entry offering it
 *   "providerId/modelId" -> exact provider+model match
 * Returns {providerId, modelId} or null when nothing matches.
 */
export function resolveModel(catalog, modelSpec) {
  if (!Array.isArray(catalog) || typeof modelSpec !== 'string') return null;
  const spec = modelSpec.trim();
  if (spec === '' || spec === '/') return null;
  const slash = spec.indexOf('/');
  if (slash > 0 && slash < spec.length - 1) {
    const providerId = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    const entry = catalog.find(
      (e) => e && e.ref && e.ref.providerId === providerId && e.ref.modelId === modelId,
    );
    return entry ? { providerId: entry.ref.providerId, modelId: entry.ref.modelId } : null;
  }
  const entry = catalog.find((e) => e && e.ref && e.ref.modelId === spec);
  return entry ? { providerId: entry.ref.providerId, modelId: entry.ref.modelId } : null;
}

/**
 * A catalog entry's reasoning.levels (notes §10: [{value,label},...]) as
 * plain strings. [] when the entry carries no levels info.
 */
export function entryReasoningLevels(entry) {
  const levels = entry && entry.reasoning && Array.isArray(entry.reasoning.levels)
    ? entry.reasoning.levels
    : [];
  return levels
    .map((l) => (typeof l === 'string' ? l : l && typeof l === 'object' && typeof l.value === 'string' ? l.value : null))
    .filter((v) => typeof v === 'string');
}

/**
 * Catalog-aware reasoning level (Controller Ruling 14): real catalogs offer
 * per-model level sets like ['low','medium','xhigh'] — 'high' does not exist
 * there. When the selected model's entry lists levels and the requested one
 * is not among them, substitute the entry's defaultLevel.
 * Returns { level, substitution } where substitution is
 * {requested, used} or null (no catalog info, level already offered, or no
 * usable default — in all those cases the request passes through verbatim).
 */
export function resolveReasoningLevel(catalog, providerId, modelId, requested) {
  const entry = Array.isArray(catalog)
    ? catalog.find((e) => e && e.ref && e.ref.providerId === providerId && e.ref.modelId === modelId)
    : null;
  const levels = entryReasoningLevels(entry);
  if (!levels.length || levels.includes(requested)) {
    return { level: requested, substitution: null };
  }
  const fallback = entry.reasoning.defaultLevel;
  if (typeof fallback !== 'string' || !levels.includes(fallback)) {
    return { level: requested, substitution: null };
  }
  return { level: fallback, substitution: { requested, used: fallback } };
}

// The questions of an interaction/requestUserInput (ZCode 0.17.0 AskUserQuestion:
// params.questions, mirrored in params.input.questions); [] when there are none.
function userInputQuestions(params) {
  if (!params || typeof params !== 'object') return [];
  const top = Array.isArray(params.questions) ? params.questions : null;
  const nested = params.input && typeof params.input === 'object' && Array.isArray(params.input.questions) ? params.input.questions : null;
  return (top && top.length ? top : nested || top || []).filter((q) => q && typeof q === 'object');
}

/**
 * Wire shape of an answer to interaction/requestUserInput (single place to fix).
 * ZCode 0.17.0 validates it against a strict schema {action, content?, reason?}
 * and AskUserQuestion reads content.answers[q.question] (then content.answer_<i>,
 * then content.answer for a single question): the text answers every question.
 */
export function buildUserInputAnswer(params, text) {
  const keyed = userInputQuestions(params).filter((q) => typeof q.question === 'string');
  if (!keyed.length) return { action: 'accept', content: { answer: text } };
  const answers = {};
  for (const q of keyed) answers[q.question] = text;
  return { action: 'accept', content: { answers } };
}

/** Answer that declines an interaction/requestUserInput (the model is told it was declined and continues). */
export function buildUserInputDecline(reason) {
  return typeof reason === 'string' && reason !== '' ? { action: 'decline', reason } : { action: 'decline' };
}

/**
 * The question of an interaction/requestUserInput as shown to users: one line
 * per question "<question> [options: a | b]" joined with " / "; without
 * questions the first string among params.question / prompt / message, else ''.
 */
export function describeUserInputQuestion(params) {
  const lines = userInputQuestions(params).map((q) => {
    const text = typeof q.question === 'string' ? q.question : '';
    const labels = (Array.isArray(q.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? o : o && typeof o === 'object' ? (typeof o.label === 'string' ? o.label : typeof o.value === 'string' ? o.value : null) : null))
      .filter((l) => typeof l === 'string' && l !== '');
    return [text, labels.length ? `[options: ${labels.join(' | ')}]` : ''].filter(Boolean).join(' ');
  }).filter(Boolean);
  if (lines.length) return lines.join(' / ');
  const p = params && typeof params === 'object' ? params : {};
  return [p.question, p.prompt, p.message].find((v) => typeof v === 'string') ?? '';
}

// Client options beyond the basics:
//   killGroup  spawn the app-server detached (own process group, pgid = pid)
//              and make every kill signal the whole group
//   onSpawn    (child) => void, called once the child has a pid; if it
//              throws, the child is killed and the constructor throws
//   onEvent    (params) => void, called for every session/event, in order
//   onUserInput  ({ requestId, protocolId, question, params }) => void, called when
//              ZCode asks interaction/requestUserInput; the request is parked
//              (no reply) until client.respond(protocolId, result). Without
//              the hook it is answered {action:'cancel'} immediately.
//   signal     AbortSignal; aborting closes the client (kills the child)
export class AppServerClient {
  constructor({
    binPath, cwd, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, spawnFn, killGroup = false, onSpawn, onEvent, onUserInput, signal,
  } = {}) {
    if (typeof binPath !== 'string' || binPath === '') throw new TypeError('binPath is required');
    if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd is required');
    this.binPath = binPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this._spawnFn = spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
    this._pending = new Map(); // our request id -> { resolve, reject, timer, method }
    this._events = []; // session/event params, in arrival order
    this._eventOrds = []; // ordinal of each buffered event (parallel to _events)
    this._ordinal = 0; // ordinal of the newest session/event; never shifts with the buffer
    this._eventWaiters = [];
    this._nextId = 1;
    this._lastMessageAt = Date.now();
    this._closed = false;
    this._exited = false;
    this._closePromise = null;
    this._killGroup = killGroup;
    this._onEvent = onEvent || null;
    this._onUserInput = typeof onUserInput === 'function' ? onUserInput : null;
    this._parkedInput = new Map(); // protocol id -> { protocolId, params }
    this._spawnChild();
    if (onSpawn && this.child.pid !== undefined) {
      try {
        onSpawn(this.child);
      } catch (err) {
        this._kill('SIGKILL');
        this._closed = true;
        throw err;
      }
    }
    if (signal) {
      this._signal = signal;
      this._onAbort = () => { this.close(); };
      if (signal.aborted) this.close();
      else signal.addEventListener('abort', this._onAbort, { once: true });
    }
  }

  // Signal the child, or its whole process group when killGroup is set.
  _kill(sig) {
    const pid = this.child.pid;
    if (this._killGroup && Number.isInteger(pid) && pid > 1) {
      try {
        signalGroup(pid, sig);
        return;
      } catch {
        // fall back to the child alone
      }
    }
    try {
      this.child.kill(sig);
    } catch { /* already gone */ }
  }

  get events() {
    return this._events;
  }

  /** Ordinal of the newest session/event so far (0 = none); a cursor for waitForEvent's `since`. */
  get eventOrdinal() {
    return this._ordinal;
  }

  isRunning() {
    return !this._exited;
  }

  /** Resolves once the app-server child has exited (or failed to start). */
  get exited() {
    return this._exitPromise;
  }

  _spawnChild() {
    // Same env handling and node-script convention as mode A (runner.mjs):
    // the macOS app bundle ships zcode as a node script and may need the
    // sibling builtin provider config injected.
    const env = buildSpawnEnv(this.binPath);
    const appArgs = ['app-server', '--stdio'];
    const opts = this._killGroup ? { cwd: this.cwd, env, detached: true } : { cwd: this.cwd, env };
    this.child = NODE_SCRIPT_RE.test(this.binPath)
      ? this._spawnFn(process.execPath, [this.binPath, ...appArgs], opts)
      : this._spawnFn(this.binPath, appArgs, opts);

    this.child.stdin.on('error', () => {}); // EPIPE when the child dies mid-write
    this.child.stderr.on('data', () => {}); // keep draining; never protocol

    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== '') this._onLine(line);
      }
    });

    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
    this.child.on('close', (code, signal) =>
      this._onChildGone(`app-server child exited (code=${code} signal=${signal})`),
    );
    // Fires without 'close' when the spawn itself fails (ENOENT etc.).
    this.child.on('error', (err) =>
      this._onChildGone(`app-server child failed to start: ${err.message}`),
    );
  }

  _onChildGone(message) {
    if (this._exited) return;
    this._exited = true;
    this._parkedInput.clear(); // nobody is left to read an answer
    this._failAll(new AppServerError(message, { code: 'child_exited' }));
    this._resolveExit();
  }

  _onLine(line) {
    this._lastMessageAt = Date.now();
    // Any protocol traffic is activity for waiters with an idle timer.
    for (const waiter of this._eventWaiters) {
      if (waiter.idleMs) this._armIdle(waiter);
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // tolerate stray non-JSON output on stdout
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) this._handleServerRequest(msg);
      else this._handleNotification(msg);
    } else if (msg.id !== undefined) {
      this._onResponse(msg);
    }
  }

  _onResponse(msg) {
    const pending = this._pending.get(msg.id);
    if (!pending) return; // answer to a server-initiated request; nothing to do
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new AppServerError(`${pending.method} failed: ${msg.error.message} (code ${msg.error.code})`, {
          code: msg.error.code,
          data: msg.error.data ?? null,
        }),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  _handleNotification(msg) {
    // Only session/event matters; startup/storageState, process/*,
    // state.updated, computer-use/*, v4/telemetry are ignored (notes §6/§11).
    if (msg.method !== 'session/event' || !msg.params || typeof msg.params !== 'object') return;
    const ord = ++this._ordinal;
    if (this._events.length >= EVENT_BUFFER_CAP) {
      this._events.shift();
      this._eventOrds.shift();
    }
    this._events.push(msg.params);
    this._eventOrds.push(ord);
    if (this._onEvent) {
      try {
        this._onEvent(msg.params);
      } catch { /* a failing observer must not wedge the protocol */ }
    }
    this._dispatchEvent(msg.params, ord);
  }

  _handleServerRequest(msg) {
    // Known server requests get their documented result; anything unknown
    // gets an empty result so it can never hang the session.
    let result = {};
    if (msg.method === 'interaction/requestUserInput' && this._onUserInput) {
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      this._parkedInput.set(msg.id, { protocolId: msg.id, params });
      // Never "[object Object]": only string texts are shown.
      const question = describeUserInputQuestion(params);
      try {
        this._onUserInput({ requestId: params.requestId, protocolId: msg.id, question, params });
      } catch { /* a failing observer must not wedge the protocol */ }
      return;
    }
    if (msg.method === 'session/requestRuntimePreferences') {
      result = { nativeSearchEnhancementsEnabled: false };
    } else if (msg.method === 'interaction/requestUserInput') {
      // Nobody can answer: a valid cancel (ZCode's answer schema is strict; {} fails it).
      result = { action: 'cancel' };
    }
    this._send({ id: msg.id, result });
  }

  /** Number of requestUserInput requests parked and not yet answered. */
  get pendingUserInput() {
    return this._parkedInput.size;
  }

  /** Parked requestUserInput requests, oldest first: [{ protocolId, params }]. */
  get parkedUserInput() {
    return [...this._parkedInput.values()];
  }

  /**
   * Answer a parked server request (see onUserInput). Sends only when the id
   * is still parked (so a late second answer for the same question is
   * dropped); returns true when sent, false otherwise.
   */
  /**
   * Drops every parked requestUserInput without answering it (the attempt that
   * asked has ended). Returns how many were dropped.
   */
  abandonParked() {
    const n = this._parkedInput.size;
    this._parkedInput.clear();
    return n;
  }

  respond(protocolId, result) {
    if (!this._parkedInput.has(protocolId)) return false;
    this._parkedInput.delete(protocolId);
    this._send({ id: protocolId, result });
    return true;
  }

  _send(obj) {
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // EPIPE on a dead child surfaces via the close handler instead
    }
  }

  request(method, params, { timeoutMs } = {}) {
    if (this._closed) {
      return Promise.reject(new AppServerError(`client is closed; cannot send ${method}`, { code: 'closed' }));
    }
    if (this._exited) {
      return Promise.reject(new AppServerError(`app-server child is not running; cannot send ${method}`, { code: 'child_exited' }));
    }
    const id = this._nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${effectiveTimeout} ms without a response`, { code: 'request_timeout' }));
      }, effectiveTimeout);
      this._pending.set(id, { resolve, reject, timer, method });
      this._send({ id, method, params: params ?? {} });
    });
  }

  /**
   * Resolve with the first buffered-or-future session/event params whose
   * `type` matches (string or array of strings). With `since` (an
   * eventOrdinal taken earlier) only events that arrived after it match, so a
   * wait after a new session/send never sees the previous turn's outcome.
   * Rejects on timeout or when the child is gone.
   */
  waitForEvent(types, { timeoutMs = this.timeoutMs, idleTimeoutMs = null, since = null } = {}) {
    const wanted = Array.isArray(types) ? types : [types];
    const after = Number.isInteger(since) ? since : -Infinity;
    const match = (p, ord) => ord > after && !!p && typeof p === 'object' && wanted.includes(p.type);
    const idx = this._events.findIndex((p, i) => match(p, this._eventOrds[i]));
    if (idx >= 0) return Promise.resolve(this._events[idx]);
    if (this._exited || this._closed) {
      return Promise.reject(
        new AppServerError(`app-server is gone; cannot wait for session/event ${wanted.join('|')}`, {
          code: this._exited ? 'child_exited' : 'closed',
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject, timer: null, idleTimer: null, idleMs: idleTimeoutMs, wanted };
      const give = (fn) => (value) => {
        this._clearWaiter(waiter);
        fn(value);
      };
      waiter.resolve = give(resolve);
      waiter.reject = give(reject);
      // Absolute cap for the whole wait; timeoutMs 0 = no cap (only the idle timer, if any, guards the wait).
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.reject(new AppServerError(`timed out after ${timeoutMs} ms waiting for session/event ${wanted.join('|')}`, { code: 'turn_timeout' }));
        }, timeoutMs);
      }
      if (waiter.idleMs) this._armIdle(waiter);
      this._eventWaiters.push(waiter);
    });
  }

  // Idle timer: aborts only when no protocol traffic arrives for idleMs.
  _armIdle(waiter) {
    clearTimeout(waiter.idleTimer);
    waiter.idleTimer = setTimeout(() => {
      // A parked question is the user's turn, not ZCode going quiet.
      if (this._parkedInput.size > 0) {
        this._armIdle(waiter);
        return;
      }
      waiter.reject(new AppServerError(`timed out: no activity for ${waiter.idleMs} ms waiting for session/event ${waiter.wanted.join('|')}`, { code: 'idle' }));
    }, waiter.idleMs);
  }

  _clearWaiter(waiter) {
    const idx = this._eventWaiters.indexOf(waiter);
    if (idx >= 0) this._eventWaiters.splice(idx, 1);
    clearTimeout(waiter.timer);
    clearTimeout(waiter.idleTimer);
  }

  /**
   * Deliver one incoming session/event directly to matching waiters. No
   * index bookkeeping on purpose: the buffer is capped and shifts once
   * saturated, which used to strand waiters whose scan start pinned at the
   * cap while every new event landed below it.
   */
  _dispatchEvent(params, ord) {
    for (let i = this._eventWaiters.length - 1; i >= 0; i--) {
      const waiter = this._eventWaiters[i];
      if (waiter.match(params, ord)) {
        waiter.resolve(params); // clears the timers and removes the waiter
      }
    }
  }

  _failAll(err) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    for (const waiter of this._eventWaiters.slice()) {
      waiter.reject(err); // clears the timers and removes the waiter
    }
  }

  /**
   * Wait for startup notifications to settle: a short quiet window after
   * the last received line, capped (notes §1: ~5 startup/storageState
   * notifications in the first ~600 ms; requests work immediately, this
   * just avoids interleaving with the noisiest phase).
   */
  async settle({ quietMs = 150, maxMs = 2000 } = {}) {
    const start = Date.now();
    while (!this._exited && Date.now() - start < maxMs) {
      if (Date.now() - this._lastMessageAt >= quietMs) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Kill the child (SIGTERM, escalating to SIGKILL). Idempotent. */
  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._parkedInput.clear();
    if (this._signal) this._signal.removeEventListener('abort', this._onAbort);
    this._closePromise = (async () => {
      if (!this._exited) {
        this._kill('SIGTERM');
        const killTimer = setTimeout(() => this._kill('SIGKILL'), CLOSE_KILL_GRACE_MS);
        await this._exitPromise;
        clearTimeout(killTimer);
      } else if (this._killGroup) {
        this._kill('SIGKILL'); // leader gone: take down any group members it left behind
      }
      this._failAll(new AppServerError('app-server client closed', { code: 'closed' }));
    })();
    return this._closePromise;
  }
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'modelRequestCount'];

/**
 * Adds one turn's payload.usage to the running total. Non-object u leaves acc
 * unchanged (null stays null); missing or non-finite fields count as 0.
 */
export function addUsage(acc, u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return acc;
  const out = {};
  for (const k of USAGE_FIELDS) {
    const v = Number(u[k]);
    out[k] = (acc ? acc[k] : 0) + (Number.isFinite(v) ? v : 0);
  }
  return out;
}

export const DEFAULT_RETRY_DELAYS_MS = [30000, 60000, 120000, 300000, 600000, 900000];
export const DEFAULT_MAX_TRANSIENT_RETRIES = 6;

// Abortable wait for a backoff; the timer is cleared when `signal` aborts.
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

// The turn.failed payload.error as returned to callers: code and message (falling
// back to the other text fields) plus every other diagnostic field that is present;
// the stack is dropped.
const TURN_ERROR_FIELDS = ['type', 'detail', 'underlyingErrorMessage', 'statusCode', 'status', 'statusMessage', 'retryable', 'retryAfter', 'retry-after', 'Retry-After'];
function turnError(raw) {
  const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const error = {
    code: raw.code ?? null,
    message: text(raw.message) ?? text(raw.statusMessage) ?? text(raw.underlyingErrorMessage) ?? text(raw.detail) ?? 'turn failed without an error payload',
  };
  for (const f of TURN_ERROR_FIELDS) {
    if (raw[f] !== undefined && raw[f] !== null) error[f] = raw[f];
  }
  return error;
}

// The backoff wait: ends early when the caller aborts, control.stop() is
// called, or the app-server exits (a dead app-server has no session left to continue).
async function backoff(client, retry, delayMs, signals) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  const live = signals.filter(Boolean);
  for (const s of live) {
    if (s.aborted) stop();
    else s.addEventListener('abort', stop, { once: true });
  }
  client.exited.then(stop);
  try {
    await retry.sleep(delayMs, ctl.signal);
  } finally {
    for (const s of live) s.removeEventListener('abort', stop);
  }
}

// A JSON-RPC answer meaning "this server does not know the method".
function notSupported(err) {
  return err instanceof AppServerError && (err.code === -32601 || /method not found|unknown method/i.test(err.message));
}

// The request failed because the client or its child is gone.
function isGone(err) {
  return err instanceof AppServerError && (err.code === 'closed' || err.code === 'child_exited');
}

let steerSeq = 0; // keeps commandIds unique when Date.now() repeats

function retryOptions(transientRetry) {
  const o = transientRetry && typeof transientRetry === 'object' ? transientRetry : {};
  const delaysMs = Array.isArray(o.delaysMs) && o.delaysMs.length && o.delaysMs.every((d) => Number.isFinite(d) && d >= 0)
    ? o.delaysMs
    : DEFAULT_RETRY_DELAYS_MS;
  return {
    maxRetries: Number.isInteger(o.maxRetries) && o.maxRetries >= 0 ? o.maxRetries : DEFAULT_MAX_TRANSIENT_RETRIES,
    delaysMs,
    jitter: Number.isFinite(o.jitter) && o.jitter >= 0 ? o.jitter : 0.1,
    continuePrompt: typeof o.continuePrompt === 'string' && o.continuePrompt.trim() !== '' ? o.continuePrompt : DEFAULT_CONTINUE_PROMPT,
    classify: typeof o.classify === 'function' ? o.classify : classifyTransient,
    onRetry: typeof o.onRetry === 'function' ? o.onRetry : null,
    sleep: typeof o.sleep === 'function' ? o.sleep : abortableSleep,
  };
}

/**
 * One-shot mode B task: create a session with an explicit model selection,
 * run the prompt to turn completion, and tear the server down.
 * Returns { ok, sessionId, response, failed, error, catalog, model,
 * reasoningSubstitution } on turn completion — reasoningSubstitution is
 * {requested, used} when the requested reasoningLevel was not offered by
 * the model's catalog entry and its defaultLevel was sent instead, else
 * null. Rejects on timeouts, protocol errors, and child death.
 *
 * providerId/modelId are optional as a pair: when both are omitted the
 * session's own settings.model.current is used, else the first catalog
 * entry; with neither, rejects with AppServerError code 'no-model'.
 * Errors before session/send (spawn, settle, session/create, subscribe)
 * carry `startup: true`; once session/create succeeded every error carries
 * the real `sessionId` (the session is resumable). Aborting `signal` closes
 * the client and rejects with AppServerError code 'aborted'.
 * killGroup/onSpawn/onEvent are passed to AppServerClient; requestTimeoutMs
 * is the per-request response timeout.
 *
 * Transient provider errors (src/transient.mjs): a turn.failed whose error is
 * transient does not end the task while retries remain. After an abortable
 * wait (delaysMs[min(k-1, last)] ± jitter with k = the retry count within the
 * error's class, or a retry-after; onRetry({attempt, maxRetries, classAttempt,
 * classMaxRetries, klass, delayMs, reason, at}) fires before it) continuePrompt is sent into the SAME session with the same
 * modelSelection. transientRetry: { maxRetries = 6 (0 disables), delaysMs,
 * jitter = 0.1, continuePrompt, classify (-> {transient, klass, maxRetries?};
 * a class cap such as the balance class's 2 retries applies on top of
 * maxRetries), onRetry, sleep(ms, signal) }. The wait also ends at once when the
 * app-server exits (rejecting with code 'child_exited'). The returned `error`
 * carries code, message and the payload's other diagnostic fields (type, detail,
 * underlyingErrorMessage, statusCode, statusMessage, retryable, ...).
 * Job control: onControl(control) is called once, right after session/subscribe
 * succeeds and before the first session/send, with
 *   control.stop()      -> Promise<'accepted'|'not_supported'>; sends session/stop.
 *                          The turn that ends after a stop is returned as failed
 *                          without any retry, whatever its error looks like, and
 *                          a running backoff ends at once. Other request errors
 *                          (e.g. request_timeout) reject.
 *   control.steer(text) -> Promise<{status:'accepted'|'rejected'|'not_supported', reason?}>;
 *                          sends a v4/command sendText with delivery 'guide';
 *                          rejected 'retry' during a backoff, else the server's
 *                          reasonCode. Other request errors reject.
 *   control.answer(text) -> {status:'accepted'|'rejected', reason?}; answers the
 *                          oldest parked requestUserInput (needs onUserInput),
 *                          rejected 'no_question' when nothing is parked.
 *   control.capabilities -> {stop, steer, userInput}: null until known; stop and
 *                          steer turn false on the first "method not found"
 *                          answer (later calls then return not_supported without
 *                          a request), true on any other answer; userInput turns
 *                          true when a question is parked.
 * The control is only useful while the task runs: after the client is closed,
 * stop() answers 'not_supported', steer() {status:'rejected', reason:'closed'}
 * and answer() rejected 'no_question'. onUserInput is passed to the client
 * (parking interaction/requestUserInput); without it questions are answered {action:'cancel'}.
 * When a failed turn is retried, parked questions are dropped unanswered and
 * onUserInputAbandoned() is called (the asking attempt has ended).
 * timeoutMs > 0 is a deadline for the whole task from the first send: every
 * wait gets the remaining time and a backoff that would pass it is not
 * started. The result carries retries [{at, attempt, delayMs, reason}] and
 * retryStop: null | 'exhausted' | 'deadline' (why a transient failure was
 * returned); a rejection after a retry carries err.retries.
 */
export async function runTaskWithModel({
  binPath,
  cwd,
  prompt,
  providerId,
  modelId,
  reasoningLevel = 'high',
  timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnFn,
  killGroup = false,
  onSpawn,
  onEvent,
  onUserInput,
  onUserInputAbandoned,
  onControl,
  signal,
  transientRetry,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('prompt must be a non-empty string');
  }
  const explicitModel = providerId !== undefined || modelId !== undefined;
  if (explicitModel && (typeof providerId !== 'string' || providerId.trim() === '')) {
    throw new TypeError('providerId must be a non-empty string');
  }
  if (explicitModel && (typeof modelId !== 'string' || modelId.trim() === '')) {
    throw new TypeError('modelId must be a non-empty string');
  }
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new TypeError('cwd must be an absolute path');
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new TypeError(`cwd does not exist or is not a directory: ${cwd}`);
  if (typeof reasoningLevel !== 'string' || reasoningLevel.trim() === '') {
    throw new TypeError('reasoningLevel must be a non-empty string');
  }

  const aborted = () => new AppServerError('app-server task aborted', { code: 'aborted' });
  const turnTimeout = (ms) => new AppServerError(`timed out after ${ms} ms waiting for session/event turn.completed|turn.failed`, { code: 'turn_timeout' });
  if (signal && signal.aborted) throw aborted();
  let client;
  const capabilities = { stop: null, steer: null, userInput: null };
  // Only hook requestUserInput when the caller listens; otherwise the client
  // answers {} at once and nothing can be left parked forever.
  const userInputHook = typeof onUserInput === 'function'
    ? (req) => { capabilities.userInput = true; onUserInput(req); }
    : undefined;
  try {
    client = new AppServerClient({ binPath, cwd, timeoutMs: requestTimeoutMs, spawnFn, killGroup, onSpawn, onEvent, onUserInput: userInputHook, signal });
  } catch (err) {
    if (err instanceof AppServerError) err.startup = true;
    throw err;
  }
  let startup = true;
  let sessionId = null;
  const retry = retryOptions(transientRetry);
  const retries = [];
  let usage = null;
  let stopRequested = false;
  let backingOff = false;
  const stopCtl = new AbortController();

  // The job-control handle given to onControl (see the doc comment above).
  function makeControl() {
    return {
      capabilities,
      async stop() {
        if (capabilities.stop === false) return 'not_supported';
        // Set before the request: the server may end the turn before it answers.
        const wasRequested = stopRequested;
        stopRequested = true;
        try {
          await client.request('session/stop', { sessionId });
        } catch (err) {
          stopRequested = wasRequested;
          if (notSupported(err)) {
            capabilities.stop = false;
            return 'not_supported';
          }
          if (isGone(err)) return 'not_supported';
          throw err;
        }
        capabilities.stop = true;
        stopCtl.abort(); // end a running backoff at once
        return 'accepted';
      },
      async steer(text) {
        if (capabilities.steer === false) return { status: 'not_supported' };
        if (backingOff) return { status: 'rejected', reason: 'retry' };
        const now = Date.now();
        const command = {
          commandId: `steer-${sessionId}-${now}-${++steerSeq}`,
          clientId: 'zcode-delegate',
          sessionId,
          type: 'sendText',
          payload: { text, delivery: { requested: 'guide' } },
          issuedAt: now,
        };
        let result;
        try {
          result = await client.request('v4/command', command);
        } catch (err) {
          if (notSupported(err)) {
            capabilities.steer = false;
            return { status: 'not_supported' };
          }
          if (isGone(err)) return { status: 'rejected', reason: 'closed' };
          throw err;
        }
        capabilities.steer = true;
        if (result && result.status === 'accepted') return { status: 'accepted' };
        return { status: 'rejected', reason: (result && typeof result.reasonCode === 'string' && result.reasonCode) || 'rejected' };
      },
      answer(text) {
        const oldest = client.parkedUserInput[0];
        if (!oldest || !client.respond(oldest.protocolId, buildUserInputAnswer(oldest.params, text))) {
          return { status: 'rejected', reason: 'no_question' };
        }
        return { status: 'accepted' };
      },
    };
  }

  try {
    await client.settle();

    // No top-level cwd param: the workspace lives in a nested object with
    // BOTH keys required (notes §3). workspaceKey === workspacePath in
    // every observed session.
    // mode: yolo is the documented autonomous semantics. Without it the
    // session falls back to 'build', which denies every side-effect tool
    // (Write, Bash) because nothing can approve the request, so the task
    // "completes" without changing any file.
    const created = await client.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
      mode: 'yolo',
    });
    sessionId = (created && created.session && created.session.sessionId) || null;
    if (!sessionId) throw new AppServerError('session/create response is missing session.sessionId');
    const catalog = (created.settings && created.settings.model && created.settings.model.available) || null;
    if (!explicitModel) {
      const current = created.settings && created.settings.model && created.settings.model.current;
      const first = Array.isArray(catalog) && catalog[0] && catalog[0].ref;
      const pick = current && current.providerId && current.modelId ? current
        : first && first.providerId && first.modelId ? first
          : null;
      if (!pick) throw new AppServerError('no model available: session/create carries no current model and no catalog', { code: 'no-model' });
      providerId = pick.providerId;
      modelId = pick.modelId;
    }

    // Catalog-aware reasoning level (Controller Ruling 14): live catalogs
    // offer level sets like ['low','medium','xhigh'] — 'high' (our default)
    // does not exist there. Adjust the send's level against the selected
    // model's own entry and report the substitution for the caller to print.
    const { level: effectiveReasoningLevel, substitution: reasoningSubstitution } =
      resolveReasoningLevel(catalog, providerId, modelId, reasoningLevel);

    // Gates session/event delivery on the real server (notes §4).
    await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });

    if (typeof onControl === 'function') {
      try {
        onControl(makeControl());
      } catch { /* an observer must not end the task */ }
    }

    // ACK-only: acceptance says nothing about model validity; the turn
    // outcome arrives as a session/event notification (notes §5/§6).
    startup = false; // from here on the task may be running: never retry
    const modelSelection = { providerId, modelId, options: { reasoningLevel: effectiveReasoningLevel } };
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
    const base = { sessionId, catalog, model: { providerId, modelId }, reasoningSubstitution, retries };
    let content = prompt;
    for (;;) {
      const cursor = client.eventOrdinal;
      await client.request('session/send', { sessionId, content, modelSelection });
      const left = deadline === null ? 0 : deadline - Date.now();
      if (deadline !== null && left <= 0) throw turnTimeout(timeoutMs);
      let event;
      try {
        event = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: left, idleTimeoutMs, since: cursor });
      } catch (err) {
        throw err instanceof AppServerError && err.code === 'turn_timeout' ? turnTimeout(timeoutMs) : err;
      }
      usage = addUsage(usage, event.payload && event.payload.usage);
      // stopped: a session/stop was sent before this terminal event arrived; the
      // caller records the job cancelled even when the turn completed.
      const stopped = stopRequested;
      if (event.type === 'turn.completed') {
        return { ...base, usage, ok: true, response: (event.payload && event.payload.response) ?? '', failed: false, error: null, retryStop: null, stopped };
      }
      const raw = (event.payload && event.payload.error) || {};
      const error = turnError(raw);
      const failed = (retryStop) => ({ ...base, usage, ok: false, response: null, failed: true, error, retryStop, stopped: stopped || stopRequested });
      if (stopRequested) return failed(null); // a stopped turn is never retried
      const cls = retry.classify(error) || {};
      if (!cls.transient) return failed(null);
      const classCap = Number.isInteger(cls.maxRetries) ? cls.maxRetries : Infinity;
      const ofClass = retries.filter((r) => r.klass === cls.klass).length;
      if (retries.length >= retry.maxRetries || ofClass >= classCap) return failed(retry.maxRetries > 0 ? 'exhausted' : null);
      const attempt = retries.length + 1;
      // Delays and the k/N display count within the class (balance: 30 s, 60 s even
      // after earlier rate-limit retries); the history keeps the global attempt.
      const classAttempt = ofClass + 1;
      const classMaxRetries = Math.min(retry.maxRetries, classCap);
      const delayMs = retryDelayMs(classAttempt, { delaysMs: retry.delaysMs, jitter: retry.jitter, retryAfter: retryAfterMs(raw) });
      if (deadline !== null && Date.now() + delayMs >= deadline) return failed('deadline');
      const at = new Date().toISOString();
      const reason = describeTurnError(error);
      const klass = cls.klass ?? null;
      // A pending user-input request ends with the failed attempt: the retry
      // starts a new turn that never sees an answer to it.
      if (client.abandonParked() > 0 && typeof onUserInputAbandoned === 'function') {
        try { onUserInputAbandoned(); } catch { /* an observer must not end the task */ }
      }
      retries.push({ at, attempt, delayMs, reason, klass });
      if (retry.onRetry) {
        try {
          retry.onRetry({ attempt, maxRetries: retry.maxRetries, classAttempt, classMaxRetries, klass, delayMs, reason, at });
        } catch { /* an observer must not end the task */ }
      }
      backingOff = true;
      try {
        await backoff(client, retry, delayMs, [signal, stopCtl.signal]);
      } finally {
        backingOff = false;
      }
      if (signal && signal.aborted) throw aborted();
      if (stopRequested) return failed(null);
      if (!client.isRunning()) {
        throw new AppServerError('app-server child exited during the backoff after a transient error', { code: 'child_exited' });
      }
      content = retry.continuePrompt;
    }
  } catch (err) {
    const out = signal && signal.aborted ? aborted() : err;
    if (startup && out instanceof AppServerError && out.code !== 'no-model' && out.code !== 'aborted') out.startup = true;
    if (sessionId && out && typeof out === 'object') out.sessionId = sessionId;
    if (retries.length && out && typeof out === 'object') out.retries = retries;
    if (out && typeof out === 'object') out.usage = usage;
    if (out && typeof out === 'object') out.stopped = stopRequested;
    throw out;
  } finally {
    await client.close();
  }
}

/**
 * Fetch the machine's model catalog (settings.model.available from a
 * session/create response, notes §10) without running a turn: spawn the
 * app-server, create one throwaway session, close. Returns the catalog
 * array, or null when the response carries none. Rejects on protocol
 * errors, timeouts, and child death — callers decide how to degrade.
 */
export async function getModelCatalog({
  binPath,
  cwd,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  spawnFn,
} = {}) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new TypeError('cwd must be an absolute path');
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new TypeError(`cwd does not exist or is not a directory: ${cwd}`);

  const client = new AppServerClient({ binPath, cwd, spawnFn });
  try {
    await client.settle();
    const created = await client.request(
      'session/create',
      { workspace: { workspacePath: cwd, workspaceKey: cwd } },
      { timeoutMs },
    );
    return (created.settings && created.settings.model && created.settings.model.available) || null;
  } finally {
    await client.close();
  }
}

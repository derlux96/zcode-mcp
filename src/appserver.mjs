// Mode B core: ZCode app-server protocol client with per-call model selection.
//
// Speaks the newline-delimited JSON protocol of
// `zcode app-server --stdio`. Every wire shape here is transcribed from
// .superpowers/v1.1/protocol-notes.md (spike-verified against v3.15.3):
//   - no handshake step, but heavy startup notifications (ignore them and
//     match responses by id)
//   - the protocol is bidirectional: the server sends requests TO the
//     client. session/requestRuntimePreferences MUST be answered with
//     {nativeSearchEnhancementsEnabled:false} or session/create hangs
//     (15 s server-side timeout). Unknown server requests are answered
//     with {id, result:{}} so they can never wedge a session.
//   - session/create takes workspace:{workspacePath,workspaceKey} (both
//     required; no top-level cwd key)
//   - session/subscribe gates session/event delivery
//   - session/send is ACK-only; the real outcome arrives as a
//     session/event notification (turn.completed / turn.failed)
//   - modelSelection requires options.reasoningLevel at send time
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { discoverZCode } from './discover.mjs';
import { buildSpawnEnv, DEFAULT_TIMEOUT_MS } from './runner.mjs';

export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_TASK_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

const NODE_SCRIPT_RE = /\.(?:c|m)?js$/;
const EVENT_BUFFER_CAP = 2000;
const CLOSE_KILL_GRACE_MS = 3000;

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

export class AppServerClient {
  constructor({ binPath, cwd, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, spawnFn } = {}) {
    if (typeof binPath !== 'string' || binPath === '') throw new TypeError('binPath is required');
    if (typeof cwd !== 'string' || cwd === '') throw new TypeError('cwd is required');
    this.binPath = binPath;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this._spawnFn = spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
    this._pending = new Map(); // our request id -> { resolve, reject, timer, method }
    this._events = []; // session/event params, in arrival order
    this._eventWaiters = [];
    this._nextId = 1;
    this._lastMessageAt = Date.now();
    this._closed = false;
    this._exited = false;
    this._closePromise = null;
    this._spawnChild();
  }

  get events() {
    return this._events;
  }

  isRunning() {
    return !this._exited;
  }

  _spawnChild() {
    // Same env handling and node-script convention as mode A (runner.mjs):
    // the macOS app bundle ships zcode as a node script and may need the
    // sibling builtin provider config injected.
    const env = buildSpawnEnv(this.binPath);
    const appArgs = ['app-server', '--stdio'];
    this.child = NODE_SCRIPT_RE.test(this.binPath)
      ? this._spawnFn(process.execPath, [this.binPath, ...appArgs], { cwd: this.cwd, env })
      : this._spawnFn(this.binPath, appArgs, { cwd: this.cwd, env });

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
    this._failAll(new AppServerError(message));
    this._resolveExit();
  }

  _onLine(line) {
    this._lastMessageAt = Date.now();
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
    if (this._events.length >= EVENT_BUFFER_CAP) this._events.shift();
    this._events.push(msg.params);
    this._dispatchEvent(msg.params);
  }

  _handleServerRequest(msg) {
    // Known server requests get their documented result; anything unknown
    // gets an empty result so it can never hang the session.
    let result = {};
    if (msg.method === 'session/requestRuntimePreferences') {
      result = { nativeSearchEnhancementsEnabled: false };
    }
    this._send({ id: msg.id, result });
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
      return Promise.reject(new AppServerError(`client is closed; cannot send ${method}`));
    }
    if (this._exited) {
      return Promise.reject(new AppServerError(`app-server child is not running; cannot send ${method}`));
    }
    const id = this._nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${effectiveTimeout} ms without a response`));
      }, effectiveTimeout);
      this._pending.set(id, { resolve, reject, timer, method });
      this._send({ id, method, params: params ?? {} });
    });
  }

  /**
   * Resolve with the first buffered-or-future session/event params whose
   * `type` matches (string or array of strings). Rejects on timeout or when
   * the child is gone.
   */
  waitForEvent(types, { timeoutMs = this.timeoutMs } = {}) {
    const wanted = Array.isArray(types) ? types : [types];
    const match = (p) => !!p && typeof p === 'object' && wanted.includes(p.type);
    const buffered = this._events.find(match);
    if (buffered) return Promise.resolve(buffered);
    if (this._exited || this._closed) {
      return Promise.reject(
        new AppServerError(`app-server is gone; cannot wait for session/event ${wanted.join('|')}`),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this._eventWaiters.indexOf(waiter);
        if (idx >= 0) this._eventWaiters.splice(idx, 1);
        reject(new AppServerError(`timed out after ${timeoutMs} ms waiting for session/event ${wanted.join('|')}`));
      }, timeoutMs);
      this._eventWaiters.push(waiter);
    });
  }

  /**
   * Deliver one incoming session/event directly to matching waiters. No
   * index bookkeeping on purpose: the buffer is capped and shifts once
   * saturated, which used to strand waiters whose scan start pinned at the
   * cap while every new event landed below it.
   */
  _dispatchEvent(params) {
    for (let i = this._eventWaiters.length - 1; i >= 0; i--) {
      const waiter = this._eventWaiters[i];
      if (waiter.match(params)) {
        this._eventWaiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(params);
      }
    }
  }

  _failAll(err) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    for (const waiter of this._eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
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
    this._closePromise = (async () => {
      if (!this._exited) {
        try {
          this.child.kill('SIGTERM');
        } catch { /* already gone */ }
        const killTimer = setTimeout(() => {
          try {
            this.child.kill('SIGKILL');
          } catch { /* already gone */ }
        }, CLOSE_KILL_GRACE_MS);
        await this._exitPromise;
        clearTimeout(killTimer);
      }
      this._failAll(new AppServerError('app-server client closed'));
    })();
    return this._closePromise;
  }
}

/**
 * One-shot mode B task: create a session with an explicit model selection,
 * run the prompt to turn completion, and tear the server down.
 * Returns { ok, sessionId, response, failed, error, catalog } on turn
 * completion; rejects on timeouts, protocol errors, and child death.
 */
export async function runTaskWithModel({
  binPath,
  cwd,
  prompt,
  providerId,
  modelId,
  reasoningLevel = 'high',
  timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  spawnFn,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('prompt must be a non-empty string');
  }
  if (typeof providerId !== 'string' || providerId.trim() === '') {
    throw new TypeError('providerId must be a non-empty string');
  }
  if (typeof modelId !== 'string' || modelId.trim() === '') {
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

  const client = new AppServerClient({ binPath, cwd, spawnFn });
  try {
    await client.settle();

    // No top-level cwd param: the workspace lives in a nested object with
    // BOTH keys required (notes §3). workspaceKey === workspacePath in
    // every observed session.
    const created = await client.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
    });
    const sessionId = created && created.session && created.session.sessionId;
    if (!sessionId) throw new AppServerError('session/create response is missing session.sessionId');
    const catalog = (created.settings && created.settings.model && created.settings.model.available) || null;

    // Gates session/event delivery on the real server (notes §4).
    await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });

    // ACK-only: acceptance says nothing about model validity; the turn
    // outcome arrives as a session/event notification (notes §5/§6).
    await client.request('session/send', {
      sessionId,
      content: prompt,
      modelSelection: { providerId, modelId, options: { reasoningLevel } },
    });

    const event = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs });
    if (event.type === 'turn.failed') {
      const err = (event.payload && event.payload.error) || {};
      return {
        ok: false,
        sessionId,
        response: null,
        failed: true,
        error: { code: err.code ?? null, message: err.message ?? 'turn failed without an error payload' },
        catalog,
      };
    }
    return {
      ok: true,
      sessionId,
      response: (event.payload && event.payload.response) ?? '',
      failed: false,
      error: null,
      catalog,
    };
  } finally {
    await client.close();
  }
}

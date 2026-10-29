// Detached job runner: `node src/job-runner.mjs <jobDir> <token>`.
// The job manager creates <jobDir>/job.json, takes the cwd lock and spawns this
// process detached. The runner is the only writer of status.json/result.json;
// it runs ZCode, records its identity and heartbeat, honours cancellation
// (cancel file, SIGTERM, SIGINT) and always ends with a terminal state.
// job.path 'cli' runs the headless CLI; 'protocol' runs the app-server protocol,
// whose event stream allows an idle timeout and progress lines.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactText } from './redact.mjs';
import { readJson, readStatus, patchStatus, writeResult, listJobDirs, TERMINAL_STATES } from './jobstore.mjs';
import { getProcessIdentity, signalGroup } from './procid.mjs';
import { changesSince } from './changes.mjs';
import { classifyError } from './errorkind.mjs';
import { releaseCwdLock } from './locks.mjs';
import { isJobAlive } from './jobs.mjs';
import { runZCodeTask, OUTPUT_CAP, DEFAULT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, worktreeSummary } from './runner.mjs';
import { runTaskWithModel, resolveBin, DEFAULT_MAX_TRANSIENT_RETRIES } from './appserver.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import { discoverZCode } from './discover.mjs';
import { oneLine } from './sanitize.mjs';
import { describeTurnError, errorText } from './transient.mjs';

const DEFAULT_HEARTBEAT_MS = 5000;
const CANCEL_POLL_MS = 250;
// ps can fail transiently: identity capture is retried this often before it is given up.
const IDENTITY_ATTEMPTS = 5;
const IDENTITY_RETRY_DELAY_MS = 100;
const ACTIVITY_WRITE_MS = 1000;
const PROGRESS_LINES = 5;
const RETRY_REASON_MAX = 200;

// Process group of the ZCode child while it runs (null before spawn / after exit).
// A fatal error in the runner kills this group before the lock is released.
let activeChildPgid = null;

export function killActiveChild() {
  const pgid = activeChildPgid;
  activeChildPgid = null;
  if (!Number.isInteger(pgid) || pgid <= 1) return false; // no child yet: nothing to kill
  try {
    return signalGroup(pgid, 'SIGKILL');
  } catch {
    return false;
  }
}

const now = () => new Date().toISOString();

function cap(text) {
  const s = typeof text === 'string' ? text : '';
  return s.length <= OUTPUT_CAP ? s : s.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]`;
}

// Writes the terminal `failed`/`crash` state unless one is already recorded.
// Lock release precedes the terminal status (the job counts as alive until the lock is gone).
export function writeCrashState(dir, job, err, { startedMs, warnings = [], onStatus } = {}) {
  if (TERMINAL_STATES.includes(readStatus(dir)?.state)) return;
  if (job && job.lockCwd) releaseCwdLock(job.lockCwd, job.jobId);
  const outputLogPath = join(dir, 'output.log');
  writeResult(dir, {
    state: 'failed',
    sessionId: null,
    output: '',
    outputLogPath: existsSync(outputLogPath) ? outputLogPath : null,
    changedFiles: [],
    diffStat: '',
    changesAvailable: false,
    warnings,
    errorKind: 'crash',
    errorMessage: redactText(err && err.message ? err.message : String(err)),
    timeoutKind: null,
    exitCode: null,
    stderr: '',
    durationMs: Number.isFinite(startedMs) ? Date.now() - startedMs : null,
  });
  const merged = patchStatus(dir, { state: 'failed', sessionId: null, warnings, errorKind: 'crash', finishedAt: now() });
  if (onStatus) onStatus(merged, { state: 'failed' });
}

// One progress line for a protocol session/event, or null for noise
// (model.streaming, session.updated, ...).
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'tool.updated') {
    const p = event.payload || {};
    return `tool ${p.toolName ?? '?'} ${p.kind ?? '?'}`;
  }
  if (['turn.started', 'turn.completed', 'turn.failed', 'checkpoint.created'].includes(event.type)) return event.type;
  return null;
}

const CANCELLED = { state: 'cancelled', errorKind: 'cancelled', errorMessage: 'Job was cancelled', timeoutKind: 'cancelled' };

// Timeout and cancellation are decided here; only a plain failure is classified.
function outcome(res, params) {
  if (res.timedOut && res.timeoutKind === 'cancelled') {
    return { state: 'cancelled', errorKind: 'cancelled', errorMessage: 'Job was cancelled' };
  }
  if (res.timedOut && res.timeoutKind === 'idle') {
    return { state: 'timeout', errorKind: 'timeout_idle', errorMessage: `No activity for ${params.idle_timeout_ms} ms` };
  }
  if (res.timedOut) {
    return { state: 'timeout', errorKind: 'timeout_total', errorMessage: `Timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms` };
  }
  if (res.code === 0) return { state: 'completed', errorKind: null, errorMessage: null };
  const errorMessage = res.code === null
    ? 'ZCode did not exit normally (no exit code)'
    : `ZCode exited with code ${res.code}`;
  // classifyError sees a synthesized message plus ZCode's real stderr; the stderr carries the cause.
  let errorKind = classifyError({ message: errorMessage, stderr: res.stderr });
  if (errorKind === 'unknown') errorKind = 'crash'; // non-zero or missing exit code here
  return { state: 'failed', errorKind, errorMessage };
}

// Protocol outcome: the runner decides timeouts and cancellation from the
// AppServerError code (never from its message); only a real failure is classified.
// A request without a response ('request_timeout') is a failure with its true message.
function protocolOutcome(res, err, params) {
  if (err) {
    const message = String((err && err.message) || err);
    if (err.code === 'aborted') {
      return { state: 'cancelled', errorKind: 'cancelled', errorMessage: 'Job was cancelled', timeoutKind: 'cancelled' };
    }
    if (err.code === 'idle') {
      const idle = params.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS;
      return { state: 'timeout', errorKind: 'timeout_idle', errorMessage: `No activity for ${idle} ms`, timeoutKind: 'idle' };
    }
    if (err.code === 'turn_timeout') {
      return {
        state: 'timeout', errorKind: 'timeout_total',
        errorMessage: `Timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT_MS} ms`, timeoutKind: 'total',
      };
    }
    return { state: 'failed', errorKind: classifyError({ message, stderr: '' }), errorMessage: message, timeoutKind: null };
  }
  if (!res.ok) {
    // The real payload may carry a localized message and the English cause in
    // detail/underlyingErrorMessage/statusMessage: classify all of them, show both.
    const message = res.error ? describeTurnError(res.error) : 'turn failed';
    return { state: 'failed', errorKind: classifyError({ message: errorText(res.error) || message, stderr: '' }), errorMessage: message, timeoutKind: null };
  }
  return { state: 'completed', errorKind: null, errorMessage: null, timeoutKind: null };
}

// Locks are per directory, change reporting is per repository: another live job in
// the same repository (e.g. a sibling subdirectory) may have made some of the changes.
function sharesRepoWithLiveJob(job, dir) {
  const root = job.baseline && job.baseline.gitRoot;
  if (!root) return false;
  return listJobDirs().some((other) => {
    if (other === dir) return false;
    const o = readJson(join(other, 'job.json'));
    return !!o && o.baseline && o.baseline.gitRoot === root && isJobAlive(other);
  });
}

async function collectChanges(job, params) {
  if (job.worktree) {
    try {
      const { changedFiles, diffStat } = await worktreeSummary(job.worktree.dir, job.worktree.startSha);
      return { available: true, changedFiles, diffStat };
    } catch {
      return { available: false, changedFiles: [], diffStat: '' };
    }
  }
  return changesSince(params.cwd, job.baseline);
}

// Records the spawned child (ZCode CLI or app-server) as the job's running child.
// childPgid: the child leads its own process group, so the manager/reaper (and the
// fatal handler via activeChildPgid) can signal the whole group after verifying it.
function childRecorder(setStatus, warn, identity = getProcessIdentity, retryDelayMs = IDENTITY_RETRY_DELAY_MS) {
  return (child) => {
    activeChildPgid = child.pid;
    const id = identity(child.pid);
    const t = now();
    try {
      setStatus({
        state: 'running',
        childPid: child.pid,
        childPgid: child.pid,
        childStart: id && !id.unknown ? id.start : null,
        childExitedAt: null,
        heartbeatAt: t,
        lastActivityAt: t,
      });
    } catch {
      warn('status_write_failed');
    }
    if (id && id.unknown) retryChildIdentity(child.pid, setStatus, warn, identity, retryDelayMs);
  };
}

// ps failed while the child was recorded: keep trying in the background while this
// child is still the active one; the signalling code never trusts a null childStart.
async function retryChildIdentity(pid, setStatus, warn, identity, delayMs) {
  for (let i = 0; i < IDENTITY_ATTEMPTS - 1; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    if (activeChildPgid !== pid) return;
    const id = identity(pid);
    if (id && !id.unknown) {
      try { setStatus({ childStart: id.start }); } catch { /* best effort */ }
      return;
    }
    if (!id) return; // gone
  }
  warn('identity_unrecorded');
}

// The child (and, with I3's sweep, its whole group) has ended: record it so the
// manager/reaper never trusts its now stale pgid again.
function childExited(setStatus) {
  activeChildPgid = null;
  try { setStatus({ childExitedAt: now(), childPgid: null }); } catch { /* best effort */ }
}

// CLI path. `idle`: pass idle_timeout_ms on (false for the protocol fallback:
// the CLI writes nothing until it ends, so an idle limit would kill live work).
async function runCli({ params, runCwd, signal, setStatus, warn, outputLogPath, idle, identity, identityRetryDelayMs }) {
  const binPath = discoverZCode();
  let lastActivityWrite = 0;
  const res = await runZCodeTask({
    binPath,
    prompt: params.prompt,
    cwd: runCwd,
    mode: params.mode,
    resume: params.resume,
    target: params.target,
    timeoutMs: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: idle ? params.idle_timeout_ms : undefined,
    signal,
    killGroup: true,
    onSpawn: childRecorder(setStatus, warn, identity, identityRetryDelayMs),
    onStdout: (chunk) => {
      try { appendFileSync(outputLogPath, chunk); } catch { warn('output_log_failed'); }
      const n = Date.now();
      if (n - lastActivityWrite >= ACTIVITY_WRITE_MS) {
        lastActivityWrite = n;
        try { setStatus({ lastActivityAt: new Date(n).toISOString() }); } catch { /* best effort */ }
      }
    },
  });
  childExited(setStatus);
  if (res.leftoverKilled) warn('leftover_processes_killed');
  const { state, errorKind, errorMessage } = outcome(res, params);
  return {
    state, errorKind, errorMessage,
    timeoutKind: res.timeoutKind || null,
    sessionId: res.sessionId || null,
    output: res.stdout,
    exitCode: res.code,
    stderr: res.stderr,
    progress: null,
  };
}

// Protocol path. Returns null when the app-server has no model to offer
// (the caller falls back to the CLI). Every session/event is activity:
// lastActivityAt and progress reach status.json at most once per
// ACTIVITY_WRITE_MS (first one at once, a trailing write for the rest),
// so an event flood costs a handful of writes.
// Transient provider errors (src/transient.mjs) continue the same session after a
// backoff: status.retry shows the pending retry (cleared when the next turn starts),
// a progress line names it, and the history lands in result.json.
async function runProtocol({ job, params, runCwd, signal, setStatus, warn, dir, outputLogPath, requestTimeoutMs, identity, identityRetryDelayMs, retryDelaysMs }) {
  const binPath = resolveBin();
  const eventsLog = join(dir, 'events.log');
  const progress = [];
  let eventSession = null;
  let lastEventMs = 0;
  let lastWriteMs = 0;
  let dirty = false;
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    lastWriteMs = Date.now();
    try {
      setStatus({ lastActivityAt: new Date(lastEventMs).toISOString(), progress: progress.slice() });
    } catch { /* best effort */ }
  };
  const addProgress = (line, ms) => {
    progress.push(line);
    if (progress.length > PROGRESS_LINES) progress.shift();
    try {
      appendFileSync(eventsLog, `${new Date(ms).toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      warn('events_log_failed');
    }
  };
  const retries = [];
  let retryPending = false;
  // attempt k/N is shown within the error's class; the history keeps the global attempt.
  const onRetry = ({ attempt, classAttempt, classMaxRetries, klass, delayMs, reason, at }) => {
    const why = oneLine(reason, RETRY_REASON_MAX);
    retries.push({ at, attempt, delayMs, reason: why, klass });
    retryPending = true;
    addProgress(`retrying in ${Math.round(delayMs / 1000)}s (attempt ${classAttempt}/${classMaxRetries}): ${why}`, Date.parse(at));
    try {
      setStatus({
        retry: { attempt: classAttempt, maxRetries: classMaxRetries, klass, nextAt: new Date(Date.parse(at) + delayMs).toISOString(), delayMs, reason: why },
        progress: progress.slice(),
      });
    } catch { /* best effort */ }
  };
  const onEvent = (event) => {
    lastEventMs = Date.now();
    if (!eventSession && typeof event.sessionId === 'string') eventSession = event.sessionId;
    if (retryPending && event.type === 'turn.started') {
      retryPending = false;
      try { setStatus({ retry: null }); } catch { /* best effort */ }
    }
    const line = describeEvent(event);
    if (line) addProgress(line, lastEventMs);
    dirty = true;
    if (flushTimer) return;
    const wait = lastWriteMs + ACTIVITY_WRITE_MS - lastEventMs;
    if (wait <= 0) {
      flush();
    } else {
      flushTimer = setTimeout(flush, wait);
      flushTimer.unref();
    }
  };
  const model = job.model || {};
  const call = () => runTaskWithModel({
    binPath,
    cwd: runCwd,
    prompt: params.prompt,
    providerId: model.providerId,
    modelId: model.modelId,
    reasoningLevel: params.reasoning_level ?? 'high',
    timeoutMs: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: params.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    killGroup: true,
    signal,
    onSpawn: childRecorder(setStatus, warn, identity, identityRetryDelayMs),
    onEvent,
    transientRetry: {
      maxRetries: params.max_transient_retries ?? DEFAULT_MAX_TRANSIENT_RETRIES,
      ...(retryDelaysMs ? { delaysMs: retryDelaysMs } : {}),
      onRetry,
    },
  });

  let res = null;
  let error = null;
  try {
    try {
      res = await call();
    } catch (err) {
      // A failed start (spawn, settle, session/create) is retried once; after
      // session/send the task may be running and is never repeated.
      if (!err || !err.startup || signal.aborted) throw err;
      childExited(setStatus);
      res = await call();
    }
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(flushTimer);
    flushTimer = null;
    // runTaskWithModel closed the client: the app-server and its group are gone.
    childExited(setStatus);
  }
  if (error && error.code === 'no-model') return null;

  if (res && res.reasoningSubstitution) {
    warn(`reasoning_level_substituted:${res.reasoningSubstitution.requested}->${res.reasoningSubstitution.used}`);
  }
  const text = (res && res.response) || '';
  try { writeFileSync(outputLogPath, redactText(text)); } catch { warn('output_log_failed'); }
  const result = protocolOutcome(res, error, params);
  const stop = res && res.retryStop;
  let retryOutcome = null;
  if (res && res.ok && retries.length) {
    retryOutcome = 'recovered';
    warn(`recovered_after_transient_errors:${retries.length}`);
  } else if (stop) {
    if (retries.length) {
      retryOutcome = 'exhausted';
      warn(`transient_retries_exhausted:${retries.length}`);
    }
    if (stop === 'deadline') warn('retry_budget_exhausted');
  } else if (retries.length) {
    retryOutcome = result.state; // a later non-transient failure, a timeout or a cancel
  }
  return {
    ...result,
    sessionId: (res && res.sessionId) || (error && error.sessionId) || eventSession,
    output: text,
    exitCode: null,
    stderr: '',
    progress,
    retries,
    retryOutcome,
  };
}

// opts.heartbeatMs: heartbeat interval; opts.signal: external abort (the CLI's
// early signal handlers); opts.onStatus(merged, patch): test hook seeing every status write;
// opts.requestTimeoutMs: protocol request timeout (test hook; default 30 s);
// opts.retryDelaysMs: backoff schedule for transient provider errors (test hook).
export async function runJob(dir, opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const onStatus = opts.onStatus;
  // R29: progress writes (heartbeat, activity, child records) never touch a
  // terminal status, so nothing resurrects a `cancelled` or `lost` job. The re-read
  // narrows, but cannot close, the race with a concurrent manager/reaper write.
  const setStatus = (patch) => {
    const cur = readStatus(dir);
    if (cur && TERMINAL_STATES.includes(cur.state)) return cur;
    const merged = patchStatus(dir, patch);
    if (onStatus) onStatus(merged, patch);
    return merged;
  };
  const setFinalStatus = (patch) => {
    const merged = patchStatus(dir, patch);
    if (onStatus) onStatus(merged, patch);
    return merged;
  };
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };

  // The manager may already have ended the job (cancelled during the startup
  // grace): never rewrite a terminal state.
  if (TERMINAL_STATES.includes(readStatus(dir)?.state)) return;
  const startedMs = Date.now();
  const job = readJson(join(dir, 'job.json')) || {};
  const params = job.params || {};
  const jobId = job.jobId;
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  const cancelFile = join(dir, 'cancel');
  const outputLogPath = join(dir, 'output.log');
  let heartbeat = null;
  let cancelPoll = null;
  let finished = false;

  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  if (opts.signal) {
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener('abort', abort, { once: true });
  }
  try {
    const identity = opts.identity || getProcessIdentity;
    const retryDelayMs = opts.identityRetryDelayMs ?? IDENTITY_RETRY_DELAY_MS;
    let self = identity(process.pid);
    for (let i = 1; i < IDENTITY_ATTEMPTS && self && self.unknown; i++) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      self = identity(process.pid);
    }
    if (!self || self.unknown) warn('identity_unrecorded');
    setStatus({
      state: 'starting',
      pid: process.pid,
      pidStart: self && !self.unknown ? self.start : null,
      token: job.token,
      startedAt: new Date(startedMs).toISOString(),
      warnings: [],
    });
    if (!job.jobId || !params.cwd) throw new Error('job.json is missing or incomplete');
    writeFileSync(outputLogPath, '', { mode: 0o600 });

    const runCwd = job.worktree ? job.worktree.dir : params.cwd;
    // Best effort: a failed heartbeat write must not end the runner.
    heartbeat = setInterval(() => {
      try { setStatus({ heartbeatAt: now() }); } catch { /* next beat retries */ }
    }, heartbeatMs);
    heartbeat.unref();
    const checkCancel = () => { if (existsSync(cancelFile)) abort(); };
    cancelPoll = setInterval(checkCancel, CANCEL_POLL_MS);
    cancelPoll.unref();
    checkCancel();

    const ctx = { job, params, runCwd, signal: ctl.signal, setStatus, warn, dir, outputLogPath, requestTimeoutMs: opts.requestTimeoutMs, identity, identityRetryDelayMs: retryDelayMs, retryDelaysMs: opts.retryDelaysMs };
    let run = job.path === 'protocol' ? await runProtocol(ctx) : await runCli({ ...ctx, idle: true });
    if (run === null) {
      warn('idle_detection_unavailable');
      run = await runCli({ ...ctx, idle: false });
    }
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    // A cancel whose ZCode exit was seen before the abort (signal or cancel-file
    // poll) is still a cancel; a genuinely completed run stays completed.
    if (run.state !== 'completed' && (ctl.signal.aborted || existsSync(cancelFile))) {
      run = { ...run, ...CANCELLED, ...(run.retryOutcome && run.retryOutcome !== 'exhausted' ? { retryOutcome: 'cancelled' } : {}) };
    }

    const { state, errorKind, errorMessage, sessionId } = run;
    // The CLI path appends raw chunks to output.log; scrub the finished file.
    try {
      if (existsSync(outputLogPath)) writeFileSync(outputLogPath, redactText(readFileSync(outputLogPath, 'utf8')));
    } catch { warn('output_log_failed'); }
    const changes = await collectChanges(job, params);
    if (state === 'completed' && changes.available && changes.changedFiles.length === 0 && params.mode !== 'plan') {
      warn('no_changes');
    }
    try {
      if (changes.available && sharesRepoWithLiveJob(job, dir)) warn('shared_repo');
    } catch { /* best effort */ }

    // R29: a terminal state set by the manager (`cancelled`) stands; the reaper's
    // `lost` is an inference and gives way to the runner's own result.
    const recorded = readStatus(dir);
    const managerFinal = !!recorded && TERMINAL_STATES.includes(recorded.state) && recorded.state !== 'lost';
    if (recorded && recorded.state === 'lost') warn('recovered_from_lost');

    try {
      new SessionStore(process.env.ZCODE_MCP_STATE || defaultStatePath()).append({
        id: sessionId || jobId,
        kind: sessionId ? 'session' : 'run',
        cwd: params.cwd,
        mode: params.mode || 'yolo',
        promptPreview: String(params.prompt || '').slice(0, 80),
        startedAt: new Date(startedMs).toISOString(),
        status: managerFinal ? recorded.state : state,
      });
    } catch {
      warn('session_store_failed');
    }

    if (managerFinal) {
      if (job.lockCwd) releaseCwdLock(job.lockCwd, jobId); // only if still ours
      finished = true;
      return;
    }
    // Lock release precedes the terminal status so the job counts as alive until the lock is gone.
    if (job.lockCwd) releaseCwdLock(job.lockCwd, jobId);
    writeResult(dir, {
      state,
      sessionId,
      output: redactText(cap(run.output)),
      outputLogPath,
      changedFiles: changes.changedFiles,
      diffStat: changes.diffStat,
      changesAvailable: changes.available,
      ...(job.worktree ? { worktree: { branch: job.worktree.branch, dir: job.worktree.dir, startSha: job.worktree.startSha } } : {}),
      warnings,
      errorKind,
      errorMessage: errorMessage == null ? errorMessage : redactText(errorMessage),
      timeoutKind: run.timeoutKind,
      exitCode: run.exitCode,
      stderr: redactText(cap(run.stderr)),
      durationMs: Date.now() - startedMs,
      ...(run.retries ? { retries: run.retries, retryOutcome: run.retryOutcome } : {}),
    });
    setFinalStatus({
      state, sessionId, warnings, errorKind, finishedAt: now(),
      ...(run.progress ? { progress: run.progress } : {}),
      ...(run.retries ? { retry: null } : {}),
    });
    finished = true;
  } catch (err) {
    if (!finished) {
      try {
        writeCrashState(dir, job, err, { startedMs, warnings, onStatus });
      } catch {
        // State directory unusable: nothing more can be recorded.
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancelPoll) clearInterval(cancelPoll);
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
    if (opts.signal) opts.signal.removeEventListener('abort', abort);
  }
}

const MIN_HEARTBEAT_MS = 1000;
const MAX_HEARTBEAT_MS = 10000;

// Options from the runner's environment. ZCODE_MCP_HEARTBEAT_MS is clamped to
// 1000..10000; ZCODE_MCP_TEST_FATAL_AFTER_SPAWN and ZCODE_MCP_TEST_RETRY_DELAYS_MS
// (comma list of ms) are ignored unless NODE_ENV=test.
export function runnerEnvOptions(env = process.env) {
  const testing = env.NODE_ENV === 'test';
  let heartbeatMs = Number(env.ZCODE_MCP_HEARTBEAT_MS);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) heartbeatMs = undefined;
  else if (!testing) heartbeatMs = Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, heartbeatMs));
  const fatal = Number(env.ZCODE_MCP_TEST_FATAL_AFTER_SPAWN);
  let retryDelaysMs;
  if (testing && typeof env.ZCODE_MCP_TEST_RETRY_DELAYS_MS === 'string') {
    const list = env.ZCODE_MCP_TEST_RETRY_DELAYS_MS.split(',').map((v) => (v.trim() === '' ? NaN : Number(v)));
    if (list.length && list.every((n) => Number.isInteger(n) && n >= 0)) retryDelaysMs = list;
  }
  return { heartbeatMs, fatalAfterMs: testing && fatal > 0 ? fatal : 0, retryDelaysMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Signal handlers first, so an early SIGTERM/SIGINT still ends in a terminal state.
  const early = new AbortController();
  process.on('SIGTERM', () => early.abort());
  process.on('SIGINT', () => early.abort());
  const [dir, token] = process.argv.slice(2);
  const job = dir ? readJson(join(dir, 'job.json')) : null;
  if (!job || typeof token !== 'string' || token === '' || job.token !== token) process.exit(2);
  let crashing = false;
  const onFatal = (err) => {
    if (crashing) process.exit(1);
    crashing = true;
    try { killActiveChild(); } catch { /* proceed to the crash state */ }
    try {
      writeCrashState(dir, job, err, { startedMs: Date.parse(readStatus(dir)?.startedAt) });
    } catch {
      // nothing more can be recorded
    }
    process.exit(1);
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  const { heartbeatMs, fatalAfterMs: fatalAfter, retryDelaysMs } = runnerEnvOptions();
  // TEST ONLY (NODE_ENV=test): throw an uncaught error <ms> after ZCode spawned.
  const onStatus = fatalAfter > 0
    ? (_s, patch) => {
      if (patch.state === 'running') setTimeout(() => { throw new Error('test fatal after spawn'); }, fatalAfter);
    }
    : undefined;
  runJob(dir, { heartbeatMs, signal: early.signal, onStatus, retryDelaysMs })
    .then(() => process.exit(0), onFatal);
}

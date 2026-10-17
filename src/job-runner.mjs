// Detached job runner (CLI path): `node src/job-runner.mjs <jobDir> <token>`.
// The job manager creates <jobDir>/job.json, takes the cwd lock and spawns this
// process detached. The runner is the only writer of status.json/result.json;
// it runs ZCode, records its identity and heartbeat, honours cancellation
// (cancel file, SIGTERM, SIGINT) and always ends with a terminal state.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, readStatus, patchStatus, writeResult, TERMINAL_STATES } from './jobstore.mjs';
import { getProcessIdentity, signalGroup } from './procid.mjs';
import { changesSince } from './changes.mjs';
import { classifyError } from './errorkind.mjs';
import { releaseCwdLock } from './locks.mjs';
import { runZCodeTask, OUTPUT_CAP, DEFAULT_TIMEOUT_MS, worktreeSummary } from './runner.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import { discoverZCode } from './discover.mjs';

const DEFAULT_HEARTBEAT_MS = 5000;
const CANCEL_POLL_MS = 250;
const ACTIVITY_WRITE_MS = 1000;

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
    errorMessage: err && err.message ? err.message : String(err),
    timeoutKind: null,
    exitCode: null,
    stderr: '',
    durationMs: Number.isFinite(startedMs) ? Date.now() - startedMs : null,
  });
  const merged = patchStatus(dir, { state: 'failed', sessionId: null, warnings, errorKind: 'crash', finishedAt: now() });
  if (onStatus) onStatus(merged, { state: 'failed' });
}

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

// opts.heartbeatMs: heartbeat interval; opts.signal: external abort (the CLI's
// early signal handlers); opts.onStatus(merged, patch): test hook seeing every status write.
export async function runJob(dir, opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const onStatus = opts.onStatus;
  const setStatus = (patch) => {
    const merged = patchStatus(dir, patch);
    if (onStatus) onStatus(merged, patch);
    return merged;
  };
  const warnings = [];
  const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };

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
    const self = getProcessIdentity(process.pid);
    setStatus({
      state: 'starting',
      pid: process.pid,
      pidStart: self ? self.start : null,
      token: job.token,
      startedAt: new Date(startedMs).toISOString(),
      warnings: [],
    });
    if (!job.jobId || !params.cwd) throw new Error('job.json is missing or incomplete');
    writeFileSync(outputLogPath, '', { mode: 0o600 });

    const binPath = discoverZCode();
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

    let lastActivityWrite = 0;
    const res = await runZCodeTask({
      binPath,
      prompt: params.prompt,
      cwd: runCwd,
      mode: params.mode,
      resume: params.resume,
      target: params.target,
      timeoutMs: params.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: params.idle_timeout_ms,
      signal: ctl.signal,
      killGroup: true,
      onSpawn: (child) => {
        activeChildPgid = child.pid;
        const id = getProcessIdentity(child.pid);
        const t = now();
        try {
          // childPgid: ZCode leads its own process group, so the manager/reaper can
          // signal the whole group after verifying the child's identity.
          setStatus({
            state: 'running',
            childPid: child.pid,
            childPgid: child.pid,
            childStart: id ? id.start : null,
            heartbeatAt: t,
            lastActivityAt: t,
          });
        } catch {
          warn('status_write_failed');
        }
      },
      onStdout: (chunk) => {
        try { appendFileSync(outputLogPath, chunk); } catch { warn('output_log_failed'); }
        const n = Date.now();
        if (n - lastActivityWrite >= ACTIVITY_WRITE_MS) {
          lastActivityWrite = n;
          try { setStatus({ lastActivityAt: new Date(n).toISOString() }); } catch { /* best effort */ }
        }
      },
    });
    activeChildPgid = null;
    clearInterval(heartbeat);
    clearInterval(cancelPoll);

    const { state, errorKind, errorMessage } = outcome(res, params);
    const changes = await collectChanges(job, params);
    if (state === 'completed' && changes.available && changes.changedFiles.length === 0 && params.mode !== 'plan') {
      warn('no_changes');
    }

    const sessionId = res.sessionId || null;
    try {
      new SessionStore(process.env.ZCODE_MCP_STATE || defaultStatePath()).append({
        id: sessionId || jobId,
        kind: sessionId ? 'session' : 'run',
        cwd: params.cwd,
        mode: params.mode || 'yolo',
        promptPreview: String(params.prompt || '').slice(0, 80),
        startedAt: new Date(startedMs).toISOString(),
        status: state,
      });
    } catch {
      warn('session_store_failed');
    }

    // Lock release precedes the terminal status so the job counts as alive until the lock is gone.
    if (job.lockCwd) releaseCwdLock(job.lockCwd, jobId);
    writeResult(dir, {
      state,
      sessionId,
      output: cap(res.stdout),
      outputLogPath,
      changedFiles: changes.changedFiles,
      diffStat: changes.diffStat,
      changesAvailable: changes.available,
      ...(job.worktree ? { worktree: { branch: job.worktree.branch, dir: job.worktree.dir, startSha: job.worktree.startSha } } : {}),
      warnings,
      errorKind,
      errorMessage,
      timeoutKind: res.timeoutKind || null,
      exitCode: res.code,
      stderr: cap(res.stderr),
      durationMs: Date.now() - startedMs,
    });
    setStatus({ state, sessionId, warnings, errorKind, finishedAt: now() });
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
  const hb = Number(process.env.ZCODE_MCP_HEARTBEAT_MS);
  // TEST ONLY (never set in production): throw an uncaught error <ms> after ZCode spawned.
  const fatalAfter = Number(process.env.ZCODE_MCP_TEST_FATAL_AFTER_SPAWN);
  const onStatus = fatalAfter > 0
    ? (_s, patch) => {
      if (patch.state === 'running') setTimeout(() => { throw new Error('test fatal after spawn'); }, fatalAfter);
    }
    : undefined;
  runJob(dir, { heartbeatMs: Number.isFinite(hb) && hb > 0 ? hb : undefined, signal: early.signal, onStatus })
    .then(() => process.exit(0), onFatal);
}

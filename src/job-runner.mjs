// Detached job runner (CLI path): `node src/job-runner.mjs <jobDir> <token>`.
// The job manager creates <jobDir>/job.json, takes the cwd lock and spawns this
// process detached. The runner is the only writer of status.json/result.json;
// it runs ZCode, records its identity and heartbeat, honours cancellation
// (cancel file, SIGTERM, SIGINT) and always ends with a terminal state.
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, patchStatus, writeResult, TERMINAL_STATES } from './jobstore.mjs';
import { getProcessIdentity } from './procid.mjs';
import { changesSince } from './changes.mjs';
import { classifyError } from './errorkind.mjs';
import { releaseCwdLock } from './locks.mjs';
import { runZCodeTask, OUTPUT_CAP, worktreeSummary } from './runner.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import { discoverZCode } from './discover.mjs';

const DEFAULT_HEARTBEAT_MS = 5000;
const CANCEL_POLL_MS = 250;

const now = () => new Date().toISOString();

function cap(text) {
  const s = typeof text === 'string' ? text : '';
  return s.length <= OUTPUT_CAP ? s : s.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]`;
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
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
    return { state: 'timeout', errorKind: 'timeout_total', errorMessage: `Timed out after ${params.timeout_ms} ms` };
  }
  if (res.code === 0) return { state: 'completed', errorKind: null, errorMessage: null };
  const errorMessage = res.code === null
    ? 'ZCode did not exit normally (no exit code)'
    : `ZCode exited with code ${res.code}`;
  let errorKind = classifyError({ message: errorMessage, stderr: res.stderr });
  if (errorKind === 'unknown' && res.code !== 0) errorKind = 'crash';
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

export async function runJob(dir, opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const onStatus = opts.onStatus; // test hook: observes every status write
  const setStatus = (patch) => {
    const merged = patchStatus(dir, patch);
    if (onStatus) onStatus(merged);
    return merged;
  };

  const startedMs = Date.now();
  const job = readJson(join(dir, 'job.json')) || {};
  const params = job.params || {};
  const jobId = job.jobId;
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  const cancelFile = join(dir, 'cancel');
  let heartbeat = null;
  let cancelPoll = null;
  let finished = false;

  // Lock release precedes the terminal status so the job counts as alive until the lock is gone.
  const finish = (result) => {
    if (job.lockCwd) releaseCwdLock(job.lockCwd, jobId);
    writeResult(dir, result);
    setStatus({
      state: result.state,
      sessionId: result.sessionId,
      warnings: result.warnings,
      errorKind: result.errorKind,
      finishedAt: now(),
    });
    finished = true;
  };

  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
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

    const binPath = discoverZCode();
    const runCwd = job.worktree ? job.worktree.dir : params.cwd;
    heartbeat = setInterval(() => setStatus({ heartbeatAt: now() }), heartbeatMs);
    heartbeat.unref();
    const checkCancel = () => { if (existsSync(cancelFile)) abort(); };
    cancelPoll = setInterval(checkCancel, CANCEL_POLL_MS);
    cancelPoll.unref();
    checkCancel();

    const res = await runZCodeTask({
      binPath,
      prompt: params.prompt,
      cwd: runCwd,
      mode: params.mode,
      resume: params.resume,
      target: params.target,
      timeoutMs: params.timeout_ms,
      idleTimeoutMs: params.idle_timeout_ms,
      signal: ctl.signal,
      onSpawn: (child) => {
        const id = getProcessIdentity(child.pid);
        const t = now();
        setStatus({
          state: 'running',
          childPid: child.pid,
          childStart: id ? id.start : null,
          heartbeatAt: t,
          lastActivityAt: t,
        });
      },
    });
    clearInterval(heartbeat);
    clearInterval(cancelPoll);

    const { state, errorKind, errorMessage } = outcome(res, params);
    const changes = await collectChanges(job, params);
    const warnings = [];
    if (state === 'completed' && changes.available && changes.changedFiles.length === 0 && params.mode !== 'plan') {
      warnings.push('no_changes');
    }

    const outputLogPath = join(dir, 'output.log');
    writeFileAtomic(outputLogPath, res.stdout || '');

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
      warnings.push('session_store_failed');
    }

    finish({
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
  } catch (err) {
    if (!finished && !TERMINAL_STATES.includes(readJson(join(dir, 'status.json'))?.state)) {
      try {
        finish({
          state: 'failed',
          sessionId: null,
          output: '',
          outputLogPath: null,
          changedFiles: [],
          diffStat: '',
          changesAvailable: false,
          warnings: [],
          errorKind: 'crash',
          errorMessage: err && err.message ? err.message : String(err),
          timeoutKind: null,
          exitCode: null,
          stderr: '',
          durationMs: Date.now() - startedMs,
        });
      } catch {
        // State directory unusable: nothing more can be recorded.
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (cancelPoll) clearInterval(cancelPoll);
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, token] = process.argv.slice(2);
  const job = dir ? readJson(join(dir, 'job.json')) : null;
  if (!job || typeof token !== 'string' || token === '' || job.token !== token) process.exit(2);
  const hb = Number(process.env.ZCODE_MCP_HEARTBEAT_MS);
  runJob(dir, { heartbeatMs: Number.isFinite(hb) && hb > 0 ? hb : undefined })
    .then(() => process.exit(0), () => process.exit(1));
}

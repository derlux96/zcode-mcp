// Job manager: starts detached runners, reads, waits for and cancels jobs.
// Holds no state of its own; everything lives in files under stateHome(), so a
// restarted server or a second server sees the same jobs. Reads never persist
// anything: `lost` and `stalled` are derived on every read.
import { spawn as spawnProcess } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_STATES, stateHome, jobsRoot, createJobDir, readJson, readStatus, readResult,
  patchStatus, writeResult, listJobDirs, isJobId, jobDir, ensurePrivateDir, STOP_GRACE_MS,
} from './jobstore.mjs';
import { acquireCwdLock, releaseCwdLock } from './locks.mjs';
import {
  getProcessIdentity, matchesIdentity, identityAlive, signalGroup, groupHasMembers, bootTimeMs,
} from './procid.mjs';

export { groupHasMembers };
import { captureBaseline, changesSince } from './changes.mjs';
import { validateRunArgs, assertGitRepo, createWorktree, removeWorktree, worktreeSummary } from './runner.mjs';
import { resolveBin, getModelCatalog, resolveModel, entryReasoningLevels } from './appserver.mjs';
import { oneLine, cleanName } from './sanitize.mjs';
import { writeInboxEntry, waitAck } from './inbox.mjs';

export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MAX_RUNNING_JOBS = 3;
export const SEND_ACK_WAIT_MS = 5000;
export const MAX_SEND_TEXT = 20000;
const STALL_MS = 30000;
const STARTUP_GRACE_MS = 15000;
const POLL_MS = 250;
const KILL_WAIT_MS = 2000;
const MODEL_CATALOG_TIMEOUT_MS = 15000;
const RUNNER_PATH = fileURLToPath(new URL('./job-runner.mjs', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTerminal = (state) => TERMINAL_STATES.includes(state);
const invalid = (msg) => ({ ok: false, error: `Invalid arguments: ${msg}` });

// `model` forces the protocol path (validation allows only mode 'yolo' with it).
export function chooseJobPath(args = {}) {
  if (args.model !== undefined) return 'protocol';
  return args.mode === undefined && args.resume === undefined && args.target === undefined ? 'protocol' : 'cli';
}

// Liveness from already-read files (token check per R10, startup grace per R22).
// `match`: identity check; the default counts an unknown ps sample as alive (M1).
// Signalling passes matchesIdentity (a definite match only); tests may replace it.
export function aliveFrom(job, status, match = identityAlive) {
  if (!job || typeof job.token !== 'string' || job.token === '') return false;
  if (status && isTerminal(status.state)) return false;
  if (!status || !Number.isInteger(status.pid)) {
    const created = Date.parse(job.createdAt);
    return Number.isFinite(created) && Date.now() - created < STARTUP_GRACE_MS;
  }
  // pidStart null = the runner could not record it (identity_unrecorded): the token
  // in its command line identifies it instead.
  const start = typeof status.pidStart === 'string' ? status.pidStart : null;
  return match({ pid: status.pid, start, token: job.token });
}

// Callers pass only jobDir(id) results (or listJobDirs entries), never raw tool input.
export function isJobAlive(dir) {
  if (!dir) return false;
  return aliveFrom(readJson(join(dir, 'job.json')), readStatus(dir));
}

function viewOf(jobId, dir) {
  const job = readJson(join(dir, 'job.json'));
  if (!job) return null;
  let status = readStatus(dir);
  let alive = aliveFrom(job, status);
  // The runner may have written its terminal state and exited between the reads.
  if (!alive) {
    status = readStatus(dir);
    alive = aliveFrom(job, status);
  }
  const recorded = (status && status.state) || 'starting';
  const state = isTerminal(recorded) || alive ? recorded : 'lost';
  if (isTerminal(state)) alive = false;
  const beat = status && Date.parse(status.heartbeatAt);
  const stalled = alive && Number.isFinite(beat) && Date.now() - beat > STALL_MS;
  const warnings = Array.isArray(status && status.warnings) ? [...status.warnings] : [];
  if (stalled && !warnings.includes('stalled')) warnings.push('stalled');
  return { jobId, dir, job, status, result: readResult(dir), state, alive, stalled, warnings };
}

export function getJob(jobId) {
  const dir = jobDir(jobId);
  return dir ? viewOf(jobId, dir) : null;
}

export function listJobs() {
  return listJobDirs().reverse()
    .map((dir) => viewOf(basename(dir), dir))
    .filter(Boolean);
}

function sleepAbortable(ms, signal) {
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

// Aborting `signal` only ends the wait; the job keeps running. until 'change'
// ends on a change of the effective state (or finishedAt) only: heartbeat and
// activity writes bump status.updatedAt every few seconds and must not end it.
export async function waitJob(jobId, { waitMs = 0, signal, until = 'terminal' } = {}) {
  let view = getJob(jobId);
  if (!view) return null;
  const finishedAt = (v) => (v.status && v.status.finishedAt) || null;
  const first = { state: view.state, finishedAt: finishedAt(view) };
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (isTerminal(view.state)) return view;
    if (until === 'change' && (view.state !== first.state || finishedAt(view) !== first.finishedAt)) return view;
    const left = deadline - Date.now();
    if (left <= 0 || (signal && signal.aborted)) return view;
    await sleepAbortable(Math.min(POLL_MS, left), signal);
    view = getJob(jobId) || view;
  }
}

export function formatCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  return catalog
    .filter((e) => e && e.ref && e.ref.providerId && e.ref.modelId)
    .map((e) => {
      const levels = entryReasoningLevels(e);
      const base = `${e.ref.providerId}/${e.ref.modelId}`;
      return cleanName(levels.length ? `${base} (reasoning: ${levels.join(',')})` : base);
    });
}

// R20: `providerId/modelId` as is; a bare modelId via the catalog.
async function resolveModelArg(model, cwd) {
  const spec = model.trim();
  const slash = spec.indexOf('/');
  if (slash > 0 && slash < spec.length - 1) {
    return { model: { providerId: spec.slice(0, slash), modelId: spec.slice(slash + 1) } };
  }
  let catalog;
  try {
    catalog = await getModelCatalog({ binPath: resolveBin(), cwd, timeoutMs: MODEL_CATALOG_TIMEOUT_MS });
  } catch (error) {
    return { error: `Model catalog unavailable, cannot resolve '${cleanName(spec)}': ${oneLine(error.message)}` };
  }
  const resolved = resolveModel(catalog, spec);
  if (resolved) return { model: resolved };
  const rows = formatCatalog(catalog);
  const listing = rows.length
    ? `Available models:\n${rows.join('\n')}`
    : 'No models are reported as available on this machine (the catalog is empty).';
  return { error: `Model '${cleanName(spec)}' not found. ${listing}` };
}

function validateStart(args) {
  const v = validateRunArgs(args);
  if (!v.ok) return invalid(v.error);
  const { resume } = v.value;
  if (resume && resume.startsWith('run_')) {
    return { ok: false, error: `'${resume}' is a server-generated run-id and is not resumable. Use zcode_sessions to find a real ZCode session id (sess_...).` };
  }
  if (args.reasoning_level !== undefined && !REASONING_LEVELS.includes(args.reasoning_level)) {
    return invalid(`reasoning_level must be one of ${REASONING_LEVELS.join('|')}`);
  }
  if (args.model !== undefined) {
    if (typeof args.model !== 'string' || args.model.trim() === '') return invalid('model must be a non-empty string');
    if (resume) return invalid('resume is not supported together with model (protocol mode always starts a fresh session)');
    if (args.target) return invalid('target is not supported together with model');
    if (args.mode !== undefined && args.mode !== 'yolo') {
      return invalid("mode is not supported when model is set: with model only mode 'yolo' is supported (protocol mode runs autonomously); omit mode or use 'yolo'");
    }
  }
  if (chooseJobPath(args) === 'cli') {
    if (v.value.idleTimeoutMs !== undefined) {
      return invalid('idle_timeout_ms applies only in protocol mode (model set, or no mode/resume/target given); the CLI prints its output only at the end, so use timeout_ms instead');
    }
    if (args.reasoning_level !== undefined) {
      return invalid('reasoning_level applies only when model is set or no mode/resume/target is given');
    }
    if (v.value.maxTransientRetries !== undefined) {
      return invalid('max_transient_retries applies only in protocol mode (model set, or no mode/resume/target given): the CLI path cannot continue a session after a provider error; rerun with resume <sess_id> instead');
    }
    if (v.value.inputTimeoutMs !== undefined) {
      return invalid('input_timeout_ms applies only in protocol mode (model set, or no mode/resume/target given); the CLI path cannot ask for user input');
    }
  }
  return { ok: true, value: v.value };
}

function storeNotWritable() {
  const root = jobsRoot();
  const locks = join(stateHome(), 'locks');
  try {
    ensurePrivateDir(stateHome());
    ensurePrivateDir(root);
    accessSync(root, constants.W_OK);
    ensurePrivateDir(locks);
    accessSync(locks, constants.W_OK);
    return null;
  } catch (err) {
    return `State directory is not writable: ${stateHome()} (${err.message})`;
  }
}

function runningJobIds() {
  return listJobDirs().filter((dir) => isJobAlive(dir)).map((dir) => basename(dir));
}

// opts.spawn: test hook only (production never sets it).
export async function startJob(args = {}, opts = {}) {
  const checked = validateStart(args);
  if (!checked.ok) return checked;
  const v = checked.value;
  const notWritable = storeNotWritable();
  if (notWritable) return { ok: false, error: notWritable };
  const cwd = realpathSync(v.cwd);
  const path = chooseJobPath(args);

  let model;
  if (args.model !== undefined) {
    const r = await resolveModelArg(args.model, cwd);
    if (r.error) return { ok: false, error: r.error };
    model = r.model;
  }

  const running = runningJobIds();
  if (running.length >= MAX_RUNNING_JOBS) {
    return { ok: false, error: `too many running jobs (${MAX_RUNNING_JOBS})`, blockingJobId: running[0] };
  }

  let worktree = null;
  if (v.isolateWorktree) {
    try {
      await assertGitRepo(cwd);
    } catch (error) {
      return { ok: false, error: `isolate_worktree requires a git repository: ${oneLine(error.message)}` };
    }
    try {
      const wt = await createWorktree(cwd);
      worktree = { branch: wt.branch, dir: wt.dir, startSha: wt.startSha };
    } catch (error) {
      return { ok: false, error: `Could not create worktree: ${oneLine(error.message)}` };
    }
  }
  const lockCwd = worktree ? worktree.dir : cwd;

  let created = null;
  let locked = false;
  const undo = async () => {
    if (locked) releaseCwdLock(lockCwd, created.jobId);
    if (created) rmSync(created.dir, { recursive: true, force: true });
    if (worktree) await removeWorktree(cwd, worktree).catch(() => {});
  };
  try {
    created = createJobDir({
      params: {
        prompt: v.prompt, cwd, mode: v.mode, resume: v.resume, target: v.target,
        model: args.model, reasoning_level: args.reasoning_level,
        timeout_ms: v.timeoutMs, idle_timeout_ms: v.idleTimeoutMs, input_timeout_ms: v.inputTimeoutMs, isolate_worktree: v.isolateWorktree,
        max_transient_retries: v.maxTransientRetries,
      },
      path,
      model,
      worktree,
      baseline: captureBaseline(lockCwd),
      lockCwd,
    });
    const lock = acquireCwdLock(lockCwd, created.jobId, (id) => isJobAlive(jobDir(id)));
    if (!lock.ok) {
      await undo();
      return {
        ok: false,
        error: `Another job is already running in this directory (${cleanName(lockCwd)}): ${lock.blockingJobId}`,
        blockingJobId: lock.blockingJobId,
      };
    }
    locked = true;
    const child = (opts.spawn || spawnProcess)(process.execPath, [RUNNER_PATH, created.dir, created.token], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.on('error', () => {}); // a late spawn error leaves the job to the startup grace -> lost
    if (!Number.isInteger(child.pid)) throw new Error('could not spawn the job runner');
    child.unref();
  } catch (error) {
    await undo();
    return { ok: false, error: `Could not start the job: ${oneLine(error.message)}` };
  }
  return { ok: true, jobId: created.jobId };
}

// A leaderless group is trusted only while the runner has not recorded the child's
// exit and the job was created after the last boot (a pgid from before a reboot or
// from a child that ended earlier may belong to an unrelated group by now).
function leaderlessGroupTrusted(job, s, bootMs) {
  if (s.childExitedAt) return false;
  const created = Date.parse(job && job.createdAt);
  if (!Number.isFinite(created)) return false;
  return !Number.isFinite(bootMs) || created > bootMs;
}

// R18: the runner's group after its identity check; ZCode's group if the child
// is alive with its recorded start time, or gone while its group still has members
// (only while trusted, see leaderlessGroupTrusted).
// Returns the process groups that were signalled. runnerGroup: false never signals the
// runner (the reaper). Groups that passed the checks but could not be signalled (EPERM)
// are pushed to `failed` when given. `signal` replaces signalGroup in tests only.
// `exec` / `bootMs`: test hooks for the ps calls and the boot time. An unknown identity
// sample never leads to a signal.
export function signalJob(job, dir, sig, {
  runnerGroup = true, failed, signal = signalGroup, exec, bootMs = bootTimeMs(),
} = {}) {
  const signalled = [];
  const s = readStatus(dir) || {};
  if (isTerminal(s.state)) return signalled;
  const idOpts = exec ? { exec } : undefined;
  if (runnerGroup && aliveFrom(job, s, (e) => matchesIdentity(e, idOpts)) && Number.isInteger(s.pid)) {
    try { if (signal(s.pid, sig)) signalled.push(s.pid); } catch { if (failed) failed.push(s.pid); }
  }
  const pgid = s.childPgid;
  if (!Number.isInteger(pgid) || pgid <= 1 || !Number.isInteger(s.childPid)) return signalled;
  const id = getProcessIdentity(s.childPid, idOpts);
  if (id && id.unknown) return signalled;
  const ok = id
    ? typeof s.childStart === 'string' && id.start === s.childStart
    : leaderlessGroupTrusted(job, s, bootMs) && groupHasMembers(pgid);
  if (ok) {
    try { if (signal(pgid, sig)) signalled.push(pgid); } catch { if (failed) failed.push(pgid); }
  }
  return signalled;
}

// Polls until the runner recorded a terminal state or no longer passes the identity check.
async function settle(job, dir, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = readStatus(dir);
    if (s && isTerminal(s.state)) return true;
    if (!aliveFrom(job, s)) return isTerminal((readStatus(dir) || {}).state);
    const left = end - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(POLL_MS, left));
  }
}

export async function collectChanges(job) {
  if (job.worktree) {
    try {
      const { changedFiles, diffStat } = await worktreeSummary(job.worktree.dir, job.worktree.startSha);
      return { available: true, changedFiles, diffStat };
    } catch {
      return { available: false, changedFiles: [], diffStat: '' };
    }
  }
  return changesSince(job.params && job.params.cwd, job.baseline);
}

// Last resort when the runner did not record a terminal state itself.
async function markCancelled(job, dir) {
  const changes = await collectChanges(job);
  const s = readStatus(dir) || {};
  if (isTerminal(s.state)) return; // never overwrite a terminal state
  if (job.lockCwd) releaseCwdLock(job.lockCwd, job.jobId); // R14: lock before terminal state
  const warnings = [...(Array.isArray(s.warnings) ? s.warnings : []), 'cancelled_by_manager'];
  const outputLogPath = join(dir, 'output.log');
  const started = Date.parse(s.startedAt);
  writeResult(dir, {
    state: 'cancelled',
    sessionId: s.sessionId || null,
    output: '',
    outputLogPath: existsSync(outputLogPath) ? outputLogPath : null,
    changedFiles: changes.changedFiles,
    diffStat: changes.diffStat,
    changesAvailable: changes.available,
    ...(job.worktree ? { worktree: job.worktree } : {}),
    warnings,
    errorKind: 'cancelled',
    errorMessage: 'Job was cancelled; the runner did not finish, the manager ended it',
    timeoutKind: 'cancelled',
    exitCode: null,
    stderr: '',
    durationMs: Number.isFinite(started) ? Date.now() - started : null,
  });
  patchStatus(dir, { state: 'cancelled', warnings, errorKind: 'cancelled', finishedAt: new Date().toISOString() });
}

export async function cancelJob(jobId, { termGraceMs = 10000, stopGraceMs = STOP_GRACE_MS + 2000 } = {}) {
  const view = getJob(jobId);
  if (!view || isTerminal(view.state)) return view;
  const { job, dir } = view;
  try { writeFileSync(join(dir, 'cancel'), '', { mode: 0o600 }); } catch { /* signals still apply */ }
  // Protocol runners react to the cancel file with session/stop; give them the chance first.
  if (job.path === 'protocol' && (await settle(job, dir, stopGraceMs))) return getJob(jobId);
  signalJob(job, dir, 'SIGTERM');
  if (!(await settle(job, dir, termGraceMs))) {
    signalJob(job, dir, 'SIGKILL');
    if (!(await settle(job, dir, KILL_WAIT_MS))) await markCancelled(job, dir);
  }
  return getJob(jobId);
}

const FINISHED_BEFORE_DELIVERY = 'job finished before the message was delivered';

// Queues `text` for the runner and waits up to ackWaitMs for its answer. Protocol path only.
export async function sendToJob(jobId, text, { ackWaitMs = SEND_ACK_WAIT_MS, signal } = {}) {
  const view = getJob(jobId);
  if (!view) return { ok: false, error: `Unknown job: ${cleanName(String(jobId))}` };
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SEND_TEXT) {
    return invalid(`text must be a non-empty string of at most ${MAX_SEND_TEXT} characters`);
  }
  if (view.job.path === 'cli') return { ok: false, error: 'Sending messages is not supported on the CLI path' };
  if (isTerminal(view.state)) return { ok: false, error: `Job already finished (${view.state})` };
  let seq;
  try {
    seq = writeInboxEntry(view.dir, { kind: 'send', text });
  } catch (error) {
    return { ok: false, error: `Could not queue the message: ${oneLine(error.message)}` };
  }
  const ack = await waitAck(view.dir, seq, ackWaitMs, { signal });
  const after = getJob(jobId) || view;
  if (!ack) {
    if (isTerminal(after.state)) return { ok: false, error: FINISHED_BEFORE_DELIVERY };
    return { ok: true, status: 'queued', view: after };
  }
  if (ack.status === 'rejected' && ack.reason === 'finished') return { ok: false, error: FINISHED_BEFORE_DELIVERY };
  return {
    ok: true,
    status: ack.status,
    ...(ack.reason ? { reason: oneLine(String(ack.reason)) } : {}),
    view: after,
  };
}

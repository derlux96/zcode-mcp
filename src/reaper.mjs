// Reaper: idempotent housekeeping, run at server start and lazily on every tool call.
// 1. Jobs whose runner vanished without a terminal state: kill verified leftovers (R18),
//    free the lock via the claim protocol (R13), then record them as `lost` (R14).
// 2. Retention: delete finished job dirs older than 7 days or beyond the newest 50.
// Only atomic file operations, so two servers may reap concurrently. Never throws for a
// single bad job; never deletes running jobs, worktrees or anything outside jobsRoot().
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  TERMINAL_STATES, stateHome, jobsRoot, jobDir, isJobId, listJobDirs, readJson, readStatus, readResult,
  patchStatus, writeResult,
} from './jobstore.mjs';
import { lockKey, removeStaleLock } from './locks.mjs';
import { aliveFrom, viewOf, isJobAlive, signalJob, groupHasMembers, collectChanges } from './jobs.mjs';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_FINISHED = 50;
const KILL_GRACE_MS = 3000;
const POLL_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTerminal = (state) => TERMINAL_STATES.includes(state);

function lockHolder(cwd) {
  const lock = readJson(join(stateHome(), 'locks', `${lockKey(cwd)}.lock`));
  return lock && lock.jobId;
}

async function waitGroupsGone(pgids, ms) {
  const end = Date.now() + ms;
  while (pgids.some(groupHasMembers) && Date.now() < end) await sleep(POLL_MS);
}

async function killLeftovers(job, dir, graceMs, killed) {
  const add = (pgids) => { for (const p of pgids) if (!killed.includes(p)) killed.push(p); };
  const termed = signalJob(job, dir, 'SIGTERM');
  if (!termed.length) return;
  add(termed);
  await waitGroupsGone(termed, graceMs);
  add(signalJob(job, dir, 'SIGKILL')); // identity/group checks are re-run inside
}

// -> 'lost' when the job was recorded as lost now.
async function reapLost(jobId, dir, graceMs, killed) {
  // A present but unreadable status.json is left alone (not "never started").
  if (existsSync(join(dir, 'status.json')) && !readStatus(dir)) return null;
  const view = viewOf(jobId, dir);
  if (!view || view.state !== 'lost') return null;
  const { job } = view;
  await killLeftovers(job, dir, graceMs, killed);
  if (job.lockCwd) {
    removeStaleLock(job.lockCwd, (id) => isJobAlive(jobDir(id)));
    if (lockHolder(job.lockCwd) === jobId) return null; // R14: retried on the next reap
  }
  const changes = await collectChanges(job);
  const s = readStatus(dir);
  if ((s && isTerminal(s.state)) || aliveFrom(job, s)) return null; // never overwrite a terminal state
  const prior = readResult(dir);
  if (prior && isTerminal(prior.state)) {
    // The runner wrote its result but died before recording the state: keep its result.
    patchStatus(dir, { state: prior.state, finishedAt: new Date().toISOString() });
    return null;
  }
  const st = s || {};
  const warnings = [...(Array.isArray(st.warnings) ? st.warnings : []), 'runner_lost'];
  const outputLogPath = join(dir, 'output.log');
  const started = Date.parse(st.startedAt);
  writeResult(dir, {
    state: 'lost',
    sessionId: st.sessionId || null,
    output: '',
    outputLogPath: existsSync(outputLogPath) ? outputLogPath : null,
    changedFiles: changes.changedFiles,
    diffStat: changes.diffStat,
    changesAvailable: changes.available,
    ...(job.worktree ? { worktree: job.worktree } : {}),
    warnings,
    errorKind: 'crash',
    errorMessage: 'runner disappeared without a result',
    timeoutKind: null,
    exitCode: null,
    stderr: '',
    durationMs: Number.isFinite(started) ? Date.now() - started : null,
  });
  const again = readStatus(dir);
  if (again && isTerminal(again.state)) return null;
  patchStatus(dir, { state: 'lost', warnings, errorKind: 'crash', finishedAt: new Date().toISOString() });
  return 'lost';
}

// Newest mtime of the dir and its direct entries (lstat: links are not followed).
function newestMtime(dir) {
  let newest = lstatSync(dir).mtimeMs;
  for (const name of readdirSync(dir)) {
    try { newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs); } catch { /* vanished */ }
  }
  return newest;
}

// Unreadable status, but nothing in it or only a terminal result: deletable by age only.
function isHusk(dir) {
  const result = readResult(dir);
  if (result && isTerminal(result.state)) return true;
  try { return readdirSync(dir).length === 0; } catch { return false; }
}

// Deletes a real job directory directly inside jobsRoot(); never follows a symlink.
function removeJobDir(dir, rootReal) {
  const id = basename(dir);
  if (!isJobId(id) || dir !== jobDir(id)) return false;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (realpathSync(dir) !== join(rootReal, id)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false; // already removed by a concurrent reaper, or not removable
  }
}

function retention(now) {
  let rootReal;
  try { rootReal = realpathSync(jobsRoot()); } catch { return []; }
  const finished = [];
  const husks = [];
  for (const dir of listJobDirs()) {
    try {
      const status = readStatus(dir);
      if (status && isTerminal(status.state)) finished.push({ dir, mtime: newestMtime(dir) });
      else if (!status && isHusk(dir)) husks.push({ dir, mtime: newestMtime(dir) });
    } catch { /* vanished or unreadable: skip */ }
  }
  finished.sort((a, b) => b.mtime - a.mtime);
  const doomed = [
    ...finished.filter((f, i) => i >= KEEP_FINISHED || now - f.mtime > RETENTION_MS),
    ...husks.filter((h) => now - h.mtime > RETENTION_MS),
  ];
  return doomed.filter((d) => removeJobDir(d.dir, rootReal)).map((d) => basename(d.dir));
}

export async function reap({ now = Date.now(), killGraceMs = KILL_GRACE_MS } = {}) {
  const out = { lost: [], deleted: [], killed: [] };
  for (const dir of listJobDirs()) {
    const jobId = basename(dir);
    const own = jobDir(jobId);
    if (!own || own !== dir) continue;
    try {
      if ((await reapLost(jobId, own, killGraceMs, out.killed)) === 'lost') out.lost.push(jobId);
    } catch { /* one bad job never stops the reaper */ }
  }
  try { out.deleted = retention(now); } catch { /* keep the lost results */ }
  return out;
}

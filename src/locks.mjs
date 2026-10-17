// Per-directory locks: at most one running job per working directory.
import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { stateHome } from './jobstore.mjs';

const MAX_ATTEMPTS = 40;
const CORRUPT_GRACE_MS = 2000;

function canonical(cwd) {
  try { return realpathSync(cwd); } catch { return resolve(cwd); }
}

export function lockKey(cwd) {
  return createHash('sha1').update(canonical(cwd)).digest('hex');
}

function lockPath(cwd) {
  return join(stateHome(), 'locks', `${lockKey(cwd)}.lock`);
}

const suffix = () => `${process.pid}.${randomBytes(4).toString('hex')}`;
const CLAIM_STALE_MS = 30_000;

function tryUnlink(path) {
  try { unlinkSync(path); } catch {}
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Creates `path` exclusively with complete content: write a temp file, then hard-link it into
// place (EEXIST if it already exists). No reader ever sees an empty file.
function createExclusive(path, content) {
  const tmp = `${path}.tmp.${suffix()}`;
  try {
    writeFileSync(tmp, JSON.stringify(content));
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    tryUnlink(tmp);
  }
}

const lockContent = (jobId) => ({ jobId, pid: process.pid, createdAt: new Date().toISOString() });

// -> { jobId } for a readable lock, { corrupt: true, ageMs } for unreadable content, null if gone.
function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data.jobId === 'string') return { jobId: data.jobId };
  } catch {}
  let ageMs = 0;
  try { ageMs = Date.now() - statSync(path).mtimeMs; } catch { return null; }
  return { corrupt: true, ageMs };
}

const isStale = (held, isAlive) => (held.corrupt ? held.ageMs > CORRUPT_GRACE_MS : !isAlive(held.jobId));

// Takeover of a stale lock is serialised by a claim file. Returns 'busy' when another process
// holds the claim, else the result of fn() (claim always removed afterwards).
function withClaim(path, fn) {
  const claim = `${path}.claim`;
  if (!createExclusive(claim, { pid: process.pid, createdAt: new Date().toISOString() })) {
    let abandoned = false;
    try {
      const data = JSON.parse(readFileSync(claim, 'utf8'));
      abandoned = Date.now() - Date.parse(data.createdAt) > CLAIM_STALE_MS;
    } catch {
      try { abandoned = Date.now() - statSync(claim).mtimeMs > CLAIM_STALE_MS; } catch {}
    }
    if (abandoned) {
      const dead = `${claim}.dead.${suffix()}`;
      try { renameSync(claim, dead); tryUnlink(dead); } catch {}
    }
    return 'busy';
  }
  try {
    return fn();
  } finally {
    tryUnlink(claim);
  }
}

export function acquireCwdLock(cwd, jobId, isAlive) {
  const path = lockPath(cwd);
  mkdirSync(join(stateHome(), 'locks'), { recursive: true });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(path, lockContent(jobId))) return { ok: true };
    const held = readLock(path);
    if (held === null) continue; // vanished meanwhile: try again
    if (!isStale(held, isAlive)) return { ok: false, blockingJobId: held.corrupt ? 'unknown' : held.jobId };
    const result = withClaim(path, () => {
      // Re-check under the claim; only claim holders and the owner ever unlink the lock.
      const cur = readLock(path);
      if (cur !== null) {
        if (!isStale(cur, isAlive)) return { ok: false, blockingJobId: cur.corrupt ? 'unknown' : cur.jobId };
        tryUnlink(path);
      }
      if (createExclusive(path, lockContent(jobId))) return { ok: true };
      const third = readLock(path); // a third process created a live lock in the gap
      return { ok: false, blockingJobId: third && third.jobId ? third.jobId : 'unknown' };
    });
    if (result === 'busy') sleepMs(20 + Math.floor(Math.random() * 30));
    else return result;
  }
  // Retries exhausted (heavy contention on a takeover): report whoever holds it now.
  const last = readLock(path);
  return { ok: false, blockingJobId: last && last.jobId ? last.jobId : 'unknown' };
}

// Removes the lock of `cwd` only if it is stale (same claim protocol). True if one was removed.
export function removeStaleLock(cwd, isAlive) {
  const path = lockPath(cwd);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const held = readLock(path);
    if (held === null || !isStale(held, isAlive)) return false;
    const result = withClaim(path, () => {
      const cur = readLock(path);
      if (cur === null || !isStale(cur, isAlive)) return false;
      tryUnlink(path);
      return true;
    });
    if (result === 'busy') sleepMs(20 + Math.floor(Math.random() * 30));
    else return result;
  }
  return false;
}

export function releaseCwdLock(cwd, jobId) {
  const path = lockPath(cwd);
  const held = readLock(path);
  if (held && held.jobId === jobId) tryUnlink(path);
}

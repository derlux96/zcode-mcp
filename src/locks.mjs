// Per-directory locks: at most one running job per working directory.
import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { stateHome } from './jobstore.mjs';

const MAX_ATTEMPTS = 5;
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

function tryUnlink(path) {
  try { unlinkSync(path); } catch {}
}

// Creates the lock exclusively with complete content: write a temp file, then hard-link it
// into place (EEXIST if a lock already exists). No reader ever sees an empty lock file.
function createExclusive(path, jobId) {
  const tmp = `${path}.tmp.${suffix()}`;
  writeFileSync(tmp, JSON.stringify({ jobId, pid: process.pid, createdAt: new Date().toISOString() }));
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    tryUnlink(tmp);
  }
}

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

export function acquireCwdLock(cwd, jobId, isAlive) {
  const path = lockPath(cwd);
  mkdirSync(join(stateHome(), 'locks'), { recursive: true });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(path, jobId)) return { ok: true };
    const held = readLock(path);
    if (held === null) continue; // vanished meanwhile: try again
    if (held.corrupt) {
      if (held.ageMs <= CORRUPT_GRACE_MS) return { ok: false, blockingJobId: 'unknown' };
    } else if (isAlive(held.jobId)) {
      return { ok: false, blockingJobId: held.jobId };
    }
    // Stale: claim it by renaming; only one process's rename succeeds, the others restart.
    const claimed = `${path}.stale.${suffix()}`;
    try {
      renameSync(path, claimed);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    // Another process may have replaced the stale lock between our read and our rename: then we
    // moved a live lock away. Put it back (link fails if yet another lock exists) and re-check.
    const moved = readLock(claimed);
    const sameStale = held.corrupt ? moved && moved.corrupt : moved && moved.jobId === held.jobId;
    if (!sameStale && moved && !moved.corrupt) {
      try { linkSync(claimed, path); } catch {}
    }
    tryUnlink(claimed);
  }
  const last = readLock(path);
  return { ok: false, blockingJobId: last && last.jobId ? last.jobId : 'unknown' };
}

export function releaseCwdLock(cwd, jobId) {
  const path = lockPath(cwd);
  const held = readLock(path);
  if (held && held.jobId === jobId) tryUnlink(path);
}

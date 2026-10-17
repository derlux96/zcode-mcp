// Per-directory locks: at most one running job per working directory.
import { createHash, randomBytes } from 'node:crypto';
import {
  linkSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { stateHome, ensurePrivateDir } from './jobstore.mjs';

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
const CLAIM_MAX_AGE_MS = 120_000; // fallback for pid reuse; see isClaimAbandoned

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
    writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
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

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else; ESRCH means gone
  }
}

function readClaim(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch {}
  return null;
}

// A claim is abandoned if its holder process is gone, or (pid reuse fallback) it is older than 120 s.
export function isClaimAbandoned(data, alive = pidAlive, now = Date.now()) {
  if (!alive(data.pid)) return true;
  return now - Date.parse(data.createdAt) > CLAIM_MAX_AGE_MS;
}

// Removes the claim at `claim` only if it still is the one judged abandoned (same nonce).
// Renames it away first (one remover wins), then verifies the nonce of what was moved. If it
// differs, a live claim was moved: do NOT restore it (its holder notices the missing/foreign
// claim via its own nonce check and backs off); the caller just re-evaluates from the top.
export function stealClaim(claim, judged) {
  const dead = `${claim}.dead.${suffix()}`;
  try { renameSync(claim, dead); } catch { return 'busy'; }
  const moved = readClaim(dead);
  tryUnlink(dead);
  return moved && moved.nonce === judged.nonce ? 'stolen' : 'busy';
}

// Takeover of a stale lock is serialised by a claim file `<lock>.claim` holding a random nonce.
// Returns 'busy' when another process holds the claim, else the result of fn(owns) where
// owns() re-verifies that the claim still carries our nonce (call it before unlinking the lock).
// Residual, accepted: a holder that stays alive but stalls for more than 120 s inside this
// microsecond-wide critical section could have its claim stolen; this needs a pid-alive stall
// (e.g. suspended process) at exactly the wrong moment, and the nonce checks limit the damage.
function withClaim(path, fn) {
  const claim = `${path}.claim`;
  const nonce = randomBytes(8).toString('hex');
  if (!createExclusive(claim, { pid: process.pid, createdAt: new Date().toISOString(), nonce })) {
    const data = readClaim(claim);
    let abandoned = false;
    let judged = { nonce: undefined };
    if (data) {
      judged = data;
      abandoned = isClaimAbandoned(data);
    } else {
      try { abandoned = Date.now() - statSync(claim).mtimeMs > CLAIM_MAX_AGE_MS; } catch {}
    }
    if (abandoned) stealClaim(claim, judged);
    return 'busy';
  }
  const owns = () => {
    const cur = readClaim(claim);
    return !!cur && cur.nonce === nonce;
  };
  try {
    return fn(owns);
  } finally {
    if (owns()) tryUnlink(claim);
  }
}

export function acquireCwdLock(cwd, jobId, isAlive) {
  const path = lockPath(cwd);
  ensurePrivateDir(join(stateHome(), 'locks'));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (createExclusive(path, lockContent(jobId))) return { ok: true };
    const held = readLock(path);
    if (held === null) continue; // vanished meanwhile: try again
    if (!isStale(held, isAlive)) return { ok: false, blockingJobId: held.corrupt ? 'unknown' : held.jobId };
    const result = withClaim(path, (owns) => {
      // Re-check under the claim; only claim holders and the owner ever unlink the lock.
      const cur = readLock(path);
      if (cur !== null) {
        if (!isStale(cur, isAlive)) return { ok: false, blockingJobId: cur.corrupt ? 'unknown' : cur.jobId };
        if (!owns()) return { ok: false, blockingJobId: 'unknown' };
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
    const result = withClaim(path, (owns) => {
      const cur = readLock(path);
      if (cur === null || !isStale(cur, isAlive)) return false;
      if (!owns()) return false;
      tryUnlink(path);
      return true;
    });
    if (result === 'busy') sleepMs(20 + Math.floor(Math.random() * 30));
    else return result;
  }
  return false;
}

// Callers must release the lock BEFORE marking the job dead/terminal: isAlive(jobId) has to stay
// true until this returns, otherwise a claim holder may treat the lock as stale while we release.
export function releaseCwdLock(cwd, jobId) {
  const path = lockPath(cwd);
  const held = readLock(path);
  if (held && held.jobId === jobId) tryUnlink(path);
}

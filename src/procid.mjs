import { execFileSync } from 'node:child_process';

// `ps -o lstart=` prints local time: a fixed locale and time zone make the
// recorded start comparable across processes with a different TZ (C1).
// -ww: never truncate `command=` (the token sits at the end of a long argv).
const PS_ENV = () => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC' });

// -> the field's text, null when ps reports no such process (exit 1, no
// output), or UNKNOWN when ps itself failed (fork failure, signal, ...).
const UNKNOWN = Symbol('unknown');

function ps(field, pid, exec) {
  try {
    const out = String(exec('ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: PS_ENV(),
    })).trim();
    return out || null;
  } catch (err) {
    if (err && err.status === 1 && !String(err.stdout ?? '').trim()) return null;
    return UNKNOWN;
  }
}

// -> { pid, start, command } | null (no such process) | { pid, unknown: true }
// (ps could not be run; the process may well be alive). opts.exec: test hook.
export function getProcessIdentity(pid, { exec = execFileSync } = {}) {
  const start = ps('lstart', pid, exec);
  if (start === UNKNOWN) return { pid, unknown: true };
  if (start === null) return null;
  const command = ps('command', pid, exec);
  if (command === UNKNOWN) return { pid, unknown: true };
  if (command === null) return null;
  return { pid, start, command };
}

// -> 'match' | 'mismatch' | 'unknown'
function compare({ pid, start, token }, opts) {
  if (token !== undefined && (typeof token !== 'string' || token === '')) {
    throw new TypeError('token must be a non-empty string when provided');
  }
  const id = getProcessIdentity(pid, opts);
  if (id && id.unknown) return 'unknown';
  if (!id || id.start !== start) return 'mismatch';
  return token === undefined || id.command.includes(token) ? 'match' : 'mismatch';
}

// Signalling decisions: only a definite match counts (an unknown sample never does).
export function matchesIdentity(expected, opts) {
  return compare(expected, opts) === 'match';
}

// Liveness decisions: an unknown sample counts as alive, so a transient ps
// failure never declares a job lost.
export function identityAlive(expected, opts) {
  return compare(expected, opts) !== 'mismatch';
}

export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new RangeError(`invalid pgid: ${String(pgid)}`);
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

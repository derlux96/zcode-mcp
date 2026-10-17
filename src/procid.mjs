import { execFileSync } from 'node:child_process';

function ps(field, pid) {
  try {
    const out = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function getProcessIdentity(pid) {
  const start = ps('lstart', pid);
  if (start === null) return null;
  const command = ps('command', pid);
  if (command === null) return null;
  return { pid, start, command };
}

export function matchesIdentity({ pid, start, token }) {
  if (token !== undefined && (typeof token !== 'string' || token === '')) {
    throw new TypeError('token must be a non-empty string when provided');
  }
  const id = getProcessIdentity(pid);
  if (!id || id.start !== start) return false;
  return token === undefined || id.command.includes(token);
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

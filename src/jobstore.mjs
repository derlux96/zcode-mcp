// On-disk job store: $ZCODE_MCP_HOME (default ~/.zcode-mcp)/jobs/<jobId>/
// {job.json,status.json,result.json,output.log,events.log,cancel}.
// A detached runner writes while the MCP server reads, so all JSON writes
// are atomic (temp file in the same directory, then rename).
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync, accessSync, constants, writeFileSync, renameSync, readFileSync,
  readdirSync, rmSync, statSync, chmodSync,
} from 'node:fs';

// Graceful cancel: after session/stop the turn gets this long to end before the group is killed.
export const STOP_GRACE_MS = 10000;

export const TERMINAL_STATES = ['completed', 'failed', 'timeout', 'cancelled', 'lost'];

export function stateHome() {
  if (process.env.ZCODE_MCP_HOME) return process.env.ZCODE_MCP_HOME;
  // os.homedir() reads $HOME on every call (POSIX), so tests can redirect it.
  return join(homedir(), '.zcode-mcp');
}

export function jobsRoot() {
  return join(stateHome(), 'jobs');
}

// Creates `dir` (and parents) with mode 0700. An existing state directory that
// belongs to this user only LOSES its group/other bits; owner bits are never
// added, so a deliberately read-only directory (0500) stays read-only and the
// caller's writability check still fails as the user intended.
// Used for the home, jobs and locks.
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid === uid && (st.mode & 0o077) !== 0) chmodSync(dir, st.mode & 0o700);
}

const JOB_ID_RE = /^job_[0-9a-z]+_[0-9a-f]{6}$/;

export function isJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

// Directory of a job, or null for anything that is not a well-formed job id
// (never resolves a caller-supplied path such as '../x').
export function jobDir(id) {
  return isJobId(id) ? join(jobsRoot(), id) : null;
}

export function newJobId() {
  return `job_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function notWritable(cause, where) {
  const err = new Error(`State directory is not writable: ${where} (${cause.message})`);
  err.code = 'not-writable';
  return err;
}

export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function createJobDir(spec = {}) {
  const root = jobsRoot();
  const jobId = newJobId();
  const dir = join(root, jobId);
  const token = randomBytes(16).toString('hex');
  try {
    ensurePrivateDir(stateHome());
    ensurePrivateDir(root);
    accessSync(root, constants.W_OK);
    mkdirSync(dir, { mode: 0o700 });
    writeJsonAtomic(join(dir, 'job.json'), {
      jobId, token, createdAt: new Date().toISOString(), ...spec,
    });
  } catch (err) {
    throw notWritable(err, root);
  }
  return { jobId, dir, token };
}

export function readStatus(dir) {
  return readJson(join(dir, 'status.json'));
}

export function patchStatus(dir, patch) {
  const merged = { ...(readStatus(dir) || {}), ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(join(dir, 'status.json'), merged);
  return merged;
}

export function readResult(dir) {
  return readJson(join(dir, 'result.json'));
}

export function writeResult(dir, obj) {
  writeJsonAtomic(join(dir, 'result.json'), obj);
}

function idKey(name) {
  const [, time = '', rand = ''] = name.split('_');
  return { time: parseInt(time, 36) || 0, rand };
}

// Oldest first: by the base36 time, then by the random part.
export function compareJobIds(a, b) {
  const x = idKey(a), y = idKey(b);
  return x.time - y.time || (x.rand < y.rand ? -1 : x.rand > y.rand ? 1 : 0);
}

export function listJobDirs() {
  const root = jobsRoot();
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('job_'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  names.sort(compareJobIds);
  return names.map((n) => join(root, n));
}

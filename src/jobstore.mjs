// On-disk job store: $ZCODE_MCP_HOME (default ~/.zcode-mcp)/jobs/<jobId>/
// {job.json,status.json,result.json,output.log,events.log,cancel}.
// A detached runner writes while the MCP server reads, so all JSON writes
// are atomic (temp file in the same directory, then rename).
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync, accessSync, constants, writeFileSync, renameSync, readFileSync,
  readdirSync, rmSync,
} from 'node:fs';

export const TERMINAL_STATES = ['completed', 'failed', 'timeout', 'cancelled', 'lost'];

export function stateHome() {
  if (process.env.ZCODE_MCP_HOME) return process.env.ZCODE_MCP_HOME;
  // Read HOME from the env (not os.homedir(), cached per process) so tests can redirect it.
  return join(process.env.HOME || homedir(), '.zcode-mcp');
}

export function jobsRoot() {
  return join(stateHome(), 'jobs');
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
    mkdirSync(root, { recursive: true, mode: 0o700 });
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
  names.sort((a, b) => {
    const x = idKey(a), y = idKey(b);
    return x.time - y.time || (x.rand < y.rand ? -1 : x.rand > y.rand ? 1 : 0);
  });
  return names.map((n) => join(root, n));
}

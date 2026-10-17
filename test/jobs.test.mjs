import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin, run } from './helpers.mjs';
import {
  chooseJobPath, isJobAlive, startJob, getJob, waitJob, cancelJob, listJobs, REASONING_LEVELS,
} from '../src/jobs.mjs';
import { createJobDir, patchStatus, readJson, readStatus, stateHome, jobsRoot } from '../src/jobstore.mjs';
import { acquireCwdLock, lockKey, releaseCwdLock } from '../src/locks.mjs';
import { getProcessIdentity } from '../src/procid.mjs';

const fakeAppServer = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));
const temps = [];
const extraPids = [];
let base;

before(() => {
  base = makeTempDir('zcode-jobs-');
  temps.push(base);
  process.env.ZCODE_MCP_STATE = join(base, 'sessions.json');
  process.env.ZCODE_BIN = fakeBin;
  process.env.ZCODE_APPSERVER_BIN = fakeAppServer;
});

beforeEach(() => {
  process.env.ZCODE_MCP_HOME = makeTempDir('zcode-home-');
  temps.push(process.env.ZCODE_MCP_HOME);
});

afterEach(async () => {
  for (const v of listJobs()) {
    if (!['completed', 'failed', 'timeout', 'cancelled', 'lost'].includes(v.state)) {
      await cancelJob(v.jobId, { termGraceMs: 2000 });
    }
  }
  for (const pid of extraPids.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  delete process.env.FAKE_ZCODE_MODE;
  delete process.env.FAKE_APPSERVER_MODE;
});

after(() => {
  for (const k of ['ZCODE_MCP_HOME', 'ZCODE_MCP_STATE', 'ZCODE_BIN', 'ZCODE_APPSERVER_BIN']) delete process.env[k];
  for (const d of temps) {
    try { chmodSync(d, 0o700); } catch {}
    removeDir(d);
  }
});

function tempCwd() {
  const d = makeTempDir('zcode-cwd-');
  temps.push(d);
  return d;
}

function gitCwd() {
  const d = makeGitRepo();
  temps.push(d);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 10000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error('waitFor timed out');
}

// Alive and not a zombie.
function alive(pid) {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false;
  }
}

const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled', 'lost'];
const isTerminal = (v) => TERMINAL.includes(v.state);

// A detached process (own process group) whose command line carries `arg`.
async function spawnHolder(arg, { ignoreTerm = false } = {}) {
  const code = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}process.stdout.write('ready\\n');setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', code, arg], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  extraPids.push(child.pid);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy();
  return child.pid;
}

function spawnSleep() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  extraPids.push(child.pid);
  return child.pid;
}

// Hand-written job whose runner identity is the given pid.
function handJob({ pid, start, cwd = tempCwd(), lock = false, createdAt, extraStatus = {} } = {}) {
  const lockCwd = realpathSync(cwd);
  const spec = { params: { prompt: 'x', cwd: lockCwd, mode: 'yolo' }, path: 'cli', baseline: null, lockCwd };
  if (createdAt) spec.createdAt = createdAt;
  const job = createJobDir(spec);
  if (lock) assert.equal(acquireCwdLock(lockCwd, job.jobId, () => true).ok, true);
  if (pid !== undefined) {
    patchStatus(job.dir, {
      state: 'running', pid, pidStart: start, token: job.token,
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), warnings: [], ...extraStatus,
    });
  }
  return { ...job, lockCwd };
}

const lockFile = (cwd) => join(stateHome(), 'locks', `${lockKey(cwd)}.lock`);

test('protocol vs cli path choice', () => {
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp' }), 'protocol');
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp', model: 'glm-test/small' }), 'protocol');
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp', model: 'small', mode: 'yolo' }), 'protocol');
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp', mode: 'yolo' }), 'cli');
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp', resume: 'sess_1' }), 'cli');
  assert.equal(chooseJobPath({ prompt: 'x', cwd: '/tmp', target: 't' }), 'cli');
  assert.deepEqual(REASONING_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('validation messages', async () => {
  const cwd = tempCwd();
  const cases = [
    [{ cwd }, /^Invalid arguments: prompt must be a non-empty string/],
    [{ prompt: 'x', cwd: 'rel' }, /cwd must be an absolute path/],
    [{ prompt: 'x', cwd, timeout_ms: 21600001 }, /timeout_ms must be an integer between 1000 and 21600000/],
    [{ prompt: 'x', cwd, mode: 'yolo', resume: 'run_abc' }, /server-generated run-id and is not resumable/],
    [{ prompt: 'x', cwd, model: '' }, /model must be a non-empty string/],
    [{ prompt: 'x', cwd, model: 'small', resume: 'sess_1' }, /resume is not supported together with model/],
    [{ prompt: 'x', cwd, model: 'small', target: 't' }, /target is not supported together with model/],
    [{ prompt: 'x', cwd, model: 'small', mode: 'plan' }, /with model only mode 'yolo' is supported/],
    [{ prompt: 'x', cwd, model: 'nope', mode: 'yolo' }, /^Model 'nope' not found/], // explicit yolo + model passes validation
    [{ prompt: 'x', cwd, reasoning_level: 'huge' }, /reasoning_level must be one of low\|medium\|high\|xhigh\|max/],
    [{ prompt: 'x', cwd, mode: 'build', idle_timeout_ms: 5000 }, /idle_timeout_ms applies only .*protocol mode/],
    [{ prompt: 'x', cwd, mode: 'build', reasoning_level: 'low' }, /reasoning_level applies only when model is set or no mode\/resume\/target is given/],
  ];
  for (const [args, re] of cases) {
    const r = await startJob(args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, re);
  }
  assert.deepEqual(listJobs(), []);
});

test('invalid job ids (../x, empty, wrong pattern) return null from getJob/waitJob/cancelJob', async () => {
  for (const id of ['../x', '', 'job_abc', 'job_abc_12345z', '../../etc', undefined, 'job_abc_123456']) {
    assert.equal(getJob(id), null);
    assert.equal(await waitJob(id, { waitMs: 10, until: 'terminal' }), null);
    assert.equal(await cancelJob(id), null);
  }
});

test('startJob returns before the task finishes', async () => {
  process.env.FAKE_ZCODE_MODE = 'slow-start';
  const cwd = tempCwd();
  const t0 = Date.now();
  const r = await startJob({ prompt: 'x', cwd, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  assert.ok(Date.now() - t0 < 1500, 'returned without waiting for the 2 s task');
  const v = getJob(r.jobId);
  assert.equal(isTerminal(v), false);
  assert.equal(v.alive, true);
  assert.equal(v.job.path, 'cli');
  assert.equal(v.job.params.cwd, realpathSync(cwd));
  assert.equal(v.job.lockCwd, realpathSync(cwd));
  const done = await waitJob(r.jobId, { waitMs: 15000, until: 'terminal' });
  assert.equal(done.state, 'completed');
  assert.equal(done.result.sessionId, 'sess_slow001');
  assert.equal(done.alive, false);
  assert.equal(existsSync(lockFile(cwd)), false, 'runner released the lock');
});

test('protocol job with a bare model id resolves the model and completes', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), model: 'small', reasoning_level: 'low', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  const done = await waitJob(r.jobId, { waitMs: 15000, until: 'terminal' });
  assert.equal(done.job.path, 'protocol');
  assert.deepEqual(done.job.model, { providerId: 'glm-test', modelId: 'small' });
  assert.equal(done.state, 'completed');
});

test('second job in same cwd is rejected with blockingJobId', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const cwd = tempCwd();
  const first = await startJob({ prompt: 'x', cwd, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(first.ok, true, first.error);
  const second = await startJob({ prompt: 'y', cwd, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(second.ok, false);
  assert.match(second.error, /already running in this directory/);
  assert.equal(second.blockingJobId, first.jobId);
  assert.equal(listJobs().length, 1, 'rejected start left no job dir');
});

test('fourth concurrent job is rejected', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await startJob({ prompt: 'x', cwd: tempCwd(), mode: 'yolo', timeout_ms: 30000 });
    assert.equal(r.ok, true, r.error);
    ids.push(r.jobId);
  }
  const fourth = await startJob({ prompt: 'x', cwd: tempCwd(), mode: 'yolo', timeout_ms: 30000 });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.error, 'too many running jobs (3)');
  assert.ok(ids.includes(fourth.blockingJobId));
  assert.equal(listJobs().length, 3);
});

test('cwd via symlink or with spaces maps to the same lock', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const parent = tempCwd();
  const real = join(parent, 'dir with spaces');
  mkdirSync(real);
  const link = join(parent, 'link to it');
  symlinkSync(real, link);
  assert.equal(lockKey(real), lockKey(link));
  const first = await startJob({ prompt: 'x', cwd: link, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(first.ok, true, first.error);
  assert.equal(getJob(first.jobId).job.lockCwd, realpathSync(real));
  const second = await startJob({ prompt: 'x', cwd: real, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(second.ok, false);
  assert.equal(second.blockingJobId, first.jobId);
});

test('isJobAlive is false for a foreign process with the recorded pid', () => {
  const pid = spawnSleep();
  const start = getProcessIdentity(pid).start;
  const { dir, jobId } = handJob({ pid, start });
  assert.equal(isJobAlive(dir), false, 'sleep has the pid and start time but not the token');
  const v = getJob(jobId);
  assert.equal(v.state, 'lost');
  assert.equal(v.alive, false);
  assert.equal(readStatus(dir).state, 'running', 'a read persists nothing');
  assert.equal(alive(pid), true);
});

test('stalled is true with live identity and old heartbeat, state stays running, never lost for that', async () => {
  const { dir, jobId, token } = handJob();
  const pid = await spawnHolder(token);
  patchStatus(dir, {
    state: 'running', pid, pidStart: getProcessIdentity(pid).start, token,
    heartbeatAt: new Date(Date.now() - 60000).toISOString(), warnings: [],
  });
  const v = getJob(jobId);
  assert.equal(v.alive, true);
  assert.equal(v.stalled, true);
  assert.equal(v.state, 'running');
  assert.ok(v.warnings.includes('stalled'));
  assert.equal(isJobAlive(dir), true);
  patchStatus(dir, { heartbeatAt: new Date().toISOString() });
  const fresh = getJob(jobId);
  assert.equal(fresh.stalled, false);
  assert.equal(fresh.warnings.includes('stalled'), false);
});

test('startup grace: a just-created job without runner identity is alive, lost after 15 s', () => {
  const young = handJob({ createdAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(isJobAlive(young.dir), true);
  assert.equal(getJob(young.jobId).state, 'starting');
  const old = handJob({ createdAt: new Date(Date.now() - 16000).toISOString() });
  assert.equal(isJobAlive(old.dir), false);
  assert.equal(getJob(old.jobId).state, 'lost');
  patchStatus(young.dir, { state: 'failed' }); // nothing to cancel in cleanup
});

test('waitJob returns running after waitMs and terminal when done', async () => {
  process.env.FAKE_ZCODE_MODE = 'slow-start';
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), mode: 'yolo', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  const t0 = Date.now();
  const mid = await waitJob(r.jobId, { waitMs: 400, until: 'terminal' });
  assert.ok(Date.now() - t0 >= 380);
  assert.equal(isTerminal(mid), false);
  const done = await waitJob(r.jobId, { waitMs: 15000, until: 'terminal' });
  assert.equal(done.state, 'completed');
  const changed = await waitJob(r.jobId, { waitMs: 5000, until: 'change' });
  assert.equal(changed.state, 'completed', 'a terminal job returns at once');
});

test('waitJob until change resolves on a status update', async () => {
  const { dir, jobId, token } = handJob();
  const pid = await spawnHolder(token);
  patchStatus(dir, { state: 'starting', pid, pidStart: getProcessIdentity(pid).start, token });
  setTimeout(() => patchStatus(dir, { state: 'running' }), 300);
  const t0 = Date.now();
  const v = await waitJob(jobId, { waitMs: 5000, until: 'change' });
  assert.equal(v.state, 'running');
  assert.ok(Date.now() - t0 < 2000);
});

test('aborting waitJob does not stop the job', async () => {
  process.env.FAKE_ZCODE_MODE = 'slow-start';
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), mode: 'yolo', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const v = await waitJob(r.jobId, { waitMs: 10000, signal: ac.signal, until: 'terminal' });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(isTerminal(v), false);
  assert.equal(getJob(r.jobId).alive, true);
  const done = await waitJob(r.jobId, { waitMs: 15000, until: 'terminal' });
  assert.equal(done.state, 'completed');
});

test('cancelJob ends the job and leaves no process', async () => {
  process.env.FAKE_ZCODE_MODE = 'spawn-grandchild';
  const cwd = tempCwd();
  const r = await startJob({ prompt: 'x', cwd, mode: 'yolo', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  const status = await waitFor(() => {
    const s = getJob(r.jobId).status;
    return s && s.state === 'running' && s.childPid ? s : null;
  });
  await sleep(500); // let the fake spawn its grandchild
  const v = await cancelJob(r.jobId);
  assert.equal(v.state, 'cancelled');
  assert.equal(v.result.state, 'cancelled');
  const m = /grandchild pid (\d+)/.exec(v.result.stderr);
  assert.ok(m, 'grandchild pid reported');
  const grandchild = Number(m[1]);
  await waitFor(() => !alive(status.pid) && !alive(status.childPid) && !alive(grandchild), 5000);
  assert.equal(existsSync(lockFile(cwd)), false);
});

test('cancelJob escalates to SIGKILL', async () => {
  const cwd = tempCwd();
  const { dir, jobId, token } = handJob({ cwd, lock: true });
  const pid = await spawnHolder(token, { ignoreTerm: true });
  patchStatus(dir, { state: 'running', pid, pidStart: getProcessIdentity(pid).start, token, heartbeatAt: new Date().toISOString() });
  assert.equal(existsSync(lockFile(cwd)), true);
  const t0 = Date.now();
  const v = await cancelJob(jobId, { termGraceMs: 300 });
  assert.ok(Date.now() - t0 >= 300, 'waited the grace period first');
  await waitFor(() => !alive(pid), 5000);
  assert.equal(v.state, 'cancelled');
  assert.equal(readStatus(dir).state, 'cancelled');
  assert.equal(v.result.state, 'cancelled');
  assert.ok(v.result.warnings.includes('cancelled_by_manager'));
  assert.equal(existsSync(join(dir, 'cancel')), true);
  assert.equal(existsSync(lockFile(cwd)), false, 'lock released');
  // terminal states are never overwritten
  const again = await cancelJob(jobId, { termGraceMs: 300 });
  assert.equal(again.status.updatedAt, v.status.updatedAt);
});

test('cancelJob does nothing to a foreign process with a reused pid', async () => {
  // Runner identity fails: the job is lost, nothing is signalled.
  const foreign = spawnSleep();
  const lost = handJob({ pid: foreign, start: getProcessIdentity(foreign).start });
  const v1 = await cancelJob(lost.jobId, { termGraceMs: 300 });
  assert.equal(v1.state, 'lost');
  assert.equal(alive(foreign), true);
  // Runner identity holds, but the recorded child pid now belongs to a foreign
  // process (start time differs): only the runner is signalled.
  const { dir, jobId, token } = handJob();
  const runnerPid = await spawnHolder(token);
  patchStatus(dir, {
    state: 'running', pid: runnerPid, pidStart: getProcessIdentity(runnerPid).start, token,
    childPid: foreign, childPgid: foreign, childStart: 'Mon Jan  1 00:00:00 2001',
  });
  const v2 = await cancelJob(jobId, { termGraceMs: 300 });
  assert.equal(v2.state, 'cancelled');
  await waitFor(() => !alive(runnerPid), 5000);
  assert.equal(alive(foreign), true, 'foreign process untouched');
});

test('unwritable home returns ok false before spawning', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async () => {
  const home = tempCwd();
  chmodSync(home, 0o500);
  process.env.ZCODE_MCP_HOME = join(home, 'state');
  const cwd = gitCwd();
  const branches = run(cwd, 'git', ['branch', '--list']);
  const r = await startJob({ prompt: 'x', cwd, mode: 'yolo', isolate_worktree: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /not writable/);
  assert.equal(existsSync(join(home, 'state')), false);
  assert.equal(existsSync(join(cwd, '.zcode-worktrees')), false);
  assert.equal(run(cwd, 'git', ['branch', '--list']), branches);
});

test('unknown model creates no worktree and no job', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const cwd = gitCwd();
  const branches = run(cwd, 'git', ['branch', '--list']);
  const r = await startJob({ prompt: 'x', cwd, model: 'nope', isolate_worktree: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Model 'nope' not found/);
  assert.match(r.error, /glm-test\/small \(reasoning: low,medium,high\)/);
  assert.equal(run(cwd, 'git', ['branch', '--list']), branches);
  assert.equal(existsSync(join(cwd, '.zcode-worktrees')), false);
  assert.deepEqual(listJobs(), []);
  const locks = join(stateHome(), 'locks');
  assert.deepEqual(existsSync(locks) ? readdirSync(locks) : [], []);
});

test('worktree job: lock is on the worktree dir, result carries worktree info, and the worktree is removed again when spawn fails', async () => {
  process.env.FAKE_ZCODE_MODE = 'slow-start';
  const cwd = gitCwd();
  const r = await startJob({ prompt: 'x', cwd, mode: 'yolo', isolate_worktree: true, timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  const { job } = getJob(r.jobId);
  assert.ok(job.worktree && job.worktree.dir.includes('.zcode-worktrees'));
  assert.equal(job.lockCwd, job.worktree.dir);
  assert.equal(job.baseline.gitRoot, realpathSync(job.worktree.dir));
  const onWorktree = acquireCwdLock(job.worktree.dir, 'job_x_000000', () => true);
  assert.equal(onWorktree.ok, false);
  assert.equal(onWorktree.blockingJobId, r.jobId);
  assert.equal(acquireCwdLock(cwd, 'job_y_000000', () => true).ok, true, 'origin dir is not locked');
  releaseCwdLock(cwd, 'job_y_000000');
  const done = await waitJob(r.jobId, { waitMs: 15000, until: 'terminal' });
  assert.equal(done.state, 'completed');
  assert.equal(done.result.worktree.branch, job.worktree.branch);
  assert.equal(done.result.worktree.dir, job.worktree.dir);

  const branches = run(cwd, 'git', ['branch', '--list']);
  const worktrees = readdirSync(join(cwd, '.zcode-worktrees'));
  const failed = await startJob(
    { prompt: 'x', cwd, mode: 'yolo', isolate_worktree: true },
    { spawn: () => { throw new Error('spawn exploded'); } },
  );
  assert.equal(failed.ok, false);
  assert.match(failed.error, /spawn exploded/);
  assert.equal(run(cwd, 'git', ['branch', '--list']), branches);
  assert.deepEqual(readdirSync(join(cwd, '.zcode-worktrees')), worktrees);
  assert.equal(listJobs().length, 1, 'no job dir for the failed start');
  assert.equal(readdirSync(join(stateHome(), 'locks')).filter((f) => f.endsWith('.lock')).length, 0);
});

test('listJobs is newest first and getJob of a missing job is null', async () => {
  const a = handJob({ createdAt: new Date(Date.now() - 20000).toISOString() });
  await sleep(5);
  const b = handJob({ createdAt: new Date(Date.now() - 20000).toISOString() });
  assert.deepEqual(listJobs().map((v) => v.jobId), [b.jobId, a.jobId]);
  assert.equal(getJob('job_zzzzzz_abcdef'), null);
  assert.equal(readJson(join(jobsRoot(), a.jobId, 'job.json')).jobId, a.jobId);
});

test('a worktree that cannot be created is reported as such, not as a missing repository', async () => {
  const repo = gitCwd();
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  const r = await startJob({ prompt: 'x', cwd: sub, mode: 'yolo', isolate_worktree: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not create worktree: /);
  assert.deepEqual(listJobs(), []);
});

import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin, run } from './helpers.mjs';
import {
  aliveFrom, chooseJobPath, isJobAlive, startJob, getJob, waitJob, cancelJob, listJobs, REASONING_LEVELS,
  sendToJob, SEND_ACK_WAIT_MS, MAX_SEND_TEXT, formatCatalog, collectChanges, signalJob,
} from '../src/jobs.mjs';
import { validateRunArgs } from '../src/runner.mjs';
import { captureBaseline } from '../src/changes.mjs';
import { createJobDir, patchStatus, readJson, readStatus, stateHome, jobsRoot, STOP_GRACE_MS } from '../src/jobstore.mjs';
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
    [{ prompt: 'x', cwd, timeout_ms: 21600001 }, /timeout_ms must be 0 \(no cap\) or an integer between 1000 and 21600000/],
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
  assert.equal(fourth.blockingJobId, ids[0], 'the oldest running job is named');
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

test('an EXISTING read-only state home: startJob fails before spawning anything (real faults-run regression)', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async () => {
  const home = makeTempDir('zcode-ro-home-');
  temps.push(home);
  chmodSync(home, 0o500);
  process.env.ZCODE_MCP_HOME = home;
  const cwd = gitCwd();
  try {
    const r = await startJob({ prompt: 'x', cwd, mode: 'yolo' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not writable/);
    assert.equal((statSync(home).mode & 0o777).toString(8), '500', 'permission left alone');
  } finally {
    chmodSync(home, 0o700);
  }
  assert.deepEqual(readdirSync(home), [], 'no jobs/locks directories were created');
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

test('aliveFrom: a null pidStart counts as alive while the pid exists and its command line has the token', () => {
  const token = 'jobs.test.mjs'; // the test file name is in this process' command line
  const job = { token, createdAt: new Date(Date.now() - 3600e3).toISOString() };
  const status = { state: 'running', pid: process.pid, pidStart: null };
  assert.equal(aliveFrom(job, status), true);
  assert.equal(aliveFrom({ ...job, token: 'not-in-any-command-line-9f3a' }, status), false);
  assert.equal(aliveFrom(job, { ...status, pid: 2 ** 22 + 12345 }), false);
});

// ---- Task 7: sendToJob, graceful cancel, input_timeout_ms ----

function protocolHandJob(extra = {}) {
  const cwd = realpathSync(tempCwd());
  const job = createJobDir({ params: { prompt: 'x', cwd }, path: 'protocol', baseline: null, lockCwd: cwd });
  patchStatus(job.dir, { state: 'running', warnings: [], ...extra });
  return job;
}

test('SEND_ACK_WAIT_MS is 5000', () => {
  assert.equal(SEND_ACK_WAIT_MS, 5000);
});

test('sendToJob: unknown id, invalid text, CLI path, terminal job', async () => {
  let r = sendToJob('job_00000000-0000-0000-0000-000000000000', 'hi');
  r = await r;
  assert.equal(r.ok, false);
  assert.match(r.error, /^Unknown job: /);
  const cli = handJob({ pid: process.pid, start: getProcessIdentity(process.pid).start });
  patchStatus(cli.dir, { token: cli.token });
  r = await sendToJob(cli.jobId, 'hi');
  assert.equal(r.ok, false);
  assert.match(r.error, /not supported on the CLI path/);
  const done = protocolHandJob();
  patchStatus(done.dir, { state: 'completed', finishedAt: new Date().toISOString() });
  r = await sendToJob(done.jobId, 'hi');
  assert.equal(r.ok, false);
  assert.match(r.error, /already finished/);
  const live = protocolHandJob();
  for (const bad of ['', 5, undefined, 'x'.repeat(20001)]) {
    r = await sendToJob(live.jobId, bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /^Invalid arguments:/);
  }
});

test('sendToJob without a runner ack within ackWaitMs on a live job is queued', async () => {
  const job = protocolHandJob();
  const pid = await spawnHolder(job.token);
  patchStatus(job.dir, { pid, pidStart: getProcessIdentity(pid).start, token: job.token, heartbeatAt: new Date().toISOString() });
  const r = await sendToJob(job.jobId, 'hello', { ackWaitMs: 200 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'queued');
  assert.equal(r.view.jobId, job.jobId);
});

test('sendToJob: job turning terminal during the wait without an ack is an error', async () => {
  const job = protocolHandJob();
  const pid = await spawnHolder(job.token);
  patchStatus(job.dir, { pid, pidStart: getProcessIdentity(pid).start, token: job.token, heartbeatAt: new Date().toISOString() });
  setTimeout(() => patchStatus(job.dir, { state: 'failed', finishedAt: new Date().toISOString() }), 100);
  const r = await sendToJob(job.jobId, 'hello', { ackWaitMs: 400 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'job finished before the message was delivered');
});

test('sendToJob maps a rejected/finished ack to the finished error and passes other acks through', async () => {
  const { writeAck } = await import('../src/inbox.mjs');
  const job = protocolHandJob();
  const pid = await spawnHolder(job.token);
  patchStatus(job.dir, { pid, pidStart: getProcessIdentity(pid).start, token: job.token, heartbeatAt: new Date().toISOString() });
  setTimeout(() => writeAck(job.dir, 1, { status: 'rejected', reason: 'finished' }), 50);
  let r = await sendToJob(job.jobId, 'a', { ackWaitMs: 2000 });
  assert.deepEqual([r.ok, r.error], [false, 'job finished before the message was delivered']);
  setTimeout(() => writeAck(job.dir, 2, { status: 'accepted', delivery: 'queue' }), 50);
  r = await sendToJob(job.jobId, 'b', { ackWaitMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'accepted');
  assert.equal(r.delivery, 'queue');
  setTimeout(() => writeAck(job.dir, 3, { status: 'rejected', reason: 'idle' }), 50);
  r = await sendToJob(job.jobId, 'c', { ackWaitMs: 2000 });
  assert.deepEqual([r.ok, r.status, r.reason], [true, 'rejected', 'idle']);
});

test('sendToJob reaches a real protocol runner (accepted)', async () => {
  process.env.FAKE_APPSERVER_MODE = 'chatty';
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), model: 'p/m', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  await waitFor(() => getJob(r.jobId).state === 'running');
  await sleep(200);
  const s = await sendToJob(r.jobId, 'more please', { ackWaitMs: 1200 });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.status, 'accepted');
});

test('cancelJob on a protocol job whose runner honours the cancel file sends no SIGTERM', async () => {
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), model: 'p/m', timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  await waitFor(() => getJob(r.jobId).state === 'running');
  await sleep(500);
  const t0 = Date.now();
  const v = await cancelJob(r.jobId, { stopGraceMs: 8000 });
  assert.ok(Date.now() - t0 < 5000, 'ended by the runner, not by waiting out the grace');
  assert.equal(v.state, 'cancelled');
  assert.ok(!(v.result.warnings || []).includes('cancelled_by_manager'));
  assert.notEqual(v.result.errorKind, 'killed');
  assert.ok(!/SIGTERM|SIGKILL/.test(String(v.result.errorMessage || '')));
});

test('cancelJob on a protocol job that ignores the cancel file falls back to SIGTERM after stopGraceMs', async () => {
  const cwd = tempCwd();
  const lockCwd = realpathSync(cwd);
  const job = createJobDir({ params: { prompt: 'x', cwd: lockCwd }, path: 'protocol', baseline: null, lockCwd });
  const pid = await spawnHolder(job.token);
  patchStatus(job.dir, { state: 'running', pid, pidStart: getProcessIdentity(pid).start, token: job.token, heartbeatAt: new Date().toISOString() });
  const t0 = Date.now();
  const v = await cancelJob(job.jobId, { stopGraceMs: 400, termGraceMs: 300 });
  assert.ok(Date.now() - t0 >= 400, 'waited for the graceful stop first');
  await waitFor(() => !alive(pid), 5000);
  assert.equal(v.state, 'cancelled');
});

test('input_timeout_ms: validateRunArgs bounds, CLI path rejection, passed to job params', async () => {
  const base = { prompt: 'x', cwd: tempCwd() };
  for (const bad of [-1, 0, 1.5, '5', 2 ** 40]) assert.equal(validateRunArgs({ ...base, input_timeout_ms: bad }).ok, false, String(bad));
  const ok = validateRunArgs({ ...base, input_timeout_ms: 60000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.inputTimeoutMs, 60000);
  const cli = await startJob({ ...base, mode: 'yolo', input_timeout_ms: 60000 });
  assert.equal(cli.ok, false);
  assert.match(cli.error, /input_timeout_ms/);
  process.env.FAKE_APPSERVER_MODE = 'slowhang';
  const r = await startJob({ ...base, model: 'p/m', input_timeout_ms: 60000, timeout_ms: 30000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(getJob(r.jobId).job.params.input_timeout_ms, 60000);
});

// --- mutation follow-up: guards, boundaries and fallbacks ---

test('aliveFrom: no job, a missing or empty token and a terminal status are never alive', () => {
  const now = new Date().toISOString();
  const yes = () => true;
  assert.equal(aliveFrom(null, null, yes), false);
  assert.equal(aliveFrom({ createdAt: now }, null, yes), false);
  assert.equal(aliveFrom({ token: 5, createdAt: now }, null, yes), false);
  assert.equal(aliveFrom({ token: '', createdAt: now }, null, yes), false);
  assert.equal(aliveFrom({ token: 't', createdAt: now }, null, yes), true, 'startup grace');
  for (const state of TERMINAL) assert.equal(aliveFrom({ token: 't', createdAt: now }, { state, pid: 123 }, yes), false, state);
  assert.equal(aliveFrom({ token: 't', createdAt: now }, { state: 'running', pid: 123 }, yes), true);
  assert.equal(isJobAlive(null), false);
  assert.equal(isJobAlive(''), false);
});

test('aliveFrom passes the recorded pidStart only when it is a string', () => {
  const seen = [];
  const match = (e) => { seen.push(e); return true; };
  aliveFrom({ token: 't' }, { state: 'running', pid: 7, pidStart: 'Mon Jan  1' }, match);
  aliveFrom({ token: 't' }, { state: 'running', pid: 7, pidStart: 12 }, match);
  aliveFrom({ token: 't' }, { state: 'running', pid: 7 }, match);
  assert.deepEqual(seen, [
    { pid: 7, start: 'Mon Jan  1', token: 't' },
    { pid: 7, start: null, token: 't' },
    { pid: 7, start: null, token: 't' },
  ]);
});

test('waitJob until terminal does not end on needs_input; until attention ends only there', async () => {
  const { dir, jobId, token } = handJob();
  const pid = await spawnHolder(token);
  patchStatus(dir, { state: 'needs_input', pid, pidStart: getProcessIdentity(pid).start, token, heartbeatAt: new Date().toISOString() });
  let t0 = Date.now();
  assert.equal((await waitJob(jobId, { waitMs: 400, until: 'terminal' })).state, 'needs_input');
  assert.ok(Date.now() - t0 >= 380, 'waited out waitMs');
  t0 = Date.now();
  assert.equal((await waitJob(jobId, { waitMs: 3000, until: 'attention' })).state, 'needs_input');
  assert.ok(Date.now() - t0 < 1000, 'returned at once');
  patchStatus(dir, { state: 'running' });
  t0 = Date.now();
  assert.equal((await waitJob(jobId, { waitMs: 400, until: 'attention' })).state, 'running');
  assert.ok(Date.now() - t0 >= 380, 'a running job is no reason to return');
});

test('waitJob until change also ends on a new finishedAt with the same state', async () => {
  const { dir, jobId, token } = handJob();
  const pid = await spawnHolder(token);
  patchStatus(dir, { state: 'running', pid, pidStart: getProcessIdentity(pid).start, token, heartbeatAt: new Date().toISOString(), finishedAt: '2026-01-01T00:00:00.000Z' });
  setTimeout(() => patchStatus(dir, { finishedAt: new Date().toISOString() }), 150);
  const t0 = Date.now();
  const v = await waitJob(jobId, { waitMs: 5000, until: 'change' });
  assert.ok(Date.now() - t0 < 3000, 'returned on the finishedAt change');
  assert.equal(v.state, 'running');
});

test('signalJob: identity and group checks decide which groups get signalled (fake ps, fake signal)', () => {
  const sleeper = spawnSleep(); // a real group with a member, for the leaderless cases (only probed with signal 0)
  const { dir, token } = handJob();
  const job = readJson(join(dir, 'job.json'));
  const created = Date.parse(job.createdAt);
  const table = { 101: { lstart: 'S1', command: `node job-runner.mjs ${token}` }, 201: { lstart: 'C1', command: 'zcode' } };
  const exec = (cmd, args) => {
    const row = table[args[4]];
    if (!row) throw Object.assign(new Error('no such process'), { status: 1, stdout: '' });
    return `${row[args[2].replace('=', '')]}\n`;
  };
  const runner = { state: 'running', pid: 101, pidStart: 'S1', token };
  const child = { childPid: 201, childPgid: 201, childStart: 'C1' };
  const sig = (status, opts = {}) => {
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    const sent = [];
    const out = signalJob(job, dir, 'SIGTERM', { exec, bootMs: 0, signal: (p) => { sent.push(p); return true; }, ...opts });
    assert.deepEqual(out, sent);
    return sent;
  };
  assert.deepEqual(sig({ ...runner, ...child }), [101, 201]);
  assert.deepEqual(sig({ ...runner, ...child }, { runnerGroup: false }), [201]);
  assert.deepEqual(sig({ ...runner, pidStart: 'other', ...child }), [201], 'a runner that fails the identity check is skipped');
  assert.deepEqual(sig({ ...runner, ...child, childStart: 'C2' }), [101], 'a child with another start time is skipped');
  assert.deepEqual(sig({ ...runner, ...child, childPgid: 1 }), [101], 'pgid 1 is never signalled');
  assert.deepEqual(sig({ ...runner, ...child, childPgid: '201' }), [101]);
  assert.deepEqual(sig({ ...runner, childPgid: sleeper }), [101], 'no child pid recorded');
  // Leaderless: the child is gone (not in the ps table), its group still has a member.
  const gone = { childPid: 999, childPgid: sleeper, childStart: 'C9' };
  assert.deepEqual(sig({ ...runner, ...gone }, { runnerGroup: false }), [sleeper]);
  assert.deepEqual(sig({ ...runner, ...gone, childExitedAt: new Date().toISOString() }, { runnerGroup: false }), []);
  assert.deepEqual(sig({ ...runner, ...gone }, { runnerGroup: false, bootMs: created }), [], 'created at the boot instant is not after it');
  assert.deepEqual(sig({ ...runner, ...gone }, { runnerGroup: false, bootMs: null }), [sleeper]);
  const undated = { ...job, createdAt: 'garbage' };
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...runner, ...gone }));
  assert.deepEqual(signalJob(undated, dir, 'SIGTERM', { exec, bootMs: 0, runnerGroup: false, signal: () => true }), []);
  assert.equal(alive(sleeper), true);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'failed' }));
});

test('formatCatalog keeps only entries with a provider and a model id', () => {
  assert.deepEqual(formatCatalog('nope'), []);
  assert.deepEqual(formatCatalog([null, {}, { ref: {} }, { ref: { providerId: 'p' } }, { ref: { modelId: 'm' } }, { ref: { providerId: 'p', modelId: 'm' } }]), ['p/m']);
});

// A spawn hook that records the call and fails like a spawn without a pid.
function failingSpawn(seen) {
  return (cmd, args, options) => {
    seen.push({ cmd, args, options, job: readJson(join(args[1], 'job.json')) });
    return { pid: undefined, on() {}, unref() {} };
  };
}

test('startJob: providerId/modelId is split at the first slash; an empty side goes to the catalog', async () => {
  for (const [spec, want] of [['p/m', { providerId: 'p', modelId: 'm' }], [' prov/sub/m ', { providerId: 'prov', modelId: 'sub/m' }]]) {
    const seen = [];
    const r = await startJob({ prompt: 'x', cwd: tempCwd(), model: spec }, { spawn: failingSpawn(seen) });
    assert.equal(r.error, 'Could not start the job: could not spawn the job runner');
    assert.deepEqual(seen[0].job.model, want, spec);
  }
  for (const spec of ['/m', 'p/']) {
    const seen = [];
    const r = await startJob({ prompt: 'x', cwd: tempCwd(), model: spec }, { spawn: failingSpawn(seen) });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`^Model '${spec}' not found`), spec);
    assert.equal(seen.length, 0, spec);
  }
});

test('startJob spawns a detached runner with the job dir and token, and undoes everything when the spawn fails', async () => {
  const cwd = realpathSync(tempCwd());
  const seen = [];
  const r = await startJob({ prompt: 'x', cwd, mode: 'yolo' }, { spawn: failingSpawn(seen) });
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1);
  const { cmd, args, options, job } = seen[0];
  assert.equal(cmd, process.execPath);
  assert.match(args[0], /job-runner\.mjs$/);
  assert.equal(args[2], job.token);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.env, process.env);
  assert.equal(existsSync(args[1]), false, 'job dir removed');
  assert.deepEqual(listJobs(), []);
  assert.equal(existsSync(lockFile(cwd)), false, 'lock released');
});

test('startJob: a job store that breaks during the model lookup fails cleanly', async () => {
  process.env.FAKE_APPSERVER_MODE = 'ok';
  const pending = startJob({ prompt: 'x', cwd: tempCwd(), model: 'small' }, { spawn: failingSpawn([]) });
  // The writability check already ran; the catalog lookup is in flight.
  removeDir(jobsRoot());
  writeFileSync(jobsRoot(), 'not a directory');
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not start the job: /);
});

test('startJob with a state home that is a file fails before spawning', async () => {
  const file = join(process.env.ZCODE_MCP_HOME, 'home-file');
  writeFileSync(file, '');
  process.env.ZCODE_MCP_HOME = file;
  const seen = [];
  const r = await startJob({ prompt: 'x', cwd: tempCwd(), mode: 'yolo' }, { spawn: failingSpawn(seen) });
  assert.equal(r.ok, false);
  assert.match(r.error, /^State directory is not writable: /);
  assert.equal(seen.length, 0);
});

test('collectChanges: worktree summary, a broken worktree, a plain cwd, no params', async () => {
  const repo = gitCwd();
  const startSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'new.txt'), 'x');
  const wt = await collectChanges({ worktree: { dir: repo, startSha } });
  assert.equal(wt.available, true);
  assert.deepEqual(wt.changedFiles, ['?? new.txt']);
  const broken = await collectChanges({ worktree: { dir: join(repo, 'missing'), startSha } });
  assert.deepEqual(broken, { available: false, changedFiles: [], diffStat: '' });
  const plain = await collectChanges({ params: { cwd: repo }, baseline: captureBaseline(repo) });
  assert.equal(plain.available, true);
  assert.equal((await collectChanges({ baseline: null })).available, false);
});

test('cancelJob on a runner that never records a state: the manager writes the cancelled result', async () => {
  const job = protocolHandJob({ sessionId: 'sess_keep', startedAt: new Date(Date.now() - 5000).toISOString(), warnings: ['w1'] });
  const t0 = Date.now();
  const v = await cancelJob(job.jobId, { stopGraceMs: 0, termGraceMs: 0 });
  assert.equal(v.state, 'cancelled');
  assert.equal(v.result.sessionId, 'sess_keep');
  assert.deepEqual(v.result.warnings, ['w1', 'cancelled_by_manager']);
  assert.ok(v.result.durationMs >= 5000 && v.result.durationMs <= 5000 + (Date.now() - t0) + 1000, String(v.result.durationMs));
});

test('cancelJob survives a status.json that vanishes while it waits', async () => {
  const job = handJob({ createdAt: new Date(Date.now() - 60000).toISOString() });
  const pid = await spawnHolder(job.token);
  patchStatus(job.dir, { state: 'running', pid, pidStart: getProcessIdentity(pid).start, token: job.token, heartbeatAt: new Date().toISOString() });
  // A protocol job: the manager first waits for the runner's graceful stop.
  writeFileSync(join(job.dir, 'job.json'), JSON.stringify({ ...readJson(join(job.dir, 'job.json')), path: 'protocol' }));
  setTimeout(() => rmSync(join(job.dir, 'status.json'), { force: true }), 150);
  const v = await cancelJob(job.jobId, { stopGraceMs: 3000, termGraceMs: 0 });
  assert.equal(v.state, 'cancelled');
  assert.ok(v.result.warnings.includes('cancelled_by_manager'));
  assert.equal(alive(pid), true, 'the holder lost its identity record and was never signalled');
});

test('cancelJob gives a protocol runner STOP_GRACE_MS + 2 s by default to stop gracefully', async () => {
  const job = protocolHandJob();
  setTimeout(() => patchStatus(job.dir, { state: 'cancelled', finishedAt: new Date().toISOString() }), STOP_GRACE_MS + 1000);
  const v = await cancelJob(job.jobId, { termGraceMs: 0 });
  assert.equal(v.state, 'cancelled');
  assert.equal(v.result, null, 'the runner ended it; the manager wrote no result');
});

test('sendToJob: text of exactly MAX_SEND_TEXT characters is accepted', async () => {
  const job = protocolHandJob();
  const r = await sendToJob(job.jobId, 'x'.repeat(MAX_SEND_TEXT), { ackWaitMs: 50 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'queued');
  patchStatus(job.dir, { state: 'failed' });
});

test('sendToJob: an inbox that cannot be written is an error', async () => {
  const job = protocolHandJob();
  writeFileSync(join(job.dir, 'inbox'), 'not a directory');
  const r = await sendToJob(job.jobId, 'hi', { ackWaitMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not queue the message: /);
  patchStatus(job.dir, { state: 'failed' });
});

test('sendToJob passes delivery guide/queue through and drops anything else', async () => {
  const { writeAck } = await import('../src/inbox.mjs');
  const job = protocolHandJob();
  const got = [];
  for (const [seq, delivery] of [[1, 'guide'], [2, 'queue'], [3, 'other']]) {
    setTimeout(() => writeAck(job.dir, seq, { status: 'accepted', delivery }), 50);
    const r = await sendToJob(job.jobId, 'm', { ackWaitMs: 2000 });
    got.push(r.delivery);
  }
  assert.deepEqual(got, ['guide', 'queue', undefined]);
  patchStatus(job.dir, { state: 'failed' });
});

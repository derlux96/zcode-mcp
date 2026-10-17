import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeDir } from './helpers.mjs';
import { reap, removeJobDir } from '../src/reaper.mjs';
import { createJobDir, patchStatus, readResult, readStatus, stateHome, jobsRoot, writeResult } from '../src/jobstore.mjs';
import { acquireCwdLock, lockKey } from '../src/locks.mjs';
import { getProcessIdentity, matchesIdentity } from '../src/procid.mjs';
import { listJobDirs } from '../src/jobstore.mjs';

const temps = [];
const extraPids = [];
const DAY = 24 * 60 * 60 * 1000;
const DEAD_PID = 999999; // above the pid range of macOS; on Linux the start time check fails anyway
const WRONG_START = 'Mon Jan  1 00:00:00 2001';
const GRACE = { killGraceMs: 300, confirmMs: 20 };

beforeEach(() => {
  process.env.ZCODE_MCP_HOME = makeTempDir('zcode-home-');
  temps.push(process.env.ZCODE_MCP_HOME);
});

afterEach(() => {
  for (const pid of extraPids.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});

after(() => {
  delete process.env.ZCODE_MCP_HOME;
  for (const d of temps) removeDir(d);
});

function tempDir(prefix = 'zcode-cwd-') {
  const d = makeTempDir(prefix);
  temps.push(d);
  return d;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 5000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return;
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

function spawnSleep() {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  extraPids.push(child.pid);
  return child.pid;
}

// Detached process (own group) running `code`; resolves with its pid and first stdout line.
async function spawnNode(code, args = []) {
  const child = spawn(process.execPath, ['-e', code, ...args], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  extraPids.push(child.pid);
  const line = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
  child.stdout.destroy();
  return { pid: child.pid, line };
}

const GRANDCHILD = "const c=require('child_process').spawn('sleep',['60'],{stdio:'ignore'});";

// Hand-written job. status: undefined -> no status.json.
function handJob({ cwd = tempDir(), status, lock = false, createdAt, worktree } = {}) {
  const lockCwd = realpathSync(cwd);
  const spec = { params: { prompt: 'x', cwd: lockCwd, mode: 'yolo' }, path: 'cli', baseline: null, lockCwd };
  if (createdAt) spec.createdAt = createdAt;
  if (worktree) spec.worktree = worktree;
  const job = createJobDir(spec);
  if (lock) assert.equal(acquireCwdLock(lockCwd, job.jobId, () => true).ok, true);
  if (status) {
    patchStatus(job.dir, {
      state: 'running', token: job.token, startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(), warnings: [], ...status,
    });
  }
  return { ...job, lockCwd };
}

// Job whose runner is a live process carrying the job token on its command line.
async function liveJob(opts = {}, extraStatus = {}) {
  const j = handJob(opts);
  const { pid } = await spawnNode("process.stdout.write('ready\\n');setInterval(()=>{},1000);", [j.token]);
  patchStatus(j.dir, {
    state: 'running', pid, pidStart: getProcessIdentity(pid).start, token: j.token,
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), warnings: [], ...extraStatus,
  });
  return j;
}

const deadRunner = (extra = {}) => ({ pid: DEAD_PID, pidStart: WRONG_START, ...extra });

function finishedJob(state = 'completed', extra = {}) {
  const j = handJob({ status: deadRunner({ state, finishedAt: new Date().toISOString(), ...extra }) });
  writeResult(j.dir, { state, output: 'done', warnings: [] });
  return j;
}

function age(dir, ms) {
  const t = new Date(Date.now() - ms);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), t, t);
  utimesSync(dir, t, t);
}

const lockFile = (cwd) => join(stateHome(), 'locks', `${lockKey(cwd)}.lock`);
const snapshot = (dir) => readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]);

test('marks a dead runner without result as lost and writes result.json', async () => {
  const j = handJob({ status: deadRunner({ sessionId: 'sess_1', warnings: ['stalled'] }) });
  const r = await reap(GRACE);
  assert.deepEqual(r.lost, [j.jobId]);
  assert.deepEqual(r.killed, []);
  const s = readStatus(j.dir);
  assert.equal(s.state, 'lost');
  assert.equal(s.errorKind, 'crash');
  const res = readResult(j.dir);
  assert.equal(res.state, 'lost');
  assert.equal(res.errorKind, 'crash');
  assert.equal(res.errorMessage, 'runner disappeared without a result');
  assert.ok(res.warnings.includes('runner_lost'));
  assert.equal(res.sessionId, 'sess_1');
  assert.deepEqual(res.changedFiles, []);
  assert.equal(typeof res.durationMs, 'number');
  // A job that never got a pid and is past the startup grace is lost too.
  const never = handJob({ createdAt: new Date(Date.now() - 60000).toISOString() });
  assert.deepEqual((await reap(GRACE)).lost, [never.jobId]);
});

test('kills verified leftover children of a lost job and nothing else', async () => {
  // ZCode child: own group with a grandchild; ignores SIGTERM so SIGKILL is needed.
  const { pid: child, line } = await spawnNode(`process.on('SIGTERM',()=>{});${GRANDCHILD}process.stdout.write(c.pid+'\\n');setInterval(()=>{},1000);`);
  const grandchild = Number(line);
  const lostJob = handJob({ status: deadRunner({ childPid: child, childPgid: child, childStart: getProcessIdentity(child).start }) });
  // Unrelated process recorded with the wrong start time in another lost job.
  const foreign = spawnSleep();
  const other = handJob({ status: deadRunner({ childPid: foreign, childPgid: foreign, childStart: WRONG_START }) });
  const r = await reap(GRACE);
  assert.deepEqual(r.lost.sort(), [lostJob.jobId, other.jobId].sort());
  assert.deepEqual(r.killed, [child]);
  await waitFor(() => !alive(child) && !alive(grandchild));
  assert.equal(alive(foreign), true, 'unrelated process survives');
});

test('kills a leftover group whose leader is gone but members remain', async () => {
  const { pid: leader, line } = await spawnNode(`${GRANDCHILD}c.unref();process.stdout.write(c.pid+'\\n',()=>process.exit(0));`);
  const member = Number(line);
  extraPids.push(member);
  await waitFor(() => getProcessIdentity(leader) === null); // exited and reaped
  assert.equal(alive(member), true);
  handJob({ status: deadRunner({ childPid: leader, childPgid: leader, childStart: WRONG_START }) });
  const r = await reap(GRACE);
  assert.deepEqual(r.killed, [leader]);
  await waitFor(() => !alive(member));
});

test('leaves a job within the startup grace alone', async () => {
  const j = handJob();
  const r = await reap(GRACE);
  assert.deepEqual(r, { lost: [], deleted: [], killed: [] });
  assert.equal(readStatus(j.dir), null);
  assert.equal(readResult(j.dir), null);
});

test('deletes finished jobs older than 7 days', async () => {
  const old = finishedJob('failed');
  age(old.dir, 8 * DAY);
  const fresh = finishedJob('completed');
  age(fresh.dir, 6 * DAY);
  const r = await reap(GRACE);
  assert.deepEqual(r.deleted, [old.jobId]);
  assert.equal(existsSync(old.dir), false);
  assert.equal(existsSync(fresh.dir), true);
  // opts.now moves the reference point.
  assert.deepEqual((await reap({ ...GRACE, now: Date.now() + 2 * DAY })).deleted, [fresh.jobId]);
});

test('keeps only the newest 50 finished jobs', async () => {
  const jobs = [];
  for (let i = 0; i < 53; i++) {
    const j = finishedJob('completed');
    age(j.dir, (60 - i) * 60000); // later jobs are newer
    jobs.push(j);
  }
  const r = await reap(GRACE);
  assert.deepEqual(r.deleted.sort(), jobs.slice(0, 3).map((j) => j.jobId).sort());
  assert.equal(readdirSync(jobsRoot()).length, 50);
  for (const j of jobs.slice(3)) assert.equal(existsSync(j.dir), true);
});

test('never deletes running jobs', async () => {
  const j = await liveJob();
  const pid = readStatus(j.dir).pid;
  age(j.dir, 30 * DAY);
  const starting = handJob();
  age(starting.dir, 30 * DAY);
  for (let i = 0; i < 52; i++) finishedJob('completed');
  const r = await reap(GRACE);
  assert.equal(r.deleted.length, 2);
  assert.deepEqual(r.lost, []);
  assert.equal(existsSync(j.dir), true);
  assert.equal(existsSync(starting.dir), true);
  assert.equal(readStatus(j.dir).state, 'running');
  assert.equal(alive(pid), true);
});

test('does not follow a symlink that points outside the jobs root', async () => {
  const outside = tempDir('zcode-outside-');
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  mkdirSync(jobsRoot(), { recursive: true });
  const fakeJob = join(jobsRoot(), 'job_zzzzzzzz_abcdef');
  symlinkSync(outside, fakeJob);
  // A real old finished job containing a link to the outside directory.
  const j = finishedJob('completed');
  symlinkSync(outside, join(j.dir, 'link'));
  age(j.dir, 8 * DAY);
  const r = await reap({ ...GRACE, now: Date.now() + 365 * DAY });
  assert.deepEqual(r.deleted, [j.jobId]);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(fakeJob), true, 'symlinked entry is left alone');
});

test('never deletes a worktree directory', async () => {
  const wt = tempDir('zcode-wt-');
  writeFileSync(join(wt, 'work.txt'), 'w');
  const worktree = { branch: 'zcode/x', dir: realpathSync(wt), startSha: 'abc' };
  const lostJob = handJob({ cwd: wt, worktree, status: deadRunner() });
  const r1 = await reap(GRACE);
  assert.deepEqual(r1.lost, [lostJob.jobId]);
  assert.deepEqual(readResult(lostJob.dir).worktree, worktree);
  assert.equal(readResult(lostJob.dir).changesAvailable, false);
  age(lostJob.dir, 8 * DAY);
  const r2 = await reap(GRACE);
  assert.deepEqual(r2.deleted, [lostJob.jobId]);
  assert.equal(readFileSync(join(wt, 'work.txt'), 'utf8'), 'w');
});

test('second reap changes nothing', async () => {
  const lostJob = handJob({ status: deadRunner(), lock: true });
  const old = finishedJob('completed');
  age(old.dir, 8 * DAY);
  const keep = finishedJob('cancelled');
  const r1 = await reap(GRACE);
  assert.deepEqual(r1.lost, [lostJob.jobId]);
  assert.deepEqual(r1.deleted, [old.jobId]);
  const before = [snapshot(lostJob.dir), snapshot(keep.dir)];
  const r2 = await reap(GRACE);
  assert.deepEqual(r2, { lost: [], deleted: [], killed: [] });
  assert.deepEqual([snapshot(lostJob.dir), snapshot(keep.dir)], before);
});

test('removes the stale lock of a lost job via the claim protocol and keeps a live job\'s lock', async () => {
  const lostJob = handJob({ status: deadRunner(), lock: true });
  assert.equal(existsSync(lockFile(lostJob.lockCwd)), true);
  const live = await liveJob({ lock: true });
  const r = await reap(GRACE);
  assert.deepEqual(r.lost, [lostJob.jobId]);
  assert.equal(existsSync(lockFile(lostJob.lockCwd)), false);
  assert.equal(JSON.parse(readFileSync(lockFile(live.lockCwd), 'utf8')).jobId, live.jobId);
  assert.equal(readStatus(live.dir).state, 'running');
});

test('lock is released before the lost state is visible', async () => {
  const j = handJob({ status: deadRunner(), lock: true });
  // A live claim held by this process blocks the takeover: the lock cannot be removed yet.
  const claim = `${lockFile(j.lockCwd)}.claim`;
  writeFileSync(claim, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce: 'held' }));
  const r1 = await reap(GRACE);
  assert.deepEqual(r1.lost, []);
  assert.equal(existsSync(lockFile(j.lockCwd)), true);
  assert.equal(readStatus(j.dir).state, 'running', 'not lost while the lock exists');
  assert.equal(readResult(j.dir), null);
  unlinkSync(claim);
  const r2 = await reap(GRACE);
  assert.deepEqual(r2.lost, [j.jobId]);
  assert.equal(existsSync(lockFile(j.lockCwd)), false);
  assert.equal(readStatus(j.dir).state, 'lost');
});

test('corrupt job.json does not stop the reaper from processing other jobs', async () => {
  const bad = handJob({ status: deadRunner() });
  writeFileSync(join(bad.dir, 'job.json'), '{not json');
  const badStatus = handJob({ createdAt: new Date(Date.now() - 60000).toISOString() });
  writeFileSync(join(badStatus.dir, 'status.json'), 'garbage');
  const before = [snapshot(bad.dir), snapshot(badStatus.dir)];
  const good = handJob({ status: deadRunner() });
  const r = await reap(GRACE);
  assert.deepEqual(r.lost, [good.jobId]);
  assert.deepEqual([snapshot(bad.dir), snapshot(badStatus.dir)], before);
});

test('a terminal job is never overwritten', async () => {
  const j = finishedJob('completed');
  const before = snapshot(j.dir);
  const r = await reap(GRACE);
  assert.deepEqual(r, { lost: [], deleted: [], killed: [] });
  assert.deepEqual(snapshot(j.dir), before);
});

test('never signals a live runner or its child, even when one identity sample fails', async () => {
  for (const flaky of [false, true]) {
    const child = spawnSleep();
    const j = await liveJob({}, { childPid: child, childPgid: child, childStart: getProcessIdentity(child).start });
    const runner = readStatus(j.dir).pid;
    let calls = 0;
    const identityOverride = (id) => (flaky && calls++ === 0 ? false : matchesIdentity(id));
    const r = await reap({ ...GRACE, identityOverride });
    assert.deepEqual(r, { lost: [], deleted: [], killed: [] });
    if (flaky) assert.ok(calls >= 2, 'the failed first sample was re-checked');
    await sleep(100);
    assert.equal(alive(runner), true);
    assert.equal(alive(child), true);
    assert.equal(readStatus(j.dir).state, 'running');
    assert.equal(readResult(j.dir), null);
  }
});

test('equal mtimes: the newest job ids are kept', async () => {
  const t = new Date(Date.now() - 60000);
  const jobs = [];
  for (let i = 0; i < 52; i++) {
    const j = finishedJob('completed');
    jobs.push(j);
    await sleep(2); // distinct id timestamps
  }
  for (const j of jobs) {
    for (const name of readdirSync(j.dir)) utimesSync(join(j.dir, name), t, t);
    utimesSync(j.dir, t, t);
  }
  const r = await reap(GRACE);
  assert.deepEqual(r.deleted.sort(), jobs.slice(0, 2).map((j) => j.jobId).sort());
});

test('terminal result.json with a non-terminal status: status takes the result state, not lost', async () => {
  const j = handJob({ status: deadRunner() });
  writeResult(j.dir, { state: 'completed', output: 'ok', warnings: [] });
  const before = readFileSync(join(j.dir, 'result.json'), 'utf8');
  const r = await reap(GRACE);
  assert.deepEqual(r.lost, []);
  assert.equal(readStatus(j.dir).state, 'completed');
  assert.equal(readFileSync(join(j.dir, 'result.json'), 'utf8'), before);
});

test('removeJobDir refuses a job-dir symlink that points outside the jobs root', async () => {
  const outside = tempDir('zcode-outside-');
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  mkdirSync(jobsRoot(), { recursive: true });
  const link = join(jobsRoot(), 'job_zzzzzzzz_abcdef');
  symlinkSync(outside, link);
  assert.equal(removeJobDir(link, realpathSync(jobsRoot())), false);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(link), true);
  assert.deepEqual(listJobDirs(), []);
  assert.deepEqual((await reap({ ...GRACE, now: Date.now() + 365 * DAY })).deleted, []);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
});

// A process group led by a root-owned process: verified, but not signallable (EPERM).
function rootGroupLeader() {
  const out = execFileSync('ps', ['-axo', 'pid=,pgid=,uid='], { encoding: 'utf8' });
  for (const line of out.trim().split('\n')) {
    const [pid, pgid, uid] = line.trim().split(/\s+/).map(Number);
    if (uid === 0 && pid === pgid && pid > 1 && getProcessIdentity(pid)) return pid;
  }
  return null;
}

test('a verified group that cannot be signalled is reported as kill_failed', {
  skip: process.getuid?.() === 0 ? 'root could signal the group' : false,
}, async (t) => {
  const leader = rootGroupLeader();
  if (!leader) return t.skip('no root-owned group leader found');
  const j = handJob({ status: deadRunner({ childPid: leader, childPgid: leader, childStart: getProcessIdentity(leader).start }) });
  const r = await reap(GRACE);
  assert.deepEqual(r.lost, [j.jobId]);
  assert.deepEqual(r.killed, []);
  assert.ok(readResult(j.dir).warnings.includes('kill_failed'));
  assert.ok(readStatus(j.dir).warnings.includes('kill_failed'));
});

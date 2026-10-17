import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin, run, safeSignal } from './helpers.mjs';
import { createJobDir, readStatus, readResult, stateHome, TERMINAL_STATES, patchStatus, writeResult } from '../src/jobstore.mjs';
import { captureBaseline } from '../src/changes.mjs';
import { acquireCwdLock, lockKey } from '../src/locks.mjs';
import { SessionStore } from '../src/state.mjs';
import { runJob } from '../src/job-runner.mjs';
import { cancelJob } from '../src/jobs.mjs';
import { OUTPUT_CAP } from '../src/runner.mjs';

const runnerPath = fileURLToPath(new URL('../src/job-runner.mjs', import.meta.url));
const temps = [];
let home;

before(() => {
  home = makeTempDir('zcode-home-');
  temps.push(home);
  process.env.ZCODE_MCP_HOME = home;
  process.env.ZCODE_MCP_STATE = join(home, 'sessions.json');
  process.env.ZCODE_BIN = fakeBin;
});

afterEach(() => {
  delete process.env.FAKE_ZCODE_MODE;
});

after(() => {
  delete process.env.ZCODE_MCP_HOME;
  delete process.env.ZCODE_MCP_STATE;
  delete process.env.ZCODE_BIN;
  for (const d of temps) removeDir(d);
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

function mkJob(params, extra = {}) {
  return createJobDir({
    params: { prompt: 'do it', mode: 'yolo', timeout_ms: 30000, ...params },
    path: 'cli',
    baseline: null,
    ...extra,
  });
}

async function waitFor(pred, timeoutMs = 10000, stepMs = 20) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

test('completed job writes result with sessionId and changedFiles', async () => {
  const cwd = gitCwd();
  const { dir, jobId } = mkJob({ cwd }, { baseline: captureBaseline(cwd) });
  writeFileSync(join(cwd, 'new.txt'), 'made by the job\n');
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.sessionId, 'sess_fake123');
  assert.deepEqual(res.changedFiles, ['?? new.txt']);
  assert.equal(res.changesAvailable, true);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.errorKind, null);
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /fake task done/);
  assert.equal(res.outputLogPath, join(dir, 'output.log'));
  assert.equal(readFileSync(res.outputLogPath, 'utf8'), res.output);
  assert.equal(statSync(res.outputLogPath).mode & 0o777, 0o600);
  assert.equal(typeof res.durationMs, 'number');
  const entry = new SessionStore(process.env.ZCODE_MCP_STATE).list().find((e) => e.id === 'sess_fake123');
  assert.ok(entry, 'session store entry written');
  assert.equal(entry.kind, 'session');
  assert.equal(entry.cwd, cwd);
  assert.equal(entry.status, 'completed');
  assert.notEqual(entry.id, jobId);
});

test('status transitions starting then running then completed', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const seen = [];
  await runJob(dir, { onStatus: (s) => { if (seen.at(-1) !== s.state) seen.push(s.state); } });
  assert.deepEqual(seen, ['starting', 'running', 'completed']);
  assert.equal(readStatus(dir).state, 'completed');
});

test('heartbeatAt advances while running', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const first = await waitFor(() => readStatus(dir)?.heartbeatAt);
  const later = await waitFor(() => {
    const s = readStatus(dir);
    return s.state === 'running' && s.heartbeatAt > first ? s.heartbeatAt : null;
  });
  assert.ok(later > first);
  await done;
  assert.equal(readStatus(dir).state, 'completed');
});

test('cancel file stops the child and ends cancelled with partial changes', async () => {
  process.env.FAKE_ZCODE_MODE = 'silent';
  const cwd = gitCwd();
  const { dir } = mkJob({ cwd }, { baseline: captureBaseline(cwd) });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  writeFileSync(join(cwd, 'partial.txt'), 'half done\n');
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.timeoutKind, 'cancelled');
  assert.deepEqual(res.changedFiles, ['?? partial.txt']);
  assert.equal(readStatus(dir).state, 'cancelled');
  assert.equal(alive(st.childPid), false);
});

test('timeout_ms ends timeout with timeoutKind total', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const { dir } = mkJob({ cwd: tempCwd(), timeout_ms: 300 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  assert.equal(res.timeoutKind, 'total');
  assert.equal(res.errorKind, 'timeout_total');
  assert.equal(readStatus(dir).state, 'timeout');
});

test('crash-mid ends failed with errorKind crash', async () => {
  process.env.FAKE_ZCODE_MODE = 'crash-mid';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.equal(res.exitCode, 1);
  assert.equal(typeof res.errorMessage, 'string');
  const entry = new SessionStore(process.env.ZCODE_MCP_STATE).list().at(-1);
  assert.equal(entry.kind, 'run');
  assert.equal(entry.status, 'failed');
});

test('plain failure with unclassified stderr becomes crash and keeps stderr', async () => {
  process.env.FAKE_ZCODE_MODE = 'fail';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.sessionId, 'sess_fail000');
  assert.match(res.stderr, /fake zcode failure/);
  assert.equal(res.errorKind, 'crash'); // classifyError -> unknown, non-zero exit -> crash
});

test('completed without file changes in a git cwd carries warning no_changes', async () => {
  const cwd = gitCwd();
  writeFileSync(join(cwd, 'preexisting.txt'), 'user work\n'); // dirty before the job: not the job's change
  const { dir } = mkJob({ cwd }, { baseline: captureBaseline(cwd) });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.changedFiles, []);
  assert.deepEqual(res.warnings, ['no_changes']);
  assert.deepEqual(readStatus(dir).warnings, ['no_changes']);
});

test('plan mode without changes carries no no_changes warning', async () => {
  const cwd = gitCwd();
  const { dir } = mkJob({ cwd, mode: 'plan' }, { baseline: captureBaseline(cwd) });
  await runJob(dir);
  assert.deepEqual(readResult(dir).warnings, []);
});

test('non-git cwd carries no no_changes warning', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.changesAvailable, false);
  assert.deepEqual(res.warnings, []);
});

test('status records pid, pidStart, token, childPid', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir, token } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  assert.equal(st.pid, process.pid);
  assert.equal(typeof st.pidStart, 'string');
  assert.ok(st.pidStart.length > 0);
  assert.equal(st.token, token);
  assert.ok(Number.isInteger(st.childPid) && st.childPid !== process.pid);
  assert.equal(st.childPgid, st.childPid);
  assert.equal(typeof st.childStart, 'string');
  assert.equal(typeof st.startedAt, 'string');
  assert.equal(typeof st.lastActivityAt, 'string');
  await done;
});

test('worktree job runs in the worktree dir and reports worktree changes', async () => {
  process.env.FAKE_ZCODE_ECHO_ARGS = '1';
  try {
    const cwd = gitCwd();
    const wt = gitCwd();
    const startSha = run(wt, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(wt, 'wt.txt'), 'x\n');
    const worktree = { branch: 'zcode/t', dir: wt, startSha };
    const { dir } = mkJob({ cwd, isolate_worktree: true }, { baseline: captureBaseline(cwd), worktree });
    await runJob(dir);
    const res = readResult(dir);
    assert.deepEqual(res.worktree, worktree);
    assert.deepEqual(res.changedFiles, ['?? wt.txt']);
    const argv = JSON.parse(res.output).argv;
    assert.equal(argv[argv.indexOf('--cwd') + 1], wt);
  } finally {
    delete process.env.FAKE_ZCODE_ECHO_ARGS;
  }
});

test('lock is released before the terminal state is visible', async () => {
  const cwd = tempCwd();
  const { dir, jobId } = mkJob({ cwd }, { lockCwd: cwd });
  assert.equal(acquireCwdLock(cwd, jobId, () => true).ok, true);
  const lockFile = join(stateHome(), 'locks', `${lockKey(cwd)}.lock`);
  assert.equal(existsSync(lockFile), true);
  const lockAtTerminal = [];
  await runJob(dir, {
    onStatus: (s) => { if (TERMINAL_STATES.includes(s.state)) lockAtTerminal.push(existsSync(lockFile)); },
  });
  assert.deepEqual(lockAtTerminal, [false]);
  assert.equal(readStatus(dir).state, 'completed');
});

test('unexpected exception still writes failed with errorKind crash', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const saved = process.env.ZCODE_BIN;
  process.env.ZCODE_BIN = join(home, 'no-such-zcode.cjs'); // discoverZCode throws
  try {
    await runJob(dir);
  } finally {
    process.env.ZCODE_BIN = saved;
  }
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.match(res.errorMessage, /not found/i);
  assert.equal(readStatus(dir).state, 'failed');
});

function spawnRunner(dir, token, env = {}) {
  const child = spawn(process.execPath, [runnerPath, dir, token], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, exited };
}

test('token mismatch exits 2 and writes nothing', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const { exited } = spawnRunner(dir, 'wrong-token');
  const { code } = await exited;
  assert.equal(code, 2);
  assert.equal(existsSync(join(dir, 'status.json')), false);
  assert.equal(existsSync(join(dir, 'result.json')), false);
  assert.equal(existsSync(join(dir, 'output.log')), false);
});

test('cancel via SIGTERM to a separately spawned runner process ends cancelled and leaves no process', async () => {
  const { dir, token } = mkJob({ cwd: tempCwd() });
  const { child, exited } = spawnRunner(dir, token, { FAKE_ZCODE_MODE: 'silent', ZCODE_MCP_HEARTBEAT_MS: '50' });
  try {
    const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
    assert.equal(st.pid, child.pid);
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0);
    assert.equal(readStatus(dir).state, 'cancelled');
    assert.equal(readResult(dir).state, 'cancelled');
    await waitFor(() => !alive(st.childPid), 2000);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('ignore-sigterm child is killed by SIGKILL after the grace period', async () => {
  process.env.FAKE_ZCODE_MODE = 'ignore-sigterm';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  // The fake prints `ready` once its SIGTERM handler is installed; that output bumps lastActivityAt.
  await waitFor(() => readStatus(dir).lastActivityAt !== st.lastActivityAt, 5000);
  const t0 = Date.now();
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  assert.ok(Date.now() - t0 >= 4500, 'waited for the SIGKILL grace period');
  assert.equal(readResult(dir).state, 'cancelled');
  assert.equal(alive(st.childPid), false);
});

function grandchildPid(res) {
  const m = /grandchild pid (\d+)/.exec(res.stderr);
  assert.ok(m, 'fake reported its grandchild');
  return Number(m[1]);
}

async function assertGrandchildGone(res) {
  const gc = grandchildPid(res);
  try {
    await waitFor(() => !alive(gc), 2000);
  } finally {
    try { process.kill(gc, 'SIGKILL'); } catch {} // cleanup only after the assertion ran
  }
}

test('cancel kills the grandchild in ZCode\'s process group', async () => {
  process.env.FAKE_ZCODE_MODE = 'spawn-grandchild';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  // Wait until the grandchild is in the group (pgrep lists group members).
  await waitFor(() => {
    try { return execFileSync('pgrep', ['-g', String(st.childPgid)], { encoding: 'utf8' }).trim().split('\n').length >= 2; } catch { return false; }
  });
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  await assertGrandchildGone(res);
});

test('timeout kills the grandchild in ZCode\'s process group', async () => {
  process.env.FAKE_ZCODE_MODE = 'spawn-grandchild';
  const { dir } = mkJob({ cwd: tempCwd(), timeout_ms: 600 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  await assertGrandchildGone(res);
});

test('a normal exit sweeps leftovers of ZCode\'s group and records it (I3, I4)', async () => {
  process.env.FAKE_ZCODE_MODE = 'leave-grandchild';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  let gc;
  try {
    gc = grandchildPid({ stderr: res.stderr });
    await waitFor(() => !alive(gc), 3000);
  } finally {
    if (gc) safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode-leftover' });
  }
  assert.equal(res.state, 'completed');
  assert.ok(res.warnings.includes('leftover_processes_killed'), JSON.stringify(res.warnings));
  const st = readStatus(dir);
  assert.equal(typeof st.childExitedAt, 'string');
  assert.equal(st.childPgid, null);
  assert.ok(Number.isInteger(st.childPid), 'childPid stays for the record');
});

test('a failing heartbeat write does not end the runner', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  let beats = 0;
  await runJob(dir, {
    heartbeatMs: 50,
    onStatus: (_s, patch) => {
      if (patch.heartbeatAt && !patch.state && ++beats === 1) throw new Error('disk hiccup');
    },
  });
  assert.ok(beats > 1, 'heartbeat continued after the failure');
  assert.equal(readResult(dir).state, 'completed');
  assert.equal(readStatus(dir).state, 'completed');
});

test('a failing running-status write becomes a warning, not a crash', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir, {
    onStatus: (_s, patch) => { if (patch.state === 'running') throw new Error('disk hiccup'); },
  });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, ['status_write_failed']);
});

test('output.log holds the full stdout while result.output stays capped', async () => {
  process.env.FAKE_ZCODE_MODE = 'bigoutput';
  const { dir } = mkJob({ cwd: tempCwd() });
  await runJob(dir);
  const res = readResult(dir);
  const log = readFileSync(res.outputLogPath, 'utf8');
  assert.ok(log.length > OUTPUT_CAP);
  assert.ok(log.length > res.output.length);
  assert.equal(log, 'x'.repeat(500000) + '\n');
  assert.equal(statSync(res.outputLogPath).mode & 0o777, 0o600);
});

test('a fatal runner error kills ZCode\'s group before releasing the lock', async () => {
  const cwd = tempCwd();
  const { dir, token, jobId } = mkJob({ cwd }, { lockCwd: cwd });
  assert.equal(acquireCwdLock(cwd, jobId, () => true).ok, true);
  const lockFile = join(stateHome(), 'locks', `${lockKey(cwd)}.lock`);
  const { child, exited } = spawnRunner(dir, token, {
    FAKE_ZCODE_MODE: 'spawn-grandchild', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '1500',
  });
  let members = [];
  try {
    const st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
    members = await waitFor(() => {
      try {
        const pids = execFileSync('pgrep', ['-g', String(st.childPgid)], { encoding: 'utf8' })
          .trim().split('\n').map(Number);
        return pids.length >= 2 ? pids : null;
      } catch { return null; }
    });
    assert.equal(readStatus(dir).state, 'running', 'group observed before the fatal error');
    const { code } = await exited;
    assert.equal(code, 1);
    const res = readResult(dir);
    assert.equal(res.state, 'failed');
    assert.equal(res.errorKind, 'crash');
    assert.match(res.errorMessage, /test fatal after spawn/);
    assert.equal(readStatus(dir).state, 'failed');
    assert.equal(existsSync(lockFile), false);
    assert.ok(members.includes(st.childPid));
    for (const pid of members) await waitFor(() => !alive(pid), 2000);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const pid of members) { try { process.kill(pid, 'SIGKILL'); } catch {} } // after the assertions
  }
});

test('a cancel whose ZCode exit is seen before the runner aborts still ends cancelled', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.childPgid ? readStatus(dir) : null));
  writeFileSync(join(dir, 'cancel'), '');
  process.kill(-st.childPgid, 'SIGKILL'); // only ZCode's group, not the runner
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'cancelled');
  assert.equal(res.errorKind, 'cancelled');
  assert.equal(res.timeoutKind, 'cancelled');
  assert.equal(readStatus(dir).state, 'cancelled');
});

test('ZCode killed without a cancel request still ends failed with errorKind crash', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.childPgid ? readStatus(dir) : null));
  process.kill(-st.childPgid, 'SIGKILL');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
});

test('a runner started after the manager already ended the job writes nothing', async () => {
  const { dir } = mkJob({ cwd: tempCwd() }, { lockCwd: tempCwd() });
  const v = await cancelJob(basename(dir), { termGraceMs: 200 });
  assert.equal(v.state, 'cancelled');
  const status = readStatus(dir);
  const result = readResult(dir);
  await runJob(dir);
  assert.deepEqual(readStatus(dir), status);
  assert.deepEqual(readResult(dir), result);
});

// I6 / R29: the manager's `cancelled` is final; the reaper's `lost` is an inference
// the runner may replace with its own result; nothing resurrects a terminal state.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a manager-set cancelled state is never overwritten by the runner', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  writeResult(dir, { state: 'cancelled', warnings: ['cancelled_by_manager'], errorKind: 'cancelled' });
  patchStatus(dir, { state: 'cancelled', warnings: ['cancelled_by_manager'], errorKind: 'cancelled', finishedAt: new Date().toISOString() });
  const status = readStatus(dir);
  const result = readResult(dir);
  await pause(200); // several heartbeats
  assert.deepEqual(readStatus(dir), status, 'heartbeat did not touch a terminal status');
  await done;
  assert.deepEqual(readStatus(dir), status);
  assert.deepEqual(readResult(dir), result);
});

test('a reaper-set lost state is replaced by the runner result with recovered_from_lost', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
  writeResult(dir, { state: 'lost', warnings: ['runner_lost'], errorKind: 'crash' });
  patchStatus(dir, { state: 'lost', warnings: ['runner_lost'], errorKind: 'crash', finishedAt: new Date().toISOString() });
  await pause(200);
  assert.equal(readStatus(dir).state, 'lost', 'heartbeat/activity writes do not resurrect it');
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.ok(res.warnings.includes('recovered_from_lost'), JSON.stringify(res.warnings));
  assert.equal(res.sessionId, 'sess_chatty1');
  const st = readStatus(dir);
  assert.equal(st.state, 'completed');
  assert.ok(st.warnings.includes('recovered_from_lost'));
});

// I7: locks are per cwd, change reporting is per repository.
test('a job ending while another live job shares its repository warns shared_repo', async () => {
  const repo = gitCwd();
  const subA = join(repo, 'a');
  const subB = join(repo, 'b');
  for (const d of [subA, subB]) execFileSync('mkdir', ['-p', d]);
  const a = mkJob({ cwd: subA }, { baseline: captureBaseline(subA), lockCwd: subA });
  const { exited } = spawnRunner(a.dir, a.token, { FAKE_ZCODE_MODE: 'hang' });
  try {
    await waitFor(() => (readStatus(a.dir)?.state === 'running' ? readStatus(a.dir) : null));
    const b = mkJob({ cwd: subB }, { baseline: captureBaseline(subB), lockCwd: subB });
    await runJob(b.dir);
    const res = readResult(b.dir);
    assert.equal(res.state, 'completed');
    assert.ok(res.warnings.includes('shared_repo'), JSON.stringify(res.warnings));
    assert.ok(res.warnings.includes('no_changes'), 'no_changes is computed as before');
    // A job in another repository is not affected.
    const other = gitCwd();
    const c = mkJob({ cwd: other }, { baseline: captureBaseline(other) });
    await runJob(c.dir);
    assert.deepEqual(readResult(c.dir).warnings, ['no_changes']);
  } finally {
    writeFileSync(join(a.dir, 'cancel'), '');
    await exited;
  }
  assert.equal(readStatus(a.dir).state, 'cancelled');
  assert.equal(readResult(a.dir).warnings.includes('shared_repo'), false, 'the other job had already ended');
});

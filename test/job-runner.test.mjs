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
import { runJob, runnerEnvOptions } from '../src/job-runner.mjs';
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
  assert.equal(res.errorMessage, null);
  assert.equal(res.exitCode, 0);
  assert.match(res.output, /fake task done/);
  assert.equal(res.outputLogPath, join(dir, 'output.log'));
  assert.equal(readFileSync(res.outputLogPath, 'utf8'), res.output);
  assert.equal(statSync(res.outputLogPath).mode & 0o777, 0o600);
  assert.ok(res.durationMs >= 0 && res.durationMs < 60000, `durationMs ${res.durationMs}`);
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
  assert.equal(res.errorMessage, 'ZCode exited with code 1');
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
  const { child, exited } = spawnRunner(dir, token, { FAKE_ZCODE_MODE: 'silent', ZCODE_MCP_HEARTBEAT_MS: '50', NODE_ENV: 'test' });
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
    safeSignal(child.pid, 'SIGKILL', { marker: 'job-runner.mjs', group: true }); // the detached runner we spawned
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
    safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode' }); // cleanup only after the assertion ran
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
    FAKE_ZCODE_MODE: 'spawn-grandchild', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '1500', NODE_ENV: 'test',
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
    safeSignal(child.pid, 'SIGKILL', { marker: 'job-runner.mjs', group: true }); // the detached runner we spawned
    for (const pid of members) safeSignal(pid, 'SIGKILL', { marker: 'fake-zcode' }); // after the assertions
  }
});

test('a cancel whose ZCode exit is seen before the runner aborts still ends cancelled', async () => {
  process.env.FAKE_ZCODE_MODE = 'hang';
  const { dir } = mkJob({ cwd: tempCwd() });
  const done = runJob(dir, { heartbeatMs: 50 });
  const st = await waitFor(() => (readStatus(dir)?.childPgid ? readStatus(dir) : null));
  writeFileSync(join(dir, 'cancel'), '');
  // only ZCode's group, not the runner
  assert.equal(safeSignal(st.childPgid, 'SIGKILL', { expectStart: st.childStart, group: true }), true);
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
  assert.equal(safeSignal(st.childPgid, 'SIGKILL', { expectStart: st.childStart, group: true }), true);
  await done;
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.equal(res.errorMessage, 'ZCode did not exit normally (no exit code)');
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
  const entry = new SessionStore(process.env.ZCODE_MCP_STATE).list().at(-1);
  assert.equal(entry.id, 'sess_chatty1');
  assert.equal(entry.status, 'cancelled', 'the session list agrees with the job state');
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

// M2: test hooks in the runner's environment apply only with NODE_ENV=test.
test('runnerEnvOptions clamps the heartbeat and ignores the fatal hook outside tests', () => {
  assert.deepEqual(runnerEnvOptions({}), { heartbeatMs: undefined, fatalAfterMs: 0, retryDelaysMs: undefined });
  assert.deepEqual(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: '50', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '1500' }), { heartbeatMs: 1000, fatalAfterMs: 0, retryDelaysMs: undefined });
  assert.deepEqual(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: '99999' }), { heartbeatMs: 10000, fatalAfterMs: 0, retryDelaysMs: undefined });
  assert.deepEqual(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: '3000' }), { heartbeatMs: 3000, fatalAfterMs: 0, retryDelaysMs: undefined });
  assert.deepEqual(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: 'x' }), { heartbeatMs: undefined, fatalAfterMs: 0, retryDelaysMs: undefined });
  assert.deepEqual(
    runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_HEARTBEAT_MS: '50', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '1500' }),
    { heartbeatMs: 50, fatalAfterMs: 1500, retryDelaysMs: undefined },
  );
});

// ps may fail transiently while the runner records itself: retry, and when it stays
// unknown say so (the job must not look dead after the startup grace).
test('identity capture retries an unknown ps sample until it works', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  let calls = 0;
  const identity = (pid) => (++calls <= 2 ? { pid, unknown: true } : { pid, start: 'Mon Jan  1 00:00:00 2024', command: 'x' });
  await runJob(dir, { identity, identityRetryDelayMs: 5 });
  assert.equal(readStatus(dir).pidStart, 'Mon Jan  1 00:00:00 2024');
  assert.ok(!(readStatus(dir).warnings || []).includes('identity_unrecorded'));
});

test('identity stays unknown: job still completes, pidStart/childStart null, warning identity_unrecorded', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const identity = (pid) => ({ pid, unknown: true });
  await runJob(dir, { identity, identityRetryDelayMs: 5 });
  const st = readStatus(dir);
  assert.equal(st.state, 'completed');
  assert.equal(st.pidStart, null);
  assert.ok(st.warnings.includes('identity_unrecorded'));
  assert.equal(st.childStart, null);
  assert.equal(readResult(dir).state, 'completed');
});

import { unlinkSync } from 'node:fs';
import { killActiveChild, writeCrashState } from '../src/job-runner.mjs';

const KNOWN = (pid, start = 'Mon Jan  1 00:00:00 2024') => ({ pid, start, command: 'x' });

test('the child identity is retried in the background: 1 + 4 samples, then identity_unrecorded', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty'; // alive ~1.5 s: long enough for every retry
  const { dir } = mkJob({ cwd: tempCwd() });
  let childCalls = 0;
  const identity = (pid) => (pid === process.pid ? KNOWN(pid) : (++childCalls, { pid, unknown: true }));
  await runJob(dir, { identity, identityRetryDelayMs: 5 });
  assert.equal(childCalls, 5);
  const st = readStatus(dir);
  assert.equal(st.pidStart, 'Mon Jan  1 00:00:00 2024');
  assert.equal(st.childStart, null);
  assert.deepEqual(st.warnings, ['identity_unrecorded']);
});

test('a child identity that becomes known on retry is recorded, without a warning', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty';
  const { dir } = mkJob({ cwd: tempCwd() });
  let childCalls = 0;
  const identity = (pid) => {
    if (pid === process.pid) return KNOWN(pid);
    return ++childCalls === 1 ? { pid, unknown: true } : KNOWN(pid, 'Tue Jan  2 00:00:00 2024');
  };
  await runJob(dir, { identity, identityRetryDelayMs: 5 });
  assert.equal(childCalls, 2);
  const st = readStatus(dir);
  assert.equal(st.childStart, 'Tue Jan  2 00:00:00 2024');
  assert.deepEqual(st.warnings, []);
});

test('a child that ps no longer finds is recorded without childStart and without a warning', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const patches = [];
  const identity = (pid) => (pid === process.pid ? KNOWN(pid) : null);
  await runJob(dir, { identity, identityRetryDelayMs: 5, onStatus: (_s, p) => patches.push(p) });
  const running = patches.find((p) => p.state === 'running');
  assert.ok(Number.isInteger(running.childPid));
  assert.equal(running.childStart, null);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, []);
});

test('the runner identity is sampled 5 times without delay, then identity_unrecorded', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const selfCalls = [];
  const identity = (pid) => {
    if (pid !== process.pid) return KNOWN(pid);
    selfCalls.push(Date.now());
    return { pid, unknown: true };
  };
  await runJob(dir, { identity, identityRetryDelayMs: 0 });
  assert.equal(selfCalls.length, 5);
  const gaps = selfCalls.slice(1).map((t, i) => t - selfCalls[i]);
  assert.ok(Math.max(...gaps) < 80, `retry delay 0 is honoured (gaps ${gaps})`);
  const st = readStatus(dir);
  assert.equal(st.pidStart, null);
  assert.equal(st.childStart, 'Mon Jan  1 00:00:00 2024');
  assert.deepEqual(st.warnings, ['identity_unrecorded']);
  assert.equal(readResult(dir).state, 'completed');
});

test('a runner identity ps cannot find is a warning, not a crash', async () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  const identity = (pid) => (pid === process.pid ? null : KNOWN(pid));
  await runJob(dir, { identity, identityRetryDelayMs: 0 });
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.deepEqual(res.warnings, ['identity_unrecorded']);
  assert.equal(readStatus(dir).pidStart, null);
});

test('CLI output writes lastActivityAt at most once per second', async () => {
  process.env.FAKE_ZCODE_MODE = 'chatty'; // 11 stdout chunks over ~1.5 s
  const { dir } = mkJob({ cwd: tempCwd() });
  let activityWrites = 0;
  await runJob(dir, { onStatus: (_s, p) => { if (p.lastActivityAt && !p.state) activityWrites++; } });
  assert.equal(readResult(dir).state, 'completed');
  assert.ok(activityWrites >= 1 && activityWrites <= 3, `${activityWrites} activity writes`);
});

test('result.output of exactly OUTPUT_CAP characters is whole; longer output keeps its head', async () => {
  const bin = join(tempCwd(), 'print.cjs');
  writeFileSync(bin, "process.stdout.write('a' + 'x'.repeat(Number(process.env.FAKE_OUT_LEN) - 1));");
  const saved = process.env.ZCODE_BIN;
  process.env.ZCODE_BIN = bin;
  try {
    process.env.FAKE_OUT_LEN = String(OUTPUT_CAP);
    const exact = mkJob({ cwd: tempCwd() });
    await runJob(exact.dir);
    assert.equal(readResult(exact.dir).output, 'a' + 'x'.repeat(OUTPUT_CAP - 1));
    process.env.FAKE_OUT_LEN = String(OUTPUT_CAP + 10);
    const over = mkJob({ cwd: tempCwd() });
    await runJob(over.dir);
    assert.equal(readResult(over.dir).output, `a${'x'.repeat(OUTPUT_CAP - 1)}\n[... output truncated at ${OUTPUT_CAP} chars]`);
  } finally {
    process.env.ZCODE_BIN = saved;
    delete process.env.FAKE_OUT_LEN;
  }
});

test('a job.json without a cwd ends failed (crash) without running ZCode', async () => {
  const { dir } = createJobDir({ params: { prompt: 'do it' }, path: 'cli', baseline: null });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.match(res.errorMessage, /missing or incomplete/);
});

test('idle_timeout_ms applies on the CLI path', async () => {
  process.env.FAKE_ZCODE_MODE = 'silent';
  const { dir } = mkJob({ cwd: tempCwd(), idle_timeout_ms: 500 });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'timeout');
  assert.equal(res.errorKind, 'timeout_idle');
  assert.equal(res.errorMessage, 'No activity for 500 ms');
});

test('the session store entry carries mode and the first 80 prompt characters', async () => {
  const prompt = `P${'q'.repeat(120)}`;
  const { dir } = mkJob({ cwd: tempCwd(), mode: 'plan', prompt });
  const saved = process.env.ZCODE_MCP_STATE;
  const store = join(tempCwd(), 'own-sessions.json'); // not the default path under ZCODE_MCP_HOME
  process.env.ZCODE_MCP_STATE = store;
  try {
    await runJob(dir);
  } finally {
    process.env.ZCODE_MCP_STATE = saved;
  }
  const entries = new SessionStore(store).list();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.mode, 'plan');
  assert.equal(entry.promptPreview, prompt.slice(0, 80));
  assert.equal(entry.status, 'completed');
});

test('a worktree job without a baseline reports its changes and no shared_repo', async () => {
  const wt = gitCwd();
  const startSha = run(wt, 'git', ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(wt, 'wt.txt'), 'x\n');
  const { dir } = mkJob({ cwd: tempCwd(), isolate_worktree: true }, { worktree: { branch: 'zcode/t', dir: wt, startSha } });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'completed');
  assert.equal(res.changesAvailable, true);
  assert.deepEqual(res.changedFiles, ['?? wt.txt']);
  assert.deepEqual(res.warnings, []);
});

test('a worktree that cannot be summarised reports changes unavailable', async () => {
  const gone = join(tempCwd(), 'no-such-worktree');
  const { dir } = mkJob({ cwd: tempCwd(), isolate_worktree: true }, { worktree: { branch: 'zcode/t', dir: gone, startSha: 'HEAD' } });
  await runJob(dir);
  const res = readResult(dir);
  assert.equal(res.state, 'failed'); // ZCode cannot start in a missing directory
  assert.equal(res.changesAvailable, false);
  assert.deepEqual(res.changedFiles, []);
});

test('killActiveChild without a running child signals nothing and says so', () => {
  assert.equal(killActiveChild(), false);
});

test('writeCrashState records a crash for a job that has no status yet', () => {
  const { dir } = mkJob({ cwd: tempCwd() });
  writeCrashState(dir, null, 'plain string failure', { startedMs: Date.now() - 1000 });
  const res = readResult(dir);
  assert.equal(res.state, 'failed');
  assert.equal(res.errorKind, 'crash');
  assert.equal(res.errorMessage, 'plain string failure');
  assert.equal(res.changesAvailable, false);
  assert.equal(res.outputLogPath, null);
  assert.ok(res.durationMs >= 1000 && res.durationMs < 60000, `durationMs ${res.durationMs}`);
  assert.equal(readStatus(dir).state, 'failed');
});

test('runnerEnvOptions: heartbeat 0 is unset, 1 is clamped; retry delays may be 0; fatal 1 counts', () => {
  assert.equal(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: '0' }).heartbeatMs, undefined);
  assert.equal(runnerEnvOptions({ ZCODE_MCP_HEARTBEAT_MS: '1' }).heartbeatMs, 1000);
  assert.equal(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_HEARTBEAT_MS: '1' }).heartbeatMs, 1);
  assert.deepEqual(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_TEST_RETRY_DELAYS_MS: '0,5' }).retryDelaysMs, [0, 5]);
  assert.equal(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_TEST_RETRY_DELAYS_MS: '' }).retryDelaysMs, undefined);
  assert.equal(runnerEnvOptions({ NODE_ENV: 'test', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '1' }).fatalAfterMs, 1);
});

test('a fatal runner error still records the crash when status.json is gone', async () => {
  const { dir, token } = mkJob({ cwd: tempCwd() });
  const { child, exited } = spawnRunner(dir, token, {
    FAKE_ZCODE_MODE: 'silent', ZCODE_MCP_TEST_FATAL_AFTER_SPAWN: '800', NODE_ENV: 'test',
  });
  let st;
  try {
    st = await waitFor(() => (readStatus(dir)?.state === 'running' ? readStatus(dir) : null));
    unlinkSync(join(dir, 'status.json'));
    const { code } = await exited;
    assert.equal(code, 1);
    const res = readResult(dir);
    assert.equal(res.state, 'failed');
    assert.match(res.errorMessage, /test fatal after spawn/);
    assert.equal(res.durationMs, null); // startedAt went with status.json
    await waitFor(() => !alive(st.childPid), 2000);
  } finally {
    safeSignal(child.pid, 'SIGKILL', { marker: 'job-runner.mjs', group: true }); // the detached runner we spawned
    if (st) safeSignal(st.childPid, 'SIGKILL', { marker: 'fake-zcode' });
  }
});

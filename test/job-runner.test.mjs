import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, makeGitRepo, removeDir, fakeBin, run } from './helpers.mjs';
import { createJobDir, readStatus, readResult, stateHome, TERMINAL_STATES } from '../src/jobstore.mjs';
import { captureBaseline } from '../src/changes.mjs';
import { acquireCwdLock, lockKey } from '../src/locks.mjs';
import { SessionStore } from '../src/state.mjs';
import { runJob } from '../src/job-runner.mjs';

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
  await new Promise((r) => setTimeout(r, 700)); // let the fake install its SIGTERM handler
  const t0 = Date.now();
  writeFileSync(join(dir, 'cancel'), '');
  await done;
  assert.ok(Date.now() - t0 >= 4500, 'waited for the SIGKILL grace period');
  assert.equal(readResult(dir).state, 'cancelled');
  assert.equal(alive(st.childPid), false);
});

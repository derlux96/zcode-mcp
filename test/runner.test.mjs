import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  OUTPUT_CAP, DEFAULT_TIMEOUT_MS,
} from '../src/runner.mjs';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';

const base = { prompt: 'do it', cwd: '/tmp' };

test('validateRunArgs accepts a minimal valid call and applies defaults', () => {
  const v = validateRunArgs(base);
  assert.equal(v.ok, true);
  assert.equal(v.value.mode, 'yolo');
  assert.equal(v.value.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(v.value.isolateWorktree, false);
});

test('validateRunArgs rejects relative cwd, bad mode, empty prompt, out-of-range timeout', () => {
  assert.match(validateRunArgs({ ...base, cwd: 'relative/x' }).error, /absolute/i);
  assert.match(validateRunArgs({ ...base, mode: 'fast' }).error, /mode/i);
  assert.match(validateRunArgs({ ...base, prompt: '' }).error, /prompt/i);
  assert.match(validateRunArgs({ ...base, timeout_ms: 10 }).error, /timeout_ms/i);
  assert.match(validateRunArgs({ ...base, timeout_ms: 999999999 }).error, /timeout_ms/i);
  assert.equal(validateRunArgs({ cwd: '/tmp' }).ok, false); // prompt missing
});

test('validateRunArgs rejects nonexistent cwd', () => {
  assert.match(validateRunArgs({ ...base, cwd: '/no/such/dir/at/all' }).error, /exist/i);
});

test('runZCodeTask runs the fake bin, extracts sess_ id, reports exit 0', async () => {
  const cwd = makeTempDir();
  const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.sessionId, 'sess_fake123');
  assert.match(res.stdout, /fake task done/);
  removeDir(cwd);
});

test('runZCodeTask passes --mode/--resume/--target through', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_ECHO_ARGS = '1';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, mode: 'plan', resume: 'sess_x1', target: 'goal text' });
    assert.match(res.stdout, /--mode/);
    assert.match(res.stdout, /plan/);
    assert.match(res.stdout, /sess_x1/);
    assert.match(res.stdout, /goal text/);
  } finally {
    delete process.env.FAKE_ZCODE_ECHO_ARGS;
    removeDir(cwd);
  }
});

test('nonzero exit is reported, session id still extracted', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'fail';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd });
    assert.equal(res.code, 1);
    assert.equal(res.sessionId, 'sess_fail000');
    assert.match(res.stderr, /fake zcode failure/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('timeout kills the child and flags timedOut', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 400 });
    assert.equal(res.timedOut, true);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('output is capped at OUTPUT_CAP characters', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'bigoutput';
  try {
    const res = await runZCodeArgs(fakeBin, [], { cwd, timeoutMs: 5000 });
    assert.ok(res.stdout.length <= OUTPUT_CAP + 100); // cap + truncation notice
    assert.match(res.stdout, /truncated/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('runZCodeArgs runs version and doctor subcommands', async () => {
  const cwd = makeTempDir();
  const v = await runZCodeArgs(fakeBin, ['version'], { cwd, timeoutMs: 5000 });
  assert.match(v.stdout, /0\.16\.9/);
  removeDir(cwd);
});

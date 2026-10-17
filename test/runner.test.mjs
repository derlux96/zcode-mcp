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

// --- ZCODE_BUILTIN_PROVIDER_CONFIG_FILE fallback (macOS app-bundle fix) ---
// The app-spawned test process inherits ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
// from the ZCode app; save/restore it so tests simulate fresh MCP-client shells.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('injects the app-bundle builtin provider config on fresh shells', async () => {
  const prev = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const prevPersonal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const prevHome = process.env.HOME;
  const home = makeTempDir('zcode-home-'); // no personal provider config there
  process.env.HOME = home;
  const app = makeTempDir('zcode-app-');
  const glm = join(app, 'glm');
  const cfg = join(app, 'config', 'provider');
  mkdirSync(glm, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  const bin = join(glm, 'fake-zcode.cjs');
  copyFileSync(fakeBin, bin);
  writeFileSync(join(cfg, 'zcode-builtin.json'), '{}');
  try {
    process.env.FAKE_ZCODE_DUMP_ENV = '1';
    const res = await runZCodeArgs(bin, [], { cwd: app, timeoutMs: 5000 });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.builtinConfig, join(app, 'config', 'provider', 'zcode-builtin.json'));
    assert.equal(parsed.personalConfig, null); // no default personal config file
  } finally {
    delete process.env.FAKE_ZCODE_DUMP_ENV;
    if (prev !== undefined) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = prev;
    if (prevPersonal !== undefined) process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = prevPersonal;
    else delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    removeDir(app);
    removeDir(home);
  }
});

test('completes the pair: injects the personal provider config default alongside the builtin one', async () => {
  const prev = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const prevPersonal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const prevHome = process.env.HOME;
  const home = makeTempDir('zcode-home-');
  const personalDir = join(home, '.zcode', 'v2');
  mkdirSync(personalDir, { recursive: true });
  writeFileSync(join(personalDir, 'provider_config.json'), '{"schemaVersion":1}');
  process.env.HOME = home;
  const app = makeTempDir('zcode-app-');
  const glm = join(app, 'glm');
  const cfg = join(app, 'config', 'provider');
  mkdirSync(glm, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  const bin = join(glm, 'fake-zcode.cjs');
  copyFileSync(fakeBin, bin);
  writeFileSync(join(cfg, 'zcode-builtin.json'), '{}');
  try {
    process.env.FAKE_ZCODE_DUMP_ENV = '1';
    const res = await runZCodeArgs(bin, [], { cwd: app, timeoutMs: 5000 });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.builtinConfig, join(app, 'config', 'provider', 'zcode-builtin.json'));
    assert.equal(parsed.personalConfig, join(home, '.zcode', 'v2', 'provider_config.json'));
  } finally {
    delete process.env.FAKE_ZCODE_DUMP_ENV;
    if (prev !== undefined) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = prev;
    if (prevPersonal !== undefined) process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = prevPersonal;
    else delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    removeDir(app);
    removeDir(home);
  }
});

test('never overrides an explicitly set ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', async () => {
  const prev = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const prevPersonal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = '/custom/personal.json';
  const app = makeTempDir('zcode-app-');
  const glm = join(app, 'glm');
  const cfg = join(app, 'config', 'provider');
  mkdirSync(glm, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  const bin = join(glm, 'fake-zcode.cjs');
  copyFileSync(fakeBin, bin);
  writeFileSync(join(cfg, 'zcode-builtin.json'), '{}');
  try {
    process.env.FAKE_ZCODE_DUMP_ENV = '1';
    const res = await runZCodeArgs(bin, [], { cwd: app, timeoutMs: 5000 });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.personalConfig, '/custom/personal.json');
  } finally {
    delete process.env.FAKE_ZCODE_DUMP_ENV;
    if (prev !== undefined) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = prev;
    if (prevPersonal !== undefined) process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = prevPersonal;
    else delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    removeDir(app);
  }
});

test('never overrides an explicitly set ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', async () => {
  const prev = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const prevPersonal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = '/custom/location.json';
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const scratch = makeTempDir();
  try {
    process.env.FAKE_ZCODE_DUMP_ENV = '1';
    const res = await runZCodeArgs(fakeBin, [], { cwd: scratch, timeoutMs: 5000 });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.builtinConfig, '/custom/location.json');
  } finally {
    delete process.env.FAKE_ZCODE_DUMP_ENV;
    if (prev !== undefined) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = prev;
    else delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (prevPersonal !== undefined) process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = prevPersonal;
    else delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    removeDir(scratch);
  }
});

test('injects nothing when the binary has no sibling builtin config', async () => {
  const prev = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const prevPersonal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  const prevHome = process.env.HOME;
  const home = makeTempDir('zcode-home-');
  const personalDir = join(home, '.zcode', 'v2');
  mkdirSync(personalDir, { recursive: true });
  writeFileSync(join(personalDir, 'provider_config.json'), '{"schemaVersion":1}');
  process.env.HOME = home;
  const plain = makeTempDir('zcode-plain-');
  const bin = join(plain, 'fake-zcode.cjs');
  copyFileSync(fakeBin, bin);
  try {
    process.env.FAKE_ZCODE_DUMP_ENV = '1';
    const res = await runZCodeArgs(bin, [], { cwd: plain, timeoutMs: 5000 });
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.builtinConfig, null);
    // Both-or-neither: without a builtin config the personal one must not be
    // injected either, or the app-server registry bootstrap would throw.
    assert.equal(parsed.personalConfig, null);
  } finally {
    delete process.env.FAKE_ZCODE_DUMP_ENV;
    if (prev !== undefined) process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = prev;
    if (prevPersonal !== undefined) process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = prevPersonal;
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    removeDir(plain);
    removeDir(home);
  }
});

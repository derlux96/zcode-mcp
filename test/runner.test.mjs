import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  OUTPUT_CAP, DEFAULT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, MAX_TIMEOUT_MS,
} from '../src/runner.mjs';
import { makeTempDir, removeDir, fakeBin, safeSignal } from './helpers.mjs';

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

test('timeout_ms 0 means no total cap: accepted, while 1..999 and negatives stay rejected', () => {
  const v = validateRunArgs({ ...base, timeout_ms: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.value.timeoutMs, 0);
  for (const bad of [1, 999, -1, 1.5, '0', null]) {
    assert.equal(validateRunArgs({ ...base, timeout_ms: bad }).ok, false, `timeout_ms ${JSON.stringify(bad)} must be rejected`);
  }
  assert.match(validateRunArgs({ ...base, timeout_ms: 10 }).error, /0 \(no cap\)/);
});

test('timeoutMs 0 arms no total timer: a 1.5 s run completes instead of being killed at once', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'chatty';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 0 });
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
    assert.equal(res.sessionId, 'sess_chatty1');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('timeoutMs 0 can still be cancelled through the abort signal (no cap is not no control)', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  const ctl = new AbortController();
  try {
    setTimeout(() => ctl.abort(), 500);
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 0, signal: ctl.signal });
    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutKind, 'cancelled');
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
    assert.equal(res.timeoutKind, 'total');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('abort signal stops the child and reports kind cancelled; onSpawn sees the child', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  try {
    const ctl = new AbortController();
    let spawnedPid = null;
    const pending = runZCodeTask({
      binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 30000, signal: ctl.signal,
      onSpawn: (child) => { spawnedPid = child.pid; },
    });
    assert.ok(Number.isInteger(spawnedPid));
    setTimeout(() => ctl.abort(), 100);
    const res = await pending;
    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutKind, 'cancelled');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitDead(pid, ms = 2000) {
  const end = Date.now() + ms;
  while (pidAlive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return !pidAlive(pid);
}

test('killGroup: a timeout also kills the grandchild', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'spawn-grandchild';
  let gc;
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 600, killGroup: true });
    assert.equal(res.timeoutKind, 'total');
    gc = Number(res.stderr.match(/grandchild pid (\d+)/)[1]);
    assert.equal(await waitDead(gc), true, 'grandchild killed with the group');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    if (gc) try { process.kill(gc, 'SIGKILL'); } catch {}
    removeDir(cwd);
  }
});

// I3: a normal exit leaves no background process of ZCode's group behind.
async function leaveGrandchild(env, opts = {}) {
  const cwd = makeTempDir();
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_ZCODE_MODE: 'leave-grandchild' }, env);
  let gc;
  try {
    const t0 = Date.now();
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 30000, killGroup: true, ...opts });
    gc = Number(res.stderr.match(/grandchild pid (\d+)/)[1]);
    return { res, gc, dead: await waitDead(gc), ms: Date.now() - t0 };
  } finally {
    for (const k of ['FAKE_ZCODE_MODE', 'FAKE_GRANDCHILD_STDIO', 'FAKE_GRANDCHILD_IGNORE_TERM']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    if (gc) safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode-leftover' }); // only if the assertion failed
    removeDir(cwd);
  }
}

test('killGroup: a normal exit kills the background process ZCode left behind', async () => {
  const { res, dead } = await leaveGrandchild({});
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.leftoverKilled, true);
  assert.equal(dead, true, 'grandchild killed after the leader exited');
});

test('killGroup: a leftover holding the pipes and ignoring SIGTERM is SIGKILLed after the grace', async () => {
  const { res, dead, ms } = await leaveGrandchild(
    { FAKE_GRANDCHILD_STDIO: 'inherit', FAKE_GRANDCHILD_IGNORE_TERM: '1' },
    { leftoverGraceMs: 300 },
  );
  assert.equal(res.code, 0);
  assert.equal(res.leftoverKilled, true);
  assert.equal(dead, true);
  assert.ok(ms < 10000, `returned promptly (${ms} ms)`);
});

// A stop arriving during the post-exit sweep must not rewrite a clean exit 0.
test('killGroup: a cancel arriving during the leftover sweep leaves a clean exit completed', async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 800); // ZCode exits at ~300 ms, the sweep then lasts ~1.5 s
  const { res, dead } = await leaveGrandchild(
    { FAKE_GRANDCHILD_STDIO: 'inherit', FAKE_GRANDCHILD_IGNORE_TERM: '1' },
    { leftoverGraceMs: 1500, signal: ctl.signal },
  );
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.timeoutKind, null);
  assert.equal(dead, true);
});

test('killGroup: the total timer firing during the leftover sweep leaves a clean exit completed', async () => {
  const { res, dead } = await leaveGrandchild(
    { FAKE_GRANDCHILD_STDIO: 'inherit', FAKE_GRANDCHILD_IGNORE_TERM: '1' },
    { leftoverGraceMs: 1500, timeoutMs: 800 },
  );
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(dead, true);
});

test('a daemonized leftover holding the pipes does not delay the result past stdioGraceMs', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'daemonize-pipe-holder';
  let gc;
  try {
    const t0 = Date.now();
    const res = await runZCodeTask({
      binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 0, killGroup: true, leftoverGraceMs: 300, stdioGraceMs: 500,
    });
    gc = Number(res.stderr.match(/grandchild pid (\d+)/)[1]);
    assert.ok(Date.now() - t0 < 5000, `resolved promptly (${Date.now() - t0} ms)`);
    assert.equal(res.code, 0);
    assert.equal(res.timedOut, false);
    assert.match(res.stdout, /daemon left/);
    assert.equal(res.sessionId, 'sess_daemon01');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    if (gc) safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode-leftover' });
    removeDir(cwd);
  }
});

test('killGroup: a clean exit reports no leftovers', async () => {
  const cwd = makeTempDir();
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, killGroup: true });
    assert.equal(res.code, 0);
    assert.equal(res.leftoverKilled, false);
  } finally {
    removeDir(cwd);
  }
});

test('a throwing onSpawn kills the child and rejects', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  let pid;
  try {
    await assert.rejects(
      runZCodeTask({
        binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 30000, killGroup: true,
        onSpawn: (child) => { pid = child.pid; throw new Error('boom'); },
      }),
      /boom/,
    );
    assert.equal(await waitDead(pid), true);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('onStdout sees the full, uncapped stdout', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'bigoutput';
  try {
    let seen = 0;
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, onStdout: (c) => { seen += c.length; } });
    assert.ok(seen > OUTPUT_CAP);
    assert.ok(seen > res.stdout.length);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('idle timeout aborts a silent child and reports kind idle', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 10000, idleTimeoutMs: 300 });
    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutKind, 'idle');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('active output keeps a run alive past the idle limit', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'chatty';
  try {
    // ~1.5 s of runtime with output every 150 ms, idle limit 600 ms.
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 10000, idleTimeoutMs: 600 });
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
    assert.equal(res.sessionId, 'sess_chatty1');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('validateRunArgs leaves idle_timeout_ms unset by default and rejects out-of-range values', () => {
  assert.equal(validateRunArgs(base).value.idleTimeoutMs, undefined);
  assert.equal(validateRunArgs({ ...base, idle_timeout_ms: 5 }).ok, false);
  assert.equal(validateRunArgs({ ...base, idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS }).value.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
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

test('timeout_ms default and maximum are 6 hours', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 21600000);
  assert.equal(MAX_TIMEOUT_MS, 21600000);
  assert.equal(validateRunArgs({ ...base, timeout_ms: 21600000 }).ok, true);
  assert.match(validateRunArgs({ ...base, timeout_ms: 21600001 }).error, /timeout_ms/);
});

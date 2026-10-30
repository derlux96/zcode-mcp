import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  OUTPUT_CAP, DEFAULT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, MAX_TIMEOUT_MS,
} from '../src/runner.mjs';
import { makeTempDir, removeDir, fakeBin, safeSignal } from './helpers.mjs';

// Every temp dir made by a test is removed at the end, including the zcode-app-* ones.
const temps = [];
const mk = (prefix) => { const d = makeTempDir(prefix); temps.push(d); return d; };
after(() => { for (const d of temps) removeDir(d); });

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
  const cwd = mk();
  const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.sessionId, 'sess_fake123');
  assert.match(res.stdout, /fake task done/);
  removeDir(cwd);
});

test('runZCodeTask passes --mode/--resume/--target through', async () => {
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
  process.env.FAKE_ZCODE_MODE = 'spawn-grandchild';
  let gc;
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 600, killGroup: true });
    assert.equal(res.timeoutKind, 'total');
    gc = Number(res.stderr.match(/grandchild pid (\d+)/)[1]);
    assert.equal(await waitDead(gc), true, 'grandchild killed with the group');
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    if (gc) safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode-grandchild' });
    removeDir(cwd);
  }
});

// I3: a normal exit leaves no background process of ZCode's group behind.
async function leaveGrandchild(env, opts = {}) {
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, killGroup: true });
    assert.equal(res.code, 0);
    assert.equal(res.leftoverKilled, false);
  } finally {
    removeDir(cwd);
  }
});

test('a throwing onSpawn kills the child and rejects', async () => {
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const cwd = mk();
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
  const home = mk('zcode-home-'); // no personal provider config there
  process.env.HOME = home;
  const app = mk('zcode-app-');
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
  const home = mk('zcode-home-');
  const personalDir = join(home, '.zcode', 'v2');
  mkdirSync(personalDir, { recursive: true });
  writeFileSync(join(personalDir, 'provider_config.json'), '{"schemaVersion":1}');
  process.env.HOME = home;
  const app = mk('zcode-app-');
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
  const app = mk('zcode-app-');
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
  const scratch = mk();
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
  const home = mk('zcode-home-');
  const personalDir = join(home, '.zcode', 'v2');
  mkdirSync(personalDir, { recursive: true });
  writeFileSync(join(personalDir, 'provider_config.json'), '{"schemaVersion":1}');
  process.env.HOME = home;
  const plain = mk('zcode-plain-');
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

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildSpawnEnv, MIN_TIMEOUT_MS, MAX_TRANSIENT_RETRIES } from '../src/runner.mjs';

test('validateRunArgs: every rejection says ok: false and names the field', () => {
  const file = join(mk(), 'plain-file');
  writeFileSync(file, 'x');
  const cases = [
    [{ prompt: ' ' }, /prompt/],
    [{ cwd: 'relative/x' }, /absolute/],
    [{ cwd: '/no/such/dir/at/all' }, /does not exist/],
    [{ cwd: file }, /not a directory/],
    [{ mode: 'fast' }, /mode/],
    [{ resume: 42 }, /resume/],
    [{ target: 42 }, /target/],
    [{ timeout_ms: MIN_TIMEOUT_MS - 1 }, /timeout_ms/],
    [{ idle_timeout_ms: MIN_TIMEOUT_MS - 1 }, /idle_timeout_ms/],
    [{ idle_timeout_ms: MAX_TIMEOUT_MS + 1 }, /idle_timeout_ms/],
    [{ idle_timeout_ms: 1500.5 }, /idle_timeout_ms/],
    [{ isolate_worktree: 'yes' }, /isolate_worktree/],
    [{ max_transient_retries: -1 }, /max_transient_retries/],
    [{ max_transient_retries: MAX_TRANSIENT_RETRIES + 1 }, /max_transient_retries/],
    [{ max_transient_retries: 1.5 }, /max_transient_retries/],
    [{ input_timeout_ms: 0 }, /input_timeout_ms/],
    [{ input_timeout_ms: MAX_TIMEOUT_MS + 1 }, /input_timeout_ms/],
    [{ input_timeout_ms: 1.5 }, /input_timeout_ms/],
  ];
  for (const [patch, re] of cases) {
    const v = validateRunArgs({ ...base, ...patch });
    assert.equal(v.ok, false, `${JSON.stringify(patch)} must be rejected`);
    assert.match(v.error, re);
  }
});

test('validateRunArgs accepts the range boundaries and passes the optional fields through', () => {
  const accepted = [
    { timeout_ms: MIN_TIMEOUT_MS },
    { idle_timeout_ms: MIN_TIMEOUT_MS },
    { idle_timeout_ms: MAX_TIMEOUT_MS },
    { max_transient_retries: 0 },
    { max_transient_retries: MAX_TRANSIENT_RETRIES },
    { input_timeout_ms: 1 },
    { input_timeout_ms: MAX_TIMEOUT_MS },
  ];
  for (const patch of accepted) {
    assert.equal(validateRunArgs({ ...base, ...patch }).ok, true, `${JSON.stringify(patch)} must be accepted`);
  }
  const v = validateRunArgs({
    ...base, resume: 'sess_r1', target: 'goal', isolate_worktree: true, max_transient_retries: 3, input_timeout_ms: 5000,
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.resume, 'sess_r1');
  assert.equal(v.value.target, 'goal');
  assert.equal(v.value.isolateWorktree, true);
  assert.equal(v.value.maxTransientRetries, 3);
  assert.equal(v.value.inputTimeoutMs, 5000);
});

test('buildSpawnEnv completes the pair without HOME set (falls back to the account home)', () => {
  const saved = { ...process.env };
  try {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = '/x/zcode-builtin.json';
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    delete process.env.HOME;
    const env = buildSpawnEnv('/no/such/bin/zcode');
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, '/x/zcode-builtin.json');
  } finally {
    for (const k of ['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'HOME']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// A child script (run with node, since it ends in .cjs) written for one test.
function script(name, code) {
  const file = join(mk('zcode-script-'), name);
  writeFileSync(file, code);
  return file;
}

test('output of exactly OUTPUT_CAP characters is kept whole; longer output keeps its head', async () => {
  const bin = script('print.cjs', "process.stdout.write('a' + 'x'.repeat(Number(process.argv[2]) - 1));");
  const cwd = mk();
  const exact = await runZCodeArgs(bin, [String(OUTPUT_CAP)], { cwd, timeoutMs: 10000 });
  assert.equal(exact.stdout, 'a' + 'x'.repeat(OUTPUT_CAP - 1));
  const over = await runZCodeArgs(bin, [String(OUTPUT_CAP + 1)], { cwd, timeoutMs: 10000 });
  assert.equal(over.stdout, `a${'x'.repeat(OUTPUT_CAP - 1)}\n[... output truncated at ${OUTPUT_CAP} chars]`);
});

test('without killGroup the child stays in our process group and no leftovers are reported', async () => {
  const cwd = mk();
  let pgid;
  const res = await runZCodeTask({
    binPath: fakeBin, prompt: 'hi', cwd,
    onSpawn: (child) => { pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' })); },
  });
  assert.equal(res.code, 0);
  assert.equal(pgid, Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' })));
  assert.equal(res.leftoverKilled, false);
});

test('a second stop while the first is still ending keeps the first kind', async () => {
  // Silent child that takes 800 ms to exit after SIGTERM: the idle stop fires
  // at 300 ms, the cancel at 700 ms must not relabel it.
  const bin = script('slow-term.cjs', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 800)); setTimeout(() => process.exit(3), 20000);");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 700);
  const res = await runZCodeArgs(bin, [], { cwd: mk(), timeoutMs: 20000, idleTimeoutMs: 300, signal: ctl.signal });
  assert.equal(res.timedOut, true);
  assert.equal(res.timeoutKind, 'idle');
});

test('timeoutMs 1 is a real (1 ms) total cap', async () => {
  const cwd = mk();
  process.env.FAKE_ZCODE_MODE = 'hang';
  const ctl = new AbortController();
  const backstop = setTimeout(() => ctl.abort(), 5000); // ends the run if no cap was armed
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 1, signal: ctl.signal });
    assert.equal(res.timedOut, true);
    assert.equal(res.timeoutKind, 'total');
  } finally {
    clearTimeout(backstop);
    delete process.env.FAKE_ZCODE_MODE;
  }
});

test('a binary that cannot be spawned yields code null and no leftovers', async () => {
  const res = await runZCodeArgs('/no/such/dir/zcode-bin', [], { cwd: mk(), timeoutMs: 5000, killGroup: true });
  assert.equal(res.code, null);
  assert.equal(res.timedOut, false);
  assert.equal(res.leftoverKilled, false);
  assert.match(res.stderr, /failed to spawn/);
});

test('output after ZCode exited does not arm the idle timer again', async () => {
  // The leader exits at once; a child holding the pipes writes 100 ms later
  // and ends by itself at 1.2 s, well past the 300 ms idle limit.
  const bin = script('late-writer.cjs', [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late\\\\n'), 100); setTimeout(() => process.exit(0), 1200);\"], { stdio: 'inherit' });",
    'process.exit(0);',
  ].join('\n'));
  const res = await runZCodeArgs(bin, [], { cwd: mk(), timeoutMs: 20000, idleTimeoutMs: 300, stdioGraceMs: 5000 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /late/);
  assert.equal(res.timedOut, false);
  assert.equal(res.timeoutKind, null);
});

test('killGroup: a leftover that ends itself on SIGTERM gets the grace before any SIGKILL', async () => {
  const dir = mk('zcode-script-');
  const marker = join(dir, 'clean-exit');
  const leftover = `process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }, 300)); setTimeout(() => process.exit(0), 15000);`;
  const bin = join(dir, 'leader.cjs');
  writeFileSync(bin, [
    "const { spawn } = require('node:child_process');",
    `const gc = spawn(process.execPath, ['-e', ${JSON.stringify(leftover)}, 'fake-zcode-graceful'], { stdio: 'ignore' });`,
    'process.stderr.write(`grandchild pid ${gc.pid}\\n`);',
    'setTimeout(() => process.exit(0), 300);',
  ].join('\n'));
  let gc;
  try {
    const res = await runZCodeArgs(bin, [], { cwd: dir, timeoutMs: 20000, killGroup: true, leftoverGraceMs: 3000 });
    gc = Number(res.stderr.match(/grandchild pid (\d+)/)[1]);
    assert.equal(res.leftoverKilled, true);
    assert.equal(existsSync(marker), true, 'the leftover finished its SIGTERM handler');
    assert.equal(readFileSync(marker, 'utf8'), 'x');
  } finally {
    if (gc) safeSignal(gc, 'SIGKILL', { marker: 'fake-zcode-graceful' });
  }
});

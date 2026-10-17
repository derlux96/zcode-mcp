import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTaskWithModel } from '../src/appserver.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const zcodeBin = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url));
const appBin = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Spawns the fake zcode in a mode; collects raw stdout/stderr buffers. */
function startZCode(mode) {
  const child = spawn(process.execPath, [zcodeBin], {
    env: { ...process.env, FAKE_ZCODE_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  const err = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => err.push(d));
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    stdoutBuf: () => Buffer.concat(out),
    stderrText: () => Buffer.concat(err).toString('utf8'),
  };
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

test('zcode silent: no output and still running after 500 ms', async () => {
  const z = startZCode('silent');
  try {
    await sleep(500);
    assert.equal(z.stdoutBuf().length, 0);
    assert.equal(z.stderrText(), '');
    assert.equal(z.child.exitCode, null);
    assert.equal(z.child.signalCode, null);
  } finally {
    z.child.kill('SIGKILL');
    await z.exited;
  }
});

test('zcode crash-mid: exits 1 after ~300 ms', async () => {
  const z = startZCode('crash-mid');
  try {
    const t0 = Date.now();
    const { code } = await z.exited;
    const dt = Date.now() - t0;
    assert.equal(code, 1);
    assert.ok(dt >= 250, `exited too early: ${dt} ms`);
  } finally {
    z.child.kill('SIGKILL');
  }
});

test('zcode badutf8: emits raw bytes ff fe, decoded as U+FFFD', async () => {
  const z = startZCode('badutf8');
  try {
    await z.exited;
    const buf = z.stdoutBuf();
    assert.ok(buf.includes(Buffer.from([0xff, 0xfe])));
    assert.ok(buf.toString('utf8').includes('�'));
  } finally {
    z.child.kill('SIGKILL');
  }
});

test('zcode ignore-sigterm: survives SIGTERM, dies on SIGKILL', async () => {
  const z = startZCode('ignore-sigterm');
  try {
    assert.ok(await waitFor(() => z.stdoutBuf().toString().includes('ready')), 'handler installed');
    z.child.kill('SIGTERM');
    await sleep(500);
    assert.equal(z.child.exitCode, null);
    assert.equal(z.child.signalCode, null);
    assert.ok(isAlive(z.child.pid));
  } finally {
    z.child.kill('SIGKILL');
    await z.exited;
  }
});

test('zcode spawn-grandchild: grandchild shares the process group and pid is on stderr', async () => {
  const z = startZCode('spawn-grandchild');
  let gpid = null;
  try {
    assert.ok(await waitFor(() => /grandchild pid (\d+)/.test(z.stderrText())), 'pid printed');
    gpid = Number(/grandchild pid (\d+)/.exec(z.stderrText())[1]);
    assert.ok(gpid > 0 && gpid !== z.child.pid);
    assert.ok(isAlive(gpid));
    assert.equal(z.child.exitCode, null);
  } finally {
    z.child.kill('SIGKILL');
    await z.exited;
    if (gpid) {
      try { process.kill(gpid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('zcode slow-start: no output for ~2 s, then a result', async () => {
  const z = startZCode('slow-start');
  try {
    await sleep(1000);
    assert.equal(z.stdoutBuf().length, 0);
    const { code } = await z.exited;
    assert.equal(code, 0);
    assert.ok(z.stdoutBuf().toString().includes('"session"'));
  } finally {
    z.child.kill('SIGKILL');
  }
});

// --- app-server fake modes, through the real client ---

async function runApp(mode, extra = {}) {
  const prev = process.env.FAKE_APPSERVER_MODE;
  process.env.FAKE_APPSERVER_MODE = mode;
  const cwd = makeTempDir();
  try {
    return await runTaskWithModel({
      binPath: appBin,
      cwd,
      prompt: 'hi',
      providerId: 'glm-test',
      modelId: 'small',
      reasoningLevel: 'low',
      timeoutMs: 8000,
      ...extra,
    });
  } finally {
    if (prev === undefined) delete process.env.FAKE_APPSERVER_MODE;
    else process.env.FAKE_APPSERVER_MODE = prev;
    removeDir(cwd);
  }
}

test('appserver rate-limit: turn.failed mentioning 429 rate limit', async () => {
  const res = await runApp('rate-limit');
  assert.equal(res.failed, true);
  assert.match(res.error.message, /429 rate limit/);
});

test('appserver auth-fail: turn.failed with project_token_login_failed', async () => {
  const res = await runApp('auth-fail');
  assert.equal(res.failed, true);
  assert.match(res.error.message, /project_token_login_failed/);
});

test('appserver: timeoutMs 0 arms no total timer, the idle timer still guards a silent turn', async () => {
  // chatty runs ~1.5 s: with a naive setTimeout(…, 0) it would be rejected at once.
  const ok = await runApp('chatty', { timeoutMs: 0, idleTimeoutMs: 1000 });
  assert.equal(ok.ok, true);
  // a silent turn is still ended by the idle limit, not by a total cap.
  await assert.rejects(
    runApp('slowhang', { timeoutMs: 0, idleTimeoutMs: 400 }),
    (e) => e.code === 'idle',
  );
});

test('appserver chatty: events every 150 ms for ~1.5 s, then turn.completed', async () => {
  const t0 = Date.now();
  // idle timeout shorter than the total run proves events keep it alive.
  const res = await runApp('chatty', { idleTimeoutMs: 1000 });
  const dt = Date.now() - t0;
  assert.equal(res.ok, true);
  assert.equal(res.failed, false);
  assert.ok(dt >= 1400, `finished too early: ${dt} ms`);
});

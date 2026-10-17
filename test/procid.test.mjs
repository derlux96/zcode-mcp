import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { getProcessIdentity, matchesIdentity, identityAlive, signalGroup } from '../src/procid.mjs';

async function withChild(cmd, args, fn) {
  const child = spawn(cmd, args, { stdio: 'ignore' });
  try {
    return await fn(child);
  } finally {
    child.kill('SIGKILL');
  }
}

test('getProcessIdentity returns start and command for the current process', () => {
  const id = getProcessIdentity(process.pid);
  assert.equal(id.pid, process.pid);
  assert.ok(id.start.length > 0);
  assert.ok(id.command.includes('node'));
});

test('getProcessIdentity returns null for a nonexistent pid', () => {
  assert.equal(getProcessIdentity(2147483646), null);
});

test('matchesIdentity is true for own identity with token in argv', async () => {
  await withChild('node', ['-e', 'setTimeout(()=>{},5000)', 'TOKEN123'], (child) => {
    const id = getProcessIdentity(child.pid);
    assert.ok(id);
    assert.equal(matchesIdentity({ pid: child.pid, start: id.start, token: 'TOKEN123' }), true);
  });
});

test('matchesIdentity is false when start differs', async () => {
  await withChild('node', ['-e', 'setTimeout(()=>{},5000)', 'TOKEN123'], (child) => {
    const id = getProcessIdentity(child.pid);
    assert.equal(matchesIdentity({ pid: child.pid, start: id.start + 'x', token: 'TOKEN123' }), false);
  });
});

test('matchesIdentity is false when token is missing from the command', async () => {
  await withChild('sleep', ['5'], (child) => {
    const id = getProcessIdentity(child.pid);
    assert.ok(id);
    assert.equal(matchesIdentity({ pid: child.pid, start: id.start }), true);
    assert.equal(matchesIdentity({ pid: child.pid, start: id.start, token: 'TOKEN123' }), false);
  });
});

test('signalGroup returns false for a dead group', () => {
  assert.equal(signalGroup(2147483646, 'SIGTERM'), false);
});

test('signalGroup throws RangeError for unsafe pgid values', () => {
  for (const bad of [0, 1, -5, NaN, '123', undefined]) {
    assert.throws(() => signalGroup(bad, 'SIGTERM'), RangeError, `pgid ${String(bad)}`);
  }
});

test('signalGroup signals a live detached group and returns true', async () => {
  const child = spawn('sleep', ['5'], { stdio: 'ignore', detached: true });
  try {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    assert.equal(signalGroup(child.pid, 'SIGTERM'), true);
    await exited;
    assert.equal(signalGroup(child.pid, 'SIGTERM'), false);
  } finally {
    child.kill('SIGKILL');
  }
});

test('matchesIdentity rejects empty or null token but allows undefined', () => {
  const id = getProcessIdentity(process.pid);
  assert.throws(() => matchesIdentity({ pid: process.pid, start: id.start, token: '' }), TypeError);
  assert.throws(() => matchesIdentity({ pid: process.pid, start: id.start, token: null }), TypeError);
  assert.equal(matchesIdentity({ pid: process.pid, start: id.start, token: undefined }), true);
});

// C1: identity must not depend on the time zone of the checking process.
function startInTz(pid, tz) {
  const procid = new URL('../src/procid.mjs', import.meta.url).href;
  const code = `import(${JSON.stringify(procid)}).then((m) => { const id = m.getProcessIdentity(${pid}); process.stdout.write(JSON.stringify(id)); });`;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
  return JSON.parse(out);
}

test('the same live pid has the same start under TZ=UTC and TZ=Asia/Tokyo', async () => {
  await withChild('sleep', ['5'], (child) => {
    const utc = startInTz(child.pid, 'UTC');
    const tokyo = startInTz(child.pid, 'Asia/Tokyo');
    assert.ok(utc && typeof utc.start === 'string' && utc.start.length > 0);
    assert.equal(tokyo.start, utc.start);
    assert.equal(matchesIdentity({ pid: child.pid, start: tokyo.start }), true);
    assert.equal(matchesIdentity({ pid: child.pid, start: utc.start }), true);
  });
});

// M1: a failing `ps` (fork failure) is not "no such process".
const psFailure = (props) => () => { throw Object.assign(new Error('ps failed'), props); };

test('getProcessIdentity: ps exit 1 with empty output means gone (null)', () => {
  assert.equal(getProcessIdentity(4242, { exec: psFailure({ status: 1, stdout: '' }) }), null);
});

test('getProcessIdentity: a ps spawn failure yields { unknown: true }', () => {
  for (const props of [{ code: 'EAGAIN' }, { code: 'ENOMEM' }, { status: 2, stdout: '' }, { signal: 'SIGKILL', status: null }]) {
    assert.deepEqual(getProcessIdentity(4242, { exec: psFailure(props) }), { pid: 4242, unknown: true }, JSON.stringify(props));
  }
});

test('an unknown sample never matches for signalling but counts as alive', () => {
  const exec = psFailure({ code: 'EAGAIN' });
  assert.equal(matchesIdentity({ pid: 4242, start: 'x', token: 'tok' }, { exec }), false);
  assert.equal(identityAlive({ pid: 4242, start: 'x', token: 'tok' }, { exec }), true);
  assert.equal(identityAlive({ pid: 4242, start: 'x' }, { exec: psFailure({ status: 1, stdout: '' }) }), false);
});

test('identityAlive is matchesIdentity for a definite sample', async () => {
  await withChild('sleep', ['5'], (child) => {
    const id = getProcessIdentity(child.pid);
    assert.equal(identityAlive({ pid: child.pid, start: id.start }), true);
    assert.equal(identityAlive({ pid: child.pid, start: id.start + 'x' }), false);
  });
});

test('ps runs without width truncation of the command', async () => {
  const long = 'L'.repeat(3000);
  await withChild('node', ['-e', 'setTimeout(()=>{},5000)', long, 'TAILTOKEN'], (child) => {
    const id = getProcessIdentity(child.pid);
    assert.ok(id.command.includes('TAILTOKEN'));
  });
});

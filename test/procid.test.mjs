import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getProcessIdentity, matchesIdentity, signalGroup } from '../src/procid.mjs';

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

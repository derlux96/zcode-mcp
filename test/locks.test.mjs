import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, readdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquireCwdLock, releaseCwdLock, lockKey } from '../src/locks.mjs';
import { stateHome } from '../src/jobstore.mjs';

const LOCKS_MODULE = new URL('../src/locks.mjs', import.meta.url).href;

function withEnv(fn) {
  return async () => {
    const prev = process.env.ZCODE_MCP_HOME;
    const root = mkdtempSync(join(tmpdir(), 'locks-'));
    process.env.ZCODE_MCP_HOME = join(root, 'state');
    try {
      await fn(root);
    } finally {
      if (prev === undefined) delete process.env.ZCODE_MCP_HOME; else process.env.ZCODE_MCP_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const locksDir = () => join(stateHome(), 'locks');
const never = () => false;
const always = () => true;

test('second acquire in the same directory is rejected with blockingJobId', withEnv((root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  assert.deepEqual(acquireCwdLock(dir, 'job_a', always), { ok: true });
  assert.deepEqual(acquireCwdLock(dir, 'job_b', always), { ok: false, blockingJobId: 'job_a' });
  const data = JSON.parse(readFileSync(join(locksDir(), `${lockKey(dir)}.lock`), 'utf8'));
  assert.equal(data.jobId, 'job_a');
  assert.equal(data.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(data.createdAt)));
}));

test('symlinked path with spaces maps to the same lock key', withEnv((root) => {
  const real = join(root, 'my project dir');
  mkdirSync(real);
  const link = join(root, 'link to dir');
  symlinkSync(real, link);
  assert.equal(lockKey(link), lockKey(realpathSync(real)));
  assert.equal(lockKey(link), lockKey(real));
  assert.match(lockKey(link), /^[0-9a-f]{40}$/);
  assert.equal(acquireCwdLock(link, 'job_a', always).ok, true);
  assert.deepEqual(acquireCwdLock(real, 'job_b', always), { ok: false, blockingJobId: 'job_a' });
}));

test('lock of a dead job is replaced', withEnv((root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  acquireCwdLock(dir, 'job_dead', always);
  assert.deepEqual(acquireCwdLock(dir, 'job_new', (id) => id !== 'job_dead'), { ok: true });
  assert.deepEqual(acquireCwdLock(dir, 'job_x', always), { ok: false, blockingJobId: 'job_new' });
  assert.deepEqual(readdirSync(locksDir()), [`${lockKey(dir)}.lock`]);
}));

test('corrupt lock: young counts as held, old counts as stale', withEnv((root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  mkdirSync(locksDir(), { recursive: true });
  const file = join(locksDir(), `${lockKey(dir)}.lock`);
  writeFileSync(file, '');
  assert.deepEqual(acquireCwdLock(dir, 'job_a', never), { ok: false, blockingJobId: 'unknown' });
  const old = new Date(Date.now() - 10_000);
  utimesSync(file, old, old);
  assert.deepEqual(acquireCwdLock(dir, 'job_a', never), { ok: true });
}));

test('release with a foreign jobId changes nothing; own jobId frees the lock', withEnv((root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  acquireCwdLock(dir, 'job_a', always);
  releaseCwdLock(dir, 'job_other');
  assert.deepEqual(acquireCwdLock(dir, 'job_b', always), { ok: false, blockingJobId: 'job_a' });
  releaseCwdLock(dir, 'job_a');
  releaseCwdLock(dir, 'job_a'); // idempotent
  assert.deepEqual(acquireCwdLock(dir, 'job_b', always), { ok: true });
}));

// Spawns n children that wait for a barrier file and then call acquireCwdLock at once.
async function raceChildren(dir, n, isAliveSrc) {
  const barrier = join(dir, '..', 'barrier');
  const code = `
    import { existsSync } from 'node:fs';
    import { acquireCwdLock } from ${JSON.stringify(LOCKS_MODULE)};
    const [dir, barrier, id] = process.argv.slice(1);
    process.stdout.write('ready\\n');
    while (!existsSync(barrier)) {}
    const isAlive = ${isAliveSrc};
    process.stdout.write(JSON.stringify(acquireCwdLock(dir, id, isAlive)));
  `;
  const kids = [];
  for (let i = 0; i < n; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir, barrier, `job_${i}`], {
      env: process.env, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    let ready;
    const readyP = new Promise((r) => { ready = r; });
    child.stdout.on('data', (d) => { out += d; if (out.includes('ready\n')) ready(); });
    const done = new Promise((r) => child.on('close', () => r(out.replace('ready\n', ''))));
    kids.push({ readyP, done });
  }
  await Promise.all(kids.map((k) => k.readyP));
  writeFileSync(barrier, '');
  return (await Promise.all(kids.map((k) => k.done))).map((o) => JSON.parse(o));
}

test('race on a fresh lock: exactly one of several processes wins', withEnv(async (root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  const results = await raceChildren(dir, 4, '() => true');
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.match(r.blockingJobId, /^job_\d$/);
  assert.deepEqual(readdirSync(locksDir()), [`${lockKey(dir)}.lock`]);
}));

test('race on a stale lock: exactly one of several processes wins', withEnv(async (root) => {
  const dir = join(root, 'proj');
  mkdirSync(dir);
  acquireCwdLock(dir, 'job_dead', always);
  // Only the pre-existing job_dead is dead; the winner's job_N counts as alive for the losers.
  const results = await raceChildren(dir, 4, "(id) => id !== 'job_dead'");
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.deepEqual(readdirSync(locksDir()), [`${lockKey(dir)}.lock`]);
}));

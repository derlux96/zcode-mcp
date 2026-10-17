import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stateHome, jobsRoot, newJobId, createJobDir, writeJsonAtomic, readJson,
  readStatus, patchStatus, readResult, writeResult, listJobDirs, TERMINAL_STATES,
} from '../src/jobstore.mjs';

function withHome(fn) {
  return async () => {
    const prev = { Z: process.env.ZCODE_MCP_HOME, H: process.env.HOME };
    const home = mkdtempSync(join(tmpdir(), 'jobstore-'));
    process.env.ZCODE_MCP_HOME = join(home, 'state');
    try {
      await fn(home);
    } finally {
      try { chmodSync(home, 0o700); } catch {}
      if (prev.Z === undefined) delete process.env.ZCODE_MCP_HOME; else process.env.ZCODE_MCP_HOME = prev.Z;
      if (prev.H === undefined) delete process.env.HOME; else process.env.HOME = prev.H;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test('stateHome honors ZCODE_MCP_HOME, falls back to $HOME/.zcode-mcp', withHome((home) => {
  assert.equal(stateHome(), join(home, 'state'));
  assert.equal(jobsRoot(), join(home, 'state', 'jobs'));
  delete process.env.ZCODE_MCP_HOME;
  process.env.HOME = home;
  assert.equal(stateHome(), join(home, '.zcode-mcp'));
}));

test('newJobId matches pattern and TERMINAL_STATES is fixed', () => {
  assert.match(newJobId(), /^job_[0-9a-z]+_[0-9a-f]{6}$/);
  assert.notEqual(newJobId(), newJobId());
  assert.deepEqual(TERMINAL_STATES, ['completed', 'failed', 'timeout', 'cancelled', 'lost']);
});

test('createJobDir makes 0700 dir and 0600 job.json', withHome(() => {
  const { jobId, dir, token } = createJobDir({ params: { a: 1 }, path: '/x' });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(jobsRoot()).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'job.json')).mode & 0o777, 0o600);
  assert.match(token, /^[0-9a-f]{32}$/);
  const job = readJson(join(dir, 'job.json'));
  assert.equal(job.jobId, jobId);
  assert.equal(job.token, token);
  assert.deepEqual(job.params, { a: 1 });
  assert.equal(job.path, '/x');
  assert.ok(!Number.isNaN(Date.parse(job.createdAt)));
}));

test('writeJsonAtomic overwrites and leaves no tmp file', withHome((home) => {
  const file = join(home, 'a.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(readJson(file), { v: 2 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home).filter((n) => n.includes('tmp')), []);
  assert.equal(readdirSync(home).includes('a.json'), true);
}));

test('readJson returns null for missing or corrupt files', withHome((home) => {
  assert.equal(readJson(join(home, 'nope.json')), null);
  writeFileSync(join(home, 'bad.json'), '{"a":');
  assert.equal(readJson(join(home, 'bad.json')), null);
}));

test('patchStatus merges fields and sets updatedAt; result roundtrips', withHome(() => {
  const { dir } = createJobDir({});
  assert.equal(readStatus(dir), null);
  const a = patchStatus(dir, { state: 'running', pid: 5 });
  assert.equal(a.state, 'running');
  assert.ok(!Number.isNaN(Date.parse(a.updatedAt)));
  const b = patchStatus(dir, { state: 'completed' });
  assert.deepEqual({ state: b.state, pid: b.pid }, { state: 'completed', pid: 5 });
  assert.deepEqual(readStatus(dir), b);
  assert.equal(readResult(dir), null);
  writeResult(dir, { ok: true });
  assert.deepEqual(readResult(dir), { ok: true });
}));

test('createJobDir throws not-writable for a read-only home', {
  skip: process.getuid && process.getuid() === 0 ? 'running as root: chmod cannot block writes' : false,
}, withHome((home) => {
  chmodSync(home, 0o500);
  assert.throws(() => createJobDir({}), (e) => e.code === 'not-writable');
}));

test('listJobDirs returns existing job dirs oldest first', withHome(() => {
  assert.deepEqual(listJobDirs(), []);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(createJobDir({}).dir);
  const listed = listJobDirs();
  assert.equal(listed.length, 3);
  assert.deepEqual(new Set(listed), new Set(ids));
  const times = listed.map((d) => d.split('/').pop().split('_')[1]);
  const sorted = [...times].sort((x, y) => (x.length - y.length) || (x < y ? -1 : x > y ? 1 : 0));
  assert.deepEqual(times, sorted);
  // Explicit ordering: shorter (older) base36 time sorts before longer one.
  mkdirSync(join(jobsRoot(), 'job_zz_aaaaaa'));
  mkdirSync(join(jobsRoot(), 'job_100_aaaaaa'));
  const tail = listJobDirs().map((d) => d.split('/').pop());
  assert.ok(tail.indexOf('job_zz_aaaaaa') < tail.indexOf('job_100_aaaaaa'));
}));

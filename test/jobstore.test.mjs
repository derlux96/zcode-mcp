import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stateHome, jobsRoot, newJobId, createJobDir, writeJsonAtomic, readJson,
  readStatus, patchStatus, readResult, writeResult, listJobDirs, TERMINAL_STATES,
  isJobId, jobDir, ensurePrivateDir, compareJobIds,
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

test('ensurePrivateDir only removes group/other bits and never adds owner bits', withHome((home) => {
  const mode = (d) => statSync(d).mode & 0o777;
  const cases = [[0o755, 0o700], [0o770, 0o700], [0o750, 0o700], [0o555, 0o500], [0o500, 0o500], [0o700, 0o700]];
  for (const [before, after] of cases) {
    const d = join(home, `d-${before.toString(8)}`);
    mkdirSync(d);
    chmodSync(d, before);
    ensurePrivateDir(d);
    assert.equal(mode(d).toString(8), after.toString(8), `${before.toString(8)} -> ${after.toString(8)}`);
    chmodSync(d, 0o700);
  }
  const fresh = join(home, 'new', 'deeper');
  ensurePrivateDir(fresh);
  assert.equal(mode(fresh).toString(8), '700');
}));

test('an existing read-only state home stays read-only: createJobDir throws not-writable and creates nothing', {
  skip: process.getuid && process.getuid() === 0 ? 'running as root: chmod cannot block writes' : false,
}, withHome((home) => {
  const state = join(home, 'state');
  mkdirSync(state);
  chmodSync(state, 0o500);
  assert.throws(() => createJobDir({}), (e) => e.code === 'not-writable');
  assert.equal((statSync(state).mode & 0o777).toString(8), '500', 'the directory permission was left alone');
  chmodSync(state, 0o700);
  assert.deepEqual(readdirSync(state), [], 'nothing was created inside');
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

test('isJobId accepts generated ids and rejects traversal and malformed ids', () => {
  assert.equal(isJobId(newJobId()), true);
  for (const bad of ['', '../x', 'job_', 'job_abc_12345', 'job_abc_12345g', 'job_ABC_123456', 'job_abc_123456/..', 'x/job_abc_123456', null, 42, undefined]) {
    assert.equal(isJobId(bad), false, String(bad));
  }
});

test('jobDir maps valid ids into the jobs root and returns null otherwise', withHome((home) => {
  const id = newJobId();
  assert.equal(jobDir(id), join(home, 'state', 'jobs', id));
  assert.equal(jobDir('../x'), null);
  assert.equal(jobDir(''), null);
}));

// M5: an existing state home and jobs/locks dirs owned by the user are tightened to 0700.
test('createJobDir tightens existing home and jobs dirs to 0700', withHome(() => {
  mkdirSync(jobsRoot(), { recursive: true, mode: 0o755 });
  chmodSync(stateHome(), 0o755);
  chmodSync(jobsRoot(), 0o755);
  const { dir } = createJobDir({});
  for (const d of [stateHome(), jobsRoot(), dir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
}));

test('STOP_GRACE_MS lives in jobstore; jobs.mjs does not import job-runner.mjs (no cycle)', async () => {
  const store = await import('../src/jobstore.mjs');
  const runner = await import('../src/job-runner.mjs');
  assert.equal(store.STOP_GRACE_MS, 10000);
  assert.equal(runner.STOP_GRACE_MS, store.STOP_GRACE_MS);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/jobs.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/job-runner\.mjs'/);
});

test('listJobDirs orders ids with the same time by their random part, malformed ids first', withHome(() => {
  ensurePrivateDir(jobsRoot());
  for (const n of ['job_k_00000f', 'job_k_0000a0', 'job_k_000001', 'job_', 'job_k_00000f2']) mkdirSync(join(jobsRoot(), n));
  assert.deepEqual(listJobDirs().map((d) => d.split('/').pop()), ['job_', 'job_k_000001', 'job_k_00000f', 'job_k_00000f2', 'job_k_0000a0']);
}));

test('compareJobIds: time first, then the random part; equal ids compare 0', () => {
  assert.ok(compareJobIds('job_zz_ffffff', 'job_100_000000') < 0);
  assert.ok(compareJobIds('job_k_000001', 'job_k_00000f') < 0);
  assert.ok(compareJobIds('job_k_00000f', 'job_k_000001') > 0);
  assert.equal(compareJobIds('job_k_00000f', 'job_k_00000f'), 0);
  assert.ok(compareJobIds('job_', 'job_1_000000') < 0);
  assert.ok(compareJobIds('job__zzzzzz', 'job_1_000000') < 0);
  assert.equal(compareJobIds('job_', 'job_x'), compareJobIds('job_', 'job_x'));
});

test('writeJsonAtomic removes its temp file when the rename fails', withHome((home) => {
  const target = join(home, 'is-a-dir');
  mkdirSync(join(target, 'child'), { recursive: true });
  assert.throws(() => writeJsonAtomic(target, { a: 1 }));
  assert.deepEqual(readdirSync(home).filter((n) => n.endsWith('.tmp')), []);
}));

test('ensurePrivateDir leaves a directory owned by someone else alone', {
  skip: process.getuid?.() !== 0 && 'needs root to create a foreign-owned directory',
}, withHome((home) => {
  const d = join(home, 'foreign');
  mkdirSync(d, { mode: 0o755 });
  chmodSync(d, 0o755);
  chownSync(d, 65534, 65534);
  ensurePrivateDir(d);
  assert.equal(statSync(d).mode & 0o777, 0o755);
}));

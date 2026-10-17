import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, defaultStatePath } from '../src/state.mjs';

const entry = (over = {}) => ({
  id: 'sess_abc123',
  kind: 'session',
  cwd: '/tmp/proj',
  mode: 'yolo',
  promptPreview: 'write tests',
  startedAt: '2026-10-16T10:00:00.000Z',
  status: 'completed',
  ...over,
});

test('defaultStatePath points into ~/.zcode-mcp', () => {
  assert.match(defaultStatePath(), /\.zcode-mcp\/sessions\.json$/);
});

test('append persists entries and list reads them back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'sessions.json'));
  store.append(entry());
  store.append(entry({ id: 'sess_def456', cwd: '/tmp/other' }));
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ cwd: '/tmp/other' })[0].id, 'sess_def456');
  rmSync(dir, { recursive: true, force: true });
});

test('state file is created with 0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const file = join(dir, 'sessions.json');
  const store = new SessionStore(file);
  store.append(entry());
  // 0o600 & 0o777 masks the permission bits on all platforms we support
  assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test('corrupt or missing state file yields empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'nope.json'));
  assert.deepEqual(store.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('keeps only the 200 newest entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'sessions.json'));
  for (let i = 0; i < 205; i++) store.append(entry({ id: `sess_${i}` }));
  const all = store.list();
  assert.equal(all.length, 200);
  assert.equal(all[0].id, 'sess_5');
  assert.equal(all[199].id, 'sess_204');
  rmSync(dir, { recursive: true, force: true });
});

const STATE_URL = new URL('../src/state.mjs', import.meta.url).href;

function runAppenders(file, procs, per) {
  const barrier = Date.now() + 600;
  const code = `
    import { SessionStore } from ${JSON.stringify(STATE_URL)};
    const [file, w, per, at] = process.argv.slice(1);
    while (Date.now() < Number(at)) {}
    const s = new SessionStore(file);
    for (let i = 0; i < Number(per); i++) s.append({ id: 'p' + w + '_' + i, cwd: '/x' });
  `;
  return Array.from({ length: procs }, (_, w) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code, file, String(w), String(per), String(barrier)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(err || `exit ${status}`))));
  }));
}

test('eight processes appending concurrently lose no entry; readers never see a partial file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const file = join(dir, 'sessions.json');
  let done = false;
  const all = Promise.all(runAppenders(file, 8, 10)).finally(() => { done = true; });
  let snapshots = 0;
  while (!done) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { text = null; }
    if (text !== null) { assert.ok(Array.isArray(JSON.parse(text))); snapshots++; }
    await new Promise((r) => setTimeout(r, 2));
  }
  await all;
  const ids = new SessionStore(file).list().map((e) => e.id);
  assert.equal(ids.length, 80);
  assert.equal(new Set(ids).size, 80);
  assert.ok(snapshots > 0);
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('same id replaces the earlier entry and moves to the end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'sessions.json'));
  store.append(entry({ id: 'a', status: 'running' }));
  store.append(entry({ id: 'b' }));
  store.append(entry({ id: 'a', status: 'completed' }));
  const all = store.list();
  assert.deepEqual(all.map((e) => e.id), ['b', 'a']);
  assert.equal(all[1].status, 'completed');
  rmSync(dir, { recursive: true, force: true });
});

test('an abandoned lock directory (20 s old) does not block append', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const file = join(dir, 'sessions.json');
  mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 20000);
  utimesSync(`${file}.lock`, old, old);
  new SessionStore(file).append(entry());
  assert.equal(new SessionStore(file).list().length, 1);
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('lock is released after an append that throws on write', { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const file = join(dir, 'sessions.json');
  const store = new SessionStore(file);
  store.append(entry());
  // lock dir can be created (parent writable) only if we make the file itself the obstacle:
  // replace the target by a directory so the atomic rename fails.
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => store.append(entry({ id: 'x' })));
  assert.equal(existsSync(`${file}.lock`), false);
  rmSync(file, { recursive: true });
  store.append(entry({ id: 'y' }));
  assert.equal(store.list().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('defaultStatePath follows ZCODE_MCP_HOME', () => {
  const prev = process.env.ZCODE_MCP_HOME;
  process.env.ZCODE_MCP_HOME = '/tmp/zcode-home-x';
  try {
    assert.equal(defaultStatePath(), '/tmp/zcode-home-x/sessions.json');
  } finally {
    if (prev === undefined) delete process.env.ZCODE_MCP_HOME; else process.env.ZCODE_MCP_HOME = prev;
  }
});

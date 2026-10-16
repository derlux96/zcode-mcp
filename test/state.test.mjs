import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
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

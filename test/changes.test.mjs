import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureBaseline, changesSince } from '../src/changes.mjs';
import { makeGitRepo, makeTempDir, removeDir, run } from './helpers.mjs';

function withRepo(fn) {
  return async () => {
    const dir = makeGitRepo();
    try { await fn(dir); } finally { removeDir(dir); }
  };
}

test('pre-existing dirty file only counts once its content changes', withRepo((dir) => {
  writeFileSync(join(dir, 'README.md'), 'user edit\n');
  writeFileSync(join(dir, 'user-new.txt'), 'u\n');
  const base = captureBaseline(dir);
  assert.deepEqual(base.dirty.map((d) => d.path).sort(), ['README.md', 'user-new.txt']);
  const none = changesSince(dir, base);
  assert.equal(none.available, true);
  assert.deepEqual(none.changedFiles, []);
  assert.equal(none.diffStat, '');
  writeFileSync(join(dir, 'README.md'), 'job edit\n');
  const after = changesSince(dir, base);
  assert.deepEqual(after.changedFiles, ['M README.md']);
  assert.match(after.diffStat, /README\.md/);
}));

test('new untracked and modified tracked files appear', withRepo((dir) => {
  const base = captureBaseline(dir);
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  writeFileSync(join(dir, 'README.md'), 'changed\n');
  const r = changesSince(dir, base);
  assert.deepEqual([...r.changedFiles].sort(), ['?? new.txt', 'M README.md']);
  assert.match(r.diffStat, /README\.md/);
  assert.match(r.diffStat, /^\?\? new\.txt$/m);
}));

test('file deleted by the job and file reverted by the job appear', withRepo((dir) => {
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  run(dir, 'git', ['add', 'a.txt']);
  run(dir, 'git', ['commit', '-qm', 'a']);
  writeFileSync(join(dir, 'README.md'), 'user edit\n');
  const base = captureBaseline(dir);
  rmSync(join(dir, 'a.txt'));
  run(dir, 'git', ['checkout', '--', 'README.md']); // test setup simulating the job
  const r = changesSince(dir, base);
  assert.deepEqual(r.changedFiles.map((l) => l.split(' ')[1]).sort(), ['README.md', 'a.txt']);
}));

test('non-git directory is unavailable', () => {
  const dir = makeTempDir();
  try {
    assert.equal(captureBaseline(dir), null);
    assert.deepEqual(changesSince(dir, null), { available: false, changedFiles: [], diffStat: '' });
    assert.deepEqual(changesSince(dir, { gitRoot: dir, dirty: [] }), { available: false, changedFiles: [], diffStat: '' });
  } finally { removeDir(dir); }
});

test('spaces and unicode in paths, repo in a directory with a space, subdirectory cwd', () => {
  const outer = makeTempDir('zcode outer ');
  const dir = join(outer, 'my repo');
  try {
    mkdirSync(dir);
    run(dir, 'git', ['init', '-q']);
    run(dir, 'git', ['config', 'user.email', 't@e.com']);
    run(dir, 'git', ['config', 'user.name', 'T']);
    mkdirSync(join(dir, 'sub dir'));
    writeFileSync(join(dir, 'sub dir', 'ä file.txt'), '1\n');
    run(dir, 'git', ['add', '.']);
    run(dir, 'git', ['commit', '-qm', 'i']);
    const sub = join(dir, 'sub dir');
    const base = captureBaseline(sub);
    writeFileSync(join(dir, 'sub dir', 'ä file.txt'), '2\n');
    writeFileSync(join(dir, 'neü datei.txt'), 'x\n');
    const r = changesSince(sub, base);
    assert.deepEqual([...r.changedFiles].sort(), ['?? neü datei.txt', 'M sub dir/ä file.txt']);
    assert.match(r.diffStat, /ä file\.txt/);
  } finally { removeDir(outer); }
});

test('repository without any commit does not throw', () => {
  const dir = makeTempDir();
  try {
    run(dir, 'git', ['init', '-q']);
    const base = captureBaseline(dir);
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    const r = changesSince(dir, base);
    assert.equal(r.available, true);
    assert.deepEqual(r.changedFiles, ['?? x.txt']);
    assert.equal(r.diffStat, '?? x.txt');
  } finally { removeDir(dir); }
});

test('does not mutate the index or working tree', withRepo((dir) => {
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  const before = run(dir, 'git', ['status', '--porcelain']);
  changesSince(dir, captureBaseline(dir));
  assert.equal(run(dir, 'git', ['status', '--porcelain']), before);
}));

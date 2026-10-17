import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertGitRepo, createWorktree, worktreeSummary, newWorktreeSlug, removeWorktree } from '../src/runner.mjs';
import { makeTempDir, makeGitRepo, removeDir, run } from './helpers.mjs';

test('assertGitRepo passes in a repo and throws outside', async () => {
  const repo = makeGitRepo();
  const plain = makeTempDir();
  await assertGitRepo(repo);
  await assert.rejects(assertGitRepo(plain), /not a git/i);
  removeDir(repo);
  removeDir(plain);
});

test('newWorktreeSlug is timestamp + 6 hex chars', () => {
  assert.match(newWorktreeSlug(), /^[0-9a-z]+-[0-9a-f]{6}$/);
});

test('createWorktree makes branch, dir, startSha, and excludes .zcode-worktrees from git status', async () => {
  const repo = makeGitRepo();
  const { dir, branch, slug, startSha } = await createWorktree(repo);
  assert.match(branch, /^zcode\//);
  assert.ok(dir.includes(slug));
  assert.ok(existsSync(dir));
  assert.match(startSha, /^[0-9a-f]{7,64}$/); // starting commit for summary diffs
  assert.ok(existsSync(join(dir, 'README.md'))); // worktree checks out HEAD
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /\.zcode-worktrees\//);
  // idempotent: second call must not duplicate the exclude line
  await createWorktree(repo);
  const exclude2 = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal((exclude2.match(/\.zcode-worktrees\//g) || []).length, 1);
  removeDir(repo);
});

test('worktreeSummary reports diffStat and changed files', async () => {
  const repo = makeGitRepo();
  const { dir, startSha } = await createWorktree(repo);
  writeFileSync(join(dir, 'new-file.txt'), 'hello\n');
  const summary = await worktreeSummary(dir, startSha);
  assert.match(summary.diffStat, /new-file\.txt/);
  assert.deepEqual(summary.changedFiles, ['?? new-file.txt']);
  removeDir(repo);
});

test('worktreeSummary includes committed and staged work, not just the working tree', async () => {
  const repo = makeGitRepo();
  const { dir, startSha } = await createWorktree(repo);
  // committed change (the case plain `git diff --stat` misses entirely)
  writeFileSync(join(dir, 'README.md'), '# demo changed\n');
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-qm', 'x']);
  // staged new file (missed by working-tree-vs-index diff)
  writeFileSync(join(dir, 'staged.txt'), 'staged\n');
  run(dir, 'git', ['add', 'staged.txt']);
  const summary = await worktreeSummary(dir, startSha);
  assert.match(summary.diffStat, /README\.md/);
  assert.match(summary.diffStat, /staged\.txt/);
  removeDir(repo);
});

test('removeWorktree deletes the worktree directory and its branch', async () => {
  const repo = makeGitRepo();
  const branchesBefore = run(repo, 'git', ['branch', '--list']);
  const wt = await createWorktree(repo);
  await removeWorktree(repo, wt);
  assert.equal(existsSync(wt.dir), false);
  assert.equal(run(repo, 'git', ['branch', '--list']), branchesBefore);
  assert.equal(run(repo, 'git', ['worktree', 'list', '--porcelain']).includes(wt.dir), false);
  removeDir(repo);
});

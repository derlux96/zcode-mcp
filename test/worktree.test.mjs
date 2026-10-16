import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertGitRepo, createWorktree, worktreeSummary, newWorktreeSlug } from '../src/runner.mjs';
import { makeTempDir, makeGitRepo, removeDir } from './helpers.mjs';

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

test('createWorktree makes branch, dir, and excludes .zcode-worktrees from git status', async () => {
  const repo = makeGitRepo();
  const { dir, branch, slug } = await createWorktree(repo);
  assert.match(branch, /^zcode\//);
  assert.ok(dir.includes(slug));
  assert.ok(existsSync(dir));
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
  const { dir } = await createWorktree(repo);
  writeFileSync(join(dir, 'new-file.txt'), 'hello\n');
  const summary = await worktreeSummary(dir);
  assert.match(summary.diffStat, /new-file\.txt/);
  assert.deepEqual(summary.changedFiles, ['?? new-file.txt']);
  removeDir(repo);
});

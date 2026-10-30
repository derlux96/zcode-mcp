// Baseline-aware change reporting: report only what a job changed, not the
// user's pre-existing uncommitted work. Read-only with respect to the repo.
// Paths are repo-root-relative and the whole repo is reported regardless of cwd.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const UNAVAILABLE = () => ({ available: false, changedFiles: [], diffStat: '' });

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function findGitRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).replace(/\r?\n$/, '') || null;
  } catch {
    return null;
  }
}

/** Parses NUL-separated porcelain v1 output into { status, path } entries. */
function readStatus(gitRoot) {
  const parts = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], gitRoot).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    entries.push({ status: xy.trim(), path: rec.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++; // skip origin path
  }
  return entries;
}

function hashOf(gitRoot, path) {
  const full = join(gitRoot, path);
  try {
    lstatSync(full);
  } catch {
    return '<deleted>';
  }
  try {
    return git(['hash-object', '--', path], gitRoot).trim();
  } catch {
    return '<unreadable>';
  }
}

function headOf(gitRoot) {
  try {
    return git(['rev-parse', '-q', '--verify', 'HEAD'], gitRoot).trim() || null;
  } catch {
    return null;
  }
}

/** Files changed by commits made since `baseHead` (null: repo had no commit). */
function committedChanges(gitRoot, baseHead) {
  if (!baseHead) {
    return git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], gitRoot)
      .split('\0').filter(Boolean).map((path) => ({ status: 'A', path }));
  }
  const parts = git(['diff', '--name-status', '--no-renames', '-z', baseHead, 'HEAD'], gitRoot).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
  return out;
}

export function captureBaseline(cwd) {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  try {
    const dirty = readStatus(gitRoot).map((e) => ({ path: e.path, hash: hashOf(gitRoot, e.path) }));
    return { gitRoot, head: headOf(gitRoot), dirty };
  } catch {
    return null;
  }
}

export function changesSince(cwd, baseline) {
  if (!baseline?.gitRoot || !existsSync(baseline.gitRoot)) return UNAVAILABLE();
  const gitRoot = baseline.gitRoot;
  try {
    const before = new Map((baseline.dirty ?? []).map((d) => [d.path, d.hash]));
    const baseHead = baseline.head;
    const current = readStatus(gitRoot);
    const seen = new Set(current.map((e) => e.path));
    const merged = new Map();
    for (const e of current) {
      const h = hashOf(gitRoot, e.path);
      if (!before.has(e.path) || before.get(e.path) !== h) {
        merged.set(e.path, { status: h === '<deleted>' ? 'D' : e.status, path: e.path });
      }
    }
    // Dirty before the job, clean now (reverted/committed) but content differs from baseline.
    for (const [path, hash] of before) {
      const h = hashOf(gitRoot, path);
      if (!seen.has(path) && h !== hash) merged.set(path, { status: h === '<deleted>' ? 'D' : 'M', path });
    }
    // The job may have committed its work: the tree is then clean again.
    const headNow = headOf(gitRoot);
    if (headNow && headNow !== baseHead) {
      for (const c of committedChanges(gitRoot, baseHead)) {
        const w = merged.get(c.path);
        if (!w || (w.status !== 'D' && w.status !== '??')) merged.set(c.path, c);
      }
    }
    const changed = [...merged.values()];
    const changedFiles = changed.map((e) => `${e.status} ${e.path}`);
    const tracked = changed.filter((e) => e.status !== '??').map((e) => e.path);
    // Stat against the baseline HEAD covers committed + uncommitted tracked
    // changes. Without a baseline commit it stays simple: untracked lines only.
    let stat = '';
    if (tracked.length && baseHead) {
      stat = git(['-c', 'core.quotepath=false', '--literal-pathspecs', 'diff', '--stat', baseHead, '--', ...tracked], gitRoot).trim();
    }
    const untracked = changedFiles.filter((l) => l.startsWith('?? '));
    return { available: true, changedFiles, diffStat: [stat, ...untracked].filter(Boolean).join('\n') };
  } catch {
    return UNAVAILABLE();
  }
}

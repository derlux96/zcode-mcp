// Baseline-aware change reporting: report only what a job changed, not the
// user's pre-existing uncommitted work. Read-only with respect to the repo.
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

export function captureBaseline(cwd) {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  try {
    const dirty = readStatus(gitRoot).map((e) => ({ path: e.path, hash: hashOf(gitRoot, e.path) }));
    return { gitRoot, dirty };
  } catch {
    return null;
  }
}

export function changesSince(cwd, baseline) {
  const gitRoot = baseline?.gitRoot && existsSync(baseline.gitRoot) ? baseline.gitRoot : findGitRoot(cwd);
  if (!gitRoot || !baseline) return UNAVAILABLE();
  try {
    const before = new Map((baseline.dirty ?? []).map((d) => [d.path, d.hash]));
    const current = readStatus(gitRoot);
    const seen = new Set(current.map((e) => e.path));
    const changed = current.filter((e) => !before.has(e.path) || before.get(e.path) !== hashOf(gitRoot, e.path));
    // Dirty before the job, clean now (reverted/committed) but content differs from baseline.
    for (const [path, hash] of before) {
      if (!seen.has(path) && hashOf(gitRoot, path) !== hash) changed.push({ status: 'M', path });
    }
    const changedFiles = changed.map((e) => `${e.status} ${e.path}`);
    const tracked = changed.filter((e) => e.status !== '??').map((e) => e.path);
    let stat = '';
    if (tracked.length) {
      try {
        git(['rev-parse', '--verify', '-q', 'HEAD'], gitRoot);
        stat = git(['-c', 'core.quotepath=false', '--literal-pathspecs', 'diff', '--stat', 'HEAD', '--', ...tracked], gitRoot).trim();
      } catch {
        stat = ''; // no commit yet
      }
    }
    const untracked = changedFiles.filter((l) => l.startsWith('?? '));
    return { available: true, changedFiles, diffStat: [stat, ...untracked].filter(Boolean).join('\n') };
  } catch {
    return UNAVAILABLE();
  }
}

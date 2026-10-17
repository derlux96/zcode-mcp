import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function makeTempDir(prefix = 'zcode-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Creates a real git repo with one committed file; returns the path. */
export function makeGitRepo() {
  const dir = makeTempDir('zcode-repo-');
  run(dir, 'git', ['init', '-q']);
  run(dir, 'git', ['config', 'user.email', 'test@example.com']);
  run(dir, 'git', ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-qm', 'init']);
  return dir;
}

export function run(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

export const fakeBin = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url));

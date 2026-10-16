import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const OUTPUT_CAP = 100000;
export const DEFAULT_TIMEOUT_MS = 600000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 3600000;
export const MODES = ['plan', 'build', 'edit', 'yolo'];

const SESSION_RE = /sess_[A-Za-z0-9._-]+/;
const NODE_SCRIPT_RE = /\.(?:c|m)?js$/;

export function validateRunArgs(args = {}) {
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt must be a non-empty string' };
  }
  const cwd = args.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return { ok: false, error: 'cwd must be an absolute path' };
  }
  let isDir;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    return { ok: false, error: `cwd does not exist: ${cwd}` };
  }
  if (!isDir) return { ok: false, error: `cwd is not a directory: ${cwd}` };

  const mode = args.mode === undefined ? 'yolo' : args.mode;
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${MODES.join('|')}` };
  }
  if (args.resume !== undefined && typeof args.resume !== 'string') {
    return { ok: false, error: 'resume must be a string session id' };
  }
  if (args.target !== undefined && typeof args.target !== 'string') {
    return { ok: false, error: 'target must be a string' };
  }
  const timeoutMs = args.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : args.timeout_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, error: `timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
  }
  if (args.isolate_worktree !== undefined && typeof args.isolate_worktree !== 'boolean') {
    return { ok: false, error: 'isolate_worktree must be a boolean' };
  }
  return {
    ok: true,
    value: {
      prompt,
      cwd,
      mode,
      resume: args.resume,
      target: args.target,
      timeoutMs,
      isolateWorktree: args.isolate_worktree === true,
    },
  };
}

function cap(text) {
  if (text.length <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]`;
}

function extractSessionId(text) {
  const m = text.match(SESSION_RE);
  return m ? m[0] : null;
}

export async function runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const isNodeScript = NODE_SCRIPT_RE.test(binPath);
  const child = isNodeScript
    ? spawn(process.execPath, [binPath, ...cliArgs], { cwd })
    : spawn(binPath, cliArgs, { cwd });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      stderr += `\n[zcode-delegate] failed to spawn: ${err.message}`;
      resolve({ stdout: cap(stdout), stderr: cap(stderr), code: null, timedOut, sessionId: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: cap(stdout),
        stderr: cap(stderr),
        code,
        timedOut,
        sessionId: extractSessionId(stdout),
      });
    });
  });
}

export async function runZCodeTask({ binPath, prompt, cwd, mode = 'yolo', resume, target, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const cliArgs = ['-p', prompt, '--cwd', cwd, '--mode', mode, '--json'];
  if (resume) cliArgs.push('--resume', resume);
  if (target) cliArgs.push('--target', target);
  return runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs });
}

export function newRunId() {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

const run = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed: ${err || out}`))));
  });

export function newWorktreeSlug() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export async function assertGitRepo(cwd) {
  const out = await run(['rev-parse', '--is-inside-work-tree'], cwd);
  if (out.trim() !== 'true') throw new Error(`${cwd} is not a git work tree`);
}

export async function createWorktree(cwd) {
  const slug = newWorktreeSlug();
  const branch = `zcode/${slug}`;
  const dir = join(cwd, '.zcode-worktrees', slug);
  // Write the exclude entry before any git mutation: non-standard .git
  // layouts (subdirectory cwd, linked worktrees) fail cleanly here, before
  // the branch or worktree exists (Controller Ruling 7).
  const excludePath = join(cwd, '.git', 'info', 'exclude');
  let exclude = '';
  try {
    exclude = readFileSync(excludePath, 'utf8');
  } catch {
    // no exclude file yet — create it below
  }
  if (!exclude.includes('.zcode-worktrees/')) {
    appendFileSync(excludePath, `${exclude.endsWith('\n') || exclude === '' ? '' : '\n'}.zcode-worktrees/\n`);
  }
  await run(['worktree', 'add', '-b', branch, dir], cwd);
  return { dir, branch, slug };
}

export async function worktreeSummary(dir) {
  const diffStat = (await run(['diff', '--stat'], dir)).trim();
  const status = await run(['status', '--porcelain'], dir);
  const changedFiles = status.split('\n').map((l) => l.trim()).filter(Boolean);
  // git diff --stat never lists untracked files; surface them so new files
  // created in the worktree appear in the summary.
  const untracked = changedFiles.filter((l) => l.startsWith('??'));
  return { diffStat: [diffStat, ...untracked].filter(Boolean).join('\n'), changedFiles };
}

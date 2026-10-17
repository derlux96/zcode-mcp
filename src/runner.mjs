import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export const OUTPUT_CAP = 100000;
// timeout_ms is the absolute cap for a whole task; idle_timeout_ms aborts only
// when ZCode has been silent that long, so long but active tasks keep running.
export const DEFAULT_TIMEOUT_MS = 3600000;
export const DEFAULT_IDLE_TIMEOUT_MS = 600000;
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
  // Optional here; the caller decides whether the path supports it (model mode).
  const idleTimeoutMs = args.idle_timeout_ms;
  if (idleTimeoutMs !== undefined && (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < MIN_TIMEOUT_MS || idleTimeoutMs > MAX_TIMEOUT_MS)) {
    return { ok: false, error: `idle_timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
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
      idleTimeoutMs,
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

// The macOS app bundle's zcode.cjs cannot find its builtin provider config
// (sibling directory config/provider/zcode-builtin.json) when spawned from a
// fresh shell — its own lookup resolves to a nonexistent system path. Shells
// launched by the ZCode app inherit ZCODE_BUILTIN_PROVIDER_CONFIG_FILE; MCP
// clients spawning this server do not, so inject the sibling config here.
// Exported for reuse by src/appserver.mjs (mode B spawns the same binary as
// an app-server child): one source of truth for the env handling.
//
// The app-server's provider registry bootstrap requires BOTH config paths or
// NEITHER (a lone ZCODE_BUILTIN_PROVIDER_CONFIG_FILE makes registry creation
// throw "ZCode Built-in missing", leaving mode B without a model catalog).
// So whenever a builtin config is in play, complete the pair with the user's
// personal provider config default.
export function buildSpawnEnv(binPath) {
  const env = { ...process.env };
  if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    const candidate = resolve(dirname(binPath), '../config/provider/zcode-builtin.json');
    if (existsSync(candidate)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = candidate;
  }
  if (env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && !env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    // Read HOME from the env (not os.homedir(), which Node caches per process)
    // so the path follows test-time HOME redirection.
    const home = env.HOME || homedir();
    const candidate = join(home, '.zcode', 'v2', 'provider_config.json');
    if (existsSync(candidate)) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = candidate;
  }
  return env;
}

// Idle detection only works on a stream that carries progress. The CLI path
// (`--json`) writes nothing until the task ends, so it has no idle timer and
// relies on the absolute timeout alone.
export async function runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs }) {
  const isNodeScript = NODE_SCRIPT_RE.test(binPath);
  const env = buildSpawnEnv(binPath);
  const child = isNodeScript
    ? spawn(process.execPath, [binPath, ...cliArgs], { cwd, env })
    : spawn(binPath, cliArgs, { cwd, env });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutKind = null; // 'total' | 'idle'
    let killTimer = null;
    let idleTimer = null;

    const stop = (kind) => {
      if (timedOut) return;
      timedOut = true;
      timeoutKind = kind;
      clearTimeout(idleTimer);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    // Any output from ZCode counts as activity and restarts the idle timer.
    const touch = () => {
      if (!idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('idle'), idleTimeoutMs);
    };
    const timer = setTimeout(() => stop('total'), timeoutMs);
    touch();

    child.stdout.on('data', (d) => { stdout += d; touch(); });
    child.stderr.on('data', (d) => { stderr += d; touch(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      stderr += `\n[zcode-delegate] failed to spawn: ${err.message}`;
      resolve({ stdout: cap(stdout), stderr: cap(stderr), code: null, timedOut, timeoutKind, sessionId: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: cap(stdout),
        stderr: cap(stderr),
        code,
        timedOut,
        timeoutKind,
        sessionId: extractSessionId(stdout),
      });
    });
  });
}

export async function runZCodeTask({ binPath, prompt, cwd, mode = 'yolo', resume, target, timeoutMs = DEFAULT_TIMEOUT_MS, idleTimeoutMs }) {
  const cliArgs = ['-p', prompt, '--cwd', cwd, '--mode', mode, '--json'];
  if (resume) cliArgs.push('--resume', resume);
  if (target) cliArgs.push('--target', target);
  return runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs, idleTimeoutMs });
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
  // Starting commit: worktreeSummary diffs against it, so committed and
  // staged work (ZCode is expected to commit during tasks) is not missed.
  const startSha = (await run(['rev-parse', 'HEAD'], cwd)).trim();
  return { dir, branch, slug, startSha };
}

export async function worktreeSummary(dir, startSha) {
  // Diff against the worktree's starting commit: `git diff --stat` with no
  // ref is working-tree-vs-index, so staged and committed files would
  // vanish. One ref diff covers committed + staged + unstaged.
  const diffStat = (await run(startSha ? ['diff', '--stat', startSha] : ['diff', '--stat'], dir)).trim();
  const status = await run(['status', '--porcelain'], dir);
  const changedFiles = status.split('\n').map((l) => l.trim()).filter(Boolean);
  // git diff --stat never lists untracked files; surface them so new files
  // created in the worktree appear in the summary.
  const untracked = changedFiles.filter((l) => l.startsWith('??'));
  return { diffStat: [diffStat, ...untracked].filter(Boolean).join('\n'), changedFiles };
}

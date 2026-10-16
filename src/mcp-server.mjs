#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createProtocol, PARSE_ERROR } from './protocol.mjs';
import { discoverZCode, ZCodeNotFoundError } from './discover.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  assertGitRepo, createWorktree, worktreeSummary, newRunId,
  MODES, DEFAULT_TIMEOUT_MS, OUTPUT_CAP,
} from './runner.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const failText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const toolSchemas = {
  zcode_check: {
    name: 'zcode_check',
    description:
      'Verify that a ZCode installation is reachable: binary path, version, and a best-effort health check. Call this once before the first delegation on a machine.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  zcode_run: {
    name: 'zcode_run',
    description:
      'Delegate one coding task to ZCode via its official headless CLI. ZCode runs as a full agent (it can read/edit files and run commands in cwd). Inspect the returned output, changed files, and test results before accepting the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed task specification: goal, files, edge cases, tests, definition of done.' },
        cwd: { type: 'string', description: 'Absolute path of the project directory the task runs in.' },
        mode: { type: 'string', enum: MODES, description: 'Permission mode: plan (read-only plan first), build, edit, yolo (autonomous, default).' },
        resume: { type: 'string', description: 'Existing ZCode session id (sess_...) to continue a previous conversation. Server run-ids (run_...) are not resumable.' },
        target: { type: 'string', description: 'Optional session goal passed to ZCode (--target).' },
        timeout_ms: { type: 'integer', description: `Task timeout in milliseconds (${DEFAULT_TIMEOUT_MS} default, max 3600000).` },
        isolate_worktree: { type: 'boolean', description: 'Run the task in an isolated git worktree on a new zcode/<slug> branch. The worktree is kept; you must merge or remove it explicitly.' },
      },
      required: ['prompt', 'cwd'],
      additionalProperties: false,
    },
  },
  zcode_sessions: {
    name: 'zcode_sessions',
    description:
      'List sessions that ran through this server (id, status, mode, cwd, prompt preview). Use a sess_... id with zcode_run/resume to continue multi-iteration work; run_... ids are not resumable.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Optional absolute path to filter sessions by project directory.' } },
      additionalProperties: false,
    },
  },
};

function buildCheckHandler() {
  return async () => {
    let binPath;
    try {
      binPath = discoverZCode();
    } catch (error) {
      if (error instanceof ZCodeNotFoundError) {
        return failText(`${JSON.stringify({ ok: false, problem: 'binary-not-found', checked: error.checked }, null, 2)}\nInstall ZCode or set ZCODE_BIN, then retry.`);
      }
      throw error;
    }
    const version = await runZCodeArgs(binPath, ['version'], { cwd: process.cwd(), timeoutMs: 15000 });
    let doctor = null;
    try {
      const d = await runZCodeArgs(binPath, ['doctor'], { cwd: process.cwd(), timeoutMs: 15000 });
      doctor = { ok: d.code === 0, excerpt: d.stdout.trim().slice(-500) };
    } catch (e) {
      doctor = { ok: false, excerpt: String(e.message).slice(0, 500) };
    }
    const ok = version.code === 0;
    return text(JSON.stringify({ ok, binPath, version: version.stdout.trim(), doctor }, null, 2));
  };
}

function buildRunHandler(store) {
  return async (args) => {
    const v = validateRunArgs(args);
    if (!v.ok) return failText(`Invalid arguments: ${v.error}`);
    const { prompt, cwd, mode, resume, target, timeoutMs, isolateWorktree } = v.value;
    if (resume && resume.startsWith('run_')) {
      return failText(`'${resume}' is a server-generated run-id and is not resumable. Use zcode_sessions to find a real ZCode session id (sess_...).`);
    }
    let binPath;
    try {
      binPath = discoverZCode();
    } catch (error) {
      return failText(`ZCode binary not found. ${error.message}`);
    }

    let worktree = null;
    if (isolateWorktree) {
      try {
        await assertGitRepo(cwd);
        worktree = await createWorktree(cwd);
      } catch (error) {
        return failText(`isolate_worktree requires a git repository: ${error.message}`);
      }
    }

    const res = await runZCodeTask({
      binPath, prompt, cwd: worktree ? worktree.dir : cwd, mode, resume, target, timeoutMs,
    });

    const sessionId = res.sessionId || newRunId();
    const status = res.timedOut ? 'timeout' : res.code === 0 ? 'completed' : 'failed';
    // Bookkeeping after task completion must never lose the task result:
    // a failure here degrades to a warning line instead of a -32603 that
    // would discard everything ZCode produced.
    let bookkeepingWarning = null;
    try {
      store.append({
        id: sessionId,
        kind: res.sessionId ? 'session' : 'run',
        cwd,
        mode,
        promptPreview: prompt.slice(0, 80),
        startedAt: new Date().toISOString(),
        status,
      });
    } catch (error) {
      bookkeepingWarning = `[warning] session bookkeeping failed: ${error.message}`;
    }

    const lines = [
      `status: ${status} (exit ${res.code}${res.timedOut ? ', timed out' : ''})`,
      `session_id: ${sessionId}${res.sessionId ? '' : '  (server run-id, not resumable)'}`,
    ];
    if (worktree) {
      let summary = null;
      try {
        summary = await worktreeSummary(worktree.dir, worktree.startSha);
      } catch (error) {
        lines.push(`[warning] worktree summary failed: ${error.message}`);
      }
      lines.push(
        `worktree_branch: ${worktree.branch}`,
        `worktree_dir: ${worktree.dir}`,
        `changed_files: ${summary ? (summary.changedFiles.length ? summary.changedFiles.join(', ') : 'none') : '(unavailable)'}`,
        `diff_stat:\n${summary ? (summary.diffStat || '(no changes)') : '(unavailable)'}`,
        'worktree kept — merge it (git merge) or remove it (git worktree remove) explicitly.'
      );
    }
    if (bookkeepingWarning) lines.push(bookkeepingWarning);
    lines.push('--- zcode output ---', res.stdout);
    if (res.stderr.trim()) lines.push('--- zcode stderr ---', res.stderr);

    const body = lines.join('\n');
    const truncated = body.length > OUTPUT_CAP;
    const result = text((truncated ? body.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]` : body));
    if (status !== 'completed') result.isError = true;
    return result;
  };
}

function buildSessionsHandler(store) {
  return async (args = {}) => {
    const entries = store.list(args.cwd ? { cwd: args.cwd } : {});
    if (!entries.length) return text('no sessions recorded for this filter yet');
    const rows = entries
      .map((e) => `${e.id} | ${e.kind === 'run' ? 'NOT-RESUMABLE' : 'resumable'} | ${e.status} | ${e.mode} | ${e.startedAt} | ${e.cwd} | ${e.promptPreview}`)
      .join('\n');
    return text(`sessions (newest last):\n${rows}`);
  };
}

export function buildTools({ store = new SessionStore(process.env.ZCODE_MCP_STATE || defaultStatePath()) } = {}) {
  return [
    { ...toolSchemas.zcode_check, handler: buildCheckHandler() },
    { ...toolSchemas.zcode_run, handler: buildRunHandler(store) },
    { ...toolSchemas.zcode_sessions, handler: buildSessionsHandler(store) },
  ];
}

export function main() {
  const protocol = createProtocol({ tools: buildTools() });
  const rl = createInterface({ input: process.stdin });
  // stdin can close (e.g. `echo ... | server`) while a handler is still
  // awaiting a child process; exiting then would drop the reply. Track
  // in-flight handlers and only exit once every reply has been written and
  // the stdout pipe has drained (writes >64k to a pipe are asynchronous and
  // process.exit() would truncate them).
  let pending = 0;
  let closing = false;
  const exitWhenSafe = () => {
    if (!closing || pending > 0) return;
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', () => process.exit(0));
    } else {
      process.exit(0);
    }
  };
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[zcode-delegate] non-JSON line ignored: ${trimmed.slice(0, 120)}\n`);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }) + '\n');
      return;
    }
    pending += 1;
    protocol.handleMessage(msg).then((reply) => {
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    }).catch((error) => {
      process.stderr.write(`[zcode-delegate] handler crash: ${error && error.stack}\n`);
    }).finally(() => {
      pending -= 1;
      exitWhenSafe();
    });
  });
  rl.on('close', () => {
    closing = true;
    exitWhenSafe();
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();

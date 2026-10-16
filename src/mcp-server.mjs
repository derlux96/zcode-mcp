#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createProtocol, PARSE_ERROR } from './protocol.mjs';
import { discoverZCode, ZCodeNotFoundError } from './discover.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import { runTaskWithModel, resolveModel, getModelCatalog, resolveBin } from './appserver.mjs';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  assertGitRepo, createWorktree, worktreeSummary, newRunId,
  MODES, DEFAULT_TIMEOUT_MS, OUTPUT_CAP,
} from './runner.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const failText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const REASONING_LEVELS = ['low', 'medium', 'high', 'max'];
// Budget for the throwaway catalog session (create only, no turn) in both
// the zcode_check models section and bare-modelId resolution.
const MODEL_CATALOG_TIMEOUT_MS = 15000;

const toolSchemas = {
  zcode_check: {
    name: 'zcode_check',
    description:
      'Verify that a ZCode installation is reachable: binary path, version, and a best-effort health check. Call this once before the first delegation on a machine.',
    inputSchema: {
      type: 'object',
      properties: {
        include_models: {
          type: 'boolean',
          description:
            'Append the available model catalog (one providerId/modelId per line), fetched via a throwaway app-server session. Best-effort: on failure a [warning] line is appended instead and the check result is unaffected.',
        },
      },
      additionalProperties: false,
    },
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
        model: {
          type: 'string',
          description:
            'Run via the internal app-server protocol with an explicit model: "modelId" (resolved against this machine\'s model catalog) or "providerId/modelId" (exact). Setting model switches off the default CLI path; resume and target do not apply in this mode. Find catalog ids via zcode_check with include_models.',
        },
        reasoning_level: {
          type: 'string',
          enum: REASONING_LEVELS,
          description: 'Reasoning effort for the selected model; only used when model is set. Default high.',
        },
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

/** Catalog -> "providerId/modelId" lines, or null when nothing usable. */
function formatModelCatalog(catalog) {
  if (!Array.isArray(catalog)) return null;
  const rows = catalog
    .filter((e) => e && e.ref && e.ref.providerId && e.ref.modelId)
    .map((e) => `${e.ref.providerId}/${e.ref.modelId}`);
  return rows.length ? rows : null;
}

function buildCheckHandler() {
  return async (args = {}) => {
    if (args.include_models !== undefined && typeof args.include_models !== 'boolean') {
      return failText('Invalid arguments: include_models must be a boolean');
    }
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
    const payload = JSON.stringify({ ok, binPath, version: version.stdout.trim(), doctor }, null, 2);
    if (args.include_models !== true) return text(payload);
    // Best-effort catalog section via a throwaway app-server session: a
    // failure degrades to a warning line and never changes the check result.
    let modelsSection;
    try {
      const catalog = await getModelCatalog({
        binPath: resolveBin(),
        cwd: process.cwd(),
        timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
      });
      const rows = formatModelCatalog(catalog);
      modelsSection = rows ? `models:\n${rows.join('\n')}` : 'models: (none reported by this installation)';
    } catch (error) {
      modelsSection = `[warning] models unavailable: ${error.message}`;
    }
    return text(`${payload}\n${modelsSection}`);
  };
}

// Shared by both run modes so the worktree block stays byte-identical.
async function worktreeLines(worktree) {
  if (!worktree) return [];
  const lines = [];
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
  return lines;
}

function capBody(body) {
  return body.length > OUTPUT_CAP ? body.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]` : body;
}

/**
 * Protocol mode (mode B): reached only when the caller set `model`.
 * All protocol knowledge lives in src/appserver.mjs — this layer only
 * routes, validates, and shapes the result like a mode A run so the
 * skill/agent contract stays uniform.
 */
async function runWithModelMode(store, args, v) {
  const { prompt, cwd, resume, target, timeoutMs, isolateWorktree } = v;
  const model = args.model;
  const reasoningLevel = args.reasoning_level === undefined ? 'high' : args.reasoning_level;
  // Everything that can be rejected without a spawn is rejected here, before
  // the binary is even resolved.
  if (typeof model !== 'string' || model.trim() === '') {
    return failText('Invalid arguments: model must be a non-empty string');
  }
  if (!REASONING_LEVELS.includes(reasoningLevel)) {
    return failText(`Invalid arguments: reasoning_level must be one of ${REASONING_LEVELS.join('|')}`);
  }
  if (resume) {
    return failText('Invalid arguments: resume is not supported together with model (protocol mode always starts a fresh session)');
  }
  if (target) {
    return failText('Invalid arguments: target is not supported together with model');
  }

  let binPath;
  try {
    binPath = resolveBin();
  } catch (error) {
    return failText(`ZCode binary not found. ${error.message}`);
  }

  // Worktree isolation applies first: the protocol session then runs in the
  // worktree directory, exactly like the CLI path.
  let worktree = null;
  if (isolateWorktree) {
    try {
      await assertGitRepo(cwd);
      worktree = await createWorktree(cwd);
    } catch (error) {
      return failText(`isolate_worktree requires a git repository: ${error.message}`);
    }
  }
  const effectiveCwd = worktree ? worktree.dir : cwd;

  // Resolve the model spec. "providerId/modelId" splits statically; a bare
  // modelId is resolved against the machine catalog via a throwaway session
  // (create only, no turn) so the user gets an actionable listing on a miss.
  const spec = model.trim();
  const slash = spec.indexOf('/');
  let providerId;
  let modelId;
  if (slash > 0 && slash < spec.length - 1) {
    providerId = spec.slice(0, slash);
    modelId = spec.slice(slash + 1);
  } else {
    let catalog = null;
    try {
      catalog = await getModelCatalog({ binPath, cwd: effectiveCwd, timeoutMs: MODEL_CATALOG_TIMEOUT_MS });
    } catch (error) {
      return failText(`Model catalog unavailable, cannot resolve '${spec}': ${error.message}`);
    }
    const resolved = resolveModel(catalog, spec);
    if (!resolved) {
      const rows = formatModelCatalog(catalog);
      const listing = rows
        ? `Available models:\n${rows.join('\n')}`
        : 'No models are reported as available on this machine (the catalog is empty).';
      return failText(`Model '${spec}' not found. ${listing}`);
    }
    ({ providerId, modelId } = resolved);
  }

  // runTaskWithModel resolves with the turn outcome and rejects on timeouts,
  // protocol errors, and child death.
  let res = null;
  let protocolError = null;
  try {
    res = await runTaskWithModel({
      binPath, cwd: effectiveCwd, prompt, providerId, modelId, reasoningLevel, timeoutMs,
    });
  } catch (error) {
    protocolError = error;
  }

  const sessionId = res ? res.sessionId : newRunId();
  const status = protocolError
    ? (/timed out/i.test(protocolError.message) ? 'timeout' : 'failed')
    : (res.ok ? 'completed' : 'failed');
  // Bookkeeping after task completion must never lose the task result (same
  // contract as mode A).
  let bookkeepingWarning = null;
  try {
    store.append({
      id: sessionId,
      kind: res ? 'session' : 'run',
      cwd,
      mode: 'model',
      promptPreview: prompt.slice(0, 80),
      startedAt: new Date().toISOString(),
      status,
    });
  } catch (error) {
    bookkeepingWarning = `[warning] session bookkeeping failed: ${error.message}`;
  }

  const lines = [
    `status: ${status} (model ${providerId}/${modelId})`,
    `session_id: ${sessionId}${res ? '' : '  (server run-id, not resumable)'}`,
  ];
  lines.push(...(await worktreeLines(worktree)));
  if (bookkeepingWarning) lines.push(bookkeepingWarning);
  if (res && !res.ok && res.error) {
    lines.push(`error: ${res.error.message}${res.error.code ? ` (code ${res.error.code})` : ''}`);
  }
  if (protocolError) lines.push(`error: ${protocolError.message}`);
  lines.push('--- zcode output ---', res ? (res.response ?? '') : '');

  const result = text(capBody(lines.join('\n')));
  if (status !== 'completed') result.isError = true;
  return result;
}

function buildRunHandler(store) {
  return async (args) => {
    const v = validateRunArgs(args);
    if (!v.ok) return failText(`Invalid arguments: ${v.error}`);
    const { prompt, cwd, mode, resume, target, timeoutMs, isolateWorktree } = v.value;
    if (resume && resume.startsWith('run_')) {
      return failText(`'${resume}' is a server-generated run-id and is not resumable. Use zcode_sessions to find a real ZCode session id (sess_...).`);
    }
    if (args.model !== undefined) return runWithModelMode(store, args, v.value);
    if (args.reasoning_level !== undefined) {
      return failText('Invalid arguments: reasoning_level applies only when model is set (protocol mode)');
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
    lines.push(...(await worktreeLines(worktree)));
    if (bookkeepingWarning) lines.push(bookkeepingWarning);
    lines.push('--- zcode output ---', res.stdout);
    if (res.stderr.trim()) lines.push('--- zcode stderr ---', res.stderr);

    const body = lines.join('\n');
    const result = text(capBody(body));
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

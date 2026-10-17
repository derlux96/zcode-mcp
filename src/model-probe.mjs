// zcode_check probe_model: one tiny real model request through the protocol path,
// in a throwaway work dir, so a broken login or provider config shows up before
// the first real job. Never throws; never retries; never leaves the dir behind.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskWithModel, resolveBin } from './appserver.mjs';
import { classifyError } from './errorkind.mjs';
import { oneLine } from './sanitize.mjs';

export const PROBE_PROMPT = 'Reply with exactly the single word OK. Do not use any tools.';
export const PROBE_TIMEOUT_MS = 60000;
export const PROBE_IDLE_TIMEOUT_MS = 30000;
const ERROR_MAX = 300;
const TIMEOUT_CODES = new Set(['idle', 'turn_timeout', 'request_timeout']);

const modelName = (m) => (m && m.providerId && m.modelId ? `${m.providerId}/${m.modelId}` : null);

/**
 * -> { ok, durationMs, model: 'provider/model' | null, errorKind?, error? }.
 * tmpRoot / run: test hooks (parent of the work dir; the task runner).
 */
export async function probeModel({
  timeoutMs = PROBE_TIMEOUT_MS, idleTimeoutMs = PROBE_IDLE_TIMEOUT_MS, tmpRoot = tmpdir(), run = runTaskWithModel,
} = {}) {
  const started = Date.now();
  const done = (fields) => ({ durationMs: Date.now() - started, ...fields });
  let dir = null;
  try {
    dir = realpathSync(mkdtempSync(join(tmpRoot, 'zcode-probe-')));
    const res = await run({
      binPath: resolveBin(),
      cwd: dir,
      prompt: PROBE_PROMPT,
      timeoutMs,
      idleTimeoutMs,
      killGroup: true,
      transientRetry: { maxRetries: 0 },
    });
    if (res.ok) return done({ ok: true, model: modelName(res.model) });
    const message = (res.error && res.error.message) || 'turn failed';
    return done({ ok: false, model: modelName(res.model), errorKind: classifyError({ message }), error: oneLine(message, ERROR_MAX) });
  } catch (err) {
    const message = String((err && err.message) || err);
    const errorKind = err && TIMEOUT_CODES.has(err.code) ? 'timeout' : classifyError({ message });
    return done({ ok: false, model: null, errorKind, error: oneLine(message, ERROR_MAX) });
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// zcode_check probe_model: one tiny real model request through the protocol path,
// in a throwaway work dir, so a broken login or provider config shows up before
// the first real job. Never throws; never retries; never leaves the dir behind.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskWithModel, resolveBin } from './appserver.mjs';
import { classifyError, LOGIN_HINT } from './errorkind.mjs';
import { oneLine } from './sanitize.mjs';
import { describeTurnError, errorText } from './transient.mjs';

export const PROBE_PROMPT = 'Reply with exactly the single word OK. Do not use any tools.';
export const PROBE_TIMEOUT_MS = 60000;
export const PROBE_IDLE_TIMEOUT_MS = 30000;
// Wall clock for the whole probe, app-server start-up included.
export const PROBE_TOTAL_MS = 75000;
const ERROR_MAX = 300;
const TIMEOUT_CODES = new Set(['idle', 'turn_timeout', 'request_timeout']);

const modelName = (m) => (m && m.providerId && m.modelId ? `${m.providerId}/${m.modelId}` : null);

/**
 * -> { ok, durationMs, model: 'provider/model' | null, errorKind?, error?, hint? }.
 * hint (the login/provider hint for "Model creation failed") is decided on the
 * full error text, before `error` is cut to 300 characters.
 * totalMs bounds the whole probe (start-up included); `signal` (the caller's
 * request) cancels it (errorKind 'cancelled'). tmpRoot / run: test hooks
 * (parent of the work dir; the task runner).
 */
export async function probeModel({
  timeoutMs = PROBE_TIMEOUT_MS, idleTimeoutMs = PROBE_IDLE_TIMEOUT_MS, totalMs = PROBE_TOTAL_MS, signal,
  tmpRoot = tmpdir(), run = runTaskWithModel,
} = {}) {
  const started = Date.now();
  const done = (fields) => ({ durationMs: Date.now() - started, ...fields });
  const ctl = new AbortController();
  let overBudget = false;
  const budget = setTimeout(() => { overBudget = true; ctl.abort(); }, totalMs);
  const cancel = () => ctl.abort();
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
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
      signal: ctl.signal,
      transientRetry: { maxRetries: 0 },
    });
    if (res.ok) return done({ ok: true, model: modelName(res.model) });
    // Localized message plus the English cause from detail & co. (real payload layout).
    const message = res.error ? describeTurnError(res.error) : 'turn failed';
    const full = errorText(res.error) || message;
    const kind = classifyError({ message: full });
    const hint = kind === 'model' && /model creation failed/i.test(full) ? { hint: LOGIN_HINT } : {};
    return done({ ok: false, model: modelName(res.model), errorKind: kind, error: oneLine(message, ERROR_MAX), ...hint });
  } catch (err) {
    if (overBudget) {
      return done({ ok: false, model: null, errorKind: 'timeout', error: `model probe exceeded its total budget of ${totalMs} ms (start-up included)` });
    }
    if (ctl.signal.aborted) return done({ ok: false, model: null, errorKind: 'cancelled', error: 'model probe cancelled with the zcode_check request' });
    const message = String((err && err.message) || err);
    const errorKind = err && TIMEOUT_CODES.has(err.code) ? 'timeout' : classifyError({ message });
    return done({ ok: false, model: null, errorKind, error: oneLine(message, ERROR_MAX) });
  } finally {
    clearTimeout(budget);
    if (signal) signal.removeEventListener('abort', cancel);
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

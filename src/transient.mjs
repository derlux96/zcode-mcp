// Transient provider errors: a turn that failed with one of these may succeed
// when the same session continues after a wait (rate limit, overload, network).
// Pure functions; the retry loop lives in runTaskWithModel (src/appserver.mjs).

// Our own AppServerError codes: timeouts, cancellation and crashes are decided by
// the runner and never retried here (a dead app-server has no session to continue).
const OWN_CODES = new Set(['idle', 'turn_timeout', 'aborted', 'request_timeout', 'child_exited', 'closed', 'no-model']);

// Checked first: a permanent cause wins even when the text also looks transient.
const PERMANENT = new RegExp([
  String.raw`\b40[0134]\b`, String.raw`\b422\b`,
  'unauthori[sz]ed', 'invalid api key', 'project_token_login_failed', 'login failed',
  'model creation failed', 'select a model', 'model is unavailable',
  String.raw`context (?:length|window)`, 'maximum context', 'too long',
  String.raw`content[ _-]?filter`,
  String.raw`app-server child (?:exited|failed)`,
].join('|'), 'i');

// Z.ai's "[1113] Insufficient balance or no resource package" arrives with HTTP 429
// and is retried like any 429 (bounded; the real message is reported in the end).
const TRANSIENT = new RegExp([
  String.raw`\b(?:429|500|502|503|504|529)\b`,
  'overloaded', String.raw`rate[ _-]?limit`, 'too many requests', 'temporarily unavailable', 'try again',
  String.raw`timed out`, 'timeout',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'fetch failed', 'socket hang up', 'network error', String.raw`\bterminated\b`,
  String.raw`stream (?:ended|closed) unexpectedly`,
].join('|'), 'i');

function haystack(err) {
  const parts = [];
  if (typeof err.code === 'string' || typeof err.code === 'number') parts.push(String(err.code));
  if (typeof err.message === 'string') parts.push(err.message);
  return parts.join(' ');
}

/** true when a turn failure ({code, message}) is worth continuing after a wait. */
export function isTransientProviderError(err) {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.code === 'string' && OWN_CODES.has(err.code)) return false;
  const text = haystack(err);
  if (text.trim() === '' || PERMANENT.test(text)) return false;
  return TRANSIENT.test(text);
}

function seconds(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

/** A numeric retry-after (seconds) carried by an error payload, in ms; null when absent. */
export function retryAfterMs(err) {
  if (!err || typeof err !== 'object') return null;
  const headers = err.headers && typeof err.headers === 'object' ? err.headers : {};
  for (const v of [err['retry-after'], err['Retry-After'], err.retryAfter, headers['retry-after'], headers['Retry-After']]) {
    const ms = seconds(v);
    if (ms !== null) return ms;
  }
  const m = typeof err.message === 'string' ? /retry[- ]after\D{0,3}(\d+)/i.exec(err.message) : null;
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * Delay before retry `attempt` (1-based): delaysMs[min(attempt-1, last)] ± jitter,
 * or a retry-after (ms) when given, capped at the largest scheduled delay.
 */
export function retryDelayMs(attempt, { delaysMs, jitter = 0, retryAfter = null, random = Math.random }) {
  const max = Math.max(...delaysMs);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter, max);
  const base = delaysMs[Math.min(Math.max(attempt, 1) - 1, delaysMs.length - 1)];
  return Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))));
}

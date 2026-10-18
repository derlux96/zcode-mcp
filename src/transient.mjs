// Transient provider errors: a turn that failed with one of these may succeed
// when the same session continues after a wait (rate limit, overload, network).
// Pure functions; the retry loop lives in runTaskWithModel (src/appserver.mjs).
//
// The real turn.failed payload is { type, code, message, detail,
// underlyingErrorMessage, stack }, where `message` may be localized (Chinese) and
// the English cause sits in `detail`/`underlyingErrorMessage`; a provider HTTP
// error may only carry statusCode/statusMessage. Every diagnostic field is
// searched (the stack never). ZCode's own `retryable` flag is NOT honoured (R30):
// ZCode marks provider 429s retryable:false although they often clear.

// Our own AppServerError codes: timeouts, cancellation and crashes are decided by
// the runner and never retried here (a dead app-server has no session to continue).
const OWN_CODES = new Set(['idle', 'turn_timeout', 'aborted', 'request_timeout', 'child_exited', 'closed', 'no-model']);

const TEXT_FIELDS = ['code', 'type', 'message', 'detail', 'underlyingErrorMessage', 'statusMessage'];
const CAUSE_FIELDS = ['detail', 'underlyingErrorMessage', 'statusMessage'];

// R31: Z.ai's balance error (business code 1113) may be a short window glitch,
// but a real exhaustion or a wrong endpoint must surface within ~1.5 min.
export const BALANCE_MAX_RETRIES = 2;

// An HTTP status only counts in a status context: at the start of a field
// (optionally after "HTTP"), after "HTTP"/"status"/"status code", or bracketed.
// Bare numbers elsewhere ("max_tokens must be <= 500") never match.
function statusContext(codes) {
  return new RegExp(
    String.raw`^\s*(?:HTTP\s*)?(?:${codes})\b|HTTP\s*:?\s*(?:${codes})\b|status(?:\s*code)?\s*[:=]?\s*(?:${codes})\b|\[(?:${codes})\]`,
    'im',
  );
}

// Checked first: a permanent cause wins even when another field looks transient.
const PERMANENT = [
  statusContext('40[0134]|422'),
  new RegExp([
    'unauthori[sz]ed', 'invalid api key', 'project_token_login_failed', 'login failed',
    'model creation failed', 'select a model', 'model is unavailable',
    String.raw`\binvalid (?:request|parameter|argument|value)\b`, String.raw`\bis invalid\b`, '取值无效', '参数无效', '参数错误',
    String.raw`context (?:length|window)`, 'maximum context', String.raw`(?:prompt|input|message|request body) is too long`,
    String.raw`content[ _-]?filter`,
    String.raw`app-server child (?:exited|failed)`,
  ].join('|'), 'i'),
];

// [klass, patterns] in priority order; the structured status is handled separately.
const CLASSES = [
  ['balance', [/\[1113\]|insufficient balance|no resource package|余额不足/i]],
  // 频率 alone means "frequency" (frequency_penalty parameter errors): only rate phrases count.
  ['rate_limit', [statusContext('429'), /rate[ _-]?limit|too many requests|速率限制|请求过多|请求频率|调用频率|访问频率|频率(?:过高|超限|限制|太高)|次数超过限制/i]],
  ['overloaded', [
    statusContext(String.raw`5\d\d`),
    /overloaded|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway timeout|try again|稍后重试|稍后再试|过载|繁忙/i,
  ]],
  ['network', [new RegExp([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'fetch failed', 'socket hang up', 'network error', 'other side closed',
    'upstream connect error', String.raw`(?:disconnect|reset) before headers`,
    String.raw`\bterminated\b.{0,40}\b(?:socket|connection)`,
    String.raw`stream (?:ended|closed) unexpectedly`,
    String.raw`\b(?:stream|upstream|gateway|read|connection|connect)\s+(?:timeout|timed out)\b`,
    String.raw`\brequest timed out\b`,
  ].join('|'), 'i'),
  // A fetch/stream abort by timeout; a tool's own "aborted due to timeout" is not a provider error.
  { test: (t) => /aborted due to timeout/i.test(t) && /\b(?:fetch|stream|network|socket|undici)\b/i.test(t) }]],
];

/** The structured HTTP status (statusCode or status, 100..599) or null. */
function statusOf(err) {
  for (const v of [err.statusCode, err.status]) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{3}\s*$/.test(v) ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return null;
}

/** All diagnostic fields of a turn error, one per line (plus "HTTP <status>"); never the stack. */
export function errorText(err) {
  if (!err || typeof err !== 'object') return '';
  const parts = [];
  for (const f of TEXT_FIELDS) {
    const v = err[f];
    if ((typeof v === 'string' && v.trim() !== '') || typeof v === 'number') parts.push(String(v));
  }
  const status = statusOf(err);
  if (status !== null) parts.push(`HTTP ${status}`);
  return parts.join('\n');
}

/** A human-readable one-liner: the message plus the distinct causes from the other fields. */
export function describeTurnError(err) {
  const e = err && typeof err === 'object' ? err : {};
  const parts = [];
  for (const f of ['message', ...CAUSE_FIELDS]) {
    const v = typeof e[f] === 'string' ? e[f].trim() : '';
    if (v && !parts.some((p) => p.toLowerCase().includes(v.toLowerCase()))) parts.push(v);
  }
  return parts.length ? parts.join(' | ') : 'turn failed without an error payload';
}

const NOT_TRANSIENT = Object.freeze({ transient: false, klass: null });

/**
 * -> { transient: false, klass: null } or { transient: true, klass, maxRetries? }
 * with klass 'balance' (maxRetries BALANCE_MAX_RETRIES) | 'rate_limit' |
 * 'overloaded' | 'network'.
 */
export function classifyTransient(err) {
  if (!err || typeof err !== 'object') return NOT_TRANSIENT;
  if (typeof err.code === 'string' && OWN_CODES.has(err.code)) return NOT_TRANSIENT;
  const text = errorText(err);
  const status = statusOf(err);
  if (status !== null && status >= 400 && status < 500 && status !== 429) return NOT_TRANSIENT;
  if (text.trim() === '' || PERMANENT.some((re) => re.test(text))) return NOT_TRANSIENT;
  for (const [klass, patterns] of CLASSES) {
    if (patterns.some((re) => re.test(text))) {
      return klass === 'balance' ? { transient: true, klass, maxRetries: BALANCE_MAX_RETRIES } : { transient: true, klass };
    }
  }
  return NOT_TRANSIENT;
}

/** true when a turn failure is worth continuing after a wait. */
export function isTransientProviderError(err) {
  return classifyTransient(err).transient;
}

function seconds(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) * 1000 : null;
}

// "retry-after: 40" / "retry after 2.5"; not "500ms", not a date like 2026-10-21.
const RETRY_AFTER_TEXT = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)(?![\d.])(?!\s*ms\b)(?!\s*[-:/])/i;

/** A retry-after in plain (possibly fractional) seconds carried by an error payload, in ms rounded up to whole seconds; null when absent. */
export function retryAfterMs(err) {
  if (!err || typeof err !== 'object') return null;
  const headers = err.headers && typeof err.headers === 'object' ? err.headers : {};
  for (const v of [err['retry-after'], err['Retry-After'], err.retryAfter, headers['retry-after'], headers['Retry-After']]) {
    const ms = seconds(v);
    if (ms !== null) return ms;
  }
  for (const f of TEXT_FIELDS) {
    const m = typeof err[f] === 'string' ? RETRY_AFTER_TEXT.exec(err[f]) : null;
    if (m) return seconds(m[1]);
  }
  return null;
}

const RETRY_AFTER_FLOOR_MS = 1000;

/**
 * Delay before retry `attempt` (1-based): delaysMs[min(attempt-1, last)] ± jitter,
 * or a retry-after (ms) when given: at least 1 s, at most the largest scheduled delay.
 */
export function retryDelayMs(attempt, { delaysMs, jitter = 0, retryAfter = null, random = Math.random }) {
  const max = Math.max(...delaysMs);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(Math.max(retryAfter, RETRY_AFTER_FLOOR_MS), max);
  const base = delaysMs[Math.min(Math.max(attempt, 1) - 1, delaysMs.length - 1)];
  return Math.max(0, Math.round(base * (1 + jitter * (2 * random() - 1))));
}

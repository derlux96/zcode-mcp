// Secret redaction for everything a job persists or returns (result.json,
// output.log, status errorMessage). Key names are matched by suffix so counters
// such as totalTokens or tokenCount survive; values are matched by shape.
export const REDACTED = '[REDACTED]';

const SENSITIVE_SUFFIXES = ['apikey', 'token', 'secret', 'password', 'authorization', 'cookie', 'privatekey'];

/** True when the key name ends in a secret-like word (apiKey, api_key, zcodeJwtToken, ...). */
export function isSensitiveKey(name) {
  if (typeof name !== 'string') return false;
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_SUFFIXES.some((s) => norm.endsWith(s));
}

/** Query-parameter names: broad substring match (old provider-check semantics). */
export function isSensitiveParam(name) {
  if (typeof name !== 'string') return false;
  return /key|token|secret|password|passwd|auth|sig/i.test(name);
}

// 40+ chars of [A-Za-z0-9_-] with a letter, a digit and a character outside
// [0-9a-f]: pure hex runs (git SHAs) are not secrets.
function looksHighEntropy(run) {
  return /[A-Za-z]/.test(run) && /[0-9]/.test(run) && /[g-zA-Z_-]/.test(run);
}

/** Masks secret-shaped substrings of a string. */
export function redactText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}/g, REDACTED)
    .replace(/\b(Bearer\s+)\S+/gi, `$1${REDACTED}`)
    .replace(/([?&])([^=&#\s]*)=([^&#\s]*)/g, (m, sep, name) => (isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : m))
    .replace(/[A-Za-z0-9_-]{40,}/g, (run) => (looksHighEntropy(run) ? REDACTED : run));
}

/** Deep copy with sensitive-named keys masked and string values passed through redactText. */
export function redactValue(v) {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSensitiveKey(k) ? REDACTED : redactValue(val);
    return out;
  }
  return v;
}

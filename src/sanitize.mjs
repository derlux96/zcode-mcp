// Escaping for text placed outside the untrusted output block: every value is
// rendered on one line, so ZCode or a caller can never forge a `status:` or
// `job_id:` line, also not for clients that split on Unicode line separators.
const ONE_LINE_MAX = 300;
const CONTROL_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
// C0, DEL, C1 (incl. NEL U+0085) and the Unicode line/paragraph separators.
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

function escapeOne(c) {
  if (CONTROL_ESCAPES[c]) return CONTROL_ESCAPES[c];
  const code = c.charCodeAt(0);
  return code > 0xff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\x${code.toString(16).padStart(2, '0')}`;
}

export const escapeControls = (s) => s.replace(CONTROLS, escapeOne);
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// R25: one short line; whitespace runs (line separators included) collapse to one
// space, the remaining control characters are escaped.
export function oneLine(value, max = ONE_LINE_MAX) {
  return cut(escapeControls(String(value ?? '').replace(/\s+/g, ' ').trim()), max);
}

// One name (a file, a session id) on one line: control characters escaped, not
// collapsed, so the name stays recognisable; capped at ONE_LINE_MAX.
export function cleanName(value) {
  return cut(escapeControls(String(value ?? '')), ONE_LINE_MAX);
}

// Ordered rules: the first matching kind wins, so the root cause beats follow-up symptoms.
// Timeouts and cancellation are decided by the runner, not classified here.
const RULES = [
  ['auth', /project_token_login_failed|\b401\b|\b403\b|unauthorized|invalid api key|login failed/i],
  ['quota', /\b429\b|rate limit|quota|insufficient balance|too many requests|余额不足|请求过多|速率限制|频率/i],
  ['network', /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i],
  ['model', /model is unavailable|model creation failed|select a model/i],
  ['crash', /app-server child exited|app-server child failed to start|SIGSEGV|SIGKILL|uncaught exception/i],
];

function text(value) {
  return typeof value === 'string' ? value : '';
}

export function classifyError(input) {
  const { message, stderr } = input && typeof input === 'object' ? input : {};
  const haystack = `${text(message)}\n${text(stderr)}`;
  for (const [kind, pattern] of RULES) {
    if (pattern.test(haystack)) return kind;
  }
  return 'unknown';
}

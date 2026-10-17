// Ordered rules: the first matching kind wins, so the root cause beats follow-up symptoms.
// Timeouts and cancellation are decided by the runner, not classified here.
const RULES = [
  ['auth', /project_token_login_failed|\b401\b|\b403\b|unauthorized|invalid api key|login failed/i],
  ['quota', /\b429\b|rate limit|quota|insufficient balance|too many requests|余额不足|请求过多|速率限制|请求频率|调用频率|访问频率|频率(?:过高|超限|限制|太高)|次数超过限制/i],
  ['network', /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i],
  ['model', /model is unavailable|model creation failed|select a model/i],
  ['crash', /app-server child exited|app-server child failed to start|SIGSEGV|SIGKILL|uncaught exception/i],
];

function text(value) {
  return typeof value === 'string' ? value : '';
}

// ZCode reports "Model creation failed" for a missing/expired login or a broken provider
// config alike. Fixed text, so it can sit outside the untrusted block.
export const LOGIN_HINT = 'hint: often caused by a missing, expired or misconfigured ZCode login/provider — check ~/.zcode/v2/provider_config.json (baseUrl, key) or run zcode login';

export function classifyError(input) {
  const { message, stderr } = input && typeof input === 'object' ? input : {};
  const haystack = `${text(message)}\n${text(stderr)}`;
  for (const [kind, pattern] of RULES) {
    if (pattern.test(haystack)) return kind;
  }
  return 'unknown';
}

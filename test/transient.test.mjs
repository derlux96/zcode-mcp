import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientProviderError, classifyTransient, errorText, describeTurnError, retryAfterMs, retryDelayMs, BALANCE_MAX_RETRIES,
} from '../src/transient.mjs';

// [message, expected klass]
const TRANSIENT = [
  ['HTTP 429 Too Many Requests', 'rate_limit'],
  ['429', 'rate_limit'],
  ['429 Too Many Requests', 'rate_limit'],
  ['status code 429', 'rate_limit'],
  ['Request failed with status: 429', 'rate_limit'],
  ['provider error [429] slow down', 'rate_limit'],
  ['Rate limit reached for requests', 'rate_limit'],
  ['rate_limit_exceeded', 'rate_limit'],
  ['too many requests', 'rate_limit'],
  ['请求过多，请稍后再试', 'rate_limit'],
  ['触发速率限制', 'rate_limit'],
  ['请求频率过高', 'rate_limit'],
  ['调用频率超限', 'rate_limit'],
  ['请求次数超过限制', 'rate_limit'],
  ['当前API请求次数超过限制', 'rate_limit'],
  ['Internal Server Error', 'overloaded'],
  ['upstream connect error or disconnect/reset before headers. reset reason: connection termination', 'network'],
  ['upstream connect error', 'network'],
  ['reset before headers', 'network'],
  ['500 Internal Server Error', 'overloaded'],
  ['HTTP 502 Bad Gateway', 'overloaded'],
  ['status 503', 'overloaded'],
  ['504 Gateway Timeout', 'overloaded'],
  ['HTTP 529 overloaded_error', 'overloaded'],
  ['The server is Overloaded', 'overloaded'],
  ['Service temporarily unavailable', 'overloaded'],
  ['Please try again later', 'overloaded'],
  ['服务过载', 'overloaded'],
  ['系统繁忙，请稍后重试', 'overloaded'],
  // Intended: an upstream 502 is transient although it mentions "400 ms" (not a status context).
  ['502 Bad Gateway (upstream 400 ms)', 'overloaded'],
  // Intended: "took too long" is not a context-length error; "try again" makes it transient.
  ['Request took too long, please try again', 'overloaded'],
  ['read ECONNRESET', 'network'],
  ['connect ECONNREFUSED 10.0.0.1:443', 'network'],
  ['connect ETIMEDOUT', 'network'],
  ['getaddrinfo ENOTFOUND api.z.ai', 'network'],
  ['getaddrinfo EAI_AGAIN api.z.ai', 'network'],
  ['write EPIPE', 'network'],
  ['TypeError: fetch failed', 'network'],
  ['socket hang up', 'network'],
  ['Network Error', 'network'],
  ['TypeError: terminated (other side closed)', 'network'],
  ['terminated: socket closed by peer', 'network'],
  ['stream ended unexpectedly', 'network'],
  ['Stream closed unexpectedly', 'network'],
  ['provider stream timeout', 'network'],
  ['upstream timed out', 'network'],
  ['read timed out', 'network'],
  ['Request timed out.', 'network'],
  ['HTTP 429: [1113] Insufficient balance or no resource package. Please recharge.', 'balance'],
  ['[1113][Insufficient balance or no resource package. Please recharge.][req_1]', 'balance'],
  ['账户余额不足', 'balance'],
];

const PERMANENT = [
  'HTTP 401 Unauthorized',
  '403 Forbidden',
  'status code: 403',
  'unauthorized',
  'Invalid API key provided',
  'project_token_login_failed',
  'Model creation failed',
  'Select a model before continuing',
  'Model is unavailable',
  'Model request failed.',
  'context length exceeded',
  'maximum context length is 200000 tokens',
  'prompt is too long',
  '400 Bad Request',
  'HTTP 404 Not Found',
  '422 Unprocessable Entity',
  'content filter triggered',
  'app-server child exited (code=1 signal=null)',
  'error 4290 in module',
  'id 5030',
  'code 15290',
  'fake model failure',
  '',
  'HTTP 401: invalid api key, try again',
  // Review cases: bare numbers and generic words are not provider errors.
  'max_tokens must be <= 500',
  'Daily limit of 500 requests reached',
  'Invalid model: request timeout configuration',
  'Tool execution timeout',
  'Process terminated by user',
  'job took 503 seconds',
  'Tool execution timeout: bash exceeded 120s',
  'Invalid request: tools[0].name is invalid. Please fix it and try again.',
  // 频率 alone is "frequency": a parameter error, not a rate limit.
  '参数 frequency_penalty（频率惩罚）取值无效',
  '频率惩罚参数超出范围',
  'frequency_penalty must be between -2 and 2',
  'The operation was aborted due to timeout',
  'Tool execution aborted due to timeout',
];

test('transient provider errors are recognised with their class (table)', () => {
  for (const [message, klass] of TRANSIENT) {
    const c = classifyTransient({ message });
    assert.equal(c.transient, true, message);
    assert.equal(c.klass, klass, message);
    assert.equal(isTransientProviderError({ message }), true, message);
  }
});

test('permanent errors, bare numbers and generic words are not transient (table)', () => {
  for (const message of PERMANENT) {
    assert.equal(isTransientProviderError({ message }), false, message);
    assert.deepEqual(classifyTransient({ message }), { transient: false, klass: null }, message);
  }
});

test('the balance class carries a short retry cap (R31)', () => {
  assert.equal(BALANCE_MAX_RETRIES, 2);
  assert.equal(classifyTransient({ message: '余额不足' }).maxRetries, 2);
  assert.equal(classifyTransient({ message: 'HTTP 429 Too Many Requests' }).maxRetries, undefined);
});

test('the real turn.failed layout: the cause can sit in detail / underlyingErrorMessage / statusMessage', () => {
  // Localized message, English cause only in underlyingErrorMessage.
  assert.equal(classifyTransient({ code: 'provider_error', message: '模型请求失败', detail: 'Model request failed', underlyingErrorMessage: 'HTTP 429 Too Many Requests' }).klass, 'rate_limit');
  // The real model_not_found payload: permanent through detail.
  assert.equal(isTransientProviderError({ code: 'model_not_found', type: 'unknown_error', message: 'Provider Registry 中不存在 Model: x/y', detail: 'Model creation failed' }), false);
  // A permanent cause in detail beats a transient-looking message.
  assert.equal(isTransientProviderError({ message: 'please try again', detail: 'HTTP 401 Unauthorized' }), false);
  // Only structured status + statusMessage (ZCode's retryable:false is not honoured, R30).
  const status1113 = { statusCode: 429, statusMessage: '[1113][Insufficient balance or no resource package. Please recharge.][req]', retryable: false };
  assert.deepEqual(classifyTransient(status1113), { transient: true, klass: 'balance', maxRetries: 2 });
  assert.equal(classifyTransient({ statusCode: 429, retryable: false }).klass, 'rate_limit');
  assert.equal(classifyTransient({ status: '503' }).klass, 'overloaded');
  assert.equal(isTransientProviderError({ statusCode: 401, message: 'try again' }), false);
  assert.equal(isTransientProviderError({ statusCode: 400 }), false);
  // The stack is never searched.
  assert.equal(isTransientProviderError({ message: 'x', stack: 'Error: fetch failed' }), false);
});

test('errorText joins the diagnostic fields (one per line) and names the structured status', () => {
  const t = errorText({ code: 'c', type: 't', message: 'm', detail: 'd', underlyingErrorMessage: 'u', statusCode: 429, statusMessage: 's', stack: 'NOPE' });
  assert.equal(t, 'c\nt\nm\nd\nu\ns\nHTTP 429');
  assert.equal(errorText(null), '');
});

test('describeTurnError: the message plus distinct English causes, for humans', () => {
  assert.equal(describeTurnError({ message: 'Provider Registry 中不存在 Model: x/y', detail: 'Model creation failed', underlyingErrorMessage: 'Provider Registry 中不存在 Model: x/y' }),
    'Provider Registry 中不存在 Model: x/y | Model creation failed');
  assert.equal(describeTurnError({ statusCode: 429, statusMessage: '[1113][Insufficient balance]' }), '[1113][Insufficient balance]');
  assert.equal(describeTurnError({ message: 'fetch failed' }), 'fetch failed');
  assert.equal(describeTurnError({}), 'turn failed without an error payload');
});

test('our own timeout, abort and crash codes are never transient', () => {
  for (const code of ['idle', 'turn_timeout', 'aborted', 'request_timeout', 'child_exited', 'closed', 'no-model']) {
    assert.equal(isTransientProviderError({ code, message: 'fetch failed' }), false, code);
  }
});

test('garbage input is not transient', () => {
  for (const v of [null, undefined, '429', {}]) assert.equal(isTransientProviderError(v), false);
});

test('retryAfterMs: plain (float) seconds only, rounded up; ms and dates are rejected', () => {
  assert.equal(retryAfterMs({ 'retry-after': 12 }), 12000);
  assert.equal(retryAfterMs({ 'Retry-After': '7' }), 7000);
  assert.equal(retryAfterMs({ retryAfter: 3 }), 3000);
  assert.equal(retryAfterMs({ retryAfter: 1.2 }), 2000);
  assert.equal(retryAfterMs({ headers: { 'retry-after': '5' } }), 5000);
  assert.equal(retryAfterMs({ message: '429 Too Many Requests (Retry-After: 40)' }), 40000);
  assert.equal(retryAfterMs({ message: 'retry after 2.5 seconds' }), 3000);
  assert.equal(retryAfterMs({ message: 'retry-after: 500ms' }), null);
  assert.equal(retryAfterMs({ message: 'Retry-After: 2026-10-21' }), null);
  assert.equal(retryAfterMs({ message: 'Retry-After: Wed, 21 Oct 2026 07:28:00 GMT' }), null);
  assert.equal(retryAfterMs({ 'retry-after': '500ms' }), null);
  assert.equal(retryAfterMs({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), null);
  assert.equal(retryAfterMs({ 'retry-after': -1 }), null);
  assert.equal(retryAfterMs({ message: '429' }), null);
  assert.equal(retryAfterMs(null), null);
});

test('retryDelayMs walks the schedule, repeats its last step and applies jitter', () => {
  const delays = [100, 200, 400];
  const mid = () => 0.5;
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: mid }), 100);
  assert.equal(retryDelayMs(3, { delaysMs: delays, jitter: 0.1, random: mid }), 400);
  assert.equal(retryDelayMs(9, { delaysMs: delays, jitter: 0.1, random: mid }), 400);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: () => 0 }), 90);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: () => 1 }), 110);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0 }), 100);
});

test('retryDelayMs honours retry-after with a 1 s floor and the largest step as cap', () => {
  const delays = [100, 2000, 4000];
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, retryAfter: 3000 }), 3000);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, retryAfter: 9000 }), 4000);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, retryAfter: 0 }), 1000, 'retry-after 0 must not drain retries');
  // The cap wins over the floor when the whole schedule is shorter than 1 s (tests).
  assert.equal(retryDelayMs(1, { delaysMs: [5], jitter: 0, retryAfter: 0 }), 5);
});

test('"aborted due to timeout" is transient only next to a fetch/stream/network word', () => {
  assert.equal(classifyTransient({ message: 'The operation was aborted due to timeout', underlyingErrorMessage: 'fetch to the model stream' }).klass, 'network');
  assert.equal(classifyTransient({ message: 'TypeError: fetch: The operation was aborted due to timeout' }).klass, 'network');
  assert.equal(isTransientProviderError({ message: 'The operation was aborted due to timeout' }), false);
});

test('errorText skips absent and blank fields; only a status 100..599 counts', () => {
  assert.equal(errorText({ message: 'm' }), 'm');
  assert.equal(errorText({ message: 'm', detail: '  ', code: 0 }), '0\nm');
  for (const s of [100, 599, '503']) assert.equal(errorText({ message: 'm', statusCode: s }), `m\nHTTP ${Number(s)}`, String(s));
  for (const s of [42, 99, 600, -5, 429.5, ['503'], true]) assert.equal(errorText({ message: 'm', status: s }), 'm', String(s));
});

test('the structured status decides alone: 4xx except 429 is permanent, 429 and 5xx are transient', () => {
  assert.deepEqual(classifyTransient({ statusCode: 429 }), { transient: true, klass: 'rate_limit' });
  assert.deepEqual(classifyTransient({ statusCode: 500 }), { transient: true, klass: 'overloaded' });
  assert.deepEqual(classifyTransient({ statusCode: 418, message: 'rate limit, try again' }), { transient: false, klass: null });
  assert.deepEqual(classifyTransient({ statusCode: 499, message: 'try again' }), { transient: false, klass: null });
});

test('describeTurnError tolerates non-object payloads', () => {
  for (const v of [null, undefined, 'text', 7, false]) assert.equal(describeTurnError(v), 'turn failed without an error payload');
});

test('retryAfterMs: zero and fractions below one second, odd headers and values', () => {
  assert.equal(retryAfterMs({ 'retry-after': 0 }), 0);
  assert.equal(retryAfterMs({ 'retry-after': '0' }), 0);
  assert.equal(retryAfterMs({ 'retry-after': 0.5 }), 1000);
  assert.equal(retryAfterMs({ headers: null, message: 'retry-after: 3' }), 3000);
  assert.equal(retryAfterMs({ headers: 'retry-after: 9', message: 'retry-after: 3' }), 3000);
  assert.equal(retryAfterMs({ 'retry-after': ['7'], message: 'retry-after: 3' }), 3000);
  assert.equal(retryAfterMs({ 'retry-after': true }), null);
});

test('retryDelayMs: no jitter by default, attempt below 1 is the first step, a zero step stays zero', () => {
  assert.equal(retryDelayMs(1, { delaysMs: [1000], random: () => 1 }), 1000);
  assert.equal(retryDelayMs(1, { delaysMs: [1000], random: () => 0 }), 1000);
  assert.equal(retryDelayMs(0, { delaysMs: [100, 200] }), 100);
  assert.equal(retryDelayMs(-3, { delaysMs: [100, 200] }), 100);
  assert.equal(retryDelayMs(2, { delaysMs: [100, 200] }), 200);
  assert.equal(retryDelayMs(5, { delaysMs: [100, 200] }), 200);
  assert.equal(retryDelayMs(1, { delaysMs: [0, 200], jitter: 0.5, random: () => 0 }), 0);
  assert.equal(retryDelayMs(1, { delaysMs: [10, 200], jitter: 2, random: () => 0 }), 0, 'never negative');
});

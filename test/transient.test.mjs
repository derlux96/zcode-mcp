import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientProviderError, retryAfterMs, retryDelayMs } from '../src/transient.mjs';

const TRANSIENT = [
  'HTTP 429 Too Many Requests',
  '429',
  'HTTP 429: [1113] Insufficient balance or no resource package. Please recharge.',
  '500 Internal Server Error',
  'status 502 bad gateway',
  'upstream returned 503',
  '504 Gateway Timeout',
  'Anthropic 529 overloaded_error',
  'The server is Overloaded',
  'Rate limit reached for requests',
  'too many requests',
  'Service temporarily unavailable',
  'Please try again later',
  'Request timed out',
  'provider stream timeout',
  'read ECONNRESET',
  'connect ECONNREFUSED 10.0.0.1:443',
  'connect ETIMEDOUT',
  'getaddrinfo ENOTFOUND api.z.ai',
  'getaddrinfo EAI_AGAIN api.z.ai',
  'write EPIPE',
  'TypeError: fetch failed',
  'socket hang up',
  'Network Error',
  'terminated',
  'stream ended unexpectedly',
  'Stream closed unexpectedly',
];

const PERMANENT = [
  'HTTP 401 Unauthorized',
  '403 Forbidden',
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
  '404 Not Found',
  '422 Unprocessable Entity',
  'content filter triggered',
  'app-server child exited (code=1 signal=null)',
  'error 4290 in module',
  'id 5030',
  'code 15290',
  'fake model failure',
  '',
  // An auth failure stays permanent even if the text also suggests retrying.
  'HTTP 401: invalid api key, try again',
];

test('transient provider errors are recognised (table)', () => {
  for (const message of TRANSIENT) {
    assert.equal(isTransientProviderError({ message }), true, message);
  }
});

test('permanent errors and word-boundary negatives are not transient (table)', () => {
  for (const message of PERMANENT) {
    assert.equal(isTransientProviderError({ message }), false, message);
  }
});

test('a numeric or string code takes part in the match', () => {
  assert.equal(isTransientProviderError({ code: 429, message: 'provider error' }), true);
  assert.equal(isTransientProviderError({ code: 'rate_limit_exceeded', message: 'x' }), true);
  assert.equal(isTransientProviderError({ code: 401, message: 'x' }), false);
});

test('our own timeout, abort and crash codes are never transient', () => {
  for (const code of ['idle', 'turn_timeout', 'aborted', 'request_timeout', 'child_exited', 'closed', 'no-model']) {
    assert.equal(isTransientProviderError({ code, message: 'timed out after 300 ms' }), false, code);
  }
});

test('garbage input is not transient', () => {
  assert.equal(isTransientProviderError(null), false);
  assert.equal(isTransientProviderError(undefined), false);
  assert.equal(isTransientProviderError('429'), false);
  assert.equal(isTransientProviderError({}), false);
});

test('retryAfterMs reads a numeric retry-after in seconds from fields or text', () => {
  assert.equal(retryAfterMs({ 'retry-after': 12 }), 12000);
  assert.equal(retryAfterMs({ 'Retry-After': '7' }), 7000);
  assert.equal(retryAfterMs({ retryAfter: 3 }), 3000);
  assert.equal(retryAfterMs({ headers: { 'retry-after': '5' } }), 5000);
  assert.equal(retryAfterMs({ message: '429 Too Many Requests (Retry-After: 40)' }), 40000);
  assert.equal(retryAfterMs({ message: '429' }), null);
  assert.equal(retryAfterMs({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), null);
  assert.equal(retryAfterMs({ 'retry-after': -1 }), null);
  assert.equal(retryAfterMs(null), null);
});

test('retryDelayMs walks the schedule, repeats its last step and applies jitter', () => {
  const delays = [100, 200, 400];
  const mid = () => 0.5; // jitter factor 0
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: mid }), 100);
  assert.equal(retryDelayMs(3, { delaysMs: delays, jitter: 0.1, random: mid }), 400);
  assert.equal(retryDelayMs(9, { delaysMs: delays, jitter: 0.1, random: mid }), 400);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: () => 0 }), 90);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, random: () => 1 }), 110);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0 }), 100);
});

test('retryDelayMs honours retry-after, capped at the largest scheduled delay', () => {
  const delays = [100, 200, 400];
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, retryAfter: 300 }), 300);
  assert.equal(retryDelayMs(1, { delaysMs: delays, jitter: 0.1, retryAfter: 9000 }), 400);
});

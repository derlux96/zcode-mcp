import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, isSensitiveKey, REDACTED } from '../src/redact.mjs';

test('REDACTED marker', () => assert.equal(REDACTED, '[REDACTED]'));

test('isSensitiveKey matches by suffix', () => {
  for (const k of ['apiKey', 'api_key', 'zcodeJwtToken', 'Authorization', 'clientSecret', 'password', 'cookie', 'privateKey']) {
    assert.equal(isSensitiveKey(k), true, k);
  }
  for (const k of ['totalTokens', 'inputTokens', 'sessionId', 'apiKeyRequired', 'tokenCount']) {
    assert.equal(isSensitiveKey(k), false, k);
  }
  assert.equal(isSensitiveKey(42), false);
});

test('redactText masks keys, bearer tokens and sensitive query params', () => {
  assert.equal(redactText('use sk-abc123def456ghi789jkl now'), 'use [REDACTED] now');
  assert.equal(redactText('Bearer eyJhbGciOi.abc.def'), 'Bearer [REDACTED]');
  assert.equal(redactText('https://x.io/v1?key=SECRET&a=1'), 'https://x.io/v1?key=[REDACTED]&a=1');
});

test('redactText masks long mixed alphanumeric tokens', () => {
  const tok = 'Zk3Jq9XvB2nLm8Rt4Yw7Pc1Hd6Fs5Gu0AeIoKbNxQz';
  assert.equal(redactText(`token ${tok} end`), 'token [REDACTED] end');
});

test('redactText leaves ordinary text, ids, paths and git SHAs alone', () => {
  for (const s of [
    'sess_fakeB1', 'job_20261029_abcdef', '/home/u/project/src/api-key-handler.mjs', 'totalTokens 32485',
    'commit 3d6de5b0a1c2e3f4a5b6c7d8e9f00112233445566',
    '3d6de5b0a1c2e3f4a5b6c7d8e9f00112233445566',
  ]) assert.equal(redactText(s), s);
});

test('redactText tolerates non-strings', () => {
  assert.equal(redactText(undefined), '');
  assert.equal(redactText(null), '');
});

test('redactValue deep-copies and masks by key', () => {
  const input = { apiKey: 'x', usage: { totalTokens: 5 }, sessionId: 's', list: [{ password: 'p', note: 'sk-abc123def456ghi789jkl' }] };
  const out = redactValue(input);
  assert.deepEqual(out, {
    apiKey: '[REDACTED]', usage: { totalTokens: 5 }, sessionId: 's',
    list: [{ password: '[REDACTED]', note: '[REDACTED]' }],
  });
  assert.equal(input.apiKey, 'x');
  assert.equal(redactValue(7), 7);
});

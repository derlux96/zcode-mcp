import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactValue, isSensitiveKey, isSensitiveParam, REDACTED } from '../src/redact.mjs';

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

test('query params use broad substring matching', () => {
  for (const n of ['access_key', 'secretKey', 'tokenId', 'auth_code', 'passwd', 'accessKey', 'authKey', 'secret_key']) {
    assert.equal(redactText(`https://x.io/?${n}=V1&a=1`), `https://x.io/?${n}=[REDACTED]&a=1`, n);
  }
  assert.equal(redactText('https://x.io/?page=2&q=hi'), 'https://x.io/?page=2&q=hi');
});

test('sk- needs a left boundary', () => {
  for (const s of ['task-implement-redaction-module', 'risk-assessment-report', 'task-runner-config', 'disk-usage-monitor']) {
    assert.equal(redactText(s), s);
  }
  assert.equal(redactText('sk-abc123def456ghi789jkl'), '[REDACTED]');
});

test('high-entropy rule leaves session ids, UUIDs, long identifiers and hex SHAs alone', () => {
  for (const s of [
    'sess_d565c105-4f40-4557-a1b0-529acd944a02',
    'session sess_d565c105-4f40-4557-a1b0-529acd944a02 resumed',
    'job-D565C105-4F40-4557-A1B0-529ACD944A02',
    'thread_d565c105-4f40-4557-a1b0-529acd944a02',
    'should_handle_extremely_long_identifier_names_v2_and_more',
    'node_modules/@scope/some-really-long-package-name-with-version-2/',
    'SHOULD_HANDLE_EXTREMELY_LONG_CONSTANT_NAMES_V2_AND_MORE_X',
    'commit 3D6DE5B0A1C2E3F4A5B6C7D8E9F00112233445566',
    '3D6DE5B0a1c2e3f4a5b6c7d8e9f00112233445566',
  ]) assert.equal(redactText(s), s, s);
});

test('high-entropy rule needs upper case, lower case and digits together', () => {
  assert.equal(redactText('x Zk3Jq9XvB2nLm8Rt4Yw7Pc1Hd6Fs5Gu0AeIoKbNxQz y'), 'x [REDACTED] y');
  assert.equal(redactText('ghp_Zk3Jq9XvB2nLm8Rt4Yw7Pc1Hd6Fs5Gu0AeIoKb'), '[REDACTED]');
});

test('isSensitiveParam: substring match on names, never on non-strings', () => {
  assert.equal(isSensitiveParam('X-Api-Key'), true);
  assert.equal(isSensitiveParam('page'), false);
  assert.equal(isSensitiveParam(undefined), false);
  assert.equal(isSensitiveParam(42), false);
});

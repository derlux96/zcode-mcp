import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../src/errorkind.mjs';

const CASES = [
  ['project_token_login_failed', 'auth'],
  ['HTTP 401 Unauthorized', 'auth'],
  ['status 403', 'auth'],
  ['Invalid API key provided', 'auth'],
  ['Login failed', 'auth'],
  ['429 rate limit', 'quota'],
  ['quota exceeded', 'quota'],
  ['Insufficient balance', 'quota'],
  ['Too many requests', 'quota'],
  ['read ECONNRESET', 'network'],
  ['connect ECONNREFUSED 127.0.0.1:443', 'network'],
  ['getaddrinfo ENOTFOUND api.example.com', 'network'],
  ['ETIMEDOUT', 'network'],
  ['getaddrinfo EAI_AGAIN host', 'network'],
  ['fetch failed', 'network'],
  ['socket hang up', 'network'],
  ['Network error', 'network'],
  ['Model is unavailable', 'model'],
  ['Model creation failed', 'model'],
  ['Select a model before continuing', 'model'],
  ['app-server child exited (code=1 signal=null)', 'crash'],
  ['app-server child failed to start: spawn ENOENT', 'crash'],
  ['received SIGSEGV', 'crash'],
  ['killed by SIGKILL', 'crash'],
  ['Uncaught Exception: boom', 'crash'],
  ['Turn execution failed', 'unknown'],
  ['Turn was cancelled.', 'unknown'],
  ['timed out after 540000 ms waiting for session/event turn.completed|turn.failed', 'unknown'],
  ['', 'unknown'],
];

for (const [message, expected] of CASES) {
  test(`message ${JSON.stringify(message)} -> ${expected}`, () => {
    assert.equal(classifyError({ message }), expected);
  });
}

test('stderr is classified too, and joined with message', () => {
  assert.equal(classifyError({ stderr: 'Error: read ECONNRESET' }), 'network');
  assert.equal(classifyError({ message: 'Turn execution failed', stderr: 'quota exceeded' }), 'quota');
});

test('matching is case-insensitive', () => {
  assert.equal(classifyError({ message: 'RATE LIMIT hit' }), 'quota');
  assert.equal(classifyError({ message: 'project_token_login_failed'.toUpperCase() }), 'auth');
});

test('priority: auth beats model, quota beats network, network beats crash', () => {
  assert.equal(classifyError({ message: 'Model creation failed', stderr: 'project_token_login_failed' }), 'auth');
  assert.equal(classifyError({ message: '429 ECONNRESET' }), 'quota');
  assert.equal(classifyError({ message: 'fetch failed', stderr: 'app-server child exited (code=1 signal=null)' }), 'network');
  assert.equal(classifyError({ message: 'Model is unavailable app-server child exited' }), 'model');
});

test('\\b patterns do not match inside longer numbers or paths', () => {
  assert.equal(classifyError({ message: 'processed 4290 items' }), 'unknown');
  assert.equal(classifyError({ message: 'open /tmp/401x/file' }), 'unknown');
  assert.equal(classifyError({ message: 'id 14030' }), 'unknown');
});

test('never throws; non-string and missing input is treated as empty', () => {
  for (const input of [undefined, null, {}, 'text', 42, { message: 5, stderr: null }, { message: {}, stderr: [] }]) {
    assert.equal(classifyError(input), 'unknown');
  }
  assert.equal(classifyError({ message: 5, stderr: 'ECONNRESET' }), 'network');
});

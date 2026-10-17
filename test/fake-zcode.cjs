#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_ZCODE_MODE || 'ok';

if (args.includes('version')) {
  console.log('zcode 0.16.9 (fake)');
  process.exit(0);
}
if (args.includes('doctor')) {
  console.log('fake doctor: all good');
  process.exit(0);
}
if (process.env.FAKE_ZCODE_ECHO_ARGS) {
  console.log(JSON.stringify({ argv: args }));
  process.exit(0);
}
if (process.env.FAKE_ZCODE_DUMP_ENV) {
  console.log(JSON.stringify({
    builtinConfig: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || null,
    personalConfig: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || null,
  }));
  process.exit(0);
}
if (mode === 'bigoutput') {
  console.log('x'.repeat(500000));
  // Exit naturally instead of process.exit(0): a 500k write to a pipe is
  // asynchronous and process.exit() truncates it (only the pipe buffer, 64k,
  // ever reaches the parent). Letting the event loop drain flushes it fully.
  process.exitCode = 0;
  return;
}
if (mode === 'hang') {
  setInterval(() => {}, 1000); // never exits; used for timeout tests
  process.exitCode = 0;
} else if (mode === 'fail') {
  console.log(JSON.stringify({ session: { id: 'sess_fail000' } }));
  console.error('fake zcode failure');
  process.exit(1);
} else if (mode === 'nosession') {
  console.log('done, but no session id anywhere');
  process.exit(0);
} else {
  console.log(JSON.stringify({ result: 'fake task done', session: { id: 'sess_fake123' } }));
  process.exit(0);
}

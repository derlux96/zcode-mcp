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
} else if (mode === 'chatty') {
  // Long-running but active: prints every 150 ms for ~1.5 s, then finishes.
  let n = 0;
  const t = setInterval(() => {
    console.log(`progress ${n}`);
    if (++n === 10) {
      clearInterval(t);
      console.log(JSON.stringify({ result: 'chatty done', session: { id: 'sess_chatty1' } }));
      process.exit(0);
    }
  }, 150);
} else if (mode === 'silent') {
  // Alive but mute for 30 s (idle-timeout tests).
  setTimeout(() => process.exit(0), 30000);
} else if (mode === 'crash-mid') {
  setTimeout(() => process.exit(1), 300);
} else if (mode === 'badutf8') {
  // Invalid UTF-8 on stdout: decoding must yield U+FFFD, not throw.
  process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
  process.exitCode = 0;
} else if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {});
  process.stdout.write('ready\n'); // handler is installed
  setTimeout(() => process.exit(0), 30000);
} else if (mode === 'spawn-grandchild') {
  // Same process group (not detached); PID reported on stderr so tests can
  // verify/kill it.
  const { spawn } = require('node:child_process');
  const gc = spawn('sleep', ['60'], { stdio: 'ignore' });
  process.stderr.write(`grandchild pid ${gc.pid}\n`);
  setTimeout(() => process.exit(0), 30000);
} else if (mode === 'slow-start') {
  setTimeout(() => {
    console.log(JSON.stringify({ result: 'slow start done', session: { id: 'sess_slow001' } }));
    process.exit(0);
  }, 2000);
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

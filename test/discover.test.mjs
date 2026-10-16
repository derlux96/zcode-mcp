import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverZCode, ZCodeNotFoundError } from '../src/discover.mjs';

function tempFile(dir, name = 'zcode.cjs') {
  const file = join(dir, name);
  writeFileSync(file, '// fake\n');
  return file;
}

test('ZCODE_BIN env wins when the file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-disc-'));
  const file = tempFile(dir);
  assert.equal(discoverZCode({ env: { ZCODE_BIN: file } }), file);
  rmSync(dir, { recursive: true, force: true });
});

test('set-but-missing ZCODE_BIN throws immediately with the checked path', () => {
  assert.throws(
    () => discoverZCode({ env: { ZCODE_BIN: '/no/such/zcode.cjs' } }),
    (e) => e instanceof ZCodeNotFoundError && e.checked.includes('ZCODE_BIN=/no/such/zcode.cjs')
  );
});

test('falls back to which zcode from PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-disc-'));
  mkdirSync(join(dir, 'bin'));
  const script = join(dir, 'bin', 'zcode');
  writeFileSync(script, '#!/bin/sh\necho fake\n');
  chmodSync(script, 0o755);
  const prevPath = process.env.PATH;
  const prevBin = process.env.ZCODE_BIN;
  process.env.PATH = `${join(dir, 'bin')}:${prevPath}`;
  delete process.env.ZCODE_BIN;
  try {
    assert.equal(discoverZCode({ macosPath: '/nonexistent/zcode-app.cjs' }), script);
  } finally {
    process.env.PATH = prevPath;
    if (prevBin !== undefined) process.env.ZCODE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing found throws ZCodeNotFoundError listing all checked candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-disc-'));
  mkdirSync(join(dir, 'emptybin'));
  const prevPath = process.env.PATH;
  const prevBin = process.env.ZCODE_BIN;
  process.env.PATH = join(dir, 'emptybin');
  delete process.env.ZCODE_BIN;
  try {
    assert.throws(
      () => discoverZCode({ macosPath: '/nonexistent/zcode-app.cjs' }),
      (e) =>
        e instanceof ZCodeNotFoundError &&
        e.checked.length >= 2 // macOS candidate + which fallback
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevBin !== undefined) process.env.ZCODE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

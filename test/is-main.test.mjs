// Entry points started through a symlinked path must still run (Node resolves the
// main module to its real path, argv[1] keeps the typed one).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../src/is-main.mjs';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const base = makeTempDir('zcode-ismain-');
const link = join(base, 'clonelink');
symlinkSync(root, link);
after(() => removeDir(base));

test('isMain compares real paths', () => {
  const real = join(root, 'src', 'is-main.mjs');
  const url = pathToFileURL(real).href;
  assert.equal(isMain(url, real), true);
  assert.equal(isMain(url, join(link, 'src', 'is-main.mjs')), true);
  assert.equal(isMain(url, join(root, 'src', 'mcp-server.mjs')), false);
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(url, join(base, 'missing.mjs')), false);
});

test('mcp-server.mjs through a symlinked dir answers initialize', () => {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  const home = join(base, 'home');
  const r = spawnSync(process.execPath, [join(link, 'src', 'mcp-server.mjs')], {
    input: `${init}\n`, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ZCODE_MCP_HOME: home, ZCODE_BIN: fakeBin },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n')[0]).id, 1);
});

test('install.mjs --help and doctor.mjs --bogus through a symlinked dir', () => {
  const h = spawnSync(process.execPath, [join(link, 'scripts', 'install.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage: node scripts\/install\.mjs/);
  const d = spawnSync(process.execPath, [join(link, 'scripts', 'doctor.mjs'), '--bogus'], { encoding: 'utf8' });
  assert.equal(d.status, 2);
  assert.match(d.stderr, /unknown argument/);
});

test('verify-protocol.mjs without --real through a symlinked dir prints usage', () => {
  const r = spawnSync(process.execPath, [join(link, 'scripts', 'verify-protocol.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node scripts\/verify-protocol\.mjs/);
});

test('every entry point uses isMain, not a typed-path URL comparison', () => {
  const files = ['src/job-runner.mjs', 'scripts/smoke-real.mjs', 'scripts/soak-real.mjs', 'scripts/faults-real.mjs', 'scripts/verify-protocol.mjs'];
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(src, /pathToFileURL\(process\.argv\[1\]\)/, f);
    assert.match(src, /isMain\(import\.meta\.url\)/, f);
  }
});

// The real `claude` CLI against this repo — runs ONLY with CLAUDE_REAL=1.
// Everything happens in a temp CLAUDE_CONFIG_DIR and a temp HOME (the user's real
// ~/.claude* is never touched); no model calls (only validate, plugin, mcp commands,
// whose health check starts the MCP server and runs initialize).
//   CLAUDE_REAL=1 node --test test/claude-real.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeDir, fakeBin, fakeAppserverBin } from './helpers.mjs';

const skip = process.env.CLAUDE_REAL !== '1' && 'set CLAUDE_REAL=1 to run against the real claude CLI';
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
let base;
let env;
let cwd;

before(() => {
  if (skip) return;
  base = makeTempDir('zcode-claude-real-');
  cwd = join(base, 'proj');
  for (const d of ['home', 'cfg', 'proj', 'mcp']) mkdirSync(join(base, d));
  env = {
    ...process.env,
    HOME: join(base, 'home'),
    CLAUDE_CONFIG_DIR: join(base, 'cfg'),
    ZCODE_BIN: fakeBin,
    ZCODE_APPSERVER_BIN: fakeAppserverBin,
    ZCODE_MCP_HOME: join(base, 'mcp'),
  };
});

after(() => { if (base) removeDir(base); });

function claude(args) {
  const r = spawnSync('claude', args, { cwd, env, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('claude plugin validate passes, also with --strict', { skip }, () => {
  for (const args of [['plugin', 'validate', root], ['plugin', 'validate', root, '--strict'], ['plugin', 'validate', join(root, '.claude-plugin', 'plugin.json'), '--strict']]) {
    const r = claude(args);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Validation passed/);
    assert.doesNotMatch(r.out, /warning/i);
  }
});

test('plugin route: marketplace add, install, server connected, uninstall', { skip }, () => {
  let r = claude(['plugin', 'marketplace', 'add', root]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /zcode-mcp/);
  r = claude(['plugin', 'install', 'zcode-delegate@zcode-mcp']);
  assert.equal(r.code, 0, r.out);
  r = claude(['plugin', 'details', 'zcode-delegate@zcode-mcp']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Skills \(1\)\s+zcode-delegate/);
  assert.match(r.out, /MCP servers \(1\)\s+zcode/);
  r = claude(['mcp', 'list']);
  assert.match(r.out, /plugin:zcode-delegate:zcode: node .*\/src\/mcp-server\.mjs - ✔ Connected/, r.out);
  r = claude(['plugin', 'uninstall', 'zcode-delegate@zcode-mcp']);
  assert.equal(r.code, 0, r.out);
  r = claude(['mcp', 'list']);
  assert.doesNotMatch(r.out, /plugin:zcode-delegate/);
  r = claude(['plugin', 'marketplace', 'remove', 'zcode-mcp']);
  assert.equal(r.code, 0, r.out);
});

test('script route: install.mjs --target claude-code registers a connected server; --uninstall removes it', { skip }, () => {
  const inst = spawnSync(process.execPath, [join(root, 'scripts', 'install.mjs'), '--target', 'claude-code', '--yes', '--json', '--no-probe'], { cwd, env, encoding: 'utf8', timeout: 180000 });
  assert.equal(inst.status, 0, `${inst.stdout}\n${inst.stderr}`);
  const report = JSON.parse(inst.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.registered[0].status, 'added');
  let r = claude(['mcp', 'get', 'zcode']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Scope: User config/);
  assert.match(r.out, /Status: ✔ Connected/);
  assert(r.out.includes(`Command: ${process.execPath}`), r.out);
  assert(r.out.includes(`Args: ${join(root, 'src', 'mcp-server.mjs')}`), r.out);
  const un = spawnSync(process.execPath, [join(root, 'scripts', 'install.mjs'), '--target', 'claude-code', '--yes', '--json', '--uninstall'], { cwd, env, encoding: 'utf8', timeout: 180000 });
  assert.equal(un.status, 0, `${un.stdout}\n${un.stderr}`);
  r = claude(['mcp', 'get', 'zcode']);
  assert.equal(r.code, 1, r.out);
});

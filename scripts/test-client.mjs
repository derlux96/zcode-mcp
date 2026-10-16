#!/usr/bin/env node
// Exercises the MCP server exactly like a real client would: spawn, stdio, JSON-RPC lines.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const e2e = process.argv.includes('--e2e');
const fakeBin = join(root, 'test', 'fake-zcode.cjs');
let failures = 0;

function assertThat(cond, label) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

class McpClient {
  constructor(env) {
    this.child = spawn(process.execPath, [join(root, 'src', 'mcp-server.mjs')], { env: { ...process.env, ...env } });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  close() {
    this.child.stdin.end();
    return new Promise((r) => this.child.on('close', r));
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'zcode-client-'));
}

function makeDemoRepoCopy() {
  const dir = tempDir();
  cpSync(join(root, 'fixtures', 'demo-repo'), dir, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return dir;
}

// --- default mode: fake binary, no real ZCode needed ---
const stateFile = join(tempDir(), 'sessions.json');
const client = new McpClient({ ZCODE_BIN: fakeBin, ZCODE_MCP_STATE: stateFile });

const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
assertThat(init.result && init.result.serverInfo.name === 'zcode-delegate', 'initialize handshake');
client.notify('notifications/initialized');

const list = await client.request('tools/list', {});
const names = list.result.tools.map((t) => t.name).sort();
assertThat(JSON.stringify(names) === JSON.stringify(['zcode_check', 'zcode_run', 'zcode_sessions']), 'exposes exactly 3 tools');

const check = await client.request('tools/call', { name: 'zcode_check', arguments: {} });
assertThat(/"ok": true/.test(check.result.content[0].text), 'zcode_check ok with fake binary');

const bad = await client.request('tools/call', { name: 'zcode_run', arguments: { prompt: 'x', cwd: 'relative/path' } });
assertThat(bad.result.isError === true && /absolute/.test(bad.result.content[0].text), 'relative cwd rejected');

const runOk = await client.request('tools/call', { name: 'zcode_run', arguments: { prompt: 'fixture task', cwd: tempDir() } });
assertThat(/status: completed/.test(runOk.result.content[0].text) && /sess_fake123/.test(runOk.result.content[0].text), 'zcode_run happy path via fake binary');

const unknown = await client.request('bogus/method', {});
assertThat(unknown.error && unknown.error.code === -32601, 'unknown method → -32601');

// garbage line: server must reply -32700 with id null and keep serving
client.child.stdin.write('this is not json\n');
const afterGarbage = await client.request('ping', {});
assertThat(afterGarbage.result && Object.keys(afterGarbage.result).length === 0, 'server survives a non-JSON line');

await client.close();

// --- e2e mode: real ZCode binary, real task ---
if (e2e) {
  delete process.env.ZCODE_BIN; // use discovery
  const e2eClient = new McpClient({ ZCODE_MCP_STATE: join(tempDir(), 'sessions.json') });
  const repo = makeDemoRepoCopy();
  console.log('e2e repo:', repo);

  const check2 = await e2eClient.request('tools/call', { name: 'zcode_check', arguments: {} });
  assertThat(/"ok": true/.test(check2.result.content[0].text), 'e2e zcode_check against real binary');

  const run1 = await e2eClient.request('tools/call', {
    name: 'zcode_run',
    arguments: { prompt: 'Create a file named hello.txt in the current directory containing exactly the text: zcode-plugin-e2e', cwd: repo, mode: 'edit', timeout_ms: 300000 },
  });
  const text1 = run1.result.content[0].text;
  assertThat(/session_id:/.test(text1), 'e2e plain run returned a session id');

  const run2 = await e2eClient.request('tools/call', {
    name: 'zcode_run',
    arguments: { prompt: 'Create a file named worktree-marker.txt containing: isolated', cwd: repo, mode: 'edit', timeout_ms: 300000, isolate_worktree: true },
  });
  const text2 = run2.result.content[0].text;
  assertThat(/worktree_branch: zcode\//.test(text2), 'e2e isolated run created zcode/ branch');
  assertThat(/worktree kept/.test(text2), 'e2e isolated run documents merge responsibility');

  await e2eClient.close();
  rmSync(repo, { recursive: true, force: true });
}

console.log(failures === 0 ? 'TEST-CLIENT PASS' : `TEST-CLIENT FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);

# grok-zcode-plugin v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `zcode-delegate` marketplace plugin: a zero-dependency stdio MCP server that lets Grok/Cursor delegate coding tasks to a locally installed ZCode via its official headless CLI.

**Architecture:** Single Node ESM package. `protocol.mjs` speaks MCP/JSON-RPC over stdio (no npm deps), `mcp-server.mjs` wires exactly 3 tools (`zcode_check`, `zcode_run`, `zcode_sessions`), `runner.mjs` spawns `zcode.cjs -p …` via argument-array `spawn` with timeout/output-cap, `state.mjs` tracks sessions in `~/.zcode-mcp/sessions.json`, `discover.mjs` finds the ZCode binary. Skill + agent files carry the orchestration knowledge.

**Tech Stack:** Node.js ≥18 (ESM, `.mjs`), built-in `node:test` for tests, no npm dependencies, git.

**Spec:** `docs/superpowers/specs/2026-10-16-grok-zcode-plugin-design.md` — the plan argues from the spec; executors read both.

## Global Constraints

- Node ≥18, ESM (`.mjs`), **zero npm dependencies**, no build step.
- Exactly 3 MCP tools: `zcode_check`, `zcode_run`, `zcode_sessions`. No `zcode_parallel` (v2).
- Spawn ZCode only via argument-array `spawn`/`execFile` — never a shell string.
- `OUTPUT_CAP = 100000` chars per tool result; `DEFAULT_TIMEOUT_MS = 600000`; timeout range `1000–3600000`.
- Permission modes enum: `plan | build | edit | yolo` (default `yolo`).
- State file `~/.zcode-mcp/sessions.json`, permissions `0600`, cap 200 newest entries. Env overrides: `ZCODE_BIN` (binary path), `ZCODE_MCP_STATE` (state file path).
- Worktree branches under namespace `zcode/<slug>`; worktrees under `<cwd>/.zcode-worktrees/`; server never removes/merges worktrees, never runs `git push`/`git commit`.
- Server makes no network requests and never reads credentials (auth is the CLI's shared login).
- Protocol: newline-delimited JSON-RPC 2.0 over stdio; stdout is protocol-only (diagnostics → stderr).
- `skills/` and `agents/` files are English; repo docs English.
- CLI surface used (verified on zcode.cjs 0.16.9): `-p <prompt> --cwd <dir> --mode <mode> --json [--resume <id>] [--target <text>]`, plus subcommands `version`, `doctor`.

---

### Task 1: Project scaffold + SessionStore

**Files:**
- Create: `package.json`, `.gitignore`, `src/state.mjs`, `test/state.test.mjs`

**Interfaces:**
- Consumes: none (first task).
- Produces: `defaultStatePath(): string`; `class SessionStore { constructor(filePath = defaultStatePath()); load(): Entry[]; append(entry: Entry): Entry; list({ cwd } = {}): Entry[] }` where `Entry = { id: string, kind: 'session' | 'run', cwd: string, mode: string, promptPreview: string, startedAt: string, status: 'completed' | 'failed' | 'timeout' }`. Later tasks import from `../src/state.mjs`.

- [ ] **Step 1: Create scaffold files**

`package.json`:

```json
{
  "name": "zcode-delegate",
  "version": "1.0.0",
  "description": "Delegate coding tasks from Grok or Cursor to a locally installed ZCode agent via its official headless CLI.",
  "type": "module",
  "private": true,
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test test/",
    "test:client": "node scripts/test-client.mjs"
  }
}
```

`.gitignore`:

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 2: Write the failing test for SessionStore**

`test/state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, defaultStatePath } from '../src/state.mjs';

const entry = (over = {}) => ({
  id: 'sess_abc123',
  kind: 'session',
  cwd: '/tmp/proj',
  mode: 'yolo',
  promptPreview: 'write tests',
  startedAt: '2026-10-16T10:00:00.000Z',
  status: 'completed',
  ...over,
});

test('defaultStatePath points into ~/.zcode-mcp', () => {
  assert.match(defaultStatePath(), /\.zcode-mcp\/sessions\.json$/);
});

test('append persists entries and list reads them back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'sessions.json'));
  store.append(entry());
  store.append(entry({ id: 'sess_def456', cwd: '/tmp/other' }));
  assert.equal(store.list().length, 2);
  assert.equal(store.list({ cwd: '/tmp/other' })[0].id, 'sess_def456');
  rmSync(dir, { recursive: true, force: true });
});

test('state file is created with 0600 permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const file = join(dir, 'sessions.json');
  const store = new SessionStore(file);
  store.append(entry());
  // 0o600 & 0o777 masks the permission bits on all platforms we support
  assert.equal(statSync(file).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

test('corrupt or missing state file yields empty list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'nope.json'));
  assert.deepEqual(store.list(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('keeps only the 200 newest entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-state-'));
  const store = new SessionStore(join(dir, 'sessions.json'));
  for (let i = 0; i < 205; i++) store.append(entry({ id: `sess_${i}` }));
  const all = store.list();
  assert.equal(all.length, 200);
  assert.equal(all[0].id, 'sess_5');
  assert.equal(all[199].id, 'sess_204');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/state.test.mjs`
Expected: FAIL — cannot find module `../src/state.mjs`.

- [ ] **Step 4: Write minimal implementation**

`src/state.mjs`:

```js
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_ENTRIES = 200;

export function defaultStatePath() {
  return join(homedir(), '.zcode-mcp', 'sessions.json');
}

export class SessionStore {
  constructor(filePath = defaultStatePath()) {
    this.filePath = filePath;
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  append(entry) {
    const entries = [...this.load(), entry].slice(-MAX_ENTRIES);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    chmodSync(this.filePath, 0o600); // also fixes pre-existing files
    return entry;
  }

  list({ cwd } = {}) {
    const entries = this.load();
    return cwd ? entries.filter((e) => e.cwd === cwd) : entries;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/state.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/state.mjs test/state.test.mjs
git commit -m "feat: project scaffold and SessionStore with 0600 perms and 200-entry cap"
```

---

### Task 2: ZCode binary discovery

**Files:**
- Create: `src/discover.mjs`, `test/discover.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `discoverZCode({ env = process.env } = {}): string` — returns an existing path; throws `ZCodeNotFoundError` (with `.checked: string[]`) when nothing is found. Candidate order: `env.ZCODE_BIN` → `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` → `which zcode` on PATH. A set-but-missing `ZCODE_BIN` is a hard error.

- [ ] **Step 1: Write the failing test**

`test/discover.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverZCode, ZCodeNotFoundError } from '../src/discover.mjs';

const MACOS_PATH = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

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
  const prevMacos = MACOS_PATH_EXISTS();
  process.env.PATH = `${join(dir, 'bin')}:${prevPath}`;
  delete process.env.ZCODE_BIN;
  try {
    if (!prevMacos) {
      assert.equal(discoverZCode({}), script);
    } else {
      // this machine has the real app installed; only assert it resolves something
      assert.equal(typeof discoverZCode({}), 'string');
    }
  } finally {
    process.env.PATH = prevPath;
    if (prevBin !== undefined) process.env.ZCODE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

function MACOS_PATH_EXISTS() {
  try {
    execFileSync('test', ['-f', MACOS_PATH]);
    return true;
  } catch {
    return false;
  }
}

test('nothing found throws ZCodeNotFoundError listing all checked candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-disc-'));
  mkdirSync(join(dir, 'emptybin'));
  const prevPath = process.env.PATH;
  const prevBin = process.env.ZCODE_BIN;
  process.env.PATH = join(dir, 'emptybin');
  delete process.env.ZCODE_BIN;
  try {
    if (!MACOS_PATH_EXISTS()) {
      assert.throws(
        () => discoverZCode({}),
        (e) =>
          e instanceof ZCodeNotFoundError &&
          e.checked.length >= 2 // macOS candidate + which fallback
      );
    } else {
      assert.ok(true); // real binary present on this machine; nothing to assert
    }
  } finally {
    process.env.PATH = prevPath;
    if (prevBin !== undefined) process.env.ZCODE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/discover.test.mjs`
Expected: FAIL — cannot find module `../src/discover.mjs`.

- [ ] **Step 3: Write minimal implementation**

`src/discover.mjs`:

```js
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MACOS_PATH = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

export class ZCodeNotFoundError extends Error {
  constructor(checked) {
    super('ZCode binary not found. Checked:\n' + checked.map((c) => `  - ${c}`).join('\n'));
    this.name = 'ZCodeNotFoundError';
    this.checked = checked;
  }
}

function whichZcode() {
  try {
    const p = execFileSync('which', ['zcode'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p || null;
  } catch {
    return null;
  }
}

export function discoverZCode({ env = process.env } = {}) {
  const checked = [];
  if (env.ZCODE_BIN) {
    checked.push(`ZCODE_BIN=${env.ZCODE_BIN}`);
    if (existsSync(env.ZCODE_BIN)) return env.ZCODE_BIN;
    throw new ZCodeNotFoundError([
      ...checked,
      'ZCODE_BIN is set but the file does not exist. Fix the path or unset it.',
    ]);
  }
  checked.push(MACOS_PATH);
  if (existsSync(MACOS_PATH)) return MACOS_PATH;
  const fromPath = whichZcode();
  if (fromPath && existsSync(fromPath)) return fromPath;
  checked.push('which zcode → not found');
  throw new ZCodeNotFoundError([
    ...checked,
    'Set ZCODE_BIN to your zcode.cjs path (e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs on macOS).',
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/discover.test.mjs`
Expected: PASS (4 tests; the two PATH tests tolerate a real install being present).

- [ ] **Step 5: Commit**

```bash
git add src/discover.mjs test/discover.test.mjs
git commit -m "feat: ZCode binary discovery with ZCODE_BIN override, macOS path, PATH fallback"
```

---

### Task 3: MCP/JSON-RPC protocol core

**Files:**
- Create: `src/protocol.mjs`, `test/protocol.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `createProtocol({ tools = [], serverInfo = DEFAULT_SERVER_INFO } = {})` → `{ async handleMessage(msg) → Reply | null }`. `Tool = { name: string, description: string, inputSchema: object, handler(args: object) → Promise<ToolResult> }`, `ToolResult = { content: { type: 'text', text: string }[], isError?: boolean }`. Exported error codes: `PARSE_ERROR = -32700` (used by the entry loop for non-JSON lines, replied with `id: null`), `INVALID_REQUEST = -32600`, `METHOD_NOT_FOUND = -32601`, `INVALID_PARAMS = -32602`, `INTERNAL_ERROR = -32603`. `initialize` echoes the client's `protocolVersion` when in `['2025-06-18','2025-03-26','2024-11-05']`, else replies `'2025-06-18'`. Notifications (no `id`) return `null`. Unknown method → `-32601`; unknown tool in `tools/call` → `-32602`; handler throw → `-32603`.

- [ ] **Step 1: Write the failing test**

`test/protocol.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol } from '../src/protocol.mjs';

const echoTool = {
  name: 'echo',
  description: 'echoes text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  handler: async (args) => ({ content: [{ type: 'text', text: args.text }] }),
};

const makeProto = () => createProtocol({ tools: [echoTool] });

test('initialize returns tools capability and negotiated protocol version', async () => {
  const p = makeProto();
  const reply = await p.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.equal(reply.result.protocolVersion, '2025-03-26');
  assert.deepEqual(reply.result.capabilities, { tools: {} });
  assert.equal(reply.result.serverInfo.name, 'zcode-delegate');
});

test('initialize falls back to 2025-06-18 for unknown versions', async () => {
  const p = makeProto();
  const reply = await p.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(reply.result.protocolVersion, '2025-06-18');
});

test('notifications return null (no reply written)', async () => {
  const p = makeProto();
  assert.equal(await p.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('ping returns empty result', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(reply.result, {});
});

test('tools/list returns name/description/inputSchema only', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(reply.result.tools, [{
    name: 'echo',
    description: 'echoes text',
    inputSchema: echoTool.inputSchema,
  }]);
});

test('tools/call dispatches to the handler', async () => {
  const reply = await makeProto().handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hi' } },
  });
  assert.deepEqual(reply.result.content, [{ type: 'text', text: 'hi' }]);
  assert.equal(reply.result.isError, undefined);
});

test('tools/call with unknown tool name returns -32602', async () => {
  const reply = await makeProto().handleMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  assert.equal(reply.error.code, -32602);
});

test('unknown method returns -32601', async () => {
  const reply = await makeProto().handleMessage({ jsonrpc: '2.0', id: 7, method: 'foo/bar' });
  assert.equal(reply.error.code, -32601);
});

test('handler exceptions become -32603, not a crash', async () => {
  const boom = { ...echoTool, handler: async () => { throw new Error('boom'); } };
  const reply = await createProtocol({ tools: [boom] }).handleMessage({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'x' } },
  });
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/protocol.test.mjs`
Expected: FAIL — cannot find module `../src/protocol.mjs`.

- [ ] **Step 3: Write minimal implementation**

`src/protocol.mjs`:

```js
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_VERSION = '2025-06-18';
const DEFAULT_SERVER_INFO = { name: 'zcode-delegate', version: '1.0.0' };

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function negotiateVersion(params) {
  const requested = params && params.protocolVersion;
  return SUPPORTED_VERSIONS.includes(requested) ? requested : DEFAULT_VERSION;
}

export function createProtocol({ tools = [], serverInfo = DEFAULT_SERVER_INFO } = {}) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    async handleMessage(msg) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return msg && msg.id !== undefined ? fail(msg.id, INVALID_REQUEST, 'Invalid Request') : null;
      }
      if (msg.id === undefined) return null; // notification
      const { id, method, params } = msg;
      try {
        switch (method) {
          case 'initialize':
            return ok(id, {
              protocolVersion: negotiateVersion(params),
              capabilities: { tools: {} },
              serverInfo,
            });
          case 'ping':
            return ok(id, {});
          case 'tools/list':
            return ok(id, {
              tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
            });
          case 'tools/call': {
            const tool = byName.get(params && params.name);
            if (!tool) {
              return fail(id, INVALID_PARAMS, `Unknown tool: ${params && params.name}`);
            }
            const result = await tool.handler((params && params.arguments) || {});
            return ok(id, result);
          }
          default:
            return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
      } catch (error) {
        return fail(id, INTERNAL_ERROR, error && error.message ? error.message : String(error));
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/protocol.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.mjs test/protocol.test.mjs
git commit -m "feat: zero-dependency MCP JSON-RPC 2.0 protocol core over stdio"
```

---

### Task 4: ZCode runner core (validation, spawn, timeout, cap, session extraction)

**Files:**
- Create: `src/runner.mjs`, `test/helpers.mjs`, `test/fake-zcode.cjs`, `test/runner.test.mjs`

**Interfaces:**
- Consumes: none (spawns processes itself).
- Produces:
  - `validateRunArgs(args): { ok: true, value: RunArgs } | { ok: false, error: string }` where `RunArgs = { prompt: string, cwd: string, mode: string, resume?: string, target?: string, timeoutMs: number, isolateWorktree: boolean }`.
  - `runZCodeTask({ binPath, prompt, cwd, mode = 'yolo', resume, target, timeoutMs = DEFAULT_TIMEOUT_MS }): Promise<ZCodeResult>` where `ZCodeResult = { stdout: string, stderr: string, code: number | null, timedOut: boolean, sessionId: string | null }`.
  - `runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs }): Promise<ZCodeResult>` — generic spawn used by `zcode_check` for `version`/`doctor`.
  - Constants: `OUTPUT_CAP = 100000`, `DEFAULT_TIMEOUT_MS = 600000`, `MAX_TIMEOUT_MS = 3600000`, `MIN_TIMEOUT_MS = 1000`, `MODES = ['plan','build','edit','yolo']`.
  - Spawn rule: if `binPath` matches `/\.(?:c|m)?js$/` spawn `process.execPath` with `[binPath, ...args]`, else spawn `binPath` directly. Node-script binaries (`.cjs` like zcode.cjs and the test fake) therefore run under node.

- [ ] **Step 1: Create test helpers and the fake ZCode binary**

`test/helpers.mjs`:

```js
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeTempDir(prefix = 'zcode-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Creates a real git repo with one committed file; returns the path. */
export function makeGitRepo() {
  const dir = makeTempDir('zcode-repo-');
  run(dir, 'git', ['init', '-q']);
  run(dir, 'git', ['config', 'user.email', 'test@example.com']);
  run(dir, 'git', ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  run(dir, 'git', ['add', '.']);
  run(dir, 'git', ['commit', '-qm', 'init']);
  return dir;
}

export function run(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

export const fakeBin = new URL('./fake-zcode.cjs', import.meta.url).pathname;
```

`test/fake-zcode.cjs` (a stand-in for `zcode.cjs`; controlled by `FAKE_ZCODE_MODE`):

```js
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
```

- [ ] **Step 2: Write the failing test**

`test/runner.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  OUTPUT_CAP, DEFAULT_TIMEOUT_MS,
} from '../src/runner.mjs';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';

const base = { prompt: 'do it', cwd: '/tmp' };

test('validateRunArgs accepts a minimal valid call and applies defaults', () => {
  const v = validateRunArgs(base);
  assert.equal(v.ok, true);
  assert.equal(v.value.mode, 'yolo');
  assert.equal(v.value.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(v.value.isolateWorktree, false);
});

test('validateRunArgs rejects relative cwd, bad mode, empty prompt, out-of-range timeout', () => {
  assert.match(validateRunArgs({ ...base, cwd: 'relative/x' }).error, /absolute/i);
  assert.match(validateRunArgs({ ...base, mode: 'fast' }).error, /mode/i);
  assert.match(validateRunArgs({ ...base, prompt: '' }).error, /prompt/i);
  assert.match(validateRunArgs({ ...base, timeout_ms: 10 }).error, /timeout_ms/i);
  assert.match(validateRunArgs({ ...base, timeout_ms: 999999999 }).error, /timeout_ms/i);
  assert.equal(validateRunArgs({ cwd: '/tmp' }).ok, false); // prompt missing
});

test('validateRunArgs rejects nonexistent cwd', () => {
  assert.match(validateRunArgs({ ...base, cwd: '/no/such/dir/at/all' }).error, /exist/i);
});

test('runZCodeTask runs the fake bin, extracts sess_ id, reports exit 0', async () => {
  const cwd = makeTempDir();
  const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.sessionId, 'sess_fake123');
  assert.match(res.stdout, /fake task done/);
  removeDir(cwd);
});

test('runZCodeTask passes --mode/--resume/--target through', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_ECHO_ARGS = '1';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, mode: 'plan', resume: 'sess_x1', target: 'goal text' });
    assert.match(res.stdout, /--mode/);
    assert.match(res.stdout, /plan/);
    assert.match(res.stdout, /sess_x1/);
    assert.match(res.stdout, /goal text/);
  } finally {
    delete process.env.FAKE_ZCODE_ECHO_ARGS;
    removeDir(cwd);
  }
});

test('nonzero exit is reported, session id still extracted', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'fail';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd });
    assert.equal(res.code, 1);
    assert.equal(res.sessionId, 'sess_fail000');
    assert.match(res.stderr, /fake zcode failure/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('timeout kills the child and flags timedOut', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'hang';
  try {
    const res = await runZCodeTask({ binPath: fakeBin, prompt: 'hi', cwd, timeoutMs: 400 });
    assert.equal(res.timedOut, true);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('output is capped at OUTPUT_CAP characters', async () => {
  const cwd = makeTempDir();
  process.env.FAKE_ZCODE_MODE = 'bigoutput';
  try {
    const res = await runZCodeArgs(fakeBin, [], { cwd, timeoutMs: 5000 });
    assert.ok(res.stdout.length <= OUTPUT_CAP + 100); // cap + truncation notice
    assert.match(res.stdout, /truncated/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('runZCodeArgs runs version and doctor subcommands', async () => {
  const cwd = makeTempDir();
  const v = await runZCodeArgs(fakeBin, ['version'], { cwd, timeoutMs: 5000 });
  assert.match(v.stdout, /0\.16\.9/);
  removeDir(cwd);
});
```

Note: the tests reference two fake modes not yet in the fake bin (`bigoutput`, and `FAKE_ZCODE_ECHO_ARGS`). Extend `test/fake-zcode.cjs` in this step — insert before the final `else`:

```js
if (process.env.FAKE_ZCODE_ECHO_ARGS) {
  console.log(JSON.stringify({ argv: args }));
  process.exit(0);
}
if (mode === 'bigoutput') {
  console.log('x'.repeat(500000));
  process.exit(0);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/runner.test.mjs`
Expected: FAIL — cannot find module `../src/runner.mjs`.

- [ ] **Step 4: Write minimal implementation**

`src/runner.mjs`:

```js
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const OUTPUT_CAP = 100000;
export const DEFAULT_TIMEOUT_MS = 600000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 3600000;
export const MODES = ['plan', 'build', 'edit', 'yolo'];

const SESSION_RE = /sess_[A-Za-z0-9._-]+/;
const NODE_SCRIPT_RE = /\.(?:c|m)?js$/;

export function validateRunArgs(args = {}) {
  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, error: 'prompt must be a non-empty string' };
  }
  const cwd = args.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return { ok: false, error: 'cwd must be an absolute path' };
  }
  let isDir;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    return { ok: false, error: `cwd does not exist: ${cwd}` };
  }
  if (!isDir) return { ok: false, error: `cwd is not a directory: ${cwd}` };

  const mode = args.mode === undefined ? 'yolo' : args.mode;
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${MODES.join('|')}` };
  }
  if (args.resume !== undefined && typeof args.resume !== 'string') {
    return { ok: false, error: 'resume must be a string session id' };
  }
  if (args.target !== undefined && typeof args.target !== 'string') {
    return { ok: false, error: 'target must be a string' };
  }
  const timeoutMs = args.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : args.timeout_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, error: `timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
  }
  if (args.isolate_worktree !== undefined && typeof args.isolate_worktree !== 'boolean') {
    return { ok: false, error: 'isolate_worktree must be a boolean' };
  }
  return {
    ok: true,
    value: {
      prompt,
      cwd,
      mode,
      resume: args.resume,
      target: args.target,
      timeoutMs,
      isolateWorktree: args.isolate_worktree === true,
    },
  };
}

function cap(text) {
  if (text.length <= OUTPUT_CAP) return text;
  return text.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]`;
}

function extractSessionId(text) {
  const m = text.match(SESSION_RE);
  return m ? m[0] : null;
}

export async function runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const isNodeScript = NODE_SCRIPT_RE.test(binPath);
  const child = isNodeScript
    ? spawn(process.execPath, [binPath, ...cliArgs], { cwd })
    : spawn(binPath, cliArgs, { cwd });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      stderr += `\n[zcode-delegate] failed to spawn: ${err.message}`;
      resolve({ stdout: cap(stdout), stderr: cap(stderr), code: null, timedOut, sessionId: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout: cap(stdout),
        stderr: cap(stderr),
        code,
        timedOut,
        sessionId: extractSessionId(stdout),
      });
    });
  });
}

export async function runZCodeTask({ binPath, prompt, cwd, mode = 'yolo', resume, target, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const cliArgs = ['-p', prompt, '--cwd', cwd, '--mode', mode, '--json'];
  if (resume) cliArgs.push('--resume', resume);
  if (target) cliArgs.push('--target', target);
  return runZCodeArgs(binPath, cliArgs, { cwd, timeoutMs });
}

export function newRunId() {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/runner.test.mjs`
Expected: PASS (10 tests). The timeout test takes ~0.5 s.

- [ ] **Step 6: Commit**

```bash
git add src/runner.mjs test/helpers.mjs test/fake-zcode.cjs test/runner.test.mjs
git commit -m "feat: zcode runner with validation, spawn, SIGTERM/SIGKILL timeout, output cap, session extraction"
```

---

### Task 5: Worktree isolation

**Files:**
- Modify: `src/runner.mjs` (append git helpers)
- Test: `test/worktree.test.mjs`

**Interfaces:**
- Consumes: `test/helpers.mjs` (`makeGitRepo`, `removeDir`).
- Produces: `assertGitRepo(cwd): Promise<void>` (throws `Error` when `cwd` is not inside a git work tree); `createWorktree(cwd): Promise<{ dir: string, branch: string, slug: string }>` — branch `zcode/<slug>`, dir `<cwd>/.zcode-worktrees/<slug>`, and appends `.zcode-worktrees/` to `<cwd>/.git/info/exclude` exactly once; `worktreeSummary(dir): Promise<{ diffStat: string, changedFiles: string[] }>`; `newWorktreeSlug(): string` (`<timestamp36>-<6 hex>`).

- [ ] **Step 1: Write the failing test**

`test/worktree.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertGitRepo, createWorktree, worktreeSummary, newWorktreeSlug } from '../src/runner.mjs';
import { makeTempDir, makeGitRepo, removeDir } from './helpers.mjs';

test('assertGitRepo passes in a repo and throws outside', async () => {
  const repo = makeGitRepo();
  const plain = makeTempDir();
  await assertGitRepo(repo);
  await assert.rejects(assertGitRepo(plain), /not a git/i);
  removeDir(repo);
  removeDir(plain);
});

test('newWorktreeSlug is timestamp + 6 hex chars', () => {
  assert.match(newWorktreeSlug(), /^[0-9a-z]+-[0-9a-f]{6}$/);
});

test('createWorktree makes branch, dir, and excludes .zcode-worktrees from git status', async () => {
  const repo = makeGitRepo();
  const { dir, branch, slug } = await createWorktree(repo);
  assert.match(branch, /^zcode\//);
  assert.ok(dir.includes(slug));
  assert.ok(existsSync(dir));
  assert.ok(existsSync(join(dir, 'README.md'))); // worktree checks out HEAD
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /\.zcode-worktrees\//);
  // idempotent: second call must not duplicate the exclude line
  await createWorktree(repo);
  const exclude2 = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal((exclude2.match(/\.zcode-worktrees\//g) || []).length, 1);
  removeDir(repo);
});

test('worktreeSummary reports diffStat and changed files', async () => {
  const repo = makeGitRepo();
  const { dir } = await createWorktree(repo);
  writeFileSync(join(dir, 'new-file.txt'), 'hello\n');
  const summary = await worktreeSummary(dir);
  assert.match(summary.diffStat, /new-file\.txt/);
  assert.deepEqual(summary.changedFiles, ['?? new-file.txt']);
  removeDir(repo);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worktree.test.mjs`
Expected: FAIL — assertGitRepo is not exported.

- [ ] **Step 3: Append implementation to `src/runner.mjs`**

```js
import { appendFileSync, readFileSync } from 'node:fs'; // add to the existing node:fs import

const run = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed: ${err || out}`))));
  });

export function newWorktreeSlug() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export async function assertGitRepo(cwd) {
  const out = await run(['rev-parse', '--is-inside-work-tree'], cwd);
  if (out.trim() !== 'true') throw new Error(`${cwd} is not a git work tree`);
}

export async function createWorktree(cwd) {
  const slug = newWorktreeSlug();
  const branch = `zcode/${slug}`;
  const dir = join(cwd, '.zcode-worktrees', slug);
  await run(['worktree', 'add', '-b', branch, dir], cwd);
  const excludePath = join(cwd, '.git', 'info', 'exclude');
  let exclude = '';
  try {
    exclude = readFileSync(excludePath, 'utf8');
  } catch {
    // no exclude file yet — create it below
  }
  if (!exclude.includes('.zcode-worktrees/')) {
    appendFileSync(excludePath, `${exclude.endsWith('\n') || exclude === '' ? '' : '\n'}.zcode-worktrees/\n`);
  }
  return { dir, branch, slug };
}

export async function worktreeSummary(dir) {
  const diffStat = (await run(['diff', '--stat'], dir)).trim();
  const status = await run(['status', '--porcelain'], dir);
  const changedFiles = status.split('\n').map((l) => l.trim()).filter(Boolean);
  return { diffStat, changedFiles };
}
```

Also extend the existing import line at the top of `src/runner.mjs` to `import { appendFileSync, readFileSync, statSync } from 'node:fs';` and add `import { join } from 'node:path';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worktree.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: PASS (state, discover, protocol, runner, worktree).

- [ ] **Step 6: Commit**

```bash
git add src/runner.mjs test/worktree.test.mjs
git commit -m "feat: git worktree isolation (zcode/<slug> branch, exclude entry, diff summary)"
```

---

### Task 6: Tool wiring + server entry

**Files:**
- Create: `src/mcp-server.mjs`, `test/tools.test.mjs`

**Interfaces:**
- Consumes: `createProtocol` (Task 3), `discoverZCode` (Task 2), `SessionStore`/`defaultStatePath` (Task 1), runner functions (Tasks 4–5).
- Produces: `buildTools({ store } = {}): Tool[]` (the 3 MCP tools) and `main(): void` (readline stdio loop). `main()` runs only when the file is executed directly. The store defaults to `new SessionStore(process.env.ZCODE_MCP_STATE || defaultStatePath())`.

- [ ] **Step 1: Write the failing test**

`test/tools.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProtocol } from '../src/protocol.mjs';
import { buildTools } from '../src/mcp-server.mjs';
import { SessionStore } from '../src/state.mjs';
import { makeTempDir, removeDir, fakeBin } from './helpers.mjs';

let store;
let proto;
const call = (name, args) => proto.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const textOf = (reply) => reply.result.content[0].text;

beforeEach(() => {
  const dir = makeTempDir('zcode-tools-');
  process.env.ZCODE_BIN = fakeBin;
  process.env.ZCODE_MCP_STATE = `${dir}/sessions.json`;
  store = new SessionStore(process.env.ZCODE_MCP_STATE);
  proto = createProtocol({ tools: buildTools({ store }) });
});

test('exposes exactly the three spec tools with object schemas', async () => {
  const reply = await proto.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['zcode_check', 'zcode_run', 'zcode_sessions']);
  for (const t of reply.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  const run = reply.result.tools.find((t) => t.name === 'zcode_run');
  assert.deepEqual(run.inputSchema.required, ['prompt', 'cwd']);
});

test('zcode_check reports ok with the fake binary', async () => {
  const reply = await call('zcode_check', {});
  assert.match(textOf(reply), /"ok": true/);
  assert.match(textOf(reply), /0\.16\.9/);
});

test('zcode_run happy path: status, session_id, state entry', async () => {
  const cwd = makeTempDir('zcode-run-');
  const reply = await call('zcode_run', { prompt: 'say hi', cwd });
  const text = textOf(reply);
  assert.match(text, /status: completed/);
  assert.match(text, /session_id: sess_fake123/);
  const entries = store.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'sess_fake123');
  assert.equal(entries[0].kind, 'session');
  assert.equal(entries[0].status, 'completed');
  removeDir(cwd);
});

test('zcode_run records a non-resumable run-id when CLI prints no session id', async () => {
  const cwd = makeTempDir('zcode-run-');
  process.env.FAKE_ZCODE_MODE = 'nosession';
  try {
    const reply = await call('zcode_run', { prompt: 'x', cwd });
    assert.match(textOf(reply), /not resumable/);
    const entries = store.list();
    assert.equal(entries[0].kind, 'run');
    assert.match(entries[0].id, /^run_/);
  } finally {
    delete process.env.FAKE_ZCODE_MODE;
    removeDir(cwd);
  }
});

test('zcode_run rejects relative cwd with isError and a diagnosis', async () => {
  const reply = await call('zcode_run', { prompt: 'x', cwd: 'relative/path' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /absolute/);
});

test('zcode_run refuses to resume server-generated run-ids', async () => {
  const cwd = makeTempDir('zcode-run-');
  const reply = await call('zcode_run', { prompt: 'x', cwd, resume: 'run_deadbeef_abc123' });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /not resumable/);
  removeDir(cwd);
});

test('zcode_run with isolate_worktree in a non-repo returns isError with a git hint', async () => {
  const cwd = makeTempDir('zcode-norepo-');
  const reply = await call('zcode_run', { prompt: 'x', cwd, isolate_worktree: true });
  assert.equal(reply.result.isError, true);
  assert.match(textOf(reply), /git/i);
  removeDir(cwd);
});

test('zcode_sessions lists recorded entries and flags run-ids', async () => {
  const cwd = makeTempDir('zcode-run-');
  await call('zcode_run', { prompt: 'first task', cwd });
  const reply = await call('zcode_sessions', {});
  assert.match(textOf(reply), /sess_fake123/);
  assert.match(textOf(reply), /first task/);
  const filtered = await call('zcode_sessions', { cwd: '/nowhere' });
  assert.match(textOf(filtered), /no sessions/i);
  removeDir(cwd);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tools.test.mjs`
Expected: FAIL — cannot find module `../src/mcp-server.mjs`.

- [ ] **Step 3: Write the implementation**

`src/mcp-server.mjs`:

```js
#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createProtocol, PARSE_ERROR } from './protocol.mjs';
import { discoverZCode, ZCodeNotFoundError } from './discover.mjs';
import { SessionStore, defaultStatePath } from './state.mjs';
import {
  validateRunArgs, runZCodeTask, runZCodeArgs,
  assertGitRepo, createWorktree, worktreeSummary, newRunId,
  MODES, DEFAULT_TIMEOUT_MS, OUTPUT_CAP,
} from './runner.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const failText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const toolSchemas = {
  zcode_check: {
    name: 'zcode_check',
    description:
      'Verify that a ZCode installation is reachable: binary path, version, and a best-effort health check. Call this once before the first delegation on a machine.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  zcode_run: {
    name: 'zcode_run',
    description:
      'Delegate one coding task to ZCode via its official headless CLI. ZCode runs as a full agent (it can read/edit files and run commands in cwd). Inspect the returned output, changed files, and test results before accepting the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed task specification: goal, files, edge cases, tests, definition of done.' },
        cwd: { type: 'string', description: 'Absolute path of the project directory the task runs in.' },
        mode: { type: 'string', enum: MODES, description: 'Permission mode: plan (read-only plan first), build, edit, yolo (autonomous, default).' },
        resume: { type: 'string', description: 'Existing ZCode session id (sess_...) to continue a previous conversation. Server run-ids (run_...) are not resumable.' },
        target: { type: 'string', description: 'Optional session goal passed to ZCode (--target).' },
        timeout_ms: { type: 'integer', description: `Task timeout in milliseconds (${DEFAULT_TIMEOUT_MS} default, max 3600000).` },
        isolate_worktree: { type: 'boolean', description: 'Run the task in an isolated git worktree on a new zcode/<slug> branch. The worktree is kept; you must merge or remove it explicitly.' },
      },
      required: ['prompt', 'cwd'],
      additionalProperties: false,
    },
  },
  zcode_sessions: {
    name: 'zcode_sessions',
    description:
      'List sessions that ran through this server (id, status, mode, cwd, prompt preview). Use a sess_... id with zcode_run/resume to continue multi-iteration work; run_... ids are not resumable.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Optional absolute path to filter sessions by project directory.' } },
      additionalProperties: false,
    },
  },
};

function buildCheckHandler() {
  return async () => {
    let binPath;
    try {
      binPath = discoverZCode();
    } catch (error) {
      if (error instanceof ZCodeNotFoundError) {
        return failText(`${JSON.stringify({ ok: false, problem: 'binary-not-found', checked: error.checked }, null, 2)}\nInstall ZCode or set ZCODE_BIN, then retry.`);
      }
      throw error;
    }
    const version = await runZCodeArgs(binPath, ['version'], { cwd: process.cwd(), timeoutMs: 15000 });
    let doctor = null;
    try {
      const d = await runZCodeArgs(binPath, ['doctor'], { cwd: process.cwd(), timeoutMs: 15000 });
      doctor = { ok: d.code === 0, excerpt: d.stdout.trim().slice(-500) };
    } catch (e) {
      doctor = { ok: false, excerpt: String(e.message).slice(0, 500) };
    }
    const ok = version.code === 0;
    return text(JSON.stringify({ ok, binPath, version: version.stdout.trim(), doctor }, null, 2));
  };
}

function buildRunHandler(store) {
  return async (args) => {
    const v = validateRunArgs(args);
    if (!v.ok) return failText(`Invalid arguments: ${v.error}`);
    const { prompt, cwd, mode, resume, target, timeoutMs, isolateWorktree } = v.value;
    if (resume && resume.startsWith('run_')) {
      return failText(`'${resume}' is a server-generated run-id and is not resumable. Use zcode_sessions to find a real ZCode session id (sess_...).`);
    }
    let binPath;
    try {
      binPath = discoverZCode();
    } catch (error) {
      return failText(`ZCode binary not found. ${error.message}`);
    }

    let worktree = null;
    if (isolateWorktree) {
      try {
        await assertGitRepo(cwd);
        worktree = await createWorktree(cwd);
      } catch (error) {
        return failText(`isolate_worktree requires a git repository: ${error.message}`);
      }
    }

    const res = await runZCodeTask({
      binPath, prompt, cwd: worktree ? worktree.dir : cwd, mode, resume, target, timeoutMs,
    });

    const sessionId = res.sessionId || newRunId();
    const status = res.timedOut ? 'timeout' : res.code === 0 ? 'completed' : 'failed';
    store.append({
      id: sessionId,
      kind: res.sessionId ? 'session' : 'run',
      cwd,
      mode,
      promptPreview: prompt.slice(0, 80),
      startedAt: new Date().toISOString(),
      status,
    });

    const lines = [
      `status: ${status} (exit ${res.code}${res.timedOut ? ', timed out' : ''})`,
      `session_id: ${sessionId}${res.sessionId ? '' : '  (server run-id, not resumable)'}`,
    ];
    if (worktree) {
      const summary = await worktreeSummary(worktree.dir);
      lines.push(
        `worktree_branch: ${worktree.branch}`,
        `worktree_dir: ${worktree.dir}`,
        `changed_files: ${summary.changedFiles.length ? summary.changedFiles.join(', ') : 'none'}`,
        `diff_stat:\n${summary.diffStat || '(no changes)'}`,
        'worktree kept — merge it (git merge) or remove it (git worktree remove) explicitly.'
      );
    }
    lines.push('--- zcode output ---', res.stdout);
    if (res.stderr.trim()) lines.push('--- zcode stderr ---', res.stderr);

    const body = lines.join('\n');
    const truncated = body.length > OUTPUT_CAP;
    const result = text((truncated ? body.slice(0, OUTPUT_CAP) + `\n[... output truncated at ${OUTPUT_CAP} chars]` : body));
    if (status !== 'completed') result.isError = true;
    return result;
  };
}

function buildSessionsHandler(store) {
  return async (args = {}) => {
    const entries = store.list(args.cwd ? { cwd: args.cwd } : {});
    if (!entries.length) return text('no sessions recorded for this filter yet');
    const rows = entries
      .map((e) => `${e.id} | ${e.kind === 'run' ? 'NOT-RESUMABLE' : 'resumable'} | ${e.status} | ${e.mode} | ${e.startedAt} | ${e.cwd} | ${e.promptPreview}`)
      .join('\n');
    return text(`sessions (newest last):\n${rows}`);
  };
}

export function buildTools({ store = new SessionStore(process.env.ZCODE_MCP_STATE || defaultStatePath()) } = {}) {
  return [
    { ...toolSchemas.zcode_check, handler: buildCheckHandler() },
    { ...toolSchemas.zcode_run, handler: buildRunHandler(store) },
    { ...toolSchemas.zcode_sessions, handler: buildSessionsHandler(store) },
  ];
}

export function main() {
  const protocol = createProtocol({ tools: buildTools() });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[zcode-delegate] non-JSON line ignored: ${trimmed.slice(0, 120)}\n`);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } }) + '\n');
      return;
    }
    protocol.handleMessage(msg).then((reply) => {
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    }).catch((error) => {
      process.stderr.write(`[zcode-delegate] handler crash: ${error && error.stack}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tools.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Manual smoke check of the real binary (only on a machine with ZCode installed)**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zcode_check","arguments":{}}}' | node src/mcp-server.mjs`
Expected: one JSON line on stdout containing `"ok": true` and the real version (0.16.9). If the machine has no ZCode: `"problem": "binary-not-found"` — also a valid outcome.

- [ ] **Step 6: Run full suite + commit**

Run: `npm test` — Expected: PASS (all suites).

```bash
git add src/mcp-server.mjs test/tools.test.mjs
git commit -m "feat: wire zcode_check/zcode_run/zcode_sessions tools and stdio server entry"
```

---

### Task 7: Test client + demo fixture

**Files:**
- Create: `scripts/test-client.mjs`, `fixtures/demo-repo/README.md`, `fixtures/demo-repo/src/app.js`

**Interfaces:**
- Consumes: `src/mcp-server.mjs` as a spawned child process (protocol per Task 3), `test/helpers.mjs`.
- Produces: `scripts/test-client.mjs` — default mode asserts handshake/tools/check/error-paths against the fake binary; `--e2e` mode additionally runs two real `zcode_run` calls (plain + `isolate_worktree`) against a temp copy of `fixtures/demo-repo`. Exit code 0 = pass. `fixtures/demo-repo/` is a plain directory (no `.git`); the client git-inits a temp copy.

- [ ] **Step 1: Create the fixture files**

`fixtures/demo-repo/README.md`:

```markdown
# demo repo

Tiny fixture used by `scripts/test-client.mjs --e2e` to verify real ZCode delegation.
```

`fixtures/demo-repo/src/app.js`:

```js
export function add(a, b) {
  return a + b;
}
```

- [ ] **Step 2: Write the test client**

`scripts/test-client.mjs`:

```js
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
```

- [ ] **Step 3: Run the default mode**

Run: `node scripts/test-client.mjs`
Expected: `TEST-CLIENT PASS` (7 assertions). Note: top-level `await` requires the script to be ESM — it is, because `package.json` sets `"type": "module"`.

- [ ] **Step 4: Run e2e mode (only on a machine with a logged-in ZCode)**

Run: `node scripts/test-client.mjs --e2e`
Expected: `TEST-CLIENT PASS` (9 assertions). This performs 2 real ZCode tasks (~1–5 min total). If login is missing, `zcode_check` reports `ok: false` — fix with `zcode login` and rerun.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-client.mjs fixtures/
git commit -m "feat: MCP test client (default + --e2e) and demo-repo fixture"
```

---

### Task 8: Skill + agent definitions

**Files:**
- Create: `skills/zcode-delegate/SKILL.md`, `agents/zcode-worker.md`

**Interfaces:**
- Consumes: the tool contracts from Task 6 (`zcode_check`, `zcode_run`, `zcode_sessions` with `isolate_worktree`).
- Produces: plugin content files consumed by Grok/Cursor at install time; no code interface.

- [ ] **Step 1: Write `skills/zcode-delegate/SKILL.md`**

```markdown
---
name: zcode-delegate
description: Delegate coding tasks (multi-file changes, refactors, test suites, implementations) to a locally installed ZCode agent via the zcode_run MCP tool. Use when a task needs a real agent runtime that reads, edits, and tests code.
---

# ZCode Task Delegation

You are the orchestrator: you write the specification and verify the result. ZCode executes.
Answer trivial questions yourself — do not spawn a ZCode task for anything a single file read cannot justify.

## 1. Pre-flight

On the first delegation on a machine, call `zcode_check`. If it reports a missing binary,
tell the user to install ZCode or set `ZCODE_BIN`; do not retry until they confirm.

## 2. Mode matrix

| Situation | mode |
|---|---|
| Risky or novel change, unclear architecture | `plan` first — review the plan, then run again with `build` |
| Implementation with an approved plan or clear spec | `build` |
| Small, precisely located fix | `edit` |
| Well-scoped task that should finish autonomously (default) | `yolo` |

## 3. Writing delegation prompts

A good `prompt` is a specification, not a wish. Include:
- Goal in one sentence.
- Affected files/paths (absolute or repo-relative).
- Edge cases to handle.
- Test requirement ("run the test suite; add tests for X").
- Definition of done.

Bad: "fix the login bug".
Good: "In src/auth/login.ts the session cookie is not refreshed on rotation. Fix the refresh, handle the expired-refresh-token case by redirecting to /login, and add tests for both cases in src/auth/login.test.ts. Run npm test — done when all tests pass."

## 4. Verification loop

After every `zcode_run`:
1. Read the returned `status:` line. Non-zero exit or timeout means the task failed — read `--- zcode output ---` before retrying.
2. Check `changed_files:` / `diff_stat` (present when `isolate_worktree` was used) and the test output inside the zcode output.
3. On failure, iterate: call `zcode_run` again with `resume` set to the returned `session_id` (a `sess_...` id) and a correction hint. Do not start over from scratch — the session keeps context.
4. Maximum two retries, then report the failure to the user with the output excerpt.

## 5. Sessions

- `zcode_sessions` lists past runs; filter with `cwd`.
- Only `sess_...` ids are resumable. Ids marked `NOT-RESUMABLE` (server run-ids, `run_...`) exist only for bookkeeping.

## 6. Worktree isolation

Use `isolate_worktree: true` when the task might conflict with uncommitted local work or when the user wants a reviewable branch:
- ZCode works on a new `zcode/<slug>` branch in `.zcode-worktrees/<slug>/`.
- The worktree is NEVER cleaned up by the server. After verifying the diff, either merge it (`git merge <branch>`) or discard it (`git worktree remove <dir>` and `git branch -D <branch>`).
- Report leftover worktrees to the user explicitly.
```

- [ ] **Step 2: Write `agents/zcode-worker.md`**

```markdown
---
name: zcode-worker
description: Delegation engineer that executes coding tasks through ZCode (zcode_run), verifies diffs and tests, iterates via resume, and reports structured results. Use for concrete implementation tasks delegated to the local ZCode agent.
tools: zcode_check, zcode_run, zcode_sessions
---

You are a delegation engineer. Your only job is to turn a task specification into a
verified result produced by ZCode — never edit files yourself.

Workflow:
1. If this is your first task on this machine, call `zcode_check`. On failure, report the
   diagnosis and stop.
2. Call `zcode_run` with the task specification. Choose `mode` per the zcode-delegate skill
   (plan for risky changes, build after an approved plan, edit for small fixes, yolo for
   well-scoped autonomous work). Use `isolate_worktree: true` when the spec asks for a
   reviewable branch or the working tree has uncommitted work.
3. Verify: read the status line, the changed files / diff stat, and any test output in the
   zcode output. A task is done only when tests pass or the spec's definition of done is met.
4. If the task failed: retry at most twice by calling `zcode_run` with `resume` = the returned
   `session_id` and a short correction hint. After two failed retries, stop and report.
5. Report back in this shape:
   - Result: done | failed | partial
   - Session: <session_id>
   - Changed files: <list from diff/changed_files>
   - Tests: pass/fail summary or "none required"
   - Worktree: branch + dir if isolation was used, plus an explicit reminder that the user
     must merge or remove it
   - Follow-ups: anything you noticed but did not do

Never: run more than one zcode task at a time in the same cwd, resume a `run_...` id,
or claim success without reading the zcode output.
```

- [ ] **Step 3: Validate frontmatter**

Run: `node -e "const fs=require('fs');for(const f of ['skills/zcode-delegate/SKILL.md','agents/zcode-worker.md']){const t=fs.readFileSync(f,'utf8');if(!/^---\nname: [\w-]+\ndescription: .+\n/.test(t))throw new Error('bad frontmatter: '+f)}console.log('frontmatter ok')"`
Expected: `frontmatter ok`.

- [ ] **Step 4: Commit**

```bash
git add skills/ agents/
git commit -m "feat: zcode-delegate skill and zcode-worker agent definitions"
```

---

### Task 9: Plugin manifest, README, final verification

**Files:**
- Create: `.mcp.json`, `plugin.json`, `README.md`
- Modify: none.

**Interfaces:**
- Consumes: the whole plugin from Tasks 1–8.
- Produces: the installable plugin surface for Grok/Cursor and the reviewer-facing documentation.

- [ ] **Step 1: Write `.mcp.json`**

```json
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["./src/mcp-server.mjs"],
      "env": {}
    }
  }
}
```

- [ ] **Step 2: Write `plugin.json`**

```json
{
  "name": "zcode-delegate",
  "version": "1.0.0",
  "description": "Delegate coding tasks from Grok or Cursor to a locally installed ZCode agent via its official headless CLI.",
  "author": { "name": "derlux" },
  "homepage": "https://github.com/derlux/grok-zcode-plugin",
  "keywords": ["zcode", "delegation", "coding-agent", "orchestration"]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# zcode-delegate (grok-zcode-plugin)

Delegate coding tasks from **Grok** or **Cursor** to a locally installed **ZCode** agent.
Grok stays the orchestrator (spec, verification); ZCode executes (edit files, run tests)
through its official headless CLI. Zero npm dependencies — the MCP server is plain Node.

## Requirements

- Node.js ≥ 18
- ZCode installed and logged in (`zcode login`). Default binary search order:
  `ZCODE_BIN` env → `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (macOS) → `zcode` on PATH.

## What the plugin provides

- **MCP server** (stdio): `zcode_check`, `zcode_run`, `zcode_sessions`
- **Skill** `zcode-delegate`: when and how to delegate (mode matrix, prompt quality, verification loop)
- **Agent** `zcode-worker`: a delegation-engineer subagent for Grok

`zcode_run` runs `zcode -p "<prompt>" --cwd <dir> --mode <plan|build|edit|yolo> --json`
with optional `--resume`/`--target`, a timeout, and optional git-worktree isolation
(`isolate_worktree: true` → new `zcode/<slug>` branch; the worktree is kept and must be
merged or removed explicitly).

## Local testing

```bash
npm test                      # unit tests (fake zcode binary, no login needed)
node scripts/test-client.mjs  # client integration test (fake binary)
node scripts/test-client.mjs --e2e   # real ZCode tasks (needs zcode login)
```

Manual exploration with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node src/mcp-server.mjs
```

## Testing instructions for marketplace reviewers

1. Requirements: Node ≥ 18, ZCode desktop app installed and logged in on macOS
   (or any machine with `ZCODE_BIN` pointing at `zcode.cjs`).
2. Install this plugin, then run the health check:
   - Prompt: `Check the ZCode installation` → expected tool call `zcode_check`,
     result contains `"ok": true` and version `0.16.9` or newer.
3. Single delegation in any small git repo:
   - Prompt: `Delegate to ZCode: create hello.txt containing "marketplace-review" in /path/to/repo`
     → expected tool call `zcode_run` (`mode: yolo`), result contains `status: completed`
     and a `session_id`.
4. Resume flow:
   - Prompt: `Show the ZCode sessions for that repo` → expected `zcode_sessions`;
     then `Continue the previous ZCode session and append "!" to hello.txt`
     → expected `zcode_run` with `resume: <sess_...>`.
5. Worktree isolation:
   - Prompt: `Delegate to ZCode in an isolated worktree: add a README section "reviewed"`
     → expected `zcode_run` with `isolate_worktree: true`, result contains
     `worktree_branch: zcode/` and the merge/remove reminder.

## Security notes

- The server spawns only `node <zcode.cjs>` and `git` (worktree add/diff/status) with
  argument arrays — no shell, no network, no credential access.
- Sessions are recorded in `~/.zcode-mcp/sessions.json` (0600, last 200 entries).
- Task output is capped at 100,000 characters; every task has a timeout (default 10 min).

## License

MIT
```

- [ ] **Step 4: Run the full verification suite**

Run: `npm test && node scripts/test-client.mjs`
Expected: all unit tests PASS + `TEST-CLIENT PASS`.

- [ ] **Step 5: Commit**

```bash
git add .mcp.json plugin.json README.md
git commit -m "feat: plugin manifest (.mcp.json, plugin.json) and reviewer-facing README"
```

- [ ] **Step 6: Manual install verification (user, once Grok Build / Cursor are at hand)**

Install the plugin locally in Cursor and in Grok Build; confirm the MCP server starts and
`zcode_check` succeeds in each. **Spec verification point:** if the relative path
`./src/mcp-server.mjs` does not resolve (client runs the command from a different cwd),
switch `.mcp.json` to the placeholder form the client documents (e.g.
`${CLAUDE_PLUGIN_ROOT}/src/mcp-server.mjs`) and re-test in both clients. Commit the result.
```

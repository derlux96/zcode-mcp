import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { getProcessIdentity, signalGroup } from '../src/procid.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

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

export const fakeBin = fileURLToPath(new URL('./fake-zcode.cjs', import.meta.url));

export const fakeAppserverBin = fileURLToPath(new URL('./fake-appserver.cjs', import.meta.url));
const serverPath = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; throws after timeoutMs. */
export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/**
 * A real `src/mcp-server.mjs` child speaking newline-delimited JSON-RPC on
 * stdio. `env` entries override the defaults (ZCODE_BIN = fake zcode).
 */
export class StdioClient {
  constructor({ home, env = {} } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.messages = []; // every parsed line the server wrote
    this.stderr = '';
    this.buf = '';
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ZCODE_MCP_HOME: home, ZCODE_BIN: fakeBin, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pid = this.child.pid;
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (d) => { this.stderr += d; });
    this.child.stdout.on('data', (d) => this.onData(String(d)));
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.hasExited = true;
        for (const p of this.pending.values()) p.reject(new Error(`server exited (code ${code}, signal ${signal})`));
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    this.child.on('error', () => {});
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { msg = { unparsable: line }; }
      this.messages.push(msg);
      const p = msg.id !== undefined && msg.id !== null ? this.pending.get(msg.id) : null;
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  /** Writes a raw line (tests for malformed input). */
  writeRaw(line) {
    this.child.stdin.write(`${line}\n`);
  }

  /** Sends a request; resolves with `result`, rejects on JSON-RPC error/timeout/exit. */
  request(method, params, { timeoutMs = 30000 } = {}) {
    return this.requestWithId(method, params, { timeoutMs }).promise;
  }

  /** Like request, but also returns the id (for notifications/cancelled). */
  requestWithId(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error) {
            const e = new Error(msg.error.message);
            e.code = msg.error.code;
            reject(e);
          } else resolve(msg.result);
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return { id, promise };
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  async callTool(name, args = {}, opts) {
    const raw = await this.request('tools/call', { name, arguments: args }, opts);
    const text = (raw.content || []).map((c) => c.text).join('\n');
    return { text, isError: raw.isError === true, raw };
  }

  kill(signal = 'SIGTERM') {
    try { this.child.kill(signal); } catch { /* already gone */ }
  }

  closeStdin() {
    this.child.stdin.end();
  }
}

/**
 * Signals a process (or, with group: true, its process group) only when it is
 * provably ours: pid is an integer > 1 and its identity matches the recorded
 * start time (expectStart) or its command line contains `marker`. Returns true
 * when signalled. Only ESRCH is swallowed. `kill` is injectable for tests.
 */
export function safeSignal(pid, signal, { expectStart, marker, group = false, kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const id = getProcessIdentity(pid);
  if (!id || id.unknown) return false;
  const byStart = typeof expectStart === 'string' && id.start === expectStart;
  const byMarker = typeof marker === 'string' && marker !== '' && id.command.includes(marker);
  if (!byStart && !byMarker) return false;
  try {
    if (group) {
      if (!kill) return signalGroup(pid, signal);
      kill(-pid, signal);
    } else {
      (kill || process.kill)(pid, signal);
    }
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

/** Throws when a process whose command line contains one of `markers` is alive (polls up to ~3 s). */
export async function assertNoLeftoverProcesses(markers, { timeoutMs = 3000 } = {}) {
  const find = () => execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() && l.trim().split(/\s+/)[0] !== String(process.pid))
    .filter((l) => markers.some((m) => l.includes(m)));
  const end = Date.now() + timeoutMs;
  let hits = find();
  while (hits.length && Date.now() < end) {
    await sleep(100);
    hits = find();
  }
  if (hits.length) throw new Error(`leftover processes matching ${JSON.stringify(markers)}:\n${hits.join('\n')}`);
}

/**
 * Per-test scope: temp home/cwds/clients, and a cleanup that stops only what
 * the test itself started (job ids and pids it recorded).
 */
export class TestScope {
  constructor() {
    this.home = makeTempDir('zcode-stdio-home-');
    this.dirs = [this.home];
    this.clients = [];
    this.jobIds = new Set();
    this.watched = []; // { pid, start }: recorded children that must be dead after cleanup
    this.markers = [basename(this.home)];
  }

  cwd() {
    const dir = makeTempDir('zcode-stdio-cwd-');
    this.dirs.push(dir);
    this.markers.push(basename(dir));
    return realpathSync(dir);
  }

  client(env = {}) {
    const c = new StdioClient({
      home: this.home,
      env: { ZCODE_MCP_STATE: join(this.home, 'sessions.json'), ...env },
    });
    this.clients.push(c);
    return c;
  }

  /** Remembers a job id for cleanup; returns it. */
  track(jobId) {
    this.jobIds.add(jobId);
    return jobId;
  }

  jobStatus(jobId) {
    try { return JSON.parse(readFileSync(join(this.home, 'jobs', jobId, 'status.json'), 'utf8')); } catch { return null; }
  }

  /** Records a job's current child (ZCode CLI or app-server) so cleanup can prove it is gone. */
  watchChild(jobId) {
    const st = this.jobStatus(jobId);
    assert(st && Number.isInteger(st.childPid), `job ${jobId} recorded no child pid`);
    this.watched.push({ pid: st.childPid, start: st.childStart });
  }

  async cleanup() {
    const live = this.clients.filter((c) => !c.hasExited);
    let helper = live[0];
    if (this.jobIds.size) {
      try {
        if (!helper) { helper = this.client(); await helper.initialize(); }
        for (const id of this.jobIds) await helper.callTool('zcode_cancel', { job_id: id }, { timeoutMs: 10000 }).catch(() => {});
      } catch { /* fall through to pid kills */ }
    }
    // Fallback: only the pids recorded in this test's own job status files.
    const marker = this.markers[0];
    for (const id of this.jobIds) {
      const s = this.jobStatus(id);
      if (!s || ['completed', 'failed', 'timeout', 'cancelled', 'lost'].includes(s.state)) continue;
      safeSignal(s.pid, 'SIGKILL', { expectStart: s.pidStart, marker });
      if (s.childPgid === s.childPid) safeSignal(s.childPid, 'SIGKILL', { expectStart: s.childStart, group: true });
    }
    for (const c of this.clients) c.kill('SIGKILL');
    await Promise.all(this.clients.map((c) => c.exited));
    try {
      await assertNoLeftoverProcesses(this.markers);
      for (const w of this.watched) {
        await waitFor(() => { const id = getProcessIdentity(w.pid); return !id || (!id.unknown && id.start !== w.start); }, { timeoutMs: 3000, what: `recorded child ${w.pid} to be gone` });
      }
    } finally {
      for (const d of this.dirs) removeDir(d);
    }
  }
}

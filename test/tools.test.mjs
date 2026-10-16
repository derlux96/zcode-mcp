import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProtocol } from '../src/protocol.mjs';
import { buildTools } from '../src/mcp-server.mjs';
import { SessionStore } from '../src/state.mjs';
import { makeTempDir, removeDir, fakeBin, makeGitRepo, run } from './helpers.mjs';

const fakeAppserverBin = new URL('./fake-appserver.cjs', import.meta.url).pathname;

/** Point mode B (ZCODE_APPSERVER_BIN) at the fake app-server for one test. */
async function withAppserver(mode, fn) {
  const prevMode = process.env.FAKE_APPSERVER_MODE;
  process.env.ZCODE_APPSERVER_BIN = fakeAppserverBin;
  process.env.FAKE_APPSERVER_MODE = mode;
  try {
    return await fn();
  } finally {
    delete process.env.ZCODE_APPSERVER_BIN;
    if (prevMode === undefined) delete process.env.FAKE_APPSERVER_MODE;
    else process.env.FAKE_APPSERVER_MODE = prevMode;
  }
}

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

// --- zcode_run protocol mode (model param set, mode B) ---

test('zcode_run with a bare model id: completed, real sess_ id, state entry', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'say hi', cwd, model: 'small' });
      const text = textOf(reply);
      assert.equal(reply.result.isError, undefined);
      assert.match(text, /status: completed/);
      assert.match(text, /session_id: sess_fakeB1\n/);
      assert.match(text, /--- zcode output ---\nfake model task done/);
      const entries = store.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, 'session');
      assert.equal(entries[0].id, 'sess_fakeB1');
      assert.equal(entries[0].status, 'completed');
      // Bare modelId costs two sessions: throwaway catalog fetch + the run.
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(received.filter((m) => m.method === 'session/create').length, 2);
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run with "providerId/modelId" passes the resolved selection on the wire', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'go', cwd, model: 'glm-test/big' });
      assert.match(textOf(reply), /status: completed/);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection, {
        providerId: 'glm-test',
        modelId: 'big',
        options: { reasoningLevel: 'high' }, // default when reasoning_level is absent
      });
      // "providerId/modelId" splits statically: no throwaway catalog session.
      assert.equal(received.filter((m) => m.method === 'session/create').length, 1);
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run forwards an explicit reasoning_level on the wire', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'go', cwd, model: 'glm-test/big', reasoning_level: 'low' });
      assert.match(textOf(reply), /status: completed/);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection.options, { reasoningLevel: 'low' });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run with an unresolvable model is an error listing the available models', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'does-not-exist' });
      assert.equal(reply.result.isError, true);
      const text = textOf(reply);
      assert.match(text, /does-not-exist/);
      assert.match(
        text,
        /Available models:\nglm-test\/small \(reasoning: low,medium,high\)\nglm-test\/big \(reasoning: low,high,max\)\nfake-openrouter\/nimbus-xl \(reasoning: low,medium,xhigh\)\nfake-local\/plain$/,
      );
      assert.equal(store.list().length, 0, 'nothing recorded for a rejected model');
    } finally {
      removeDir(cwd);
    }
  });
});

test('zcode_run rejects an invalid reasoning_level before spawning anything', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'small', reasoning_level: 'extreme' });
      assert.equal(reply.result.isError, true);
      assert.match(textOf(reply), /reasoning_level/);
      assert.equal(existsSync(log), false, 'validation must fail before any app-server spawn');
      assert.equal(store.list().length, 0);
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run rejects reasoning_level without model (mode A ignores nothing silently)', async () => {
  const cwd = makeTempDir('zcode-run-');
  try {
    const reply = await call('zcode_run', { prompt: 'x', cwd, reasoning_level: 'low' });
    assert.equal(reply.result.isError, true);
    assert.match(textOf(reply), /reasoning_level/);
  } finally {
    removeDir(cwd);
  }
});

test('zcode_run model mode maps turn.failed to isError with the failure message', async () => {
  await withAppserver('fail', async () => {
    const cwd = makeTempDir('zcode-runb-');
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'glm-test/small' });
      assert.equal(reply.result.isError, true);
      const text = textOf(reply);
      assert.match(text, /status: failed/);
      assert.match(text, /session_id: sess_fakeB1\n/);
      assert.match(text, /fake model failure/);
      const entries = store.list();
      assert.equal(entries[0].kind, 'session');
      assert.equal(entries[0].status, 'failed');
    } finally {
      removeDir(cwd);
    }
  });
});

test('zcode_run model mode timeout: status timeout, isError, run-id state entry', async () => {
  await withAppserver('slowhang', async () => {
    const cwd = makeTempDir('zcode-runb-');
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'glm-test/small', timeout_ms: 1000 });
      assert.equal(reply.result.isError, true);
      const text = textOf(reply);
      assert.match(text, /status: timeout/);
      assert.match(text, /not resumable/);
      assert.match(text, /timed out/);
      const entries = store.list();
      assert.equal(entries[0].kind, 'run');
      assert.equal(entries[0].status, 'timeout');
    } finally {
      removeDir(cwd);
    }
  });
});

test('zcode_run model mode honors isolate_worktree (session runs in the worktree)', async () => {
  await withAppserver('ok', async () => {
    const repo = makeGitRepo();
    const log = join(repo, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd: repo, model: 'small', isolate_worktree: true });
      const text = textOf(reply);
      assert.match(text, /status: completed/);
      assert.match(text, /worktree_branch: zcode\//);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const creates = received.filter((m) => m.method === 'session/create');
      assert.equal(creates.length, 2, 'catalog fetch + run session');
      assert.equal(creates[0].params.workspace.workspacePath, repo, 'catalog fetch runs against cwd before the worktree exists');
      assert.ok(creates[1].params.workspace.workspacePath.startsWith(`${repo}/.zcode-worktrees/`), 'the run session uses the worktree dir');
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(repo);
    }
  });
});

test('zcode_run model mode with an unresolvable model creates NO worktree', async () => {
  await withAppserver('ok', async () => {
    const repo = makeGitRepo();
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd: repo, model: 'does-not-exist', isolate_worktree: true });
      assert.equal(reply.result.isError, true);
      assert.match(textOf(reply), /Available models:/);
      assert.equal(existsSync(join(repo, '.zcode-worktrees')), false, 'no worktree dir leaked');
      assert.equal(run(repo, 'git', ['branch', '--list', 'zcode/*']).trim(), '', 'no zcode/ branch leaked');
      assert.equal(store.list().length, 0);
    } finally {
      removeDir(repo);
    }
  });
});

test('zcode_run model mode rejects mode instead of silently dropping it', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'small', mode: 'plan' });
      assert.equal(reply.result.isError, true);
      assert.match(textOf(reply), /mode/);
      assert.equal(existsSync(log), false, 'rejection happens before any spawn');
      assert.equal(store.list().length, 0);
      // The default yolo is what protocol mode actually does: explicit is fine.
      const yolo = await call('zcode_run', { prompt: 'x', cwd, model: 'small', mode: 'yolo' });
      assert.match(textOf(yolo), /status: completed/);
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

// --- zcode_run reasoning-level substitution (Controller Ruling 14) ---

test('zcode_run substitutes an unoffered reasoning_level and prints the notice', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      // Default level is high; nimbus-xl offers low|medium|xhigh only.
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'fake-openrouter/nimbus-xl' });
      assert.match(textOf(reply), /status: completed/);
      assert.match(
        textOf(reply),
        /\[notice\] reasoning_level high not offered by fake-openrouter\/nimbus-xl; using xhigh instead/,
      );
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection, {
        providerId: 'fake-openrouter',
        modelId: 'nimbus-xl',
        options: { reasoningLevel: 'xhigh' },
      });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run with explicit xhigh passes through without a notice', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'fake-openrouter/nimbus-xl', reasoning_level: 'xhigh' });
      assert.match(textOf(reply), /status: completed/);
      assert.doesNotMatch(textOf(reply), /\[notice\]/);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection.options, { reasoningLevel: 'xhigh' });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_run with an offered reasoning_level: no substitution, no notice', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-runb-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_run', { prompt: 'x', cwd, model: 'fake-openrouter/nimbus-xl', reasoning_level: 'low' });
      assert.match(textOf(reply), /status: completed/);
      assert.doesNotMatch(textOf(reply), /\[notice\]/);
      const received = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const send = received.find((m) => m.method === 'session/send');
      assert.deepEqual(send.params.modelSelection.options, { reasoningLevel: 'low' });
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

// --- zcode_check include_models ---

test('zcode_check with include_models appends the catalog from the app-server', async () => {
  await withAppserver('ok', async () => {
    const reply = await call('zcode_check', { include_models: true });
    const text = textOf(reply);
    assert.match(text, /"ok": true/);
    assert.match(
      text,
      /models:\nglm-test\/small \(reasoning: low,medium,high\)\nglm-test\/big \(reasoning: low,high,max\)\nfake-openrouter\/nimbus-xl \(reasoning: low,medium,xhigh\)\nfake-local\/plain$/,
    );
  });
});

test('zcode_check without include_models keeps the v1 output (no models section)', async () => {
  await withAppserver('ok', async () => {
    const cwd = makeTempDir('zcode-check-');
    const log = join(cwd, 'rx.log');
    process.env.FAKE_APPSERVER_LOG = log;
    try {
      const reply = await call('zcode_check', {});
      const text = textOf(reply);
      assert.match(text, /"ok": true/);
      assert.doesNotMatch(text, /models:/);
      assert.doesNotMatch(text, /warning/);
      assert.equal(existsSync(log), false, 'fast path: no app-server spawn at all');
    } finally {
      delete process.env.FAKE_APPSERVER_LOG;
      removeDir(cwd);
    }
  });
});

test('zcode_check include_models degrades to a warning when the catalog fetch fails', async () => {
  await withAppserver('die', async () => {
    const reply = await call('zcode_check', { include_models: true });
    const text = textOf(reply);
    assert.match(text, /"ok": true/, 'the check itself stays ok exactly as v1 computed it');
    assert.match(text, /\[warning\] models unavailable: /);
    assert.doesNotMatch(text, /glm-test\//);
  });
});

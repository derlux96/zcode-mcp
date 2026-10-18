// scripts/install.mjs and scripts/doctor.mjs end to end: a fake `claude` on PATH,
// temp HOME / CLAUDE_CONFIG_DIR / ZCODE_MCP_HOME / TMPDIR, the fake ZCode binaries.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeDir, fakeBin, fakeAppserverBin, assertNoLeftoverProcesses } from './helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const INSTALL = join(root, 'scripts', 'install.mjs');
const DOCTOR = join(root, 'scripts', 'doctor.mjs');
const SERVER = join(root, 'src', 'mcp-server.mjs');
const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.cjs', import.meta.url));
const REPORT_KEYS = ['ok', 'version', 'user', 'home', 'steps', 'registered', 'files', 'nextSteps'];

let t; // per-test context

beforeEach(() => {
  const base = makeTempDir('zcode-inst-');
  const dirs = { home: join(base, 'home'), claudeHome: join(base, 'claude-cfg'), bin: join(base, 'bin'), nodeBin: join(base, 'nodebin'), mcpHome: join(base, 'mcp'), tmp: join(base, 'tmp'), cwd: join(base, 'proj') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  // PATH gets node via its own dir, never the directory of a real `claude`.
  symlinkSync(process.execPath, join(dirs.nodeBin, 'node'));
  const desktopDir = join(dirs.home, 'Library', 'Application Support', 'Claude');
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(join(dirs.bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  t = {
    base, ...dirs,
    desktop: join(desktopDir, 'claude_desktop_config.json'),
    state: join(base, 'claude-state.json'),
    log: join(base, 'claude-log.jsonl'),
    appserver: appserverWrapper(base, 'ok'),
  };
});

afterEach(async () => {
  await assertNoLeftoverProcesses([basename(t.base)]);
  assert.deepEqual(readdirSync(t.tmp).filter((f) => f.startsWith('zcode-probe-')), [], 'no probe dir left');
  removeDir(t.base);
});

// A private copy of the fake app-server's entry with a fixed mode (the self-test
// passes only a clean env to the server, so the mode cannot come from FAKE_*).
function appserverWrapper(base, mode) {
  const p = join(base, `appserver-${mode}.cjs`);
  writeFileSync(p, `process.env.FAKE_APPSERVER_MODE = ${JSON.stringify(mode)};\nrequire(${JSON.stringify(fakeAppserverBin)});\n`);
  return p;
}

function env(extra = {}) {
  return {
    HOME: t.home,
    USER: process.env.USER || 'tester',
    PATH: [t.bin, t.nodeBin, '/usr/bin', '/bin'].join(':'),
    TMPDIR: t.tmp,
    CLAUDE_CONFIG_DIR: t.claudeHome,
    FAKE_CLAUDE_STATE: t.state,
    FAKE_CLAUDE_LOG: t.log,
    ZCODE_BIN: fakeBin,
    ZCODE_APPSERVER_BIN: t.appserver,
    ZCODE_MCP_HOME: t.mcpHome,
    ...extra,
  };
}

function run(script, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: t.cwd, env: env(extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function install(args, extraEnv) {
  const r = await run(INSTALL, args, extraEnv);
  let report = null;
  if (args.includes('--json')) {
    assert.doesNotThrow(() => { report = JSON.parse(r.stdout); }, `stdout is one JSON document:\n${r.stdout}\n${r.stderr}`);
  }
  return { ...r, report };
}

const claudeCalls = () => (existsSync(t.log) ? readFileSync(t.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).argv) : []);
const claudeCwds = () => readFileSync(t.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).cwd);
const state = () => (existsSync(t.state) ? JSON.parse(readFileSync(t.state, 'utf8')) : {});
const step = (report, name) => report.steps.find((s) => s.name === name);
const skillPath = () => join(t.claudeHome, 'skills', 'zcode-delegate', 'SKILL.md');
const agentPath = () => join(t.claudeHome, 'agents', 'zcode-worker.md');
// I-2: the registered node is the PATH entry (t.nodeBin/node) when it is the running binary.
const nodePath = () => join(t.nodeBin, 'node');
const want = () => ({ command: nodePath(), args: [SERVER] });
// Pre-existing registrations: the fake's state plus the config file the real CLI would have.
function seed(st) {
  writeFileSync(t.state, JSON.stringify(st));
  writeFileSync(join(t.claudeHome, '.claude.json'), '{}\n');
}

test('dry-run: reports the plan, writes nothing, one JSON document on stdout', async () => {
  const r = await install(['--dry-run', '--json', '--target', 'all']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(r.report), REPORT_KEYS);
  assert.equal(r.report.ok, true);
  assert.equal(r.report.version, '1.2.0');
  assert.equal(r.report.home, t.home);
  assert.deepEqual(r.report.registered.map((x) => [x.target, x.status]), [['claude-code', 'would-add'], ['claude-desktop', 'would-add']]);
  assert(r.report.files.every((f) => f.action.startsWith('would-')), JSON.stringify(r.report.files));
  assert(!claudeCalls().some((a) => a[1] === 'add'), 'no claude mcp add');
  assert(!existsSync(t.desktop));
  assert(!existsSync(skillPath()));
  assert(!existsSync(join(t.claudeHome, '.claude.json')), 'no `claude` call created its config in a dry run');
  assert(r.report.files.some((f) => f.path === join(t.claudeHome, '.claude.json') && f.action === 'would-write'));
  assert(!r.report.steps.some((s) => s.name.startsWith('selftest:')), 'no self-test in a dry run');
});

test('install all targets, self-test with the model probe, then an idempotent re-run', async () => {
  const r = await install(['--yes', '--json', '--target', 'all']);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.report.ok, true);
  const regEnv = { ZCODE_BIN: fakeBin, ZCODE_APPSERVER_BIN: t.appserver, ZCODE_MCP_HOME: t.mcpHome };
  assert.deepEqual(state().user.zcode, { ...want(), env: regEnv });
  assert.deepEqual(JSON.parse(readFileSync(t.desktop, 'utf8')), { mcpServers: { zcode: { ...want(), env: regEnv } } });
  assert.equal(readFileSync(skillPath(), 'utf8'), readFileSync(join(root, 'skills', 'zcode-delegate', 'SKILL.md'), 'utf8'));
  assert.equal(readFileSync(agentPath(), 'utf8'), readFileSync(join(root, 'claude', 'agents', 'zcode-worker.md'), 'utf8'));
  assert.deepEqual(r.report.registered.map((x) => [x.target, x.status]), [['claude-code', 'added'], ['claude-desktop', 'added']]);
  for (const p of [t.desktop, skillPath(), agentPath(), join(t.claudeHome, '.claude.json')]) assert(r.report.files.some((f) => f.path === p && f.action === 'written'), p);
  assert.equal(step(r.report, 'selftest:probe').ok, true);
  assert.match(step(r.report, 'selftest:probe').detail, /glm-test\/small/);
  assert.match(step(r.report, 'preflight:user').detail, new RegExp(t.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert(!JSON.stringify(r.report).includes('sk-'), 'no key material');
  assert.deepEqual([...new Set(claudeCwds())], [realpathSync(t.home)], 'user scope: claude runs from HOME, not from the cwd');

  const again = await install(['--yes', '--json', '--target', 'all', '--no-probe']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.report.registered.map((x) => x.status), ['unchanged', 'unchanged']);
  assert.equal(claudeCalls().filter((a) => a[1] === 'add').length, 1, 'claude mcp add ran once');
  assert(again.report.files.every((f) => f.action === 'unchanged'), JSON.stringify(again.report.files));
  assert.match(step(r.report, 'preflight:node').detail, new RegExp(`at ${nodePath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(readdirSync(dirname(t.desktop)), ['claude_desktop_config.json'], 'no backup when nothing changed');
});

test('a different server under the same name stops the run unless --force', async () => {
  seed({ user: { zcode: { command: 'python3', args: ['/other/server.py', '--api-key', 'sk-SENTINEL-1'], env: {} } } });
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe']);
  assert.equal(r.code, 1);
  const s = step(r.report, 'register:claude-code');
  assert.equal(s.ok, false);
  assert.match(s.detail, /python3 \/other\/server\.py --api-key \*\*\*/);
  assert(!(r.stdout + r.stderr).includes('sk-SENTINEL-1'), 'a foreign server\'s secret args are masked');
  assert.match(s.fix, /--force/);
  assert.equal(state().user.zcode.command, 'python3', 'left alone');

  const f = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe', '--force']);
  assert.equal(f.code, 0, f.stderr);
  assert.equal(f.report.registered[0].status, 'replaced');
  assert.equal(state().user.zcode.command, nodePath());
});

test('project scope: a user-scope server of the same name is not touched; re-run and uninstall stay in scope', async () => {
  seed({ user: { zcode: { command: 'python3', args: ['/other.py'], env: {} } } });
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--scope', 'project', '--no-probe']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.report.registered[0].status, 'added');
  assert.match(step(r.report, 'register:claude-code').detail, /also exists in the user scope/);
  assert.equal(state().project.zcode.command, nodePath());
  assert.deepEqual([...new Set(claudeCwds())], [realpathSync(t.cwd)], 'project scope: claude runs in the project dir');
  assert(existsSync(join(t.cwd, '.claude', 'skills', 'zcode-delegate', 'SKILL.md')));
  assert(existsSync(join(t.cwd, '.claude', 'agents', 'zcode-worker.md')));
  const again = await install(['--yes', '--json', '--target', 'claude-code', '--scope', 'project', '--no-probe']);
  assert.equal(again.report.registered[0].status, 'unchanged');
  const u = await install(['--uninstall', '--yes', '--json', '--target', 'claude-code', '--scope', 'project']);
  assert.equal(u.code, 0);
  assert.deepEqual(state().project, {});
  assert.equal(state().user.zcode.command, 'python3', 'the user-scope server stays');
});

test('--scope project inside the zcode-mcp clone is refused', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [INSTALL, '--yes', '--json', '--target', 'claude-code', '--scope', 'project', '--no-probe'], { cwd: root, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, report: JSON.parse(stdout) }));
  });
  assert.equal(r.code, 1);
  assert.match(step(r.report, 'register:claude-code').detail, /zcode-mcp clone/);
  assert(!claudeCalls().some((a) => a[1] === 'add'));
});

test('Claude Desktop: other servers and keys survive, a backup is written first; invalid JSON is refused', async () => {
  const before = { theme: 'dark', mcpServers: { other: { command: 'x', args: ['y'] } } };
  writeFileSync(t.desktop, JSON.stringify(before));
  const r = await install(['--yes', '--json', '--target', 'claude-desktop', '--no-probe']);
  assert.equal(r.code, 0, r.stderr);
  const after = JSON.parse(readFileSync(t.desktop, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.mcpServers.other, before.mcpServers.other);
  assert.equal(after.mcpServers.zcode.command, nodePath());
  const backups = readdirSync(dirname(t.desktop)).filter((f) => /\.bak-\d{8}-\d{6}$/.test(f));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(t.desktop), backups[0]), 'utf8')), before);
  assert(r.report.files.some((f) => f.action === 'backup'));

  writeFileSync(t.desktop, '{ broken');
  const bad = await install(['--yes', '--json', '--target', 'claude-desktop', '--no-probe']);
  assert.equal(bad.code, 1);
  assert.match(step(bad.report, 'register:claude-desktop').detail, /not valid JSON/);
  assert.equal(readFileSync(t.desktop, 'utf8'), '{ broken');
});

test('uninstall removes exactly what the installer added and keeps backups', async () => {
  writeFileSync(t.desktop, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  seed({ user: { keep: { command: 'k', args: [], env: {} } } });
  assert.equal((await install(['--yes', '--json', '--target', 'all', '--no-probe'])).code, 0);
  const u = await install(['--uninstall', '--yes', '--json', '--target', 'all']);
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(state().user, { keep: { command: 'k', args: [], env: {} } });
  assert.deepEqual(JSON.parse(readFileSync(t.desktop, 'utf8')), { mcpServers: { other: { command: 'x' } } });
  assert(!existsSync(dirname(skillPath())), 'the skill dir it created is gone');
  assert(!existsSync(agentPath()));
  assert.equal(readdirSync(dirname(t.desktop)).filter((f) => f.includes('.bak-')).length, 2, 'install and uninstall backups kept');
  assert.deepEqual(u.report.registered.map((x) => [x.target, x.status]), [['claude-code', 'removed'], ['claude-desktop', 'removed']]);
  // Second uninstall: nothing left to do.
  const again = await install(['--uninstall', '--yes', '--json', '--target', 'all']);
  assert.equal(again.code, 0);
  assert.deepEqual(again.report.registered.map((x) => x.status), ['absent', 'absent']);
});

test('uninstall leaves a foreign server and a modified agent alone', async () => {
  assert.equal((await install(['--yes', '--json', '--target', 'claude-code', '--no-probe'])).code, 0);
  writeFileSync(agentPath(), 'my own edits\n');
  const s = state();
  s.user.zcode.command = 'python3';
  writeFileSync(t.state, JSON.stringify(s));
  const u = await install(['--uninstall', '--yes', '--json', '--target', 'claude-code']);
  assert.equal(u.code, 0);
  assert.equal(state().user.zcode.command, 'python3');
  assert.equal(readFileSync(agentPath(), 'utf8'), 'my own edits\n');
  assert(!existsSync(skillPath()), 'the unmodified skill is removed');
  assert.equal(u.report.registered[0].status, 'foreign');
});

test('self-test failures carry the specific fix and exit 1', async () => {
  const cases = [
    [{ ZCODE_BIN: join(t.base, 'missing', 'zcode.cjs') }, [], 'selftest:zcode', /Install ZCode|ZCODE_BIN/],
    [{ ZCODE_APPSERVER_BIN: appserverWrapper(t.base, 'fail-auth') }, [], 'selftest:probe', /setup-zcode-cli-auth\.zsh/],
    [{ ZCODE_APPSERVER_BIN: appserverWrapper(t.base, 'fail-model-creation') }, [], 'selftest:probe', /zcode login/],
    [{ ZCODE_APPSERVER_BIN: appserverWrapper(t.base, 'fail-1113-always') }, [], 'selftest:probe', /balance/],
  ];
  for (const [extra, args, name, fix] of cases) {
    const r = await install(['--yes', '--json', '--target', 'claude-code', ...args], extra);
    assert.equal(r.code, 1, `${name}: ${r.stderr}`);
    assert.equal(r.report.ok, false);
    const s = step(r.report, name);
    assert.equal(s.ok, false, JSON.stringify(r.report.steps));
    assert.match(s.fix, fix);
  }
});

test('a provider baseUrl with a trailing dot fails the self-test with file and field', async () => {
  const cfgDir = join(t.home, '.zcode', 'v2');
  mkdirSync(cfgDir, { recursive: true });
  const SECRET = 'sk-test-secret-value-123';
  writeFileSync(join(cfgDir, 'provider_config.json'), JSON.stringify({ config: { providerConfigRules: { providerRules: [
    { providerId: 'zai-coding-plan', enabled: true, config: { group: 'standard-personal', access: { type: 'zhipu-coding-plan-api-key', apiKey: SECRET }, api: { baseUrl: 'https://api.z.ai/api/coding/paas/v4.', type: 'openai-compatible' } } },
  ] } } }));
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe']);
  assert.equal(r.code, 1);
  const s = step(r.report, 'selftest:providers');
  assert.equal(s.ok, false);
  assert.match(s.fix, /provider_config\.json/);
  assert.match(s.fix, /config\.api\.baseUrl/);
  assert(!(r.stdout + r.stderr).includes(SECRET), 'the key is never printed');
  assert.match(s.detail, /key present/);
});

test('without a terminal and without --yes nothing is written (exit 2)', async () => {
  const r = await install(['--target', 'claude-code']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--yes/);
  assert(!claudeCalls().some((a) => a[1] === 'add'));
});

test('usage errors exit 2', async () => {
  const r = await install(['--target', 'grok']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--target must be one of/);
});

test('claude missing: skipped when another target works, a failure when it is the only one', async () => {
  const noClaude = { PATH: [t.nodeBin, '/usr/bin', '/bin'].join(':'), CLAUDE_CONFIG_DIR: join(t.base, 'absent-claude') };
  const auto = await install(['--yes', '--json', '--no-probe'], noClaude);
  assert.equal(auto.code, 0, auto.stderr);
  assert.deepEqual(auto.report.registered.map((x) => [x.target, x.status]), [['claude-desktop', 'added']]);
  const only = await install(['--yes', '--json', '--no-probe', '--target', 'claude-code'], noClaude);
  assert.equal(only.code, 1);
  const s = step(only.report, 'register:claude-code');
  assert.equal(s.ok, false);
  assert.match(s.fix, /claude/);
});

test('an installed zcode-delegate plugin skips the user-level server, skill and agent', async () => {
  mkdirSync(join(t.claudeHome, 'plugins'), { recursive: true });
  writeFileSync(join(t.claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'zcode-delegate@zcode-mcp': [{ scope: 'user' }] } }));
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(step(r.report, 'register:claude-code').detail, /plugin zcode-delegate@zcode-mcp/);
  assert(!existsSync(skillPath()) && !existsSync(agentPath()));
  assert(!claudeCalls().some((a) => a[1] === 'add'));
});

test('--copy-to registers the copy; --name renames the agent tools', async () => {
  const dest = join(t.base, 'stable', 'zcode-mcp');
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe', '--copy-to', dest, '--name', 'zc2']);
  assert.equal(r.code, 0, r.stderr);
  assert(existsSync(join(dest, 'src', 'mcp-server.mjs')) && existsSync(join(dest, 'package.json')));
  // dest lies under /var/folders (a symlink to /private/var): the server must still start (C-1).
  assert.deepEqual(state().user.zc2.args, [join(dest, 'src', 'mcp-server.mjs')]);
  assert(existsSync(join(dest, '.zcode-mcp-runtime')));
  const agent = readFileSync(agentPath(), 'utf8');
  assert.match(agent, /mcp__zc2__zcode_run/);
  assert.doesNotMatch(agent, /mcp__zcode__/);
  assert.equal(step(r.report, 'selftest:server').ok, true);
});

test('a runtime in a temporary directory is flagged', async () => {
  const dest = join(t.tmp, 'zcode-copy');
  const r = await install(['--dry-run', '--json', '--target', 'claude-code', '--copy-to', dest]);
  assert.equal(r.code, 0);
  assert.match(step(r.report, 'preflight:runtime').detail, /temporary/);
  assert.match(step(r.report, 'preflight:runtime').fix, /--copy-to/);
});

test('doctor: static checks without probe pass; a failing probe exits 1; install --doctor delegates', async () => {
  const d = await run(DOCTOR, ['--json', '--no-probe']);
  assert.equal(d.code, 0, d.stderr);
  const rep = JSON.parse(d.stdout);
  assert.deepEqual(Object.keys(rep).slice(0, REPORT_KEYS.length), REPORT_KEYS);
  assert(Array.isArray(rep.providers));
  assert.equal(rep.steps.find((s) => s.name === 'selftest:probe').detail.includes('skipped'), true);

  const bad = await run(DOCTOR, ['--json'], { ZCODE_APPSERVER_BIN: appserverWrapper(t.base, 'fail-auth') });
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.stdout).steps.find((s) => s.name === 'selftest:probe').fix, /hidden input/);

  const human = await run(INSTALL, ['--doctor', '--no-probe']);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /PASS/);
  assert.match(human.stdout, new RegExp(`user .* home ${t.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal((await run(DOCTOR, ['--bogus'])).code, 2);
});

test('uninstall removes our registration even when the env (or node path) differs from the install', async () => {
  assert.equal((await install(['--yes', '--json', '--target', 'all', '--no-probe'])).code, 0);
  const u = await install(['--uninstall', '--yes', '--json', '--target', 'all'], { ZCODE_BIN: '', ZCODE_APPSERVER_BIN: '', ZCODE_MCP_HOME: '' });
  assert.equal(u.code, 0, u.stderr);
  assert.deepEqual(u.report.registered.map((x) => x.status), ['removed', 'removed']);
  assert.deepEqual(state().user, {});
  assert.deepEqual(JSON.parse(readFileSync(t.desktop, 'utf8')).mcpServers, {});
  assert(u.report.nextSteps.some((n) => /disappears/.test(n)));
});

test('uninstall from another location reports failure and keeps the server', async () => {
  const other = join(t.base, 'old-clone', 'src', 'mcp-server.mjs');
  seed({ user: { zcode: { command: 'node', args: [other], env: {} } } });
  writeFileSync(t.desktop, JSON.stringify({ mcpServers: { zcode: { command: 'node', args: [other] } } }));
  const u = await install(['--uninstall', '--yes', '--json', '--target', 'all']);
  assert.equal(u.code, 1);
  assert.deepEqual(u.report.registered.map((x) => x.status), ['elsewhere', 'elsewhere']);
  assert.equal(step(u.report, 'register:claude-code').ok, false);
  assert(!u.report.nextSteps.some((n) => /disappears/.test(n)));
  assert.equal(state().user.zcode.args[0], other);
});

test('install updates our own earlier registration (other env / node path) without --force', async () => {
  seed({ user: { zcode: { command: '/old/node/bin/node', args: [SERVER], env: { ZCODE_BIN: '/old' } } } });
  writeFileSync(t.desktop, JSON.stringify({ mcpServers: { zcode: { command: '/old/node/bin/node', args: [SERVER] } } }));
  const r = await install(['--yes', '--json', '--target', 'all', '--no-probe']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.report.registered.map((x) => x.status), ['updated', 'updated']);
  assert.equal(state().user.zcode.command, nodePath());
  assert.equal(JSON.parse(readFileSync(t.desktop, 'utf8')).mcpServers.zcode.command, nodePath());
});

test('--copy-to refuses a non-empty foreign directory; replaces an earlier copy; --force overrides', async () => {
  const dest = join(t.base, 'myapp');
  mkdirSync(join(dest, 'src'), { recursive: true });
  writeFileSync(join(dest, 'package.json'), '{"name":"myapp"}');
  const r = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe', '--copy-to', dest]);
  assert.equal(r.code, 1);
  assert.match(step(r.report, 'copy-runtime').detail, /not a zcode-mcp runtime copy/);
  assert.equal(readFileSync(join(dest, 'package.json'), 'utf8'), '{"name":"myapp"}');
  assert(!claudeCalls().some((a) => a[1] === 'add'));

  const copy = join(t.base, 'stable');
  assert.equal((await install(['--yes', '--json', '--target', 'claude-code', '--no-probe', '--copy-to', copy])).code, 0);
  writeFileSync(join(copy, 'src', 'stale.mjs'), '');
  const again = await install(['--yes', '--json', '--target', 'claude-code', '--no-probe', '--copy-to', copy]);
  assert.equal(again.code, 0, again.stderr);
  assert(!existsSync(join(copy, 'src', 'stale.mjs')), 'stale files of an earlier copy are gone');

  const forced = await install(['--yes', '--json', '--target', 'claude-desktop', '--no-probe', '--copy-to', dest, '--force']);
  assert.equal(forced.code, 0, forced.stderr);
});

test('--json refusals (usage error, no terminal) still print one JSON document', async () => {
  for (const args of [['--json', '--target', 'grok'], ['--json', '--target', 'claude-code']]) {
    const r = await install(args);
    assert.equal(r.code, 2);
    assert.equal(r.report.ok, false);
    assert.deepEqual(Object.keys(r.report), REPORT_KEYS);
  }
  const d = await run(DOCTOR, ['--json', '--bogus']);
  assert.equal(d.code, 2);
  assert.equal(JSON.parse(d.stdout).steps[0].name, 'usage');
});

test('the documented `npm run -s doctor -- --json` prints exactly one JSON document', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn('npm', ['run', '-s', 'doctor', '--', '--json', '--no-probe'], { cwd: root, env: { ...env(), PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

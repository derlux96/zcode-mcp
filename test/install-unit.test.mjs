// Pure parts of scripts/install.mjs and scripts/doctor.mjs: argument parsing,
// Claude Desktop config merge, paths, plugin detection, `claude mcp get` parsing,
// self-test evaluation and its fix texts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseInstallArgs, parseDoctorArgs, UsageError } from '../scripts/install/args.mjs';
import { mergeDesktopConfig, removeDesktopEntry, backupPath, freeBackupPath, writeAtomic } from '../scripts/install/desktop.mjs';
import { claudeHome, desktopConfigPath, tempPathWarning, pluginInstalled, findOnPath } from '../scripts/install/context.mjs';
import { parseMcpGet, renderAgent } from '../scripts/install/claude-code.mjs';
import { evaluateSession, parseCheckText, providerTable, cleanEnv, forwardedEnv, REPORT_KEYS } from '../scripts/install/selftest.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const temps = [];
const tmp = (p) => { const d = makeTempDir(p); temps.push(d); return d; };
after(() => { for (const d of temps) removeDir(d); });

// ---------- arguments ----------

test('install args: defaults', () => {
  assert.deepEqual(parseInstallArgs([]), {
    target: 'auto', scope: 'user', name: 'zcode', copyTo: null, skill: true, agent: true, probe: true,
    dryRun: false, json: false, yes: false, force: false, uninstall: false, help: false,
  });
});

test('install args: every flag, both --flag value and --flag=value', () => {
  const o = parseInstallArgs(['--target', 'claude-desktop', '--scope=project', '--name', 'zc-2', '--copy-to', 'rel/dir',
    '--no-skill', '--no-agent', '--no-probe', '--dry-run', '--json', '--yes', '--force', '--uninstall']);
  assert.equal(o.target, 'claude-desktop');
  assert.equal(o.scope, 'project');
  assert.equal(o.name, 'zc-2');
  assert.equal(o.copyTo, join(process.cwd(), 'rel/dir'));
  assert.deepEqual([o.skill, o.agent, o.probe, o.dryRun, o.json, o.yes, o.force, o.uninstall], [false, false, false, true, true, true, true, true]);
  assert.equal(parseInstallArgs(['-y', '-h']).yes, true);
  assert.equal(parseInstallArgs(['--target', 'all']).target, 'all');
});

test('install args: usage errors', () => {
  for (const argv of [['--target', 'grok'], ['--scope', 'local'], ['--name', 'a b'], ['--name'], ['--copy-to'], ['--bogus'], ['extra'], ['--name', '']]) {
    assert.throws(() => parseInstallArgs(argv), UsageError, JSON.stringify(argv));
  }
});

test('doctor args', () => {
  assert.deepEqual(parseDoctorArgs([]), { probe: true, json: false, help: false });
  assert.deepEqual(parseDoctorArgs(['--no-probe', '--json']), { probe: false, json: true, help: false });
  assert.equal(parseDoctorArgs(['--probe']).probe, true);
  assert.throws(() => parseDoctorArgs(['--yes']), UsageError);
});

// ---------- Claude Desktop config ----------

const ENTRY = { command: '/usr/local/bin/node', args: ['/opt/zcode/src/mcp-server.mjs'] };

test('desktop merge: a missing file gets a fresh config', () => {
  const r = mergeDesktopConfig(null, 'zcode', ENTRY);
  assert.equal(r.status, 'added');
  assert.deepEqual(JSON.parse(r.text), { mcpServers: { zcode: ENTRY } });
});

test('desktop merge: keeps every other key and server, idempotent on re-run', () => {
  const before = JSON.stringify({ globalShortcut: 'Cmd+K', mcpServers: { other: { command: 'x', args: ['y'], env: { A: '1' } } } });
  const r = mergeDesktopConfig(before, 'zcode', ENTRY);
  assert.equal(r.status, 'added');
  assert.deepEqual(JSON.parse(r.text), { globalShortcut: 'Cmd+K', mcpServers: { other: { command: 'x', args: ['y'], env: { A: '1' } }, zcode: ENTRY } });
  const again = mergeDesktopConfig(r.text, 'zcode', ENTRY);
  assert.equal(again.status, 'unchanged');
  assert.equal(again.text, r.text);
});

test('desktop merge: a different server under the name is a conflict unless force', () => {
  const before = JSON.stringify({ mcpServers: { zcode: { command: 'python', args: ['other.py'] } } });
  const r = mergeDesktopConfig(before, 'zcode', ENTRY);
  assert.equal(r.status, 'conflict');
  assert.equal(r.text, before);
  const f = mergeDesktopConfig(before, 'zcode', ENTRY, { force: true });
  assert.equal(f.status, 'replaced');
  assert.deepEqual(JSON.parse(f.text).mcpServers.zcode, ENTRY);
});

test('desktop merge: refuses invalid JSON and non-object shapes', () => {
  assert.throws(() => mergeDesktopConfig('{ "mcpServers": ', 'zcode', ENTRY), /not valid JSON/);
  assert.throws(() => mergeDesktopConfig('[]', 'zcode', ENTRY), /not a JSON object/);
  assert.throws(() => mergeDesktopConfig('{"mcpServers": []}', 'zcode', ENTRY), /mcpServers/);
});

test('desktop remove: only our own entry', () => {
  const ours = JSON.stringify({ a: 1, mcpServers: { zcode: ENTRY, other: { command: 'x' } } });
  const r = removeDesktopEntry(ours, 'zcode', ENTRY);
  assert.equal(r.status, 'removed');
  assert.deepEqual(JSON.parse(r.text), { a: 1, mcpServers: { other: { command: 'x' } } });
  assert.equal(removeDesktopEntry(r.text, 'zcode', ENTRY).status, 'absent');
  const foreign = JSON.stringify({ mcpServers: { zcode: { command: 'python' } } });
  assert.equal(removeDesktopEntry(foreign, 'zcode', ENTRY).status, 'foreign');
  assert.equal(removeDesktopEntry(foreign, 'zcode', ENTRY, { force: true }).status, 'removed');
  assert.equal(removeDesktopEntry(null, 'zcode', ENTRY).status, 'absent');
  assert.throws(() => removeDesktopEntry('nope', 'zcode', ENTRY), /not valid JSON/);
});

test('desktop backup name carries a sortable timestamp', () => {
  assert.equal(backupPath('/x/claude_desktop_config.json', new Date(Date.UTC(2026, 9, 18, 5, 7, 9))), '/x/claude_desktop_config.json.bak-20261018-050709');
});

test('freeBackupPath never reuses a taken name', () => {
  const d = tmp('zcode-inst-bak-');
  const p = join(d, 'c.json');
  const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(freeBackupPath(p, at), `${p}.bak-20260102-030405`);
  writeFileSync(`${p}.bak-20260102-030405`, '');
  writeFileSync(`${p}.bak-20260102-030405-1`, '');
  assert.equal(freeBackupPath(p, at), `${p}.bak-20260102-030405-2`);
});

test('writeAtomic writes the full text and leaves no temp file', () => {
  const d = tmp('zcode-inst-atomic-');
  const p = join(d, 'c.json');
  writeAtomic(p, '{"a":1}\n');
  assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n');
  assert.deepEqual(readdirSync(d), ['c.json']);
});

// ---------- paths and detection ----------

test('claude home: CLAUDE_CONFIG_DIR wins, else ~/.claude', () => {
  assert.equal(claudeHome({ HOME: '/h' }), '/h/.claude');
  assert.equal(claudeHome({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' }), '/c');
});

test('desktop config path per platform (only macOS is tested)', () => {
  assert.deepEqual(desktopConfigPath({ HOME: '/h' }, 'darwin'), { path: '/h/Library/Application Support/Claude/claude_desktop_config.json', tested: true });
  assert.deepEqual(desktopConfigPath({ HOME: '/h', APPDATA: 'C:\\A' }, 'win32'), { path: join('C:\\A', 'Claude', 'claude_desktop_config.json'), tested: false });
  assert.deepEqual(desktopConfigPath({ HOME: '/h' }, 'linux'), { path: '/h/.config/Claude/claude_desktop_config.json', tested: false });
  assert.deepEqual(desktopConfigPath({ HOME: '/h', XDG_CONFIG_HOME: '/x' }, 'linux'), { path: '/x/Claude/claude_desktop_config.json', tested: false });
});

test('temp-path warning for runtime paths that may vanish', () => {
  for (const p of ['/tmp/zcode-mcp', '/private/tmp/a', '/private/var/folders/xy/T/zcode-mcp', '/var/folders/a/b',
    '/Users/u/Library/Application Support/Claude/scratch-workspaces/1/zcode-mcp', '/Users/u/.cache/zcode-mcp']) {
    assert.match(tempPathWarning(p) || '', /temporary|scratch|cache/, p);
  }
  for (const p of ['/Users/u/code/zcode-mcp', '/opt/zcode-mcp', '/Users/u/tmpwork/zcode']) assert.equal(tempPathWarning(p), null, p);
});

test('plugin detection reads installed_plugins.json', () => {
  const home = tmp('zcode-inst-claude-');
  assert.equal(pluginInstalled(home), null);
  mkdirSync(join(home, 'plugins'));
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), 'garbage');
  assert.equal(pluginInstalled(home), null);
  writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'other@m': [{}], 'zcode-delegate@zcode-mcp': [{ scope: 'user' }] } }));
  assert.equal(pluginInstalled(home), 'zcode-delegate@zcode-mcp');
  assert.equal(pluginInstalled(home, 'nope'), null);
});

test('findOnPath finds executables only', () => {
  const d = tmp('zcode-inst-path-');
  writeFileSync(join(d, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(d, 'noexec'), 'x', { mode: 0o644 });
  assert.equal(findOnPath('claude', { PATH: `/nonexistent:${d}` }), join(d, 'claude'));
  assert.equal(findOnPath('noexec', { PATH: d }), null);
  assert.equal(findOnPath('claude', { PATH: '' }), null);
});

// ---------- claude mcp get / agent ----------

test('parseMcpGet reads command, args and env from `claude mcp get`', () => {
  const out = 'zc2:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Issue: CONNECTION_CLOSED: Connection closed\n  Type: stdio\n  Command: /usr/local/bin/node\n  Args: /p q/s.mjs\n  Environment:\n    ZCODE_BIN=/a/b\n    ZCODE_MCP_HOME=/x y/z\n\nTo remove this server, run: claude mcp remove zc2 -s user\n';
  assert.deepEqual(parseMcpGet(out), { scope: 'user', command: '/usr/local/bin/node', args: '/p q/s.mjs', env: { ZCODE_BIN: '/a/b', ZCODE_MCP_HOME: '/x y/z' } });
  const proj = 'zp:\n  Scope: Project config (shared via .mcp.json)\n  Status: ⏸ Pending approval\n  Type: stdio\n  Command: /n\n  Args: /x.mjs\n  Environment:\n\nTo remove this server, run: claude mcp remove zp -s project\n';
  assert.deepEqual(parseMcpGet(proj), { scope: 'project', command: '/n', args: '/x.mjs', env: {} });
});

test('renderAgent rewrites the user-level tool prefix for a custom server name', () => {
  const src = 'tools: Read, mcp__plugin_zcode-delegate_zcode__zcode_run, mcp__zcode__zcode_run\n';
  assert.equal(renderAgent(src, 'zcode'), src);
  assert.equal(renderAgent(src, 'zc2'), 'tools: Read, mcp__plugin_zcode-delegate_zcode__zcode_run, mcp__zc2__zcode_run\n');
});

// ---------- self-test evaluation ----------

const TOOLS = ['zcode_check', 'zcode_run', 'zcode_sessions', 'zcode_status', 'zcode_result', 'zcode_cancel'].map((name) => ({ name }));
const PAYLOAD = { ok: true, binPath: '/z/zcode.cjs', version: 'zcode 0.16.9', jobs: { dir: '/j', writable: true }, providers: [], warnings: [] };
const session = (payload = PAYLOAD, extra = {}) => ({ serverInfo: { name: 'zcode-delegate', version: '1.2.0' }, tools: TOOLS, check: { isError: false, text: JSON.stringify(payload, null, 2) }, ...extra });
const step = (steps, name) => steps.find((s) => s.name === name);

test('parseCheckText takes the leading JSON object, also of an error answer', () => {
  assert.deepEqual(parseCheckText(JSON.stringify({ ok: true, a: { b: 1 } }, null, 2) + '\nmodels:\n  x'), { ok: true, a: { b: 1 } });
  assert.deepEqual(parseCheckText(JSON.stringify({ ok: false, problem: 'binary-not-found', checked: ['a'] }, null, 2) + '\nInstall ZCode or set ZCODE_BIN, then retry.'), { ok: false, problem: 'binary-not-found', checked: ['a'] });
  assert.equal(parseCheckText('garbage'), null);
});

test('evaluate: all good, probe skipped', () => {
  const steps = evaluateSession(session(), { probe: false, keys: new Map(), providerFile: '/p.json' });
  assert.deepEqual(steps.map((s) => [s.name, s.ok]), [
    ['selftest:server', true], ['selftest:tools', true], ['selftest:zcode', true], ['selftest:jobs', true], ['selftest:providers', true], ['selftest:probe', true],
  ]);
  assert.match(step(steps, 'selftest:probe').detail, /skipped/);
});

test('evaluate: server did not start', () => {
  const steps = evaluateSession({ error: 'server exited before answering initialize (code 1): boom' }, { probe: true, keys: new Map() });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, 'selftest:server');
  assert.equal(steps[0].ok, false);
  assert.match(steps[0].fix, /node/);
});

test('evaluate: missing tools', () => {
  const s = session();
  s.tools = TOOLS.slice(0, 2);
  const st = step(evaluateSession(s, { probe: false, keys: new Map() }), 'selftest:tools');
  assert.equal(st.ok, false);
  assert.match(st.detail, /zcode_sessions/);
});

test('evaluate: no ZCode binary -> install / ZCODE_BIN fix', () => {
  const s = session();
  s.check = { isError: true, text: JSON.stringify({ ok: false, problem: 'binary-not-found', checked: ['/Applications/ZCode.app/…'] }, null, 2) + '\nInstall ZCode or set ZCODE_BIN, then retry.' };
  const st = step(evaluateSession(s, { probe: true, keys: new Map() }), 'selftest:zcode');
  assert.equal(st.ok, false);
  assert.match(st.fix, /Install ZCode/);
  assert.match(st.fix, /ZCODE_BIN/);
});

test('evaluate: jobs dir not writable', () => {
  const st = step(evaluateSession(session({ ...PAYLOAD, jobs: { dir: '/j', writable: false } }), { probe: false, keys: new Map() }), 'selftest:jobs');
  assert.equal(st.ok, false);
  assert.match(st.fix, /\/j/);
});

test('evaluate: baseUrl typo names the file and the field', () => {
  const p = { ...PAYLOAD, providers: [{ id: 'zai', enabled: true, baseUrl: 'https://api.z.ai/v4.', apiType: 'openai', accessType: 'api-key' }], warnings: ['provider zai: baseUrl "https://api.z.ai/v4." ends with "." — probably a typo'] };
  const st = step(evaluateSession(session(p), { probe: false, keys: new Map([['zai', true]]), providerFile: '/h/.zcode/v2/provider_config.json' }), 'selftest:providers');
  assert.equal(st.ok, false);
  assert.match(st.fix, /\/h\/\.zcode\/v2\/provider_config\.json/);
  assert.match(st.fix, /providerId "zai"/);
  assert.match(st.fix, /config\.api\.baseUrl/);
});

test('evaluate: enabled API-key provider without a key -> guided helper', () => {
  const p = { ...PAYLOAD, providers: [{ id: 'zai', enabled: true, baseUrl: 'https://a/v4', apiType: 'openai', accessType: 'zhipu-coding-plan-api-key' }] };
  const st = step(evaluateSession(session(p), { probe: false, keys: new Map([['zai', false]]) }), 'selftest:providers');
  assert.equal(st.ok, false);
  assert.match(st.fix, /zsh scripts\/setup\/setup-zcode-cli-auth\.zsh/);
  assert.match(st.fix, /hidden/);
});

test('providerTable: access kind and key presence only', () => {
  const rows = providerTable([
    { id: 'zai', enabled: true, baseUrl: 'https://a', apiType: 'openai', accessType: 'zhipu-coding-plan-api-key' },
    { id: 'acct', enabled: true, baseUrl: null, apiType: null, accessType: 'oauth' },
  ], new Map([['zai', true]]));
  assert.deepEqual(rows, [
    { id: 'zai', enabled: true, access: 'api-key', accessType: 'zhipu-coding-plan-api-key', apiType: 'openai', baseUrl: 'https://a', keyPresent: true },
    { id: 'acct', enabled: true, access: 'account-login', accessType: 'oauth', apiType: null, baseUrl: null, keyPresent: null },
  ]);
});

const probeFail = (errorKind, error, extra = {}) => session({ ...PAYLOAD, modelProbe: { ok: false, durationMs: 5, model: 'p/m', errorKind, error, ...extra } });
const probeStep = (s) => step(evaluateSession(s, { probe: true, keys: new Map() }), 'selftest:probe');

test('evaluate probe: pass', () => {
  const st = probeStep(session({ ...PAYLOAD, modelProbe: { ok: true, durationMs: 9, model: 'glm-test/small' } }));
  assert.equal(st.ok, true);
  assert.match(st.detail, /glm-test\/small/);
});

test('evaluate probe: failure hints per cause', () => {
  const cases = [
    [probeFail('auth', 'HTTP 401 Unauthorized: invalid api key'), /setup-zcode-cli-auth\.zsh/],
    [probeFail('model', 'Model creation failed', { hint: 'hint: …' }), /zcode login|setup-zcode-cli-auth/],
    [probeFail('quota', 'HTTP 429: [1113] Insufficient balance or no resource package.'), /balance|package/],
    [probeFail('quota', 'HTTP 429 Too Many Requests: rate limit reached'), /rate|window/],
    [probeFail('timeout', 'model probe exceeded its total budget of 75000 ms'), /timed out|again/],
    [probeFail('unknown', 'Model request failed.'), /baseUrl/],
    [probeFail('network', 'TypeError: fetch failed'), /network|proxy/],
  ];
  for (const [s, re] of cases) {
    const st = probeStep(s);
    assert.equal(st.ok, false);
    assert.match(st.fix, re, st.detail);
  }
});

test('evaluate probe: requested but missing from the answer is a failure', () => {
  const st = probeStep(session());
  assert.equal(st.ok, false);
});

// ---------- env and report schema ----------

test('cleanEnv keeps the basics plus the registration env; forwardedEnv picks ZCode paths only', () => {
  const env = { HOME: '/h', PATH: '/bin', USER: 'u', SECRET_TOKEN: 's', ZCODE_BIN: '/z', ZCODE_CREDENTIAL_SECRET: 'x', ZCODE_MCP_HOME: '/m', FOO: 'b' };
  assert.deepEqual(forwardedEnv(env), { ZCODE_BIN: '/z', ZCODE_MCP_HOME: '/m' });
  assert.deepEqual(cleanEnv(env, { ZCODE_BIN: '/z' }), { HOME: '/h', PATH: '/bin', USER: 'u', ZCODE_BIN: '/z' });
});

test('report keys are the documented schema', () => {
  assert.deepEqual(REPORT_KEYS, ['ok', 'version', 'user', 'home', 'steps', 'registered', 'files', 'nextSteps']);
});

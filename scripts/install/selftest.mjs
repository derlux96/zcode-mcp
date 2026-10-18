// Self-test shared by the installer and the doctor: start the server exactly as a
// client would (absolute node + server path, clean env), MCP initialize, tools/list,
// tools/call zcode_check, then turn the answer into PASS/FAIL steps with fixes.
// API keys are never read into memory beyond a presence test, never printed.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { providerConfigPath } from '../../src/provider-check.mjs';

export const REPORT_KEYS = ['ok', 'version', 'user', 'home', 'steps', 'registered', 'files', 'nextSteps'];
export const TOOL_NAMES = ['zcode_check', 'zcode_run', 'zcode_sessions', 'zcode_status', 'zcode_result', 'zcode_cancel'];

// ZCode path variables set while installing are written into the registration so
// the client starts the server with them; secrets (ZCODE_CREDENTIAL_SECRET) never.
export const FORWARD_ENV = ['ZCODE_BIN', 'ZCODE_APPSERVER_BIN', 'ZCODE_MCP_HOME', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'];
const BASE_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];

const pick = (env, keys) => Object.fromEntries(keys.filter((k) => typeof env[k] === 'string' && env[k] !== '').map((k) => [k, env[k]]));

export function forwardedEnv(env) {
  return pick(env, FORWARD_ENV);
}

/** The basics a client passes (HOME, PATH, …) plus the registration's own env. */
export function cleanEnv(env, regEnv = {}) {
  return { ...pick(env, BASE_ENV), ...regEnv };
}

export const SETUP_HELPER = 'in the zcode-mcp clone, the user runs `zsh scripts/setup/setup-zcode-cli-auth.zsh` in a terminal (it asks for the Z.ai API key with hidden input, backs up credentials.json and provider_config.json, then tests a real turn); a model must never ask for or handle the key';
const LOGIN = 'the user runs `zcode login` (account login)';

/** The leading JSON object of a zcode_check answer (also of its error answer), or null. */
export function parseCheckText(text) {
  const s = String(text || '');
  const end = s.indexOf('\n}');
  try {
    return JSON.parse(end >= 0 ? s.slice(0, end + 2) : s);
  } catch {
    return null;
  }
}

/** providerId -> key present (non-empty access.apiKey). Only presence leaves this function. */
export function providerKeys(env) {
  const keys = new Map();
  try {
    const cfg = JSON.parse(readFileSync(providerConfigPath(env), 'utf8'));
    const rules = cfg && cfg.config && cfg.config.providerConfigRules && cfg.config.providerConfigRules.providerRules;
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || typeof r.providerId !== 'string') continue;
      const k = r.config && r.config.access && r.config.access.apiKey;
      keys.set(r.providerId, typeof k === 'string' && k.trim() !== '');
    }
  } catch { /* no file or unreadable: no presence information */ }
  return keys;
}

const isApiKey = (accessType) => /api-?key/i.test(String(accessType || ''));
const accessKind = (t) => (isApiKey(t) ? 'api-key' : t ? 'account-login' : 'unknown');

export function providerTable(providers, keys) {
  return (providers || []).map((p) => ({
    id: p.id,
    enabled: p.enabled,
    access: accessKind(p.accessType),
    accessType: p.accessType,
    apiType: p.apiType,
    baseUrl: p.baseUrl,
    keyPresent: isApiKey(p.accessType) && keys.has(p.id) ? keys.get(p.id) : null,
  }));
}

function probeFix(mp, providerFile) {
  const e = String(mp.error || '');
  switch (mp.errorKind) {
    case 'auth':
      return `ZCode's login or API key was rejected: ${LOGIN}, or for a Z.ai Coding Plan API key ${SETUP_HELPER}.`;
    case 'model':
      if (/model creation failed/i.test(e) || mp.hint) return `ZCode could not create the model — usually a missing/expired login or a broken provider config: ${LOGIN}, or ${SETUP_HELPER}; also check config.api.baseUrl in ${providerFile}.`;
      return 'ZCode\'s current model is unavailable: pick another model in ZCode, or pass `model` to zcode_run (zcode_check with include_models lists them).';
    case 'quota':
      if (/1113|insufficient balance|余额不足|resource package/i.test(e)) return `Insufficient balance / no resource package (Z.ai 1113): the user checks the plan and balance; a Coding Plan key also needs the coding endpoint as baseUrl in ${providerFile} (…/api/coding/paas/v4, not the general API).`;
      return 'Rate or usage-window limit (HTTP 429): wait until the window resets, then run the doctor again.';
    case 'timeout':
      return 'The probe timed out (75 s budget, start-up included): run it again; if it persists check the network/proxy and `zcode doctor`.';
    case 'network':
      return `Network error reaching the provider: check the network, proxy or VPN and config.api.baseUrl in ${providerFile}.`;
    default:
      if (/model request failed/i.test(e)) return `"Model request failed." is most often a wrong provider baseUrl (typo, trailing dot) — check config.api.baseUrl in ${providerFile} — else a wrong key (${SETUP_HELPER}).`;
      return `Unexpected probe failure: run \`zcode doctor\` and report this output (${e || 'no error text'}).`;
  }
}

/**
 * session: { serverInfo, tools, check: { isError, text } } or { error }.
 * opts: { probe, keys (Map), providerFile, node, server }.
 */
export function evaluateSession(session, { probe, keys = new Map(), providerFile = '~/.zcode/v2/provider_config.json', node = 'node', server = 'src/mcp-server.mjs' } = {}) {
  const steps = [];
  if (session.error) {
    steps.push({ name: 'selftest:server', ok: false, detail: session.error, fix: `Start it by hand to see the error: "${node}" "${server}" (Node >= 18 required; the path must exist and stay; rerun the installer after moving the clone).` });
    return steps;
  }
  const info = session.serverInfo || {};
  steps.push({ name: 'selftest:server', ok: true, detail: `initialize answered by ${info.name || '?'} ${info.version || ''}`.trim() });

  const names = (session.tools || []).map((t) => t.name);
  const missing = TOOL_NAMES.filter((t) => !names.includes(t));
  steps.push(missing.length
    ? { name: 'selftest:tools', ok: false, detail: `tools/list lacks ${missing.join(', ')}`, fix: 'The server file is not this version of zcode-mcp: re-run the installer from an up-to-date clone.' }
    : { name: 'selftest:tools', ok: true, detail: `tools/list has all six tools (${TOOL_NAMES.join(', ')})` });

  const p = parseCheckText(session.check && session.check.text);
  if (!p) {
    steps.push({ name: 'selftest:zcode', ok: false, detail: `zcode_check gave no parsable answer: ${String(session.check && session.check.text).slice(0, 200)}`, fix: 'Run the doctor (npm run doctor) and report its output.' });
    return steps;
  }
  if (p.problem === 'binary-not-found') {
    steps.push({ name: 'selftest:zcode', ok: false, detail: `ZCode binary not found (checked: ${(p.checked || []).join('; ')})`, fix: 'Install ZCode (the desktop app puts it at /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs) or set ZCODE_BIN to your zcode.cjs and re-run the installer (it writes ZCODE_BIN into the registration).' });
    return steps;
  }
  const versionWarnings = (p.warnings || []).filter((w) => /^ZCode version/.test(w));
  steps.push(p.ok
    ? { name: 'selftest:zcode', ok: true, detail: `${p.binPath} (${p.version})${versionWarnings.length ? `; warning: ${versionWarnings.join('; ')}` : ''}` }
    : { name: 'selftest:zcode', ok: false, detail: `\`zcode version\` failed for ${p.binPath}`, fix: `Run "node ${p.binPath} version" by hand; reinstall or update ZCode.` });

  const jobs = p.jobs || {};
  steps.push(jobs.writable
    ? { name: 'selftest:jobs', ok: true, detail: `jobs dir ${jobs.dir} is writable` }
    : { name: 'selftest:jobs', ok: false, detail: `jobs dir ${jobs.dir} is not writable`, fix: `Fix the ownership/permissions of ${jobs.dir} (or set ZCODE_MCP_HOME to a writable directory and re-run the installer).` });

  const table = providerTable(p.providers, keys);
  const problems = [];
  const fixes = [];
  for (const w of p.warnings || []) {
    const m = /^provider (.+?): baseUrl "(.*)" (.*)$/.exec(w);
    if (m) {
      problems.push(w);
      fixes.push(`The user edits ${providerFile}: in config.providerConfigRules.providerRules, the rule with providerId "${m[1]}" -> field config.api.baseUrl ("${m[2]}" ${m[3]}). The file also holds the API key: never print or share it.`);
    } else if (/^provider config .* is not valid JSON/.test(w)) {
      problems.push(w);
      fixes.push(`${providerFile} is not valid JSON: restore it from its .bak backup or let ZCode rewrite it (ZCode settings).`);
    }
  }
  // The key may live elsewhere (credentials.json, a ZCode UI rule): a passed probe is the
  // ground truth, so a missing inline key fails only without a passing probe.
  const probePassed = probe && p.modelProbe && p.modelProbe.ok === true;
  const notes = [];
  for (const r of table) {
    if (r.enabled && r.access === 'api-key' && r.keyPresent === false) {
      if (probePassed) {
        notes.push(`Provider "${r.id}" has no inline key in the config, but the model probe passed, so ZCode finds its key elsewhere: no action needed.`);
      } else {
        problems.push(`provider ${r.id}: no API key in the config`);
        fixes.push(`Provider "${r.id}" uses an API key but none is set in the config (and no passing model probe shows that ZCode finds one elsewhere): ${SETUP_HELPER}.`);
      }
    }
  }
  const summary = table.length
    ? table.map((r) => `${r.id} (${r.enabled ? 'enabled' : 'disabled'}, ${r.access}${r.keyPresent === null ? '' : r.keyPresent ? ', key present' : ', key MISSING'}, ${r.baseUrl || 'no baseUrl'})`).join('; ')
    : 'no personal provider rules (ZCode\'s built-in login is used)';
  steps.push(problems.length
    ? { name: 'selftest:providers', ok: false, detail: `${problems.join('; ')} | ${summary}`, fix: fixes.join(' ') }
    : { name: 'selftest:providers', ok: true, detail: summary, ...(notes.length ? { fix: notes.join(' ') } : {}) });

  if (!probe) {
    steps.push({ name: 'selftest:probe', ok: true, detail: 'skipped (--no-probe): no model request was made' });
  } else if (!p.modelProbe) {
    steps.push({ name: 'selftest:probe', ok: false, detail: 'the model probe was requested but zcode_check returned no modelProbe', fix: 'The server is older than this installer: update the clone and re-run.' });
  } else if (p.modelProbe.ok) {
    steps.push({ name: 'selftest:probe', ok: true, detail: `model ${p.modelProbe.model || '?'} answered in ${p.modelProbe.durationMs} ms` });
  } else {
    const mp = p.modelProbe;
    steps.push({ name: 'selftest:probe', ok: false, detail: `${mp.errorKind}: ${mp.error}${mp.model ? ` (model ${mp.model})` : ''}`, fix: probeFix(mp, providerFile) });
  }
  return steps;
}

/**
 * Spawns `node server` with `env` and runs initialize, tools/list and
 * zcode_check { probe_model }. -> session or { error }. Never leaves the child behind.
 */
export function mcpSession({ node, server, env, probe, timeoutMs = probe ? 120000 : 30000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(node, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ error: `could not start the server: ${err.message}` });
      return;
    }
    const session = {};
    let buf = '';
    let stderr = '';
    let settled = false;
    let stage = 'initialize';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      // The server exits once stdin is closed and its replies are written.
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
      child.once('close', () => { clearTimeout(kill); resolve(result); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(kill); resolve(result); }
    };
    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    const timer = setTimeout(() => finish({ error: `no answer to ${stage} within ${timeoutMs} ms` }), timeoutMs);
    child.on('error', (err) => finish({ error: `could not start the server: ${err.message}` }));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('close', (code, signal) => {
      if (!settled) finish({ error: `server exited before answering ${stage} (code ${code}, signal ${signal})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}` });
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) { finish({ error: `${stage} failed: ${msg.error.message}` }); return; }
        if (msg.id === 1) {
          session.serverInfo = msg.result && msg.result.serverInfo;
          send({ method: 'notifications/initialized', params: {} });
          stage = 'tools/list';
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          session.tools = (msg.result && msg.result.tools) || [];
          stage = 'tools/call zcode_check';
          send({ id: 3, method: 'tools/call', params: { name: 'zcode_check', arguments: { probe_model: probe } } });
        } else if (msg.id === 3) {
          const r = msg.result || {};
          session.check = { isError: r.isError === true, text: (r.content || []).map((c) => c.text).join('\n') };
          finish(session);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zcode-mcp-selftest', version: '1' } } });
  });
}

/** -> { ok, steps, providers } for node + server started with env. */
export async function runSelfTest({ node, server, env, probe }) {
  const session = await mcpSession({ node, server, env, probe });
  const providerFile = providerConfigPath(env);
  const keys = providerKeys(env);
  const steps = evaluateSession(session, { probe, keys, providerFile, node, server });
  const p = session.check ? parseCheckText(session.check.text) : null;
  return { ok: steps.every((s) => s.ok), steps, providers: providerTable(p && p.providers, keys), providerFile };
}

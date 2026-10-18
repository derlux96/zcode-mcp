#!/usr/bin/env node
// Fake `claude` CLI for the installer tests: the `mcp add|get|remove` subset with
// the real CLI's output shapes and exit codes (transcribed from claude 2.1.283).
// FAKE_CLAUDE_STATE: JSON file { "<scope>": { "<name>": { command, args, env } } }.
// FAKE_CLAUDE_LOG: every invocation is appended as one JSON line { argv, cwd }.
'use strict';

const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const STATE = process.env.FAKE_CLAUDE_STATE;
if (!STATE) {
  process.stderr.write('[fake-claude] FAKE_CLAUDE_STATE is not set; nothing to do\n');
  process.exitCode = 0;
  return;
}
const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const SCOPE_TEXT = { user: 'User config (available in all your projects)', project: 'Project config (shared via .mcp.json)', local: 'Local config (private to you in this project)' };
const out = (s) => process.stdout.write(s);
const fail = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

function opt(args, long, short) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || args[i] === short) { const v = args[i + 1]; args.splice(i, 2); return v; }
  }
  return undefined;
}

if (argv[0] === '--version') { out('2.1.283 (Claude Code)\n'); process.exit(0); }
if (argv[0] !== 'mcp') fail(`[fake-claude] unsupported: ${argv.join(' ')}`);
const sub = argv[1];
const rest = argv.slice(2);
const state = load();

if (sub === 'add') {
  const dd = rest.indexOf('--');
  const head = dd >= 0 ? rest.slice(0, dd) : rest;
  const cmd = dd >= 0 ? rest.slice(dd + 1) : [];
  const scope = opt(head, '--scope', '-s') || 'local';
  const env = {};
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '-e' || head[i] === '--env') { const [k, ...v] = head[i + 1].split('='); env[k] = v.join('='); head.splice(i, 2); i -= 1; }
  }
  const name = head[0];
  if (!name || !cmd.length) fail('error: missing required argument');
  if (state[scope] && state[scope][name]) fail(`MCP server ${name} already exists in ${scope} config`);
  state[scope] = { ...(state[scope] || {}), [name]: { command: cmd[0], args: cmd.slice(1), env } };
  save(state);
  out(`Added stdio MCP server ${name} with command: ${cmd.join(' ')} to ${scope} config\n`);
  process.exit(0);
}

if (sub === 'get') {
  const name = rest[0];
  for (const scope of ['local', 'project', 'user']) {
    const s = state[scope] && state[scope][name];
    if (!s) continue;
    const env = Object.entries(s.env || {}).map(([k, v]) => `    ${k}=${v}\n`).join('');
    out(`${name}:\n  Scope: ${SCOPE_TEXT[scope]}\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${s.command}\n  Args: ${s.args.join(' ')}\n  Environment:\n${env}\nTo remove this server, run: claude mcp remove ${name} -s ${scope}\n`);
    process.exit(0);
  }
  const all = Object.values(state).flatMap((s) => Object.keys(s));
  fail(`No MCP server named "${name}". Configured servers: ${all.join(', ')}`);
}

if (sub === 'remove') {
  const scope = opt(rest, '--scope', '-s');
  const name = rest[0];
  const scopes = scope ? [scope] : ['local', 'project', 'user'];
  for (const sc of scopes) {
    if (state[sc] && state[sc][name]) {
      delete state[sc][name];
      save(state);
      out(`Removed MCP server ${name} from ${sc} config\n`);
      process.exit(0);
    }
  }
  fail(`No MCP server named "${name}"${scope ? ` in ${scope} scope` : ''}`);
}

fail(`[fake-claude] unsupported: ${argv.join(' ')}`);

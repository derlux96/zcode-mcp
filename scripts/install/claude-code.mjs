// Claude Code registration through its own CLI (`claude mcp get|add|remove`) and
// the user-level agent text.
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { classifyServer } from './context.mjs';

/** Parses `claude mcp get <name>` -> { scope, command, args, env } (args as printed: space-joined). */
export function parseMcpGet(out) {
  const lines = String(out).split('\n');
  const field = (k) => {
    const l = lines.find((x) => x.trimStart().startsWith(`${k}:`));
    return l === undefined ? null : l.slice(l.indexOf(':') + 1).trim();
  };
  const scopeText = field('Scope') || '';
  const scope = /^user/i.test(scopeText) ? 'user' : /^project/i.test(scopeText) ? 'project' : /^local/i.test(scopeText) ? 'local' : scopeText || null;
  const env = {};
  const at = lines.findIndex((l) => l.trim() === 'Environment:');
  if (at >= 0) {
    for (const l of lines.slice(at + 1)) {
      if (!/^\s{3,}\S/.test(l)) break;
      const t = l.trim();
      const i = t.indexOf('=');
      if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
    }
  }
  return { scope, command: field('Command'), args: field('Args'), env };
}

/** The agent for a user-level server named `name` (tools mcp__<name>__*). */
export function renderAgent(text, name) {
  return name === 'zcode' ? text : text.replaceAll('mcp__zcode__', `mcp__${name}__`);
}

// run: { env, cwd }. The cwd matters: `claude mcp get` also sees the .mcp.json of
// the cwd and its parents (e.g. the zcode-mcp clone's own one for Grok/Cursor).
function claude(bin, args, run) {
  const r = spawnSync(bin, args, { env: run.env, cwd: run.cwd, encoding: 'utf8', timeout: 60000 });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message) };
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Compares the registration of `name` in `scope` with { command, args: [server], env }.
 * -> { state: absent|same|outdated|different, kind?, found?, otherScope? }. outdated:
 * our script with another node path or env; kind: classifyServer (ours|elsewhere|foreign).
 * A server of that name in another scope counts as absent here (reported as otherScope).
 */
export function registrationState(bin, name, scope, want, run) {
  const r = claude(bin, ['mcp', 'get', name], run);
  if (r.code !== 0) return { state: 'absent' };
  const found = parseMcpGet(r.stdout);
  if (found.scope && found.scope !== scope) return { state: 'absent', otherScope: found.scope };
  const same = found.command === want.command && found.args === want.args.join(' ') && isDeepStrictEqual(found.env, want.env);
  const kind = classifyServer(found.command, found.args, want.args[0]);
  return { state: same ? 'same' : kind === 'ours' ? 'outdated' : 'different', kind, found };
}

export function addArgs(name, scope, want) {
  const envFlags = Object.entries(want.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', '--scope', scope, name, ...envFlags, '--', want.command, ...want.args];
}

export function addServer(bin, name, scope, want, run) {
  return claude(bin, addArgs(name, scope, want), run);
}

export function removeServer(bin, name, scope, run) {
  return claude(bin, ['mcp', 'remove', name, '--scope', scope], run);
}

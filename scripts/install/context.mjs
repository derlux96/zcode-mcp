// Where things live: Claude Code home, Claude Desktop config, the `claude` CLI,
// an installed zcode-delegate plugin, and runtime paths that may vanish.
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export const PLUGIN_NAME = 'zcode-delegate';

export const homeOf = (env) => env.HOME || homedir();

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeHome(env) {
  return env.CLAUDE_CONFIG_DIR || join(homeOf(env), '.claude');
}

/** Only the macOS path is tested; Windows and Linux follow Claude's documented locations. */
export function desktopConfigPath(env, platform = process.platform) {
  const file = 'claude_desktop_config.json';
  if (platform === 'darwin') return { path: join(homeOf(env), 'Library', 'Application Support', 'Claude', file), tested: true };
  if (platform === 'win32') return { path: join(env.APPDATA || join(homeOf(env), 'AppData', 'Roaming'), 'Claude', file), tested: false };
  return { path: join(env.XDG_CONFIG_HOME || join(homeOf(env), '.config'), 'Claude', file), tested: false };
}

const TEMP_PATHS = [
  [/^\/(private\/)?tmp\//, 'a temporary directory (/tmp)'],
  [/^\/(private\/)?var\/folders\//, 'a temporary directory (/var/folders)'],
  [/\/scratch-workspaces\//, 'a scratch workspace'],
  [/\/\.cache\//, 'a cache directory (.cache)'],
];

/** A warning when the runtime lies somewhere that may be deleted, else null. */
export function tempPathWarning(path) {
  for (const [re, what] of TEMP_PATHS) {
    if (re.test(path)) return `the runtime path ${path} lies in ${what} and may disappear; Claude then cannot start the server`;
  }
  return null;
}

/** The installed plugin id (e.g. zcode-delegate@zcode-mcp), or null. */
export function pluginInstalled(home, name = PLUGIN_NAME) {
  try {
    const data = JSON.parse(readFileSync(join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
    const ids = Object.keys((data && data.plugins) || {});
    return ids.find((id) => id.startsWith(`${name}@`)) || null;
  } catch {
    return null;
  }
}

/** Absolute path of an executable on env.PATH, or null. */
export function findOnPath(cmd, env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

/** Claude Code's user-scope config file (holds user-scope MCP servers). */
export function userConfigFile(env) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homeOf(env), '.claude.json');
}

/**
 * The node to register: the `node` on PATH when it is the same binary as the running
 * one (process.execPath is symlink-resolved, e.g. a version-pinned Homebrew Cellar
 * path that `brew upgrade` deletes), else process.execPath.
 */
export function chooseNode(env, execPath = process.execPath) {
  const p = findOnPath('node', env);
  try {
    if (p && realpathSync(p) === realpathSync(execPath)) return p;
  } catch { /* fall back */ }
  return execPath;
}

/**
 * A registered server vs this installation's server script: 'ours' (node + the same
 * script, whatever node path or env), 'elsewhere' (node + another zcode-mcp
 * src/mcp-server.mjs) or 'foreign'. args: the first argument (or args space-joined).
 */
export function classifyServer(command, args, server) {
  if (!command || !/^node(\.exe)?$/i.test(basename(command))) return 'foreign';
  if (args === server) return 'ours';
  return /\/src\/mcp-server\.mjs$/.test(String(args || '')) ? 'elsewhere' : 'foreign';
}

const SECRET_OPT = /key|token|secret|password|auth/i;

/** Masks the values of secret-looking options in a space-joined argument string. */
export function redactArgs(args) {
  const parts = String(args || '').split(' ').filter((x) => x !== '');
  return parts.map((a, i) => {
    const eq = a.indexOf('=');
    if (a.startsWith('-') && eq > 0 && SECRET_OPT.test(a.slice(0, eq))) return `${a.slice(0, eq)}=***`;
    const prev = parts[i - 1];
    if (prev && prev.startsWith('-') && !prev.includes('=') && SECRET_OPT.test(prev) && !a.startsWith('-')) return '***';
    return a;
  }).join(' ');
}

export function whoami(env) {
  let user = env.USER || env.LOGNAME || null;
  try { user = userInfo().username; } catch { /* keep env value */ }
  return { user, home: homeOf(env) };
}

// Claude Desktop config: merge/remove our mcpServers entry without touching
// anything else; refuse a file that is not valid JSON; atomic writes.
import { isDeepStrictEqual } from 'node:util';
import { existsSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

function parse(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error('the Claude Desktop config is not valid JSON; fix or move it, nothing was changed');
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('the Claude Desktop config is not a JSON object; nothing was changed');
  if (cfg.mcpServers !== undefined && (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers))) {
    throw new Error('mcpServers in the Claude Desktop config is not an object; nothing was changed');
  }
  return cfg;
}

const render = (cfg) => `${JSON.stringify(cfg, null, 2)}\n`;

/** text: current file content or null (missing) -> { status: added|unchanged|conflict|replaced, text }. */
export function mergeDesktopConfig(text, name, entry, { force = false } = {}) {
  const cfg = text === null ? {} : parse(text);
  const servers = cfg.mcpServers || {};
  const current = servers[name];
  if (current !== undefined && isDeepStrictEqual(current, entry)) return { status: 'unchanged', text };
  if (current !== undefined && !force) return { status: 'conflict', text };
  cfg.mcpServers = { ...servers, [name]: entry };
  return { status: current === undefined ? 'added' : 'replaced', text: render(cfg) };
}

/** -> { status: removed|absent|foreign, text } (foreign: a different server; removed only with force). */
export function removeDesktopEntry(text, name, entry, { force = false } = {}) {
  if (text === null) return { status: 'absent', text };
  const cfg = parse(text);
  const current = cfg.mcpServers && cfg.mcpServers[name];
  if (current === undefined) return { status: 'absent', text };
  if (!isDeepStrictEqual(current, entry) && !force) return { status: 'foreign', text };
  const { [name]: _gone, ...rest } = cfg.mcpServers;
  cfg.mcpServers = rest;
  return { status: 'removed', text: render(cfg) };
}

const pad = (n) => String(n).padStart(2, '0');

/** <path>.bak-YYYYMMDD-HHMMSS (UTC). */
export function backupPath(path, date = new Date()) {
  const d = date;
  return `${path}.bak-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** backupPath, with -1, -2, … appended when that name is taken (two runs in one second). */
export function freeBackupPath(path, date = new Date()) {
  const base = backupPath(path, date);
  let p = base;
  for (let i = 1; existsSync(p); i++) p = `${base}-${i}`;
  return p;
}

/** Write to a temp file in the same directory, then rename over the target. */
export function writeAtomic(path, text, mode = 0o600) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

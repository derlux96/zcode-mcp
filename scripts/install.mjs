#!/usr/bin/env node
// Installer for everything that is not the Claude Code plugin route: registers the
// MCP server in Claude Code (`claude mcp add`) and/or Claude Desktop (config merge),
// copies the skill and the Claude agent, then self-tests the registered command.
// See INSTALL.md / llms-install.md; `--help` lists the options. Zero dependencies.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../src/is-main.mjs';
import { parseInstallArgs, INSTALL_USAGE, UsageError } from './install/args.mjs';
import { chooseNode, claudeHome, desktopConfigPath, findOnPath, pluginInstalled, redactArgs, tempPathWarning, userConfigFile, whoami, PLUGIN_NAME } from './install/context.mjs';
import { mergeDesktopConfig, removeDesktopEntry, freeBackupPath, writeAtomic } from './install/desktop.mjs';
import { registrationState, addServer, removeServer, renderAgent } from './install/claude-code.mjs';
import { cleanEnv, forwardedEnv, runSelfTest } from './install/selftest.mjs';
import { emit, emitRefusal } from './install/report.mjs';
import { main as doctorMain, nodeStep, packageVersion, userStep } from './doctor.mjs';
import { discoverZCode } from '../src/discover.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const CLAUDE_HINT = 'Install Claude Code (https://claude.com/claude-code) so that `claude` is on PATH, or use the plugin route: claude plugin marketplace add derlux96/zcode-mcp && claude plugin install zcode-delegate@zcode-mcp';

const readOrNull = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// Marks a --copy-to directory as a zcode-mcp runtime copy (only such a directory,
// a new or an empty one is written to without --force).
export const RUNTIME_MARKER = '.zcode-mcp-runtime';
const ACTION = { written: 'write', removed: 'remove', backup: 'backup' };

/** Runs the whole plan; with opts.dryRun nothing is written and `claude mcp add/remove` never runs. */
async function execute(opts, env) {
  const { user, home } = whoami(env);
  const version = packageVersion();
  const node = chooseNode(env);
  const runtime = opts.copyTo || repoRoot;
  const server = join(runtime, 'src', 'mcp-server.mjs');
  const regEnv = forwardedEnv(env);
  const want = { command: node, args: [server], env: regEnv };
  const steps = [userStep(env), nodeStep(node)];
  const registered = [];
  const files = [];
  const nextSteps = [];
  const dry = opts.dryRun;
  const would = (a) => (dry ? `would-${ACTION[a] || a}` : a);
  const report = () => ({ ok: steps.every((s) => s.ok), version, user, home, steps, registered, files, nextSteps });
  if (!steps[1].ok) return report();

  // Preflight: runtime path and ZCode binary.
  const warn = tempPathWarning(runtime);
  steps.push({
    name: 'preflight:runtime', ok: true,
    detail: `${warn ? 'WARNING: ' : ''}server ${server}${warn ? ` — ${warn}` : ''}`,
    ...(warn ? { fix: 'Use --copy-to <stable dir> (e.g. ~/.local/share/zcode-mcp) or clone to a permanent place, then re-run.' } : {}),
  });
  if (!opts.uninstall) {
    try {
      const bin = discoverZCode({ env });
      const v = execFileSync(node, [bin, 'version'], { encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      steps.push({ name: 'preflight:zcode', ok: true, detail: `${bin} (${v})` });
    } catch (err) {
      steps.push({ name: 'preflight:zcode', ok: false, detail: String(err.message).split('\n').join(' '), fix: 'Install ZCode (desktop app: /Applications/ZCode.app) or set ZCODE_BIN to your zcode.cjs before running the installer (it is written into the registration).' });
    }
  }

  // Targets.
  const claudeBin = findOnPath('claude', env);
  const cHome = claudeHome(env);
  const desk = desktopConfigPath(env);
  let targets;
  if (opts.target === 'auto') {
    targets = [];
    if (claudeBin || existsSync(cHome)) targets.push('claude-code');
    if (existsSync(dirname(desk.path))) targets.push('claude-desktop');
    if (!targets.length) {
      steps.push({ name: 'targets', ok: false, detail: `found neither Claude Code (\`claude\` on PATH or ${cHome}) nor Claude Desktop (${dirname(desk.path)})`, fix: `${CLAUDE_HINT}; or install Claude Desktop; or pass --target explicitly.` });
      return report();
    }
  } else {
    targets = opts.target === 'all' ? ['claude-code', 'claude-desktop'] : [opts.target];
  }
  steps.push({ name: 'targets', ok: true, detail: `${targets.join(', ')}${opts.target === 'auto' ? ' (auto-detected)' : ''}` });

  // --copy-to: the runtime the clients will start.
  if (opts.copyTo && !opts.uninstall) {
    let entries = [];
    try { entries = readdirSync(runtime); } catch { /* absent: fine */ }
    const isCopy = entries.includes(RUNTIME_MARKER);
    if (entries.length && !isCopy && !opts.force) {
      steps.push({ name: 'copy-runtime', ok: false, detail: `${runtime} is not empty and is not a zcode-mcp runtime copy (no ${RUNTIME_MARKER}); nothing was copied`, fix: 'Choose a new or empty directory (e.g. ~/.local/share/zcode-mcp), or --force to copy into it anyway (it overwrites src/ and package.json there).' });
      return report();
    }
    const items = ['src', 'package.json', 'LICENSE'].filter((i) => existsSync(join(repoRoot, i)));
    if (!dry) {
      mkdirSync(runtime, { recursive: true });
      // An earlier copy: replace src/ as a whole so files removed upstream do not linger.
      if (isCopy) rmSync(join(runtime, 'src'), { recursive: true, force: true });
      for (const i of items) cpSync(join(repoRoot, i), join(runtime, i), { recursive: true, force: true });
      writeFileSync(join(runtime, RUNTIME_MARKER), `zcode-mcp runtime copy ${version} from ${repoRoot}\n`);
    }
    for (const i of [...items, RUNTIME_MARKER]) files.push({ path: join(runtime, i), action: would('written') });
    steps.push({ name: 'copy-runtime', ok: true, detail: `${dry ? 'would copy' : 'copied'} ${items.join(', ')} to ${runtime}${isCopy ? ' (replacing an earlier copy)' : ''}` });
  }

  let claudeCodeUsable = false;
  if (targets.includes('claude-code')) claudeCodeUsable = claudeCodeTarget({ opts, env, claudeBin, cHome, want, steps, registered, files, would, dry });
  if (targets.includes('claude-desktop')) desktopTarget({ opts, desk, want, steps, registered, files, would, dry });
  if (claudeCodeUsable) filesTarget({ opts, cHome, steps, files, would, dry });

  // A missing `claude` only fails the run when no other target did its job.
  const missing = steps.find((s) => s.name === 'register:claude-code' && s.missingClaude);
  if (missing) {
    delete missing.missingClaude;
    missing.ok = registered.some((r) => !['conflict', 'elsewhere'].includes(r.status));
  }

  if (!dry && !opts.uninstall) {
    const st = await runSelfTest({ node, server, env: cleanEnv(env, regEnv), probe: opts.probe });
    steps.push(...st.steps);
  }

  const ok = steps.every((s) => s.ok);
  if (dry) nextSteps.push('Nothing was written. Show this plan to the user; re-run without --dry-run (with --yes) to apply it.');
  else if (!ok) nextSteps.push('Apply the fix of each FAIL line, then re-run the installer (it is idempotent) or `npm run doctor`.');
  else if (opts.uninstall) {
    if (registered.some((r) => r.status === 'removed')) nextSteps.push('Restart Claude Code / quit and reopen Claude Desktop so the server disappears.');
    if (registered.some((r) => r.status === 'foreign')) nextSteps.push(`A server named "${opts.name}" that this installer did not add was left registered.`);
    if (opts.copyTo) nextSteps.push(`The runtime copy in ${runtime} was kept; delete it yourself if it is no longer needed.`);
  } else {
    nextSteps.push('Start a new Claude Code session / quit and reopen Claude Desktop so the server is loaded.');
    if (targets.includes('claude-code') && claudeCodeUsable) nextSteps.push(`Verify: \`claude mcp get ${opts.name}\` shows "✔ Connected".`);
    nextSteps.push('First use: ask Claude "Check the ZCode installation with zcode_check" — expect "ok": true and no warnings.');
  }
  if (warn && !opts.uninstall) nextSteps.push('The runtime lies in a temporary location: re-run with --copy-to <stable dir>.');
  return report();
}

/** -> true when skill/agent should be handled for Claude Code. */
function claudeCodeTarget({ opts, env, claudeBin, cHome, want, steps, registered, files, would, dry }) {
  const name = 'register:claude-code';
  if (!claudeBin) {
    steps.push({ name, ok: false, missingClaude: true, detail: 'skipped: the `claude` CLI is not on PATH', fix: CLAUDE_HINT });
    return false;
  }
  if (opts.scope === 'project' && (process.cwd() + '/').startsWith(repoRoot + '/')) {
    steps.push({ name, ok: false, detail: `--scope project registers the server for the project in the current directory, but that is the zcode-mcp clone (${process.cwd()}), whose .mcp.json belongs to Grok/Cursor`, fix: 'Run the installer from the project directory you want it in (node /path/to/zcode-mcp/scripts/install.mjs --scope project), or use --scope user.' });
    return false;
  }
  const plugin = pluginInstalled(cHome, PLUGIN_NAME);
  if (plugin && !opts.force && !opts.uninstall) {
    steps.push({ name, ok: true, detail: `skipped: plugin ${plugin} already provides the server, skill and agent (tools mcp__plugin_zcode-delegate_zcode__*); a second user-level server would duplicate the tools. Use --force to add it anyway.` });
    return false;
  }
  // User scope from HOME, so a .mcp.json of the current directory (e.g. this clone's) is not seen.
  const run = { env, cwd: opts.scope === 'project' ? process.cwd() : whoami(env).home };
  // The file `claude mcp add/remove` writes. Without it no user-scope server exists, and
  // `claude mcp get` is not called (it would create the file, also in a dry run).
  const cfgFile = opts.scope === 'project' ? join(process.cwd(), '.mcp.json') : userConfigFile(env);
  const cur = opts.scope === 'user' && !existsSync(cfgFile) ? { state: 'absent' } : registrationState(claudeBin, opts.name, opts.scope, want, run);
  const entry = (status) => registered.push({ target: 'claude-code', name: opts.name, scope: opts.scope, command: want.command, args: want.args, env: want.env, status });
  const shown = cur.found ? `${cur.found.command} ${redactArgs(cur.found.args)}` : '';
  const other = cur.otherScope ? `; note: a server "${opts.name}" also exists in the ${cur.otherScope} scope (not touched)` : '';
  const wrote = (by) => files.push({ path: cfgFile, action: would('written'), by });
  if (opts.uninstall) {
    if (cur.state === 'absent') { entry('absent'); steps.push({ name, ok: true, detail: `no server "${opts.name}" registered in the ${opts.scope} scope${other}` }); return true; }
    if (cur.kind === 'elsewhere' && !opts.force) {
      entry('elsewhere');
      steps.push({ name, ok: false, detail: `"${opts.name}" runs zcode-mcp from another location (${shown}), not from ${want.args[0]}; it stays registered`, fix: `Re-run the uninstall from that clone (or with the --copy-to used for the install), or add --force to remove it, or: claude mcp remove ${opts.name} -s ${opts.scope}` });
      return true;
    }
    if (cur.kind === 'foreign' && !opts.force) {
      entry('foreign');
      steps.push({ name, ok: true, detail: `left alone: "${opts.name}" is a different server (${shown}), not added by this installer`, fix: 'Use --force to remove it anyway.' });
      return true;
    }
    if (!dry) {
      const r = removeServer(claudeBin, opts.name, opts.scope, run);
      if (r.code !== 0) { steps.push({ name, ok: false, detail: `claude mcp remove failed: ${(r.stderr || r.stdout).trim()}`, fix: `Remove it by hand: claude mcp remove ${opts.name} -s ${opts.scope}` }); return true; }
    }
    wrote('claude mcp remove');
    entry(dry ? 'would-remove' : 'removed');
    steps.push({ name, ok: true, detail: `${dry ? 'would remove' : 'removed'} "${opts.name}" (${opts.scope} scope)` });
    return true;
  }
  if (cur.state === 'same') {
    entry('unchanged');
    steps.push({ name, ok: true, detail: `"${opts.name}" is already registered with this command (${opts.scope} scope)` });
    return true;
  }
  if (cur.state === 'different' && !opts.force) {
    entry('conflict');
    steps.push({ name, ok: false, detail: `a different server is registered as "${opts.name}": ${shown}`, fix: `Choose another --name, remove it (claude mcp remove ${opts.name} -s ${opts.scope}), or re-run with --force to replace it.` });
    return false;
  }
  if (!dry) {
    if (cur.state !== 'absent') removeServer(claudeBin, opts.name, opts.scope, run);
    const r = addServer(claudeBin, opts.name, opts.scope, want, run);
    if (r.code !== 0) {
      steps.push({ name, ok: false, detail: `claude mcp add failed: ${(r.stderr || r.stdout).trim()}`, fix: `Run it by hand: claude mcp add --scope ${opts.scope} ${opts.name} -- "${want.command}" "${want.args[0]}"` });
      return false;
    }
  }
  wrote('claude mcp add');
  const status = { absent: 'added', outdated: 'updated', different: 'replaced' }[cur.state];
  entry(dry ? { added: 'would-add', updated: 'would-update', replaced: 'would-replace' }[status] : status);
  steps.push({ name, ok: true, detail: `${dry ? 'would run' : 'ran'}: claude mcp add --scope ${opts.scope} ${opts.name} -- ${want.command} ${want.args[0]}${cur.state === 'outdated' ? ` (updates our earlier registration: ${shown})` : ''}${other}` });
  return true;
}

function desktopTarget({ opts, desk, want, steps, registered, files, would, dry }) {
  const name = 'register:claude-desktop';
  const entryObj = { command: want.command, args: want.args, ...(Object.keys(want.env).length ? { env: want.env } : {}) };
  const note = desk.tested ? '' : ' (this platform\'s path is documented but untested)';
  const text = readOrNull(desk.path);
  let res;
  try {
    res = opts.uninstall ? removeDesktopEntry(text, opts.name, want.args[0], { force: opts.force }) : mergeDesktopConfig(text, opts.name, entryObj, { force: opts.force });
  } catch (err) {
    steps.push({ name, ok: false, detail: `${desk.path}: ${err.message}`, fix: `The user repairs ${desk.path} (or moves it away), then re-run.` });
    return;
  }
  const entry = (status) => registered.push({ target: 'claude-desktop', name: opts.name, config: desk.path, command: want.command, args: want.args, env: want.env, status });
  if (res.status === 'conflict') {
    entry('conflict');
    steps.push({ name, ok: false, detail: `${desk.path} already has a different mcpServers.${opts.name}`, fix: 'Choose another --name or re-run with --force to replace it (a backup is written first).' });
    return;
  }
  if (res.status === 'elsewhere') {
    entry('elsewhere');
    steps.push({ name, ok: false, detail: `${desk.path}: mcpServers.${opts.name} runs zcode-mcp from another location, not from ${want.args[0]}; it stays`, fix: 'Re-run the uninstall from that clone (or with the --copy-to used for the install), or add --force to remove it.' });
    return;
  }
  if (res.status === 'unchanged' || res.status === 'absent' || res.status === 'foreign') {
    entry(res.status);
    steps.push({ name, ok: true, detail: `${desk.path}: ${res.status === 'foreign' ? `mcpServers.${opts.name} is a different server, left alone (--force removes it)` : res.status === 'absent' ? 'no entry to remove' : 'entry already present'}${note}` });
    return;
  }
  if (text !== null) {
    const bak = freeBackupPath(desk.path);
    if (!dry) copyFileSync(desk.path, bak);
    files.push({ path: bak, action: would('backup') });
  }
  if (!dry) {
    mkdirSync(dirname(desk.path), { recursive: true });
    writeAtomic(desk.path, res.text);
  }
  files.push({ path: desk.path, action: would('written') });
  const verb = { added: 'add', updated: 'update', replaced: 'replace', removed: 'remove' }[res.status];
  entry(dry ? `would-${verb}` : res.status);
  steps.push({ name, ok: true, detail: `${dry ? `would ${verb}` : res.status} mcpServers.${opts.name} in ${desk.path}${note}` });
}

// Skill and agent for Claude Code (user scope: <claude home>, project scope: ./.claude).
function filesTarget({ opts, cHome, steps, files, would, dry }) {
  const base = opts.scope === 'project' ? join(process.cwd(), '.claude') : cHome;
  const plugin = pluginInstalled(cHome, PLUGIN_NAME);
  const items = [
    ['skill', opts.skill, join(base, 'skills', 'zcode-delegate', 'SKILL.md'), () => readFileSync(join(repoRoot, 'skills', 'zcode-delegate', 'SKILL.md'), 'utf8')],
    ['agent', opts.agent, join(base, 'agents', 'zcode-worker.md'), () => renderAgent(readFileSync(join(repoRoot, 'claude', 'agents', 'zcode-worker.md'), 'utf8'), opts.name)],
  ];
  for (const [name, wanted, dest, content] of items) {
    if (!wanted) { steps.push({ name, ok: true, detail: `skipped (--no-${name})` }); continue; }
    if (plugin && !opts.uninstall && !opts.force) { steps.push({ name, ok: true, detail: `skipped: plugin ${plugin} provides it` }); continue; }
    const body = content();
    const cur = readOrNull(dest);
    if (opts.uninstall) {
      if (cur === null) { steps.push({ name, ok: true, detail: `${dest} not present` }); continue; }
      if (cur !== body && !opts.force) { steps.push({ name, ok: true, detail: `left alone: ${dest} differs from this installer's version (edited?)`, fix: 'Use --force to remove it anyway.' }); continue; }
      if (!dry) {
        rmSync(dest);
        if (name === 'skill') { try { rmdirSync(dirname(dest)); } catch { /* not empty: keep */ } }
      }
      files.push({ path: dest, action: would('removed') });
      steps.push({ name, ok: true, detail: `${dry ? 'would remove' : 'removed'} ${dest}` });
      continue;
    }
    if (cur === body) { files.push({ path: dest, action: 'unchanged' }); steps.push({ name, ok: true, detail: `${dest} is up to date` }); continue; }
    if (cur !== null && !opts.force) {
      steps.push({ name, ok: false, detail: `${dest} exists with different content`, fix: 'Re-run with --force to replace it (a backup is written first), or with --no-' + name + '.' });
      continue;
    }
    if (cur !== null) {
      const bak = freeBackupPath(dest);
      if (!dry) copyFileSync(dest, bak);
      files.push({ path: bak, action: would('backup') });
    }
    if (!dry) {
      mkdirSync(dirname(dest), { recursive: true });
      writeAtomic(dest, body, 0o644);
    }
    files.push({ path: dest, action: would('written') });
    steps.push({ name, ok: true, detail: `${dry ? 'would write' : 'wrote'} ${dest}` });
  }
}

function ask(question, { stdin, stderr }) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stderr });
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  if (argv.includes('--doctor')) return doctorMain(argv.filter((a) => a !== '--doctor'), { env, stdout, stderr });
  let opts;
  try {
    opts = parseInstallArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const { user, home } = whoami(env);
    emitRefusal({ json: argv.includes('--json'), version: packageVersion(), user, home, name: 'usage', detail: err.message, fix: INSTALL_USAGE, stdout, stderr });
    return 2;
  }
  if (opts.help) {
    stdout.write(`${INSTALL_USAGE}\n`);
    return 0;
  }
  const title = opts.uninstall ? 'zcode-mcp uninstaller' : 'zcode-mcp installer';
  if (!opts.dryRun && !opts.yes) {
    const { user, home } = whoami(env);
    const refuse = (detail, fix) => emitRefusal({ json: opts.json, version: packageVersion(), user, home, name: 'confirm', detail, fix, stdout, stderr });
    if (!(stdin.isTTY && stderr.isTTY)) {
      refuse('Not running in a terminal, so the installer cannot ask for confirmation. Nothing was changed.', 'Review the plan with --dry-run, then re-run with --yes.');
      return 2;
    }
    const plan = await execute({ ...opts, dryRun: true }, env);
    emit(`${title} (plan)`, plan, { json: false, stdout: stderr, stderr });
    if (!(await ask('Apply this plan? [y/N] ', { stdin, stderr }))) {
      refuse('Aborted at the confirmation; nothing was changed.', 'Re-run and answer y, or pass --yes.');
      return 2;
    }
  }
  const report = await execute(opts, env);
  emit(title, report, { json: opts.json, stdout, stderr });
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

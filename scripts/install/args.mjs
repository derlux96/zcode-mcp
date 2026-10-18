// Command-line parsing for scripts/install.mjs and scripts/doctor.mjs (exit 2 on a UsageError).
import { resolve } from 'node:path';

export class UsageError extends Error {}

export const INSTALL_USAGE = `Usage: node scripts/install.mjs [options]
  --target claude-code|claude-desktop|all   default: every client found on this machine
  --scope user|project      Claude Code scope (default user)
  --name <name>             MCP server name (default zcode)
  --copy-to <dir>           copy the runtime (src/, package.json) to <dir> and register that copy
  --no-skill, --no-agent    do not copy the skill / the agent to Claude Code
  --no-probe                self-test without the model probe (no model request)
  --dry-run                 print what would be done; write nothing
  --json                    one JSON document on stdout (human text on stderr)
  --yes, -y                 do not ask for confirmation (required without a terminal)
  --force                   replace a different server/file of the same name
  --uninstall               remove what this installer added (backups are kept)
  --doctor                  run the doctor instead (node scripts/doctor.mjs)
Exit codes: 0 ok, 1 a step failed, 2 usage error.`;

export const DOCTOR_USAGE = `Usage: node scripts/doctor.mjs [--no-probe] [--json]
  --probe / --no-probe   send one tiny model request (default on)
  --json                 one JSON document on stdout (human text on stderr)
Exit codes: 0 all checks pass, 1 a check failed, 2 usage error.`;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICES = { target: ['claude-code', 'claude-desktop', 'all'], scope: ['user', 'project'] };

// Splits --flag=value; returns [flag, inlineValue|undefined].
function split(arg) {
  const i = arg.indexOf('=');
  return arg.startsWith('--') && i > 0 ? [arg.slice(0, i), arg.slice(i + 1)] : [arg, undefined];
}

function takeValue(argv, i, flag, inline) {
  if (inline !== undefined) return [inline, i];
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('-')) throw new UsageError(`${flag} needs a value`);
  return [v, i + 1];
}

export function parseInstallArgs(argv) {
  const o = {
    target: 'auto', scope: 'user', name: 'zcode', copyTo: null, skill: true, agent: true, probe: true,
    dryRun: false, json: false, yes: false, force: false, uninstall: false, help: false,
  };
  const bool = {
    '--no-skill': ['skill', false], '--no-agent': ['agent', false], '--no-probe': ['probe', false],
    '--dry-run': ['dryRun', true], '--json': ['json', true], '--yes': ['yes', true], '-y': ['yes', true],
    '--force': ['force', true], '--uninstall': ['uninstall', true], '--help': ['help', true], '-h': ['help', true],
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = split(argv[i]);
    if (bool[flag] && inline === undefined) {
      o[bool[flag][0]] = bool[flag][1];
      continue;
    }
    let v;
    switch (flag) {
      case '--target':
      case '--scope':
        [v, i] = takeValue(argv, i, flag, inline);
        if (!CHOICES[flag.slice(2)].includes(v)) throw new UsageError(`${flag} must be one of ${CHOICES[flag.slice(2)].join(', ')}`);
        o[flag.slice(2)] = v;
        break;
      case '--name':
        [v, i] = takeValue(argv, i, flag, inline);
        if (!NAME.test(v)) throw new UsageError('--name may contain only letters, digits, "_" and "-" (max 64)');
        o.name = v;
        break;
      case '--copy-to':
        [v, i] = takeValue(argv, i, flag, inline);
        if (!v) throw new UsageError('--copy-to needs a directory');
        o.copyTo = resolve(v);
        break;
      default:
        throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  return o;
}

export function parseDoctorArgs(argv) {
  const o = { probe: true, json: false, help: false };
  for (const a of argv) {
    if (a === '--probe') o.probe = true;
    else if (a === '--no-probe') o.probe = false;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return o;
}

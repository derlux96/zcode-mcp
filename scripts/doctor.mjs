#!/usr/bin/env node
// Doctor: which user/home is examined, ZCode binary + version, the provider table
// (key presence only), baseUrl sanity and (default) one tiny model probe — through
// the same self-test the installer runs. Exit 0 only when every check passes.
// Usage: node scripts/doctor.mjs [--no-probe] [--json]   (npm run doctor)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../src/is-main.mjs';
import { parseDoctorArgs, DOCTOR_USAGE, UsageError } from './install/args.mjs';
import { whoami } from './install/context.mjs';
import { cleanEnv, forwardedEnv, runSelfTest } from './install/selftest.mjs';
import { emit, emitRefusal } from './install/report.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const packageVersion = () => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

export function nodeStep(node = process.execPath, version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  return major >= 18
    ? { name: 'preflight:node', ok: true, detail: `node ${version} at ${node}` }
    : { name: 'preflight:node', ok: false, detail: `node ${version} at ${node} is too old`, fix: 'Install Node.js 18 or newer (https://nodejs.org) and run again with it.' };
}

export function userStep(env) {
  const { user, home } = whoami(env);
  return { name: 'preflight:user', ok: true, detail: `user ${user}, home ${home}: ZCode's login and provider config of THIS user (${join(home, '.zcode')}) are examined; another macOS user has their own` };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseDoctorArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const { user, home } = whoami(env);
    emitRefusal({ json: argv.includes('--json'), version: packageVersion(), user, home, name: 'usage', detail: err.message, fix: DOCTOR_USAGE, stdout, stderr });
    return 2;
  }
  if (opts.help) {
    stdout.write(`${DOCTOR_USAGE}\n`);
    return 0;
  }
  const { user, home } = whoami(env);
  const version = packageVersion();
  const node = process.execPath;
  const server = join(repoRoot, 'src', 'mcp-server.mjs');
  const steps = [userStep(env), nodeStep(node)];
  const st = await runSelfTest({ node, server, env: cleanEnv(env, forwardedEnv(env)), probe: opts.probe });
  steps.push(...st.steps);
  const ok = steps.every((s) => s.ok);
  const nextSteps = ok
    ? [opts.probe ? 'ZCode answers model requests: delegation is ready.' : 'Static checks pass; run without --no-probe to test a real model request (costs one tiny request).']
    : ['Apply the fix of each FAIL line (fixes marked "the user" need the human, e.g. entering an API key), then run the doctor again.'];
  const report = { ok, version, user, home, steps, registered: [], files: [], nextSteps, providers: st.providers, providerFile: st.providerFile };
  emit('zcode-mcp doctor', report, { json: opts.json, stdout, stderr });
  return ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

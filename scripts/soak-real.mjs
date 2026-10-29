#!/usr/bin/env node
// Stage 5: soak run. ONE long, deterministic, multi-step task on the real
// protocol path as a background job; the MCP server is killed (-9) once mid-run
// and replaced by a fresh one on the same home. The job must survive, keep its
// heartbeat and activity advancing, and end completed (effect checked) or fail
// truthfully. Spends real ZCode quota (20-40 min of model work): only with --real.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMain } from '../src/is-main.mjs';
import { safeSignal, sleep } from '../test/helpers.mjs';
import {
  startCli, tempDir, initRepo, realServer, stopServer, readJobStatus, parseResultText,
  assertNothingLeft, writeReport, TERMINAL,
} from './real-lib.mjs';

const USAGE = `usage: node scripts/soak-real.mjs --real [--minutes N] [--modules N] [--restart-at M] [--cap-min C] [--poll-sec S] [--dry-run]

Starts one real protocol-path job (wait_ms 0) that writes N small modules with
tests one after another, running the test suite after each step. Polls
zcode_status every S s (default 60), kills the MCP server with SIGKILL once after M
minutes and continues with a fresh server on the same ZCODE_MCP_HOME.
  --minutes N     planned duration (default 25)
  --cap-min C     cancel the job after C minutes (default max(2N, N+20))
  --modules N     task size (default 25 modules; raise it if the job finishes too early)
  --restart-at M  minute of the server restart (default max(2, N/3))
  --poll-sec S    zcode_status poll interval in seconds, at least 10 (default 60)
  --dry-run       print the plan and the prompt, start nothing
Spends real ZCode quota. Report: $ZCODE_MCP_HOME/reports/soak-*.json.
`;

/** The deterministic long task: n modules, tests after every step. */
export function soakPrompt(n) {
  return [
    `Work through the following ${n} steps strictly one after another, in order. Do not batch steps.`,
    `For each i from 1 to ${n}:`,
    '  a) Create mod<i>.js (CommonJS) exporting a function f<i>(x) that returns x * <i> + <i>.',
    '  b) Create mod<i>.test.js using node:test and node:assert with three cases: f<i>(0) === <i>, f<i>(1) === 2*<i>, f<i>(2) === 3*<i>.',
    '  c) Run the complete test suite with `node --test` in the current directory and read its result.',
    '  d) Only when every test passes, append exactly one line "step <i>: PASS" to progress.log. If a test fails, fix the module and rerun before appending.',
    `Files to create, for reference: ${Array.from({ length: n }, (_, k) => `mod${k + 1}.js`).join(', ')} and the matching .test.js files.`,
    'After the last step write exactly DONE into done.txt. Do not modify any other file.',
  ].join('\n');
}

/** Effect check after a completed soak job. */
export function checkSoakEffect(dir, n) {
  const reasons = [];
  for (let i = 1; i <= n; i++) {
    for (const f of [`mod${i}.js`, `mod${i}.test.js`]) if (!existsSync(join(dir, f))) reasons.push(`missing ${f}`);
  }
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } };
  const log = read('progress.log');
  const want = Array.from({ length: n }, (_, k) => `step ${k + 1}: PASS`).join('\n');
  if (log === null) reasons.push('missing progress.log');
  else if (log.replace(/\r\n/g, '\n').trim() !== want) reasons.push(`progress.log does not list steps 1..${n} in order`);
  const done = read('done.txt');
  if (done === null || done.trim() !== 'DONE') reasons.push('done.txt missing or not DONE');
  return reasons.length ? { ok: false, reason: reasons.join('; ') } : { ok: true };
}

/**
 * Verdict over the timeline. Entries: { kind: 'poll', t, state, heartbeatAt,
 * lastActivityAt, warnings }, { kind: 'restart', t }, { kind: 'final', t, state,
 * errorKind, effectOk }. t in seconds since the start.
 */
export function judgeSoak(timeline) {
  const reasons = [];
  const restartIdx = timeline.findIndex((e) => e.kind === 'restart');
  const polls = timeline.filter((e) => e.kind === 'poll');
  if (restartIdx < 0) reasons.push('no server restart happened during the run');
  else if (timeline[restartIdx].killed === false) reasons.push('the kill of the MCP server was refused (identity mismatch); restart not tested');
  else if (!timeline.slice(restartIdx + 1).some((e) => e.kind === 'poll')) reasons.push('no poll after the restart');

  for (const p of polls) if (p.state === 'lost') reasons.push(`job turned lost at t=${p.t}s`);
  // Only `running` polls: the runner writes no heartbeat while `starting`.
  const running = polls.filter((p) => p.state === 'running');
  for (let i = 1; i < running.length; i++) {
    const a = Date.parse(running[i - 1].heartbeatAt);
    const b = Date.parse(running[i].heartbeatAt);
    if (!(b > a)) reasons.push(`heartbeat did not advance between t=${running[i - 1].t}s and t=${running[i].t}s`);
  }
  const stalled = polls.filter((p) => (p.warnings || []).includes('stalled')).length;
  if (stalled) reasons.push(`stalled warning in ${stalled} poll(s)`);

  if (restartIdx >= 0) {
    const before = timeline.slice(0, restartIdx).filter((e) => e.kind === 'poll' && !TERMINAL.includes(e.state));
    const afterRunning = timeline.slice(restartIdx + 1).filter((e) => e.kind === 'poll' && !TERMINAL.includes(e.state));
    const last = before.length ? Date.parse(before[before.length - 1].lastActivityAt) : NaN;
    if (Number.isFinite(last) && afterRunning.length && !afterRunning.some((p) => Date.parse(p.lastActivityAt) > last)) {
      reasons.push('last activity did not advance after the restart');
    }
  }

  const final = timeline.find((e) => e.kind === 'final');
  if (!final) reasons.push('the job never reached a terminal state');
  else if (final.state === 'completed') { if (!final.effectOk) reasons.push('completed but the effect check failed'); }
  else if (final.state === 'failed') { if (!final.errorKind) reasons.push('failed without error_kind'); }
  else reasons.push(`job ended ${final.state}${final.state === 'timeout' ? ` (${final.errorKind || 'timeout'})` : ''}`);

  return {
    ok: reasons.length === 0,
    reasons,
    stats: { polls: polls.length, stalledPolls: stalled, restartAt: restartIdx >= 0 ? timeline[restartIdx].t : null, finalState: final ? final.state : null },
  };
}

/** Option checks -> list of error messages ([] = ok). */
export function validateSoakOptions({ minutes, modules, restartAt, capMin, pollSec }) {
  const errors = [];
  for (const [name, v] of [['--minutes', minutes], ['--modules', modules], ['--restart-at', restartAt], ['--cap-min', capMin], ['--poll-sec', pollSec]]) {
    if (!Number.isFinite(v) || v <= 0) errors.push(`${name} must be a positive number`);
  }
  if (Number.isFinite(modules) && !Number.isInteger(modules)) errors.push('--modules must be an integer');
  // The runner beats every 5 s; shorter polls would see unchanged heartbeats.
  if (Number.isFinite(pollSec) && pollSec > 0 && pollSec < 10) errors.push('--poll-sec must be at least 10 (the heartbeat interval is 5 s)');
  return errors;
}

async function main() {
  const flags = startCli(process.argv.slice(2), { boolean: ['dry-run'], value: ['minutes', 'modules', 'restart-at', 'cap-min', 'poll-sec'] }, USAGE);
  const minutes = Number(flags.minutes ?? 25);
  const modules = Number(flags.modules ?? 25);
  const restartAt = Number(flags['restart-at'] ?? Math.max(2, minutes / 3));
  const capMin = Number(flags['cap-min'] ?? Math.max(2 * minutes, minutes + 20));
  const pollSec = Number(flags['poll-sec'] ?? 60);
  const errors = validateSoakOptions({ minutes, modules, restartAt, capMin, pollSec });
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n\n${USAGE}`);
    return 2;
  }
  const plan = { minutes, modules, restartAtMin: restartAt, capMin, pollEverySec: pollSec, prompt: soakPrompt(modules) };
  if (flags['dry-run']) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return 0; }

  const home = tempDir('zcode-soak-home-');
  const repo = tempDir('zcode-soak-repo-');
  initRepo(repo);
  const report = { name: 'soak-real', startedAt: new Date().toISOString(), home, repo, plan };
  const timeline = [];
  const t0 = Date.now();
  const sec = () => Math.round((Date.now() - t0) / 1000);
  let client = await realServer(home);
  let jobId = null;
  // Cancels the job through a live server (a fresh one if the current one is gone).
  const cancelJob = async () => {
    if (!jobId) return;
    const c = client && !client.hasExited ? client : await realServer(home).catch(() => null);
    if (!c) return;
    await c.callTool('zcode_cancel', { job_id: jobId }, { timeoutMs: 60000 }).catch(() => {});
    if (c !== client) await stopServer(c);
  };
  // Hard wall-clock guard: whatever hangs, the job is cancelled and the run ends.
  const hardMs = (capMin + 15) * 60000;
  const watchdog = setTimeout(async () => {
    report.error = `hard wall-clock guard hit after ${capMin + 15} min`;
    await cancelJob();
    await stopServer(client);
    report.timeline = timeline;
    report.verdict = judgeSoak(timeline);
    report.ok = false;
    writeReport(home, 'soak', report);
    process.exit(1);
  }, hardMs);
  try {
    const started = await client.callTool('zcode_run', { prompt: plan.prompt, cwd: repo, wait_ms: 0 }, { timeoutMs: 120000 });
    jobId = parseResultText(started.text).jobId;
    report.start = started.text.slice(0, 2000);
    if (!jobId) throw new Error(`zcode_run did not start a job: ${started.text.slice(0, 500)}`);
    let restarted = false;
    for (;;) {
      await sleep(pollSec * 1000);
      if (!restarted && Date.now() - t0 >= restartAt * 60000) {
        const killed = safeSignal(client.pid, 'SIGKILL', { expectStart: client.identity });
        timeline.push({ kind: 'restart', t: sec(), killed });
        restarted = true;
        if (!killed) {
          // Never wait for a server we could not kill: cancel and end with a failed verdict.
          report.error = 'the MCP server kill was refused (identity mismatch); job cancelled';
          await client.callTool('zcode_cancel', { job_id: jobId }, { timeoutMs: 60000 }).catch(() => {});
          break;
        }
        await Promise.race([client.exited, sleep(10000)]);
        try {
          client = await realServer(home);
        } catch (error) {
          throw new Error(`the replacement MCP server did not start: ${error.message}`);
        }
      }
      const r = await client.callTool('zcode_status', { job_id: jobId }, { timeoutMs: 120000 });
      const p = parseResultText(r.text);
      const s = readJobStatus(home, jobId) || {};
      timeline.push({ kind: 'poll', t: sec(), state: p.state, heartbeatAt: s.heartbeatAt || null, lastActivityAt: s.lastActivityAt || null, warnings: p.warnings, changedFiles: (p.changedFiles || []).length });
      process.stderr.write(`[soak] t=${sec()}s ${p.state} warnings=${p.warnings.join(',') || '-'}\n`);
      if (TERMINAL.includes(p.state)) break;
      if (Date.now() - t0 > capMin * 60000) {
        await client.callTool('zcode_cancel', { job_id: jobId }, { timeoutMs: 60000 });
        report.capped = true;
        break;
      }
    }
    const fin = await client.callTool('zcode_result', { job_id: jobId }, { timeoutMs: 60000 });
    const p = parseResultText(fin.text);
    const effect = p.state === 'completed' ? checkSoakEffect(repo, modules) : null;
    timeline.push({ kind: 'final', t: sec(), state: p.state, errorKind: p.errorKind, error: p.error, warnings: p.warnings, effectOk: effect ? effect.ok : false, effect });
    report.result = fin.text.slice(0, 4000);
  } catch (error) {
    report.error = String(error && error.stack ? error.stack : error);
    await cancelJob();
  } finally {
    clearTimeout(watchdog);
    await stopServer(client);
  }
  try {
    await assertNothingLeft([basename(home), basename(repo)], home, jobId ? [jobId] : []);
    report.leftover = { ok: true };
  } catch (error) {
    report.leftover = { ok: false, error: error.message };
  }
  rmSync(repo, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.timeline = timeline;
  report.verdict = judgeSoak(timeline);
  report.ok = !report.error && report.verdict.ok && report.leftover.ok;
  writeReport(home, 'soak', report);
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`soak-real: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

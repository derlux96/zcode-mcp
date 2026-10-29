// Protocol spike: verifies facts about the ZCode app-server event stream
// that the job API relies on. `--real` talks to the installed ZCode and
// spends a little quota; run it in a throwaway git repo, never in this repo.
import { pathToFileURL } from 'node:url';
import { AppServerClient, resolveBin, buildUserInputAnswer } from '../src/appserver.mjs';

const tsOf = (e) => (e && typeof e === 'object' ? (typeof e.ts === 'number' ? e.ts : typeof e.timestamp === 'number' ? e.timestamp : null) : null);

/** Pure analysis of session/event params objects. */
export function analyzeEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const types = [...new Set(list.map((e) => e && e.type).filter((t) => typeof t === 'string'))].sort();
  let maxGapMs = 0;
  let prev = null;
  for (const e of list) {
    const ts = tsOf(e);
    if (ts === null) continue;
    if (prev !== null && ts - prev > maxGapMs) maxGapMs = ts - prev;
    prev = ts;
  }
  const denied = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const decision = e.decision ?? p.decision;
    if (decision !== 'deny') continue;
    const name = e.toolName ?? e.tool ?? p.toolName ?? p.tool ?? p.name ?? e.name ?? '(unknown)';
    denied.add(String(name));
  }
  return { types, maxGapMs, deniedTools: [...denied].sort() };
}


// ---- --controls probes -------------------------------------------------

const TERMINAL = ['turn.completed', 'turn.failed'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncateText(v, max = 2000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function answerReachedOutput(output, answer) {
  return typeof output === 'string' && typeof answer === 'string' && answer !== '' && output.includes(answer);
}

/** Answer shapes to try for interaction/requestUserInput, in order, de-duplicated, max 4. */
export function answerShapes(params, text) {
  const all = [
    { name: 'buildUserInputAnswer', result: buildUserInputAnswer(params, text) },
    { name: '{ answer }', result: { answer: text } },
    { name: '{ text }', result: { text } },
    { name: '{ response: { text } }', result: { response: { text } } },
  ];
  const seen = new Set();
  const out = [];
  for (const s of all) {
    const key = JSON.stringify(s.result);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 4);
}

/** Raw facts of a probe's event list: types, steer events, terminal event with error code/message. */
export function summarizeProbeEvents(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const types = [...new Set(list.map((e) => e.type).filter((t) => typeof t === 'string'))].sort();
  const t = [...list].reverse().find((e) => TERMINAL.includes(e.type));
  let terminal = null;
  if (t) {
    const p = t.payload && typeof t.payload === 'object' ? t.payload : {};
    const err = p.error && typeof p.error === 'object' ? p.error : {};
    terminal = {
      type: t.type,
      errorCode: err.code ?? null,
      errorMessage: err.message ?? null,
      response: typeof p.response === 'string' ? p.response : null,
    };
  }
  return {
    types,
    steerQueued: types.includes('turn.steerQueued'),
    steerDrained: types.includes('turn.steerDrained'),
    terminal,
  };
}

export async function startSession(cwd, clientOpts = {}) {
  const client = new AppServerClient({ binPath: resolveBin(), cwd, ...clientOpts });
  try {
  await client.settle();
  const created = await client.request('session/create', {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
    mode: 'yolo',
  });
  const sessionId = created.session.sessionId;
  const current = created.settings && created.settings.model && created.settings.model.current;
  await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
  const send = (content) => client.request('session/send', {
    sessionId,
    content,
    ...(current ? { modelSelection: { providerId: current.providerId, modelId: current.modelId, options: current.options || {} } } : {}),
  });
  return { client, sessionId, send };
  } catch (e) {
    await client.close(); // do not leak the spawned app-server when setup fails
    throw e;
  }
}

const errInfo = (e) => ({ message: String(e && e.message), code: e && e.code });

function finish(client, extra = {}) {
  const sum = summarizeProbeEvents(client.events.slice());
  return { ...sum, response: truncateText(sum.terminal && sum.terminal.response, 2000), ...extra };
}

async function probeSteer(cwd, o) {
  let s;
  try {
    s = await startSession(cwd);
    await s.send('Count slowly from 1 to 50, one number per line, one line per second.');
    await sleep(o.steerAfterMs);
    let steerResult;
    try {
      steerResult = await s.client.request('v4/command', {
        commandId: `probe-steer-${Date.now()}`,
        clientId: 'zcode-delegate',
        sessionId: s.sessionId,
        type: 'sendText',
        payload: { text: 'stop at 10', delivery: { requested: 'guide' } },
        issuedAt: Date.now(),
      });
    } catch (e) {
      steerResult = { error: errInfo(e) };
    }
    let waitError = null;
    try {
      await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs });
    } catch (e) {
      waitError = errInfo(e);
    }
    await sleep(300);
    return finish(s.client, { v4CommandResult: steerResult, ...(waitError ? { waitError } : {}) });
  } catch (e) {
    return { error: errInfo(e) };
  } finally {
    if (s) await s.client.close();
  }
}

async function probeStop(cwd, o) {
  let s;
  try {
    s = await startSession(cwd);
    await s.send('Count slowly from 1 to 50, one number per line, one line per second.');
    await sleep(o.stopAfterMs);
    let stopResult;
    try {
      stopResult = await s.client.request('session/stop', { sessionId: s.sessionId });
    } catch (e) {
      stopResult = { error: errInfo(e) };
    }
    let waitError = null;
    try {
      await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs });
    } catch (e) {
      waitError = errInfo(e);
    }
    await sleep(300);
    return finish(s.client, { stopResult, ...(waitError ? { waitError } : {}) });
  } catch (e) {
    return { error: errInfo(e) };
  } finally {
    if (s) await s.client.close();
  }
}

async function probeUserInput(cwd, o) {
  const attempts = [];
  let requestUserInput = null;
  let workedShape = 'none';
  let lastFacts = {};
  const ANSWER = '8080';
  for (let i = 0; i < 4; i++) {
    let parked = null;
    let s;
    const attempt = {};
    try {
      s = await startSession(cwd, { onUserInput: (req) => { parked = req; } });
      await s.send('Ask me which port to use via your ask-user tool, then print it.');
      const deadline = Date.now() + o.turnTimeoutMs;
      while (!parked && Date.now() < deadline && !s.client.events.some((e) => e && TERMINAL.includes(e.type))) await sleep(200);
      if (!parked) {
        attempt.error = 'no interaction/requestUserInput arrived';
        attempts.push(attempt);
        lastFacts = finish(s.client);
        break; // the agent did not ask; further shapes cannot be tested
      }
      if (!requestUserInput) requestUserInput = parked.params;
      const shapes = answerShapes(parked.params, ANSWER);
      if (i >= shapes.length) { attempts.push({ skipped: 'no more shapes' }); break; }
      const shape = shapes[i];
      attempt.shape = shape.name;
      attempt.result = shape.result;
      attempt.accepted = s.client.respond(parked.protocolId, shape.result);
      try {
        await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs });
      } catch (e) {
        attempt.waitError = errInfo(e);
      }
      await sleep(300);
      lastFacts = finish(s.client);
      attempt.reached = answerReachedOutput(lastFacts.terminal && lastFacts.terminal.response, ANSWER);
      attempts.push(attempt);
      if (attempt.reached) { workedShape = shape.name; break; }
    } catch (e) {
      attempts.push({ ...attempt, error: errInfo(e) });
      break;
    } finally {
      if (s) await s.client.close();
    }
  }
  return { requestUserInput, workedShape, attempts, ...lastFacts };
}

/** Runs the steer, stop and user-input probes sequentially, each in a fresh session. */
export async function runControlProbes(cwd, opts = {}) {
  const o = { turnTimeoutMs: 180000, idleTimeoutMs: 90000, steerAfterMs: 3000, stopAfterMs: 3000, ...opts };
  const out = {};
  for (const [name, fn] of [['steer', probeSteer], ['stop', probeStop], ['userInput', probeUserInput]]) {
    try {
      out[name] = await fn(cwd, o);
    } catch (e) {
      out[name] = { error: errInfo(e) };
    }
  }
  return out;
}

async function runReal(cwd) {
  const client = new AppServerClient({ binPath: resolveBin(), cwd });
  try {
    await client.settle();
    const created = await client.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
      mode: 'yolo',
    });
    const sessionId = created.session.sessionId;
    const current = created.settings && created.settings.model && created.settings.model.current;
    await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
    await client.request('session/send', {
      sessionId,
      content: 'Create a file hello.txt containing hi',
      ...(current ? { modelSelection: { providerId: current.providerId, modelId: current.modelId, options: current.options || {} } } : {}),
    });
    const end = await client.waitForEvent(['turn.completed', 'turn.failed'], { timeoutMs: 180000, idleTimeoutMs: 90000 });
    await new Promise((r) => setTimeout(r, 500));
    const events = client.events.slice();
    const analysis = analyzeEvents(events);
    const firstByType = {};
    for (const e of events) if (!(e.type in firstByType)) firstByType[e.type] = e;
    return {
      sessionId,
      mode: created.session.mode,
      hasModelCurrent: !!current,
      modelCurrent: current || null,
      endType: end.type,
      eventCount: events.length,
      timestampFields: [...new Set(events.flatMap((e) => Object.keys(e).filter((k) => /ts|time|at/i.test(k))))],
      ...analysis,
      firstByType,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  if (!process.argv.includes('--real')) {
    process.stderr.write('usage: node scripts/verify-protocol.mjs --real [--controls]   (run with cwd = a throwaway git repo)\n');
    process.exit(2);
  }
  if (process.argv.includes('--controls')) {
    process.stdout.write(`${JSON.stringify(await runControlProbes(process.cwd()), null, 2)}\n`);
    return;
  }
  const result = await runReal(process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`${e && e.stack}\n`);
    process.exit(1);
  });
}

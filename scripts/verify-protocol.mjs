// Protocol spike: verifies facts about the ZCode app-server event stream
// that the job API relies on. `--real` talks to the installed ZCode and
// spends a little quota; run it in a throwaway git repo, never in this repo.
import { isMain } from '../src/is-main.mjs';
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
    // ZCode 0.17.0's AskUserQuestion fallbacks after content.answers[q.question]
    { name: '{ content: { answer_0 } }', result: { action: 'accept', content: { answer_0: text } } },
    { name: '{ content: { answer } }', result: { action: 'accept', content: { answer: text } } },
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

export const STEER_MARKER = 'PINEAPPLE';
export const DRAIN_MARKER = 'BANANA';

// v4/command helpers for one probe session: every answer's revisionAtDecision
// is kept, CAS commands go out with it as top-level baseRevision and a stale
// answer is retried once with the revision it carries.
function v4Commands(s) {
  let lastRevision = 0;
  let seq = 0;
  const request = async (type, payload, baseRevision) => {
    const params = {
      commandId: `probe-${type}-${Date.now()}-${++seq}`,
      clientId: 'zcode-delegate',
      sessionId: s.sessionId,
      ...(baseRevision === undefined ? {} : { baseRevision }),
      type,
      payload,
      issuedAt: Date.now(),
    };
    try {
      const r = await s.client.request('v4/command', params);
      if (r && typeof r.revisionAtDecision === 'number') lastRevision = r.revisionAtDecision;
      return r;
    } catch (e) {
      return { error: errInfo(e) };
    }
  };
  const cas = async (type, payload) => {
    const attempts = [];
    let baseRevision = lastRevision;
    for (let i = 0; i < 2; i++) {
      const result = await request(type, payload, baseRevision);
      attempts.push({ baseRevision, result });
      if (!(result && result.status === 'stale' && typeof result.revisionAtDecision === 'number')) break;
      baseRevision = result.revisionAtDecision;
    }
    return { result: attempts[attempts.length - 1].result, attempts };
  };
  return { request, cas };
}

/**
 * Steer probe (ZCode 0.17.0): a sendText {text, requestedDelivery:'guide'}
 * during a slow counting turn, asking for a marker word. Records the raw ack,
 * whether turn.steerDrained arrived and whether the marker reached the answer.
 */
export async function probeSteer(cwd, o) {
  let s;
  try {
    s = await startSession(cwd);
    const { request } = v4Commands(s);
    await s.send('Count slowly from 1 to 30, one number per line, one line per second.');
    await sleep(o.steerAfterMs);
    const steerResult = await request('sendText', { text: `After the number 20 write the word ${STEER_MARKER} once.`, requestedDelivery: 'guide' });
    let waitError = null;
    try {
      await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs });
    } catch (e) {
      waitError = errInfo(e);
    }
    await sleep(300);
    const out = finish(s.client, { v4CommandResult: steerResult, ...(waitError ? { waitError } : {}) });
    return { ...out, markerInAnswer: answerReachedOutput(out.response, STEER_MARKER) };
  } catch (e) {
    return { error: errInfo(e) };
  } finally {
    if (s) await s.client.close();
  }
}

/**
 * Auto-drain probe: a sendText with the default delivery ('queue') during a
 * short turn is held when the turn ends (autoDrain false). Then CAS
 * setAutoDrain {autoDrain:true} with baseRevision from the last ack (stale:
 * retried once) and records whether ZCode starts a second turn.
 */
export async function probeAutoDrain(cwd, o) {
  let s;
  try {
    s = await startSession(cwd);
    const { request, cas } = v4Commands(s);
    await s.send('Count from 1 to 10, one number per line.');
    await sleep(o.queueAfterMs);
    const queueResult = await request('sendText', { text: `Reply with only the word ${DRAIN_MARKER}.` });
    let waitError = null;
    try {
      await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs });
    } catch (e) {
      waitError = errInfo(e);
    }
    await sleep(300);
    const first = finish(s.client, { v4CommandResult: queueResult, ...(waitError ? { waitError } : {}) });
    const cursor = s.client.eventOrdinal;
    const from = s.client.events.length;
    const { result, attempts } = await cas('setAutoDrain', { autoDrain: true });
    let secondTurn = false;
    let drainWaitError = null;
    try {
      await s.client.waitForEvent('turn.started', { timeoutMs: o.autoDrainWaitMs, since: cursor });
      secondTurn = true;
      await s.client.waitForEvent(TERMINAL, { timeoutMs: o.turnTimeoutMs, idleTimeoutMs: o.idleTimeoutMs, since: cursor });
    } catch (e) {
      drainWaitError = errInfo(e);
    }
    await sleep(300);
    const sum = summarizeProbeEvents(s.client.events.slice(from));
    const response = truncateText(sum.terminal && sum.terminal.response, 2000);
    return {
      first,
      result,
      attempts,
      staleRetried: attempts.length > 1,
      secondTurn,
      ...sum,
      response,
      markerInAnswer: answerReachedOutput(response, DRAIN_MARKER),
      ...(drainWaitError ? { waitError: drainWaitError } : {}),
    };
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

/** Runs the steer, auto-drain, stop and user-input probes sequentially, each in a fresh session. */
export async function runControlProbes(cwd, opts = {}) {
  const o = { turnTimeoutMs: 180000, idleTimeoutMs: 90000, steerAfterMs: 3000, queueAfterMs: 300, stopAfterMs: 3000, autoDrainWaitMs: 10000, ...opts };
  const out = {};
  for (const [name, fn] of [['steer', probeSteer], ['autoDrain', probeAutoDrain], ['stop', probeStop], ['userInput', probeUserInput]]) {
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

if (isMain(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${e && e.stack}\n`);
    process.exit(1);
  });
}

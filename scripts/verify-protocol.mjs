// Protocol spike: verifies facts about the ZCode app-server event stream
// that the job API relies on. `--real` talks to the installed ZCode and
// spends a little quota; run it in a throwaway git repo, never in this repo.
import { pathToFileURL } from 'node:url';
import { AppServerClient, resolveBin } from '../src/appserver.mjs';

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
    process.stderr.write('usage: node scripts/verify-protocol.mjs --real   (run with cwd = a throwaway git repo)\n');
    process.exit(2);
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

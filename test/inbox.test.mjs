import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, chmodSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  INBOX_STALE_RESERVATION_MS, writeInboxEntry, readPending, writeAck, readAck, waitAck,
} from '../src/inbox.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'inbox-'));
const MODULE_URL = new URL('../src/inbox.mjs', import.meta.url).href;

test('first entry is seq 1, second is seq 2', () => {
  const d = tmp();
  assert.equal(writeInboxEntry(d, { kind: 'send', text: 'a' }), 1);
  assert.equal(writeInboxEntry(d, { kind: 'send', text: 'b' }), 2);
  const all = readPending(d, 0);
  assert.deepEqual(all.map((e) => [e.seq, e.kind, e.text]), [[1, 'send', 'a'], [2, 'send', 'b']]);
  assert.equal(typeof all[0].createdAt, 'string');
});

test('readPending(dir, 1) returns only seq 2', () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  writeInboxEntry(d, { kind: 'send', text: 'b' });
  assert.deepEqual(readPending(d, 1).map((e) => e.seq), [2]);
});

test('files have mode 0600 and the inbox dir 0700', () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  writeAck(d, 1, { status: 'delivered' });
  const inbox = join(d, 'inbox');
  assert.equal(statSync(inbox).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(inbox).sort(), ['000001.ack.json', '000001.json']);
  for (const f of readdirSync(inbox)) assert.equal(statSync(join(inbox, f)).mode & 0o777, 0o600);
});

test('20 parallel writeInboxEntry calls yield seqs 1..20 without duplicates', async () => {
  const d = tmp();
  const seqs = await Promise.all(Array.from({ length: 20 }, async (_, i) =>
    writeInboxEntry(d, { kind: 'send', text: `m${i}` })));
  assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(readPending(d, 0).length, 20);
});

test('writers in separate processes get unique contiguous seqs', () => {
  const d = tmp();
  const code = `import(${JSON.stringify(MODULE_URL)}).then(m => {
    const out = [];
    for (let i = 0; i < 10; i++) out.push(m.writeInboxEntry(process.argv[1], { kind: 'send', text: 'x' }));
    console.log(JSON.stringify(out));
  });`;
  const procs = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code, d], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.on('exit', (rc) => (rc === 0 ? resolve(JSON.parse(out)) : reject(new Error(`rc ${rc}`))));
  }));
  return Promise.all(procs).then((lists) => {
    const all = lists.flat().sort((a, b) => a - b);
    assert.deepEqual(all, Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(readPending(d, 0).length, 40);
  });
});

test('readPending ignores tmp files, ack files and reserved-empty entries', () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  const inbox = join(d, 'inbox');
  writeFileSync(join(inbox, '000002.json.tmp'), '{"seq":2,"kind":"se');
  writeFileSync(join(inbox, '000003.json.123.abcd.tmp'), '{}');
  writeFileSync(join(inbox, '000004.json'), '');
  writeFileSync(join(inbox, '000005.json'), '{"half');
  writeAck(d, 1, { status: 'delivered' });
  assert.deepEqual(readPending(d, 0).map((e) => e.seq), [1]);
});

const filled = (seq, text) => JSON.stringify({ seq, kind: 'send', text, createdAt: 'x' });

test('readPending returns only the prefix before an unfilled reservation', () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  const inbox = join(d, 'inbox');
  writeFileSync(join(inbox, '000002.json'), '');
  writeFileSync(join(inbox, '000003.json'), filled(3, 'c'));
  assert.deepEqual(readPending(d, 0).map((e) => e.seq), [1]);
  assert.deepEqual(readPending(d, 1), []);
  // filled before it goes stale: everything is delivered in order
  writeFileSync(join(inbox, '000002.json'), filled(2, 'b'));
  assert.deepEqual(readPending(d, 0).map((e) => e.seq), [1, 2, 3]);
});

test('a stale unfilled reservation is skipped', () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  const inbox = join(d, 'inbox');
  const f2 = join(inbox, '000002.json');
  writeFileSync(f2, '');
  writeFileSync(join(inbox, '000003.json'), filled(3, 'c'));
  const old = new Date(Date.now() - 10000);
  utimesSync(f2, old, old);
  assert.deepEqual(readPending(d, 0).map((e) => e.seq), [1, 3]);
  assert.equal(INBOX_STALE_RESERVATION_MS, 5000);
  // staleMs override
  const f4 = join(inbox, '000004.json');
  writeFileSync(f4, '');
  writeFileSync(join(inbox, '000005.json'), filled(5, 'e'));
  assert.deepEqual(readPending(d, 3).map((e) => e.seq), []);
  assert.deepEqual(readPending(d, 3, { staleMs: -1 }).map((e) => e.seq), [5]);
});

test('a failed content write releases the reservation', { skip: process.getuid?.() === 0 }, () => {
  const d = tmp();
  writeInboxEntry(d, { kind: 'send', text: 'a' });
  const inbox = join(d, 'inbox');
  chmodSync(inbox, 0o500);
  try { assert.throws(() => writeInboxEntry(d, { kind: 'send', text: 'b' })); } finally { chmodSync(inbox, 0o700); }
  assert.deepEqual(readdirSync(inbox), ['000001.json']);
});

test('seq continues after the highest existing entry, even a reserved one', () => {
  const d = tmp();
  mkdirSync(join(d, 'inbox'), { recursive: true });
  writeFileSync(join(d, 'inbox', '000007.json'), '');
  assert.equal(writeInboxEntry(d, { kind: 'send', text: 'a' }), 8);
});

test('readPending on a missing inbox returns []', () => {
  assert.deepEqual(readPending(tmp(), 0), []);
});

test('readPending orders entries by seq whatever order they were created in', () => {
  const d = tmp();
  const inbox = join(d, 'inbox');
  mkdirSync(inbox, { recursive: true });
  for (const seq of [2, 10, 3, 1]) writeFileSync(join(inbox, `${String(seq).padStart(6, '0')}.json`), filled(seq, `t${seq}`));
  assert.deepEqual(readPending(d, 0).map((e) => e.seq), [1, 2, 3, 10]);
});

test('an unfilled reservation is stale only once it is older than staleMs', () => {
  const d = tmp();
  const inbox = join(d, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const f1 = join(inbox, '000001.json');
  writeFileSync(f1, 'null');
  writeFileSync(join(inbox, '000002.json'), filled(2, 'b'));
  const t = 1700000000000;
  utimesSync(f1, t / 1000, t / 1000);
  assert.deepEqual(readPending(d, 0, { staleMs: 1000, now: () => t + 1000 }).map((e) => e.seq), []);
  assert.deepEqual(readPending(d, 0, { staleMs: 1000, now: () => t + 1001 }).map((e) => e.seq), [2]);
});

test('invalid input throws TypeError', () => {
  const d = tmp();
  assert.throws(() => writeInboxEntry(d, { kind: 'send', text: 5 }), TypeError);
  assert.throws(() => writeInboxEntry(d, { kind: 'stop', text: 'x' }), TypeError);
  assert.throws(() => writeInboxEntry(d, null), { name: 'TypeError', message: 'inbox entry must be an object' });
  assert.throws(() => writeInboxEntry(d, 'send'), { name: 'TypeError', message: 'inbox entry must be an object' });
  assert.deepEqual(readPending(d, 0), []);
});

test('readAck / writeAck round-trip', () => {
  const d = tmp();
  assert.equal(readAck(d, 1), null);
  writeAck(d, 1, { status: 'rejected', reason: 'nope' });
  const a = readAck(d, 1);
  assert.equal(a.status, 'rejected');
  assert.equal(a.reason, 'nope');
  assert.equal(typeof a.at, 'string');
  writeFileSync(join(d, 'inbox', '000002.ack.json'), '"accepted"');
  assert.equal(readAck(d, 2), null);
});

test('waitAck returns null after the timeout', async () => {
  const d = tmp();
  const t0 = Date.now();
  assert.equal(await waitAck(d, 1, 120), null);
  assert.ok(Date.now() - t0 >= 100);
});

test('waitAck returns the ack once written', async () => {
  const d = tmp();
  setTimeout(() => writeAck(d, 1, { status: 'delivered' }), 100);
  const a = await waitAck(d, 1, 3000);
  assert.equal(a.status, 'delivered');
});

test('waitAck resolves null on abort', async () => {
  const d = tmp();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  const t0 = Date.now();
  assert.equal(await waitAck(d, 1, 5000, { signal: ac.signal }), null);
  assert.ok(Date.now() - t0 < 2000);
  const pre = new AbortController();
  pre.abort();
  assert.equal(await waitAck(d, 1, 5000, { signal: pre.signal }), null);
});

// File-based inbox: the MCP server drops numbered entries into <job>/inbox/,
// the detached runner polls them and answers each with <seq>.ack.json.
import { closeSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, readJson, writeJsonAtomic } from './jobstore.mjs';

const ENTRY_RE = /^(\d+)\.json$/;
const POLL_MS = 50;
// A reserved entry that stays unfilled this long is treated as abandoned.
export const INBOX_STALE_RESERVATION_MS = 5000;

const inboxDir = (dir) => join(dir, 'inbox');
const name = (seq) => String(seq).padStart(6, '0');

function listEntrySeqs(inbox) {
  let names;
  try { names = readdirSync(inbox); } catch { return []; }
  const seqs = [];
  for (const n of names) {
    const m = ENTRY_RE.exec(n);
    if (m) seqs.push(parseInt(m[1], 10));
  }
  return seqs.sort((a, b) => a - b);
}

// Returns the seq assigned to the entry. The seq is reserved by creating the
// entry file exclusively ('wx'), so concurrent writers (also in other
// processes) never share one; the content then replaces the empty file by an
// atomic rename.
export function writeInboxEntry(dir, entry) {
  if (!entry || typeof entry !== 'object') throw new TypeError('inbox entry must be an object');
  if (entry.kind !== 'send') throw new TypeError("inbox entry kind must be 'send'");
  if (typeof entry.text !== 'string') throw new TypeError('inbox entry text must be a string');
  const inbox = inboxDir(dir);
  ensurePrivateDir(inbox);
  for (;;) {
    const seqs = listEntrySeqs(inbox);
    const seq = (seqs.length ? seqs[seqs.length - 1] : 0) + 1;
    const file = join(inbox, `${name(seq)}.json`);
    try {
      closeSync(openSync(file, 'wx', 0o600));
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeJsonAtomic(file, { seq, kind: entry.kind, text: entry.text, createdAt: new Date().toISOString() });
    } catch (err) {
      try { unlinkSync(file); } catch { /* best effort */ }
      throw err;
    }
    return seq;
  }
}

// Entries with seq > afterSeq, ascending, as the contiguous prefix before the
// first reserved-but-unfilled entry (so a caller advancing its high-water mark
// never skips a message that is still being written). An unfilled entry older
// than staleMs is abandoned and skipped. Ack and *.tmp files are never listed.
export function readPending(dir, afterSeq, { staleMs = INBOX_STALE_RESERVATION_MS } = {}) {
  const inbox = inboxDir(dir);
  const out = [];
  for (const seq of listEntrySeqs(inbox)) {
    if (seq <= afterSeq) continue;
    const file = join(inbox, `${name(seq)}.json`);
    const e = readJson(file);
    if (!e || typeof e !== 'object' || typeof e.text !== 'string') {
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
      if (age > staleMs) continue;
      break;
    }
    out.push({ seq, kind: e.kind, text: e.text, createdAt: e.createdAt });
  }
  return out;
}

export function writeAck(dir, seq, { status, reason } = {}) {
  const inbox = inboxDir(dir);
  ensurePrivateDir(inbox);
  const ack = { status };
  if (reason !== undefined) ack.reason = reason;
  ack.at = new Date().toISOString();
  writeJsonAtomic(join(inbox, `${name(seq)}.ack.json`), ack);
}

export function readAck(dir, seq) {
  const a = readJson(join(inboxDir(dir), `${name(seq)}.ack.json`));
  return a && typeof a === 'object' ? a : null;
}

// Resolves the ack, or null on timeout/abort.
export function waitAck(dir, seq, ms, { signal } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    let timer = null;
    const done = (v) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => done(null);
    const tick = () => {
      const a = readAck(dir, seq);
      if (a) return done(a);
      const left = deadline - Date.now();
      if (left <= 0) return done(null);
      timer = setTimeout(tick, Math.min(POLL_MS, left));
    };
    if (signal) {
      if (signal.aborted) return done(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    tick();
  });
}

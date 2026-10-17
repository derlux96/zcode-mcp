import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateHome, writeJsonAtomic } from './jobstore.mjs';

const MAX_ENTRIES = 200;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

export function defaultStatePath() {
  return join(stateHome(), 'sessions.json');
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Directory lock (mkdir is atomic). A lock older than LOCK_STALE_MS belongs to
// a dead holder and is removed. Always pair with releaseLock in a finally.
function acquireLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
    } catch { /* vanished meanwhile: retry */ }
    if (Date.now() > deadline) throw new Error(`Could not lock session store: ${lock}`);
    sleepMs(10 + Math.random() * 15);
  }
}

export class SessionStore {
  constructor(filePath = defaultStatePath()) {
    this.filePath = filePath;
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  append(entry) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lock = `${this.filePath}.lock`;
    acquireLock(lock);
    try {
      const entries = [...this.load().filter((e) => entry.id === undefined || e?.id !== entry.id), entry].slice(-MAX_ENTRIES);
      writeJsonAtomic(this.filePath, entries);
      chmodSync(this.filePath, 0o600);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    return entry;
  }

  list({ cwd } = {}) {
    const entries = this.load();
    return cwd ? entries.filter((e) => e.cwd === cwd) : entries;
  }
}

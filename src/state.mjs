import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_ENTRIES = 200;

export function defaultStatePath() {
  return join(homedir(), '.zcode-mcp', 'sessions.json');
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
    const entries = [...this.load(), entry].slice(-MAX_ENTRIES);
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    chmodSync(this.filePath, 0o600); // also fixes pre-existing files
    return entry;
  }

  list({ cwd } = {}) {
    const entries = this.load();
    return cwd ? entries.filter((e) => e.cwd === cwd) : entries;
  }
}

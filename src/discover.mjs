import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const MACOS_PATH = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

export class ZCodeNotFoundError extends Error {
  constructor(checked) {
    super('ZCode binary not found. Checked:\n' + checked.map((c) => `  - ${c}`).join('\n'));
    this.name = 'ZCodeNotFoundError';
    this.checked = checked;
  }
}

function whichZcode() {
  try {
    const p = execFileSync('which', ['zcode'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p || null;
  } catch {
    return null;
  }
}

export function discoverZCode({ env = process.env, macosPath = MACOS_PATH } = {}) {
  const checked = [];
  if (env.ZCODE_BIN) {
    checked.push(`ZCODE_BIN=${env.ZCODE_BIN}`);
    if (existsSync(env.ZCODE_BIN)) return env.ZCODE_BIN;
    throw new ZCodeNotFoundError([
      ...checked,
      'ZCODE_BIN is set but the file does not exist. Fix the path or unset it.',
    ]);
  }
  checked.push(macosPath);
  if (existsSync(macosPath)) return macosPath;
  const fromPath = whichZcode();
  if (fromPath && existsSync(fromPath)) return fromPath;
  checked.push('which zcode → not found');
  throw new ZCodeNotFoundError([
    ...checked,
    'Set ZCODE_BIN to your zcode.cjs path (e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs on macOS).',
  ]);
}

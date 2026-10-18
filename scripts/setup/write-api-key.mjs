#!/usr/bin/env node
// Helper: writes the three credential entries for the "manual" auth path
// (Z.ai Coding Plan API key, no OAuth exchange). Reads the key from stdin.
// Usage:  print -r -- "$KEY" | node write-api-key.mjs [credentials.json]
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';

const file = process.argv[2] || homedir() + '/.zcode/v2/credentials.json';
const key = readFileSync(0, 'utf8').trim();
if (key.length < 8) { console.error('Key too short.'); process.exit(1); }

// Same encryption as the ZCode CLI: AES-256-GCM, key derived from the
// fallback secret (or ZCODE_CREDENTIAL_SECRET when set).
const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
const cipherKey = createHash('sha256').update(secret).digest();
const enc = (v) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey, iv);
  const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
  return 'enc:v1:' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + ct.toString('base64url');
};

const identity = 'key-' + createHash('sha256').update(key).digest('hex').slice(0, 24);
const P = 'account:zai-individual-coding-plan';
const creds = JSON.parse(readFileSync(file, 'utf8'));
creds[`account-provider:${P}:identity`] = enc(identity);
creds[`account-provider:${P}:auth-source`] = enc('manual');
creds[`account-provider:coding-plan:${P}:account:${encodeURIComponent(identity)}:api-key`] = enc(key);
writeFileSync(file, JSON.stringify(creds, null, 2) + ' ');
console.log('API key stored in credentials.json (identity ' + identity.slice(0, 10) + '…, auth-source manual).');

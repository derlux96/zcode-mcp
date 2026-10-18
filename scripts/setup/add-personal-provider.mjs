#!/usr/bin/env node
// Helper: adds the personal provider rule "zai-coding-plan" (template zai-api,
// API key stored in the file itself) to the personal provider config. The key
// is read from credentials.json (run write-api-key.mjs first).
// Usage: node add-personal-provider.mjs [provider_config.json]
import { createHash, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';

const credsFile = homedir() + '/.zcode/v2/credentials.json';
const personalFile = process.argv[2] || process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  || homedir() + '/.zcode/v2/provider_config.json';
const P = 'account:zai-individual-coding-plan';
const PROVIDER_ID = 'zai-coding-plan';

const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
const secret = process.env.ZCODE_CREDENTIAL_SECRET?.trim()
  || `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
const key = createHash('sha256').update(secret).digest();
const dec = (v) => {
  const p = v.slice('enc:v1:'.length).split('.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(p[0], 'base64url'));
  d.setAuthTag(Buffer.from(p[1], 'base64url'));
  return Buffer.concat([d.update(Buffer.from(p[2], 'base64url')), d.final()]).toString('utf8');
};

const identity = dec(creds[`account-provider:${P}:identity`]);
const apiKey = dec(creds[`account-provider:coding-plan:${P}:account:${encodeURIComponent(identity)}:api-key`]);
if (!apiKey) { console.error('No API key found in credentials.json; run write-api-key.mjs first.'); process.exit(1); }

const cfg = JSON.parse(readFileSync(personalFile, 'utf8'));
if (!(cfg.config?.providerConfigRules?.providerRules instanceof Array)) {
  console.error('Unexpected format in ' + personalFile + '; aborted, nothing changed.');
  process.exit(1);
}
copyFileSync(personalFile, personalFile + '.bak');
// group is required: the registry only iterates zai-family/bigmodel-family/standard-personal.
const rules = cfg.config.providerConfigRules.providerRules.filter((r) => r.providerId !== PROVIDER_ID);
rules.push({
  providerId: PROVIDER_ID,
  templateId: 'zai-api',
  providerName: 'Z.ai Coding Plan (API Key)',
  enabled: true,
  config: { group: 'standard-personal', access: { type: 'zhipu-coding-plan-api-key', apiKey } },
});
cfg.config.providerConfigRules.providerRules = rules;
writeFileSync(personalFile, JSON.stringify(cfg, null, 2) + ' ');
// The file holds the API key in cleartext, so keep it at 0600.
chmodSync(personalFile, 0o600);
console.log('Provider rule set: ' + PROVIDER_ID + ' (template zai-api, backup: ' + personalFile + '.bak)');

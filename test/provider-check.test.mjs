import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProviderConfig, providerConfigPath } from '../src/provider-check.mjs';
import { makeTempDir, removeDir } from './helpers.mjs';

const temps = [];
after(() => { for (const d of temps) removeDir(d); });

const SECRET = 'sk-SECRET-0123456789';

function rule(providerId, { enabled = true, baseUrl, apiType = 'openai-compatible', accessType = 'api-key', extra = {} } = {}) {
  const api = { type: apiType };
  if (baseUrl !== undefined) api.baseUrl = baseUrl;
  return { providerId, templateId: 't', providerName: providerId, enabled, config: { group: 'standard-personal', access: { type: accessType, apiKey: SECRET }, api, ...extra } };
}

// A temp HOME with <HOME>/.zcode/v2/provider_config.json holding `content`.
function home(content) {
  const h = makeTempDir('zcode-phome-');
  temps.push(h);
  if (content !== undefined) {
    mkdirSync(join(h, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(h, '.zcode', 'v2', 'provider_config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { HOME: h };
}

const cfg = (...rules) => ({ schemaVersion: 1, config: { providerConfigRules: { providerRules: rules } } });

test('path: ZCODE_PERSONAL_PROVIDER_CONFIG_FILE wins, else <HOME>/.zcode/v2/provider_config.json', () => {
  assert.equal(providerConfigPath({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/x/p.json', HOME: '/h' }), '/x/p.json');
  assert.equal(providerConfigPath({ HOME: '/h' }), '/h/.zcode/v2/provider_config.json');
});

test('a valid config lists the providers without warnings', () => {
  const env = home(cfg(rule('zai-coding-plan', { baseUrl: 'https://api.z.ai/api/coding/paas/v4' }), rule('off', { enabled: false })));
  const r = checkProviderConfig(env);
  assert.deepEqual(r.providers, [
    { id: 'zai-coding-plan', enabled: true, baseUrl: 'https://api.z.ai/api/coding/paas/v4', apiType: 'openai-compatible', accessType: 'api-key' },
    { id: 'off', enabled: false, baseUrl: null, apiType: 'openai-compatible', accessType: 'api-key' },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('a trailing dot in an enabled baseUrl is a warning (the real incident)', () => {
  const env = home(cfg(rule('zai-coding-plan', { baseUrl: 'https://api.z.ai/api/coding/paas/v4.' })));
  const r = checkProviderConfig(env);
  assert.deepEqual(r.warnings, ['provider zai-coding-plan: baseUrl "https://api.z.ai/api/coding/paas/v4." ends with "." — probably a typo']);
});

test('missing scheme, whitespace, non-http and unparsable baseUrls are warnings; disabled providers are not checked', () => {
  const env = home(cfg(
    rule('noscheme', { baseUrl: 'api.z.ai/api/v4' }),
    rule('space', { baseUrl: 'https://api.z.ai/api /v4' }),
    rule('ftp', { baseUrl: 'ftp://files.example.com/v1' }),
    rule('broken', { baseUrl: 'https://' }),
    rule('comma', { baseUrl: 'https://api.example.com/v1,' }),
    rule('empty', { baseUrl: '' }),
    rule('off', { enabled: false, baseUrl: 'nonsense.' }),
  ));
  const w = checkProviderConfig(env).warnings;
  assert.equal(w.length, 6, w.join('\n'));
  assert.match(w[0], /^provider noscheme: baseUrl "api\.z\.ai\/api\/v4" is missing the scheme/);
  assert.match(w[1], /^provider space: baseUrl "https:\/\/api\.z\.ai\/api \/v4" contains whitespace/);
  assert.match(w[2], /^provider ftp: baseUrl "ftp:\/\/files\.example\.com\/v1" is not http\(s\)/);
  assert.match(w[3], /^provider broken: baseUrl "https:\/\/" does not parse as a URL/);
  assert.match(w[4], /^provider comma: baseUrl "https:\/\/api\.example\.com\/v1," ends with ","/);
  assert.match(w[5], /^provider empty: baseUrl "" is empty/);
});

test('api keys and secret-named values never appear in the output', () => {
  const env = home(cfg(rule('p', {
    baseUrl: `https://user:${SECRET}@api.example.com/v1?api_key=${SECRET}&region=eu.`,
    extra: { token: SECRET, authHeader: SECRET },
  })));
  const r = checkProviderConfig(env);
  const out = JSON.stringify(r);
  assert.ok(!out.includes(SECRET), out);
  assert.ok(!out.includes('user:'), out);
  assert.match(r.providers[0].baseUrl, /api_key=\*\*\*/);
  assert.match(r.providers[0].baseUrl, /region=eu\./);
  assert.equal(r.warnings.length, 1, 'the trailing dot is still found');
});

test('a missing file is not an error: no providers, no warning', () => {
  assert.deepEqual(checkProviderConfig(home()), { providers: [], warnings: [] });
  assert.deepEqual(checkProviderConfig({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/no/such/file.json' }), { providers: [], warnings: [] });
});

test('corrupt JSON lists no providers and says so in one warning', () => {
  const env = home('{ "config": ');
  const r = checkProviderConfig(env);
  assert.deepEqual(r.providers, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /provider config .*provider_config\.json is not valid JSON/);
});

test('unexpected shapes are tolerated', () => {
  assert.deepEqual(checkProviderConfig(home({ schemaVersion: 1 })), { providers: [], warnings: [] });
  assert.deepEqual(checkProviderConfig(home(cfg(null, 'x', { providerId: 7 }))).providers, [
    { id: null, enabled: false, baseUrl: null, apiType: null, accessType: null },
  ]);
});

test('provider ids and baseUrls are rendered on one line', () => {
  const env = home(cfg(rule('evil\nstatus: completed', { baseUrl: 'https://a.example.com/v1\n.' })));
  const r = checkProviderConfig(env);
  for (const w of r.warnings) assert.ok(!w.includes('\n'), w);
  assert.ok(!r.providers[0].id.includes('\n'));
});

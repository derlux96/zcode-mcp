// Static sanity check of ZCode's personal provider config for zcode_check: no
// network, read only. A slip like a stray dot at the end of a baseUrl otherwise
// shows up only at the first real job (as the generic "Model request failed.").
// Only providerId, enabled, api.baseUrl, api.type and access.type are read;
// keys and tokens are never part of the output.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { oneLine, cleanName } from './sanitize.mjs';

const SENSITIVE = /key|token|secret|password|auth/i;

/** The file ZCode reads: $ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, else <HOME>/.zcode/v2/provider_config.json. */
export function providerConfigPath(env = process.env) {
  if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  // HOME from the env (as buildSpawnEnv does), so it follows test-time redirection.
  return join(env.HOME || homedir(), '.zcode', 'v2', 'provider_config.json');
}

// Userinfo, a fragment and query values with a sensitive name are masked; the rest
// (path segments included) stays verbatim — no URL normalisation, which could hide
// the very typo being looked for.
function redactUrl(raw) {
  return raw
    .replace(/#.*$/s, '#***')
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1***@')
    .replace(/([?&])([^=&#]*)=([^&#]*)/g, (m, sep, name) => (SENSITIVE.test(name) ? `${sep}${name}=***` : m));
}

// The first problem of a baseUrl, or null.
function baseUrlProblem(raw) {
  if (raw === '') return 'is empty';
  if (/\s/.test(raw)) return 'contains whitespace';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return 'is missing the scheme (http:// or https://)';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'does not parse as a URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'is not http(s)';
  const trailing = /([.,;:!?])\/?$/.exec(raw);
  if (trailing) return `ends with "${trailing[1]}" — probably a typo`;
  return null;
}

const str = (v) => (typeof v === 'string' ? v : null);

/**
 * -> { providers: [{ id, enabled, baseUrl, apiType, accessType }], warnings: [] }.
 * A missing or unreadable file yields no providers and no warning; invalid JSON
 * yields one warning.
 */
export function checkProviderConfig(env = process.env) {
  const path = providerConfigPath(env);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { providers: [], warnings: [] };
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { providers: [], warnings: [oneLine(`provider config ${path} is not valid JSON; ZCode may not load its providers`)] };
  }
  const rules = cfg && cfg.config && cfg.config.providerConfigRules && cfg.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) return { providers: [], warnings: [] };
  const providers = [];
  const warnings = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const c = r.config && typeof r.config === 'object' ? r.config : {};
    const api = c.api && typeof c.api === 'object' ? c.api : {};
    const access = c.access && typeof c.access === 'object' ? c.access : {};
    const id = str(r.providerId);
    const raw = str(api.baseUrl);
    const shown = raw === null ? null : redactUrl(raw);
    const enabled = r.enabled === true;
    providers.push({
      id: id === null ? null : cleanName(id),
      enabled,
      baseUrl: shown === null ? null : cleanName(shown),
      apiType: str(api.type) === null ? null : cleanName(api.type),
      accessType: str(access.type) === null ? null : cleanName(access.type),
    });
    if (!enabled || raw === null) continue;
    const problem = baseUrlProblem(raw);
    if (problem) warnings.push(oneLine(`provider ${id ?? '?'}: baseUrl "${shown}" ${problem}`));
  }
  return { providers, warnings };
}

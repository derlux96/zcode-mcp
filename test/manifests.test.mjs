// Packaging: the four manifests agree on the version, the Claude Code plugin wires
// the MCP server from the plugin root, and the Claude agent has the real MCP tool
// names (plugin and user-level forms) and no file-editing tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = (rel) => JSON.parse(readFileSync(root + rel, 'utf8'));
const TOOLS = ['zcode_check', 'zcode_run', 'zcode_sessions', 'zcode_status', 'zcode_result', 'zcode_cancel'];

function frontmatter(rel) {
  const text = readFileSync(root + rel, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert(m, `${rel} has a frontmatter block`);
  const fields = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

test('package.json, plugin.json, .claude-plugin/plugin.json and the marketplace entry share one version', () => {
  const pkg = json('package.json');
  const grok = json('plugin.json');
  const claude = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  const entry = market.plugins.find((p) => p.name === claude.name);
  assert(entry, 'the marketplace lists the plugin');
  assert.equal(pkg.version, '1.2.0');
  assert.deepEqual([grok.version, claude.version, entry.version], [pkg.version, pkg.version, pkg.version]);
  assert.equal(claude.name, 'zcode-delegate');
  assert.equal(grok.name, 'zcode-delegate');
});

test('the marketplace is named zcode-mcp and its plugin source is the repo root', () => {
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'zcode-mcp');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].source, './');
});

test('the Claude plugin starts the server from ${CLAUDE_PLUGIN_ROOT}; the Grok/Cursor .mcp.json is unchanged', () => {
  const claude = json('.claude-plugin/plugin.json');
  assert.deepEqual(claude.mcpServers, { zcode: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/mcp-server.mjs'] } });
  assert.deepEqual(json('.mcp.json'), { mcpServers: { zcode: { command: 'node', args: ['./src/mcp-server.mjs'], env: {} } } });
  // The Claude agent lives outside agents/ so Claude never loads the Grok variant.
  assert.deepEqual(claude.agents, ['./claude/agents/zcode-worker.md']);
});

test('the Claude agent lists every tool in the plugin and the user-level form, and no editing tool', () => {
  const fm = frontmatter('claude/agents/zcode-worker.md');
  assert.equal(fm.name, 'zcode-worker');
  const tools = fm.tools.split(',').map((t) => t.trim());
  for (const t of TOOLS) {
    assert(tools.includes(`mcp__plugin_zcode-delegate_zcode__${t}`), `plugin form of ${t}`);
    assert(tools.includes(`mcp__zcode__${t}`), `user-level form of ${t}`);
  }
  // Bash can edit files too: the delegate gets read-only tools only.
  for (const banned of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) assert(!tools.includes(banned), `no ${banned}`);
  assert.deepEqual(tools.filter((t) => !t.startsWith('mcp__')), ['Read', 'Grep', 'Glob']);
});

test('the Grok/Cursor agent keeps its bare tool names', () => {
  const fm = frontmatter('agents/zcode-worker.md');
  assert.equal(fm.name, 'zcode-worker');
  assert.deepEqual(fm.tools.split(',').map((t) => t.trim()), TOOLS);
});

test('the skill names the Claude tool forms', () => {
  const text = readFileSync(root + 'skills/zcode-delegate/SKILL.md', 'utf8');
  assert.match(text, /mcp__zcode__zcode_run/);
  assert.match(text, /mcp__plugin_zcode-delegate_zcode__zcode_run/);
});

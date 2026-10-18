# Install zcode-mcp

Requirements: Node.js ≥ 18 and ZCode installed and logged in (`zcode login`, or an API key via
`zsh scripts/setup/setup-zcode-cli-auth.zsh`). Letting an AI model do the setup? Point it at
[`llms-install.md`](llms-install.md).

## Claude Code — plugin (recommended)

```bash
claude plugin marketplace add derlux96/zcode-mcp
claude plugin install zcode-delegate@zcode-mcp
claude mcp list        # plugin:zcode-delegate:zcode: … - ✔ Connected
```

Gives the MCP server (tools `mcp__plugin_zcode-delegate_zcode__zcode_*`), the skill
`zcode-delegate` and the agent `zcode-worker`. Remove with `claude plugin uninstall zcode-delegate@zcode-mcp`.

## Script — Claude Code and/or Claude Desktop

From a permanent clone (not `/tmp`; or add `--copy-to <dir>`):

```bash
node scripts/install.mjs --dry-run     # what would be done
node scripts/install.mjs --yes         # do it, then self-test (one tiny model request; --no-probe skips it)
```

`--target claude-code|claude-desktop|all` (default: what is installed), `--scope user|project`,
`--name`, `--no-skill`, `--no-agent`, `--json`, `--force`, `--uninstall`. Same as
`npm run install:claude -- …`. Claude Code gets `claude mcp add --scope user zcode -- <node> <server>`
plus the skill and agent in `~/.claude/`; Claude Desktop gets an `mcpServers.zcode` entry in
`~/Library/Application Support/Claude/claude_desktop_config.json` (backup first). Restart the client
afterwards.

Claude Desktop by hand (absolute paths):

```json
{ "mcpServers": { "zcode": { "command": "/usr/local/bin/node", "args": ["/path/to/zcode-mcp/src/mcp-server.mjs"] } } }
```

## Check

```bash
npm run doctor              # user/home, ZCode binary + version, providers (key presence only), model probe
npm run doctor -- --no-probe --json
```

Every FAIL line comes with the fix. Exit code 0 = everything works.

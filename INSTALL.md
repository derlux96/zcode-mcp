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

Scope: the plugin installs for your user by default (all projects). `--scope project` (shared via the
project's `.claude/settings.json`) or `--scope local` (this project, only you) limit it to one project:
`claude plugin install zcode-delegate@zcode-mcp --scope project`. Uninstall with the same `--scope`.

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

Claude Desktop: quit it completely (⌘Q) before the script or a hand edit touches the config. A
running Desktop writes its in-memory config back on exit and drops the new `zcode` entry.

Claude Desktop by hand (absolute paths):

```json
{ "mcpServers": { "zcode": { "command": "/usr/local/bin/node", "args": ["/path/to/zcode-mcp/src/mcp-server.mjs"] } } }
```

## Check

```bash
npm run doctor                          # user/home, ZCode binary + version, providers (key presence only), model probe
node scripts/doctor.mjs --no-probe --json   # machine-readable (npm run without -s prints a banner first)
```

Plugin users (no clone): ask Claude to call `zcode_check` with `probe_model: true`.

Every FAIL line comes with the fix. Exit code 0 = everything works.

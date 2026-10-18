# Installing zcode-mcp — instructions for an AI model

You are setting up **zcode-mcp** (MCP server `zcode`, skill `zcode-delegate`, agent `zcode-worker`)
so that Claude Code and/or Claude Desktop can delegate coding tasks to a locally installed ZCode.
Follow the steps in order. Run every command yourself unless the step says **user**. Report each
result honestly, including failures.

## Hard rules

1. Never print, request, read or store an API key or token — not in chat, files, commands or logs.
   Only the user enters a key, in their own terminal, through the guided helper (see the table).
2. Ask the user before writing outside the repo/clone, before editing an existing Claude or ZCode
   config, and before cloning to a new place. Always run `--dry-run` first and show its output.
3. Never use `sudo`. Never edit anything under `~/.zcode` yourself.
4. Stop and report when a state is not covered here (unknown output, unexpected error).
5. Always run the self-test (it is part of the installer; or `npm run doctor`) and report its JSON
   result as it is. Do not claim success when `ok` is `false`.
6. ZCode's login and provider config belong to the macOS user who runs Claude. Every report names
   the `user` and `home` it examined — if that is not the user who will use Claude, say so.

## 1. Preconditions

| Check | Command | Meaning |
|---|---|---|
| Node.js | `node --version` | `v18` or newer required; older or missing: the user installs Node.js (nodejs.org). |
| User/home | `whoami; echo $HOME` | The account whose `~/.zcode` login is used. |
| ZCode | `ls /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (or `echo $ZCODE_BIN`) | Missing: the user installs the ZCode desktop app and logs in, or sets `ZCODE_BIN` to their `zcode.cjs`. |
| ZCode version | `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs version` | Prints e.g. `zcode 0.16.9`. |
| Claude Code | `claude --version` | Prints e.g. `2.1.283 (Claude Code)`; "command not found": no Claude Code. |
| Claude Desktop | `ls ~/Library/Application\ Support/Claude/` | Exists: Claude Desktop is installed (macOS). |
| Plugin already there | `claude plugin list` | Lists `zcode-delegate@zcode-mcp`: the plugin route is installed — go to step 4. |

## 2. Choose the route

| Situation | Route |
|---|---|
| Claude Code is installed (default) | **A: plugin** — two commands, updates via `claude plugin update`. |
| Claude Desktop, or Claude Code without plugin support, or a fixed local checkout wanted | **B: script** (`scripts/install.mjs`). |
| Both Claude Code and Claude Desktop | A for Claude Code, plus B with `--target claude-desktop`. |

Do not install both A and B for Claude Code: that registers the tools twice (the installer skips
Claude Code when it finds the plugin, unless `--force`).

## 3A. Plugin route (Claude Code)

```bash
claude plugin marketplace add derlux96/zcode-mcp
claude plugin install zcode-delegate@zcode-mcp
```

Expected: `✔ Successfully added marketplace: zcode-mcp` and
`✔ Successfully installed plugin: zcode-delegate@zcode-mcp (scope: user)`.
Verify (no model request):

```bash
claude mcp list
```

Expected line: `plugin:zcode-delegate:zcode: node …/src/mcp-server.mjs - ✔ Connected`.
In Claude Code the tools are then named `mcp__plugin_zcode-delegate_zcode__zcode_run` etc., the
skill is `zcode-delegate:zcode-delegate`, the agent `zcode-delegate:zcode-worker`.
Then run the doctor from the plugin's install path (`installPath` in `claude plugin list --json`):

```bash
node "<installPath>/scripts/doctor.mjs" --json
```

## 3B. Script route (Claude Code and/or Claude Desktop)

Needs a permanent clone (ask the user where; not `/tmp` or a scratch/cache directory — the
installer warns about those, `--copy-to <dir>` copies the runtime to a stable place instead):

```bash
git clone https://github.com/derlux96/zcode-mcp ~/.local/share/zcode-mcp
cd ~/.local/share/zcode-mcp
node scripts/install.mjs --dry-run            # show this output to the user
node scripts/install.mjs --yes --json         # after the user agreed
```

Options: `--target claude-code|claude-desktop|all` (default: every client found), `--scope user|project`
(Claude Code; `project` = the current directory, run it from that project, not from the clone),
`--name zcode`, `--copy-to <dir>`, `--no-skill`, `--no-agent`, `--no-probe` (no model request),
`--force` (replace a different server/file of the same name; backup first), `--uninstall`.
Without a terminal it never prompts: it needs `--yes` (exit 2 otherwise).
What it does: Claude Code → `claude mcp add --scope user zcode -- <abs node> <abs server>` plus
`~/.claude/skills/zcode-delegate/SKILL.md` and `~/.claude/agents/zcode-worker.md` (tools
`mcp__zcode__*`); Claude Desktop → merges `mcpServers.zcode` into
`~/Library/Application Support/Claude/claude_desktop_config.json` (timestamped backup first; other
servers kept; invalid JSON is refused). `ZCODE_BIN`, `ZCODE_APPSERVER_BIN`, `ZCODE_MCP_HOME`,
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` and `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, when set during the
install, are written into the registration's env. Windows/Linux Desktop paths
(`%APPDATA%\Claude\…`, `~/.config/Claude/…`) are implemented but untested.

## 4. Verification

The installer ends with a self-test: it starts the registered command exactly like Claude
(absolute node + server path, clean env), runs MCP `initialize`, `tools/list` (six tools) and
`zcode_check` with `probe_model: true` (**one tiny real model request**, up to ~75 s; skip it with
`--no-probe`). The doctor runs the same checks any time:

```bash
npm run doctor -- --json        # or: node scripts/install.mjs --doctor --json
```

`--json` prints exactly one JSON document on stdout (human text goes to stderr):

```json
{
  "ok": true,
  "version": "1.2.0",
  "user": "alice",
  "home": "/Users/alice",
  "steps": [{ "name": "selftest:probe", "ok": true, "detail": "model glm-…/… answered in 2400 ms" }],
  "registered": [{ "target": "claude-code", "name": "zcode", "scope": "user", "command": "/usr/local/bin/node", "args": ["/…/src/mcp-server.mjs"], "env": {}, "status": "added" }],
  "files": [{ "path": "/Users/alice/.claude/agents/zcode-worker.md", "action": "written" }],
  "nextSteps": ["Start a new Claude Code session / quit and reopen Claude Desktop so the server is loaded."]
}
```

- `steps[]`: `{name, ok, detail, fix?}`; names `preflight:user|node|runtime|zcode`, `targets`,
  `copy-runtime`, `register:claude-code|claude-desktop`, `skill`, `agent`, `selftest:server|tools|zcode|jobs|providers|probe`.
  A failed step has a `fix`; a passing step may carry a `fix` as a note (e.g. temp-path warning).
- `registered[].status`: `added`, `unchanged`, `replaced`, `removed`, `absent`, `foreign` (a different
  server, left alone), `conflict`, or `would-add|would-replace|would-remove` (dry run).
- `files[].action`: `written`, `backup`, `removed`, `unchanged`, or `would-…` (dry run).
- The doctor adds `providers` (`{id, enabled, access: api-key|account-login, accessType, apiType,
  baseUrl, keyPresent}` — key presence only, never the key) and `providerFile`.
- Exit codes: `0` everything passed, `1` a step failed, `2` usage error / confirmation needed.

Claude Code check after a script install: `claude mcp get zcode` shows `Status: ✔ Connected`.
Restart Claude Code (new session) / quit and reopen Claude Desktop after installing.

## 5. Failures

| Symptom (step / text) | Cause | Fix | Who |
|---|---|---|---|
| `preflight:node` FAIL | Node < 18 | Install Node.js 18+, re-run | user |
| `selftest:zcode` "ZCode binary not found" | ZCode missing / `ZCODE_BIN` wrong | Install ZCode or set `ZCODE_BIN`, re-run the installer | user, then model |
| `selftest:providers` `baseUrl "…" ends with "."` | Typo in `~/.zcode/v2/provider_config.json` | The user edits the rule with that `providerId`, field `config.api.baseUrl` (file holds the key — never print it) | user |
| `selftest:providers` "key MISSING" / probe `auth` (401/403) | No or wrong API key / login | User runs `zsh scripts/setup/setup-zcode-cli-auth.zsh` in a terminal (hidden key input, backups, test turn) or `zcode login` | user |
| probe `model` "Model creation failed" | Missing/expired login or broken provider config | `zcode login` or the setup helper above; check `config.api.baseUrl` | user |
| probe `quota` with `1113` / Insufficient balance | Plan/balance, or Coding-Plan key on the general API URL | User checks the plan; baseUrl must be `…/api/coding/paas/v4` | user |
| probe `quota` 429 rate limit | Request window exhausted | Wait, then `npm run doctor` again | model (later) |
| probe `timeout` / `network` | Slow/unreachable provider, proxy | Retry; check network/proxy; `zcode doctor` | model, then user |
| `register:claude-code` "a different server is registered" | Name taken | Ask the user: other `--name`, or `--force` (replaces it) | user decides |
| `register:claude-code` "`claude` CLI is not on PATH" | No Claude Code | Install Claude Code, or `--target claude-desktop` | user |
| `register:claude-desktop` "not valid JSON" | Broken Desktop config | User repairs/moves the file; nothing was changed | user |
| `skill`/`agent` "exists with different content" | Edited or older copy | Ask the user; `--force` writes a backup and replaces it | user decides |
| `preflight:runtime` WARNING temporary | Clone in /tmp, scratch or cache dir | Re-run with `--copy-to ~/.local/share/zcode-mcp` | model (ask first) |
| `selftest:jobs` not writable | `~/.zcode-mcp` permissions | User fixes ownership of the shown dir | user |
| Exit 2 "Not running in a terminal" | No `--yes` | Show `--dry-run`, get consent, re-run with `--yes` | model |
| `claude mcp list` shows `✘ Failed to connect` | Path moved/deleted, Node missing | Re-run the installer from the permanent clone; `npm run doctor` | model |

## 6. First use

In a new Claude Code session, in a small git repository, ask:

> Check the ZCode installation with zcode_check, then delegate to ZCode: create hello.txt containing "zcode works".

Good result: `zcode_check` answers `"ok": true` (no `warnings`, or only a version note), then
`zcode_run` answers `status: completed` with a `job_id: job_…`, a `session_id: sess_…` and
`changed_files` containing `hello.txt` (a longer task answers `status: running`; follow it with
`zcode_status` and `zcode_result`). Check the file exists. The agent `zcode-worker` can be asked
to run such tasks too.

## 7. Uninstall

- Plugin: `claude plugin uninstall zcode-delegate@zcode-mcp` (optionally
  `claude plugin marketplace remove zcode-mcp`).
- Script route: `node scripts/install.mjs --uninstall --dry-run`, show it, then
  `node scripts/install.mjs --uninstall --yes --json` (add the same `--target/--scope/--name/--copy-to`
  as for the install). It removes only what it added (registration, skill, agent, Desktop entry);
  a different server or an edited file is left alone; backups are kept. A `--copy-to` runtime and
  the clone stay — delete them only if the user asks.

#!/bin/zsh
# Sets up ZCode CLI auth with a Z.ai Coding Plan API key (macOS).
# Fixes both headless CLI turns (mode A) AND the app-server model catalog
# (mode B). See "Troubleshooting: CLI login broken" in the README.
#
# Before you start: create an API key at https://z.ai/manage-apikey/apikey-list.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
CREDS="$HOME/.zcode/v2/credentials.json"
BIN="${ZCODE_BIN:-/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs}"

# Find the builtin provider config: the runtime copy (version-specific) or the
# app bundle. Fresh shells lack the variable (only Desktop child processes have it).
CFG="${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:-$(print -r -- $HOME/.zcode/v2/runtime/provider/*/*/*/zcode-builtin.json(N) | head -1)}"
[[ -n "${CFG:-}" && -f "$CFG" ]] || CFG=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
[[ -f "$CFG" ]] || { echo "zcode-builtin.json not found; set ZCODE_BUILTIN_PROVIDER_CONFIG_FILE by hand."; exit 1; }

echo "== Set up the Z.ai Coding Plan API key =="
echo "Paste the API key and press Enter (input is hidden):"
read -s KEY
[[ ${#KEY} -ge 8 ]] || { echo "Key too short; aborted."; exit 1; }

cp "$CREDS" "$CREDS.bak-apikey"
print -r -- "$KEY" | node "$SCRIPT_DIR/write-api-key.mjs" "$CREDS"
node "$SCRIPT_DIR/add-personal-provider.mjs"
unset KEY

echo
echo "== Test 1: headless CLI turn (mode A) =="
mkdir -p /tmp/zcode-apikey-test && cd /tmp/zcode-apikey-test
[[ -d .git ]] || { git init -q; git config user.email t@e.de; git config user.name T; echo x > x.txt; git add .; git commit -qm i; }
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$CFG" node "$BIN" -p "Create ok.txt containing exactly: manual-auth-works" --mode edit --json
echo "ok.txt contains: $(cat ok.txt 2>/dev/null || echo '(MISSING: test failed)')"

echo
echo "== Test 2: app-server model catalog (mode B) =="
CATALOG=$(ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$CFG" ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json" \
  node -e '
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[1], "app-server", "--stdio"], { env: process.env });
let buf = "";
const done = (code, msg) => { console.error(msg || ""); child.kill(); process.exit(code); };
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method && m.id !== undefined) {
      const r = m.method === "session/requestRuntimePreferences" ? { nativeSearchEnhancementsEnabled: false } : {};
      child.stdin.write(JSON.stringify({ id: m.id, result: r }) + "\n");
    } else if (m.id === 1 && m.result) {
      const avail = m.result.settings?.model?.available ?? [];
      if (avail.length === 0) done(1, "Catalog EMPTY: the provider rule is not in effect.");
      for (const a of avail) console.log("  Model:", a.ref.providerId + "/" + a.ref.modelId);
      done(0);
    }
  }
});
setTimeout(() => child.stdin.write(JSON.stringify({ id: 1, method: "session/create", params: { workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" } } }) + "\n"), 1500);
setTimeout(() => done(1, "Timed out waiting for the catalog."), 30000);
' "$BIN")
echo "$CATALOG"

echo
echo "== Done. Backups: $CREDS.bak-apikey and provider_config.json.bak =="
echo "Optional: zcode-mcp end-to-end test: run 'node scripts/test-client.mjs --e2e' in your clone."

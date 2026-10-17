#!/bin/zsh
# Einrichtung der ZCode-CLI-Auth per Z.ai Coding-Plan API-Key (macOS).
# Behebt beides: headless CLI-Turns (Modus A) UND den Modell-Katalog des
# App-Servers (Modus B). Siehe BERICHT.md im übergeordneten Ordner.
#
# Vorbereitung: API-Key unter https://z.ai/manage-apikey/apikey-list erstellen.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
CREDS="$HOME/.zcode/v2/credentials.json"
BIN="${ZCODE_BIN:-/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs}"

# Built-in-Provider-Konfiguration finden: Runtime-Endpunkt (versionsspezifisch)
# oder App-Bundle. Frische Shells haben die Variable nicht (nur Desktop-Kinder).
CFG="${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:-$(print -r -- $HOME/.zcode/v2/runtime/provider/*/*/*/zcode-builtin.json(N) | head -1)}"
[[ -n "${CFG:-}" && -f "$CFG" ]] || CFG=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
[[ -f "$CFG" ]] || { echo "zcode-builtin.json nicht gefunden — ZCODE_BUILTIN_PROVIDER_CONFIG_FILE manuell setzen."; exit 1; }

echo "== Z.ai Coding-Plan API-Key einrichten =="
echo "API-Key jetzt einfügen und Enter drücken (Eingabe ist versteckt):"
read -s KEY
[[ ${#KEY} -ge 8 ]] || { echo "Key zu kurz — abgebrochen."; exit 1; }

cp "$CREDS" "$CREDS.bak-apikey"
print -r -- "$KEY" | node "$SCRIPT_DIR/write-api-key.mjs" "$CREDS"
node "$SCRIPT_DIR/add-personal-provider.mjs"
unset KEY

echo
echo "== Test 1: headless CLI-Turn (Modus A) =="
mkdir -p /tmp/zcode-apikey-test && cd /tmp/zcode-apikey-test
[[ -d .git ]] || { git init -q; git config user.email t@e.de; git config user.name T; echo x > x.txt; git add .; git commit -qm i; }
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="$CFG" node "$BIN" -p "Create ok.txt containing exactly: manual-auth-works" --mode edit --json
echo "Inhalt ok.txt: $(cat ok.txt 2>/dev/null || echo '(FEHLT — Test fehlgeschlagen)')"

echo
echo "== Test 2: Modell-Katalog des App-Servers (Modus B) =="
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
      if (avail.length === 0) done(1, "Katalog LEER — Provider-Regel nicht wirksam (siehe BERICHT.md).");
      for (const a of avail) console.log("  Modell:", a.ref.providerId + "/" + a.ref.modelId);
      done(0);
    }
  }
});
setTimeout(() => child.stdin.write(JSON.stringify({ id: 1, method: "session/create", params: { workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" } } }) + "\n"), 1500);
setTimeout(() => done(1, "Timeout beim Warten auf den Katalog."), 30000);
' "$BIN")
echo "$CATALOG"

echo
echo "== Fertig. Backups: $CREDS.bak-apikey und provider_config.json.bak =="
echo "Optional: zcode-mcp E2E — im Repo-Kopie-Ordner 'node scripts/test-client.mjs --e2e' ausführen."

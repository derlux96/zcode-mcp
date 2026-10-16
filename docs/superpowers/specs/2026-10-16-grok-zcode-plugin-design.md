# Design-Spec: grok-zcode-plugin v1

**Datum:** 2026-10-16
**Status:** Zur Freigabe durch den Nutzer
**Ziel:** Marketplace-Plugin (xAI), mit dem Grok und Cursor Coding-Aufgaben an ein lokal installiertes ZCode delegieren können.

## 1. Ziel & Nicht-Ziele

### Ziel
Ein Plugin im [xAI-Plugin-Format](https://github.com/xai-org/plugin-marketplace), das über einen lokalen stdio-MCP-Server das offizielle ZCode-Headless-CLI (`zcode.cjs -p …`) ansteuert. Grok fungiert als Orchestrator (Spezifikation, Verifikation), ZCode als ausführender Agent (Implementierung, Tests). Die Delegations-Intelligenz liegt in der Skill-/Agent-Schicht.

### Nicht-Ziele (v1)
- **Kein `zcode_parallel`** (Multi-Task-Worktree-Orchestrierung) — v2, sobald Einzel-Delegation stabil läuft. Nutzer-Entscheidung vom 2026-10-16.
- **Kein per-Call-Model-/Reasoning-Routing** — das Headless-CLI bietet dafür keine Flags; käme erst mit einem optionalen `app-server`-Protokoll-Layer in v2.
- **Keine Remote-Bridge für den Cloud-Grok-Bot** — ZCode läuft auf dem Cloud-Rechner des Nutzers und wird dort lokal angesprochen; stdio genügt.
- **Kein Credential-Handling** — der Server liest niemals Credentials; Auth läuft nativ über das geteilte ZCode-Login (`zcode login`).
- **Keine Windows-Pfad-Discovery** — über `ZCODE_BIN`-Env überbrückbar.

### Verifizierte Grundlagen (2026-10-16)
- Lokale Runtime: `zcode.cjs` 0.16.9 (Desktop-App 3.15.3), Pffad `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`.
- Headless-Flags: `-p/--prompt`, `--cwd`, `--mode <build|edit|plan|yolo>` (Default `yolo` für `-p`), `--resume <sessionId>`, `--target <text>`, `--json`.
- Plugin-Format (xai-org): Verzeichnis aus `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json` + optionales `plugin.json`. Marketplace-Katalog nutzt `.grok-plugin/marketplace.json` mit SHA-gepinnten Quellen.
- Existierende Dritt-MCPs als Abgrenzung, nicht als Basis: TechYan/zcode_mcp und Mnehmos/mnehmos.zcode.mcp fahren beide das interne `app-server`-Protokoll; wir nutzen bewusst das stabilere offizielle CLI.

## 2. Plugin-Struktur

```
grok-zcode-plugin/
├── .mcp.json                  # stdio-MCP-Server-Registrierung
├── plugin.json                # Metadaten-Manifest
├── src/
│   ├── mcp-server.mjs         # Entry: JSON-RPC-Loop über stdio
│   ├── protocol.mjs           # MCP/JSON-RPC: Framing, Dispatch, Fehler
│   ├── runner.mjs             # ZCode-Spawning, Timeout, Output-Cap, Worktree
│   ├── state.mjs              # Session-State-File (~/.zcode-mcp/)
│   └── discover.mjs           # ZCode-Binary-Discovery
├── skills/
│   └── zcode-delegate/
│       └── SKILL.md           # Orchestrierungs-Regeln (Englisch)
├── agents/
│   └── zcode-worker.md        # Grok-Subagent "Delegation Engineer"
├── scripts/
│   └── test-client.mjs        # Test-Client (Handshake, tools/list, zcode_check)
├── fixtures/
│   └── demo-repo/             # Minimales Git-Repo für E2E-Tests
└── README.md                  # Setup + Testing Instructions fürs xAI-Review
```

**Modulgrenzen:** `protocol.mjs` kennt kein ZCode; `runner.mjs` kennt kein MCP; `state.mjs` nur Datei-I/O. Jedes Modul ist unabhängig testbar.

### `.mcp.json`

```json
{
  "mcpServers": {
    "zcode": {
      "command": "node",
      "args": ["./src/mcp-server.mjs"],
      "env": {}
    }
  }
}
```

Pfad relativ zum Plugin-Root. **Verifikationspunkt im Implementierungsplan:** gegen einen echten Grok-Build- und Cursor-Install testen, ob ein Root-Placeholder (à la `${CLAUDE_PLUGIN_ROOT}`) nötig ist; falls ja, nur diese eine Datei anpassen.

### `plugin.json`

```json
{
  "name": "zcode-delegate",
  "version": "1.0.0",
  "description": "Delegate coding tasks from Grok or Cursor to a locally installed ZCode agent via its official headless CLI.",
  "author": { "name": "derlux" },
  "homepage": "https://github.com/derlux/grok-zcode-plugin",
  "keywords": ["zcode", "delegation", "coding-agent", "orchestration"]
}
```

## 3. MCP-Server

### 3.1 Protokoll-Implementierung (null Dependencies)
- Reines Node ≥18 (ESM, `.mjs`), keine npm-Pakete, kein Build-Schritt.
- MCP über stdio: newline-delimited JSON-RPC 2.0.
- Methoden: `initialize` (protokollierte Version des Clients echoen), `notifications/initialized`, `tools/list`, `tools/call`, `ping`. Unbekannte Methode → `-32601`; Parse-Fehler → `-32700`.
- Tool-Antworten als `content: [{ type: "text", text }]`; Fehler als `isError: true` mit Klartext-Diagnose.

### 3.2 Tools (exakt 3)

**`zcode_check`** — keine Parameter. Prüft in dieser Reihenfolge und berichtet alles strukturiert:
1. Binary-Discovery erfolgreich (Pfad + Version via `<bin> version`)
2. Login-Zustand (best-effort über `<bin> doctor`)
3. Konfigurations-Hinweise bei Problemen (z. B. `ZCODE_BIN` setzen, `zcode login` ausführen)
Rückgabe: `ok: true/false` + Mensch-lesbare Zeilen. Grok soll dieses Tool vor der ersten Delegation aufrufen.

**`zcode_run`** — Kern-Delegation, ein Headless-Task.

| Parameter | Typ | Default | Regeln |
|---|---|---|---|
| `prompt` | string | — | required, nicht-leer |
| `cwd` | string | — | required, absolut, muss existieren und Verzeichnis sein |
| `mode` | enum | `yolo` | `plan` \| `build` \| `edit` \| `yolo` |
| `resume` | string | — | Session-ID (`sess_…`), überschreibt Session-Kontext |
| `target` | string | — | Session-Ziel via `--target` |
| `timeout_ms` | int | 600000 | 1.000–3.600.000 |
| `isolate_worktree` | bool | `false` | Einzel-Task-Isolation (siehe unten) |

Aufruf: `execFile("node", [<bin>, "-p", prompt, "--cwd", cwd, "--mode", mode, "--json", …])` — Argumente-Array, kein Shell-String. Bei Timeout: SIGTERM, nach 5 s Grace SIGKILL; Ergebnis als Fehler mit Partial-Output (gedeckelt).

Rückgabe: ZCode-Output (Text), plus wenn extrahierbar: `session_id` (für `resume`) und Exit-Status. Ausgabe-Cap: 100.000 Zeichen, darüber abgeschnitten mit Kennzeichnung.

**`isolate_worktree: true`:** Voraussetzung `cwd` ist Git-Repo (sonst klarer Fehler). Ablauf: `git worktree add <worktree-dir> -b zcode/<slug>` (Slug: Zeitstempel + 6-stelliger Random-Suffix), Task im Worktree ausführen, danach `git diff --stat` + geänderte Dateien einsammeln. Rückgabe: Branch-Name, Worktree-Pfad, Diff-Stat. **Worktree bleibt bestehen** (Nutzer/Grok soll prüfen und mergen können); `git worktree remove` passiert nicht automatisch.

**`zcode_sessions`** — optionaler Parameter `cwd` (Filter). Listet die Sessions, die über diesen Server liefen, aus dem eigenen State-File (siehe 3.3): Session-ID, cwd, mode, Prompt-Kurzfassung (erste ~80 Zeichen), Zeitstempel, letzter bekannter Status. Kein Lesen interner ZCode-Speicher.

### 3.3 Session-State
- Datei `~/.zcode-mcp/sessions.json`, Array von Session-Einträgen, Dateirechte `0600`.
- `zcode_run` extrahiert die Session-ID best-effort aus dem `--json`-Output; falls das CLI sie (noch) nicht liefert, generiert der Server eine eigene Run-ID und kennzeichnet das im Eintrag. Das ist die einzige State-Quelle für `zcode_sessions`.
- State wächst unbegrenzt? Nein — Cap: die letzten 200 Einträge.

### 3.4 Binary-Discovery (`discover.mjs`)
1. Env `ZCODE_BIN` (wenn gesetzt: muss existieren)
2. `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (macOS)
3. `which zcode` via PATH
4. Alles fehlschlagen → Fehlermeldung mit allen geprüften Pfaden + Doku-Hinweis auf `ZCODE_BIN`.

## 4. Skill- & Agent-Schicht

### 4.1 `skills/zcode-delegate/SKILL.md` (Englisch)
Frontmatter (`name: zcode-delegate`, `description:` …) plus Abschnitte:
1. **When to delegate** — Multi-File-Änderungen, Refactorings, Test-Suiten, alles was einen echten Agent-Runtime braucht. Kleine Fragen beantwortet Grok selbst; nicht für jede Kleinigkeit ein Task.
2. **Mode matrix** — `plan` für riskante/neue Änderungen (erst Plan prüfen!), `build` für Implementierung nach freigegebenem Plan, `edit` für kleine gezielte Fixe, `yolo` für klar abgegrenzte, autonom abschließbare Tasks (Default des CLI).
3. **Writing delegation prompts** — Template: Ziel, betroffene Dateien, Edge-Cases, Test-Anforderung, Definition-of-Done. Grok schreibt die Spezifikation, ZCode führt aus.
4. **Verification loop** — Nach jedem `zcode_run`: Ergebnis lesen, Diff-Stat prüfen (bei `isolate_worktree`), Test-Ausgaben kontrollieren. Bei Fehlern: `resume` mit Korrektur-Hinweis statt neuem Task.
5. **Resume pattern** — Mehr-Iterationen-Arbeit über `zcode_sessions` → `resume` auf derselben Session halten (Kontext bleibt erhalten).
6. **Pre-flight** — Erster Kontakt in einer Maschine: `zcode_check` aufrufen.

### 4.2 `agents/zcode-worker.md` (Englisch)
Grok-Subagent im üblichen Frontmatter-Format (`name`, `description`, `tools`): **Delegation Engineer**. Rolle: erhält eine Task-Spec, führt `zcode_check` (einmalig) + `zcode_run` aus, verifiziert Diff und Test-Output, iteriert bei Fehlern maximal zweimal via `resume`, berichtet strukturiert zurück (Ergebnis, geänderte Dateien, Tests, offene Punkte). Bricht bei wiederholtem Scheitern ab, statt Endlos-Loops zu feuern.

## 5. Fehlerbehandlung & Sicherheit
- **Keine Shell-Injection:** ausschließlich `execFile` mit Argument-Arrays.
- **`cwd`-Validierung:** absolut, existiert, Verzeichnis. Relative Pfade → Fehler mit Hinweis.
- **Timeouts:** pro Task, mit zweistufiger Terminierung.
- **Output-Cap:** 100.000 Zeichen pro Tool-Result.
- **Keine Netzwerk-Calls** im Server; keine Credential-Lektüre; State-File `0600`.
- **Worktree-Slugs** kollisionsfrei (Zeitstempel + Random); Branches im Namensraum `zcode/`.
- Git-Operationen nur: `worktree add`, `diff --stat`, `status --porcelain`. Kein `push`, kein `commit` durch den Server — Commits macht ZCode selbst im Task, wenn der Prompt es verlangt.

## 6. Testing
- **`scripts/test-client.mjs`** (ohne echte ZCode-Calls, default): startet den Server, macht Initialize-Handshake, `tools/list` (erwartet exakt 3 Tools mit korrekten Schemas), ruft `zcode_check`, testet Fehlerfälle (`cwd` relativ → Fehler; unbekannte Methode → `-32601`). Exit-Code 0 nur bei Bestehen.
- **E2E-Modus** `node scripts/test-client.mjs --e2e`: zusätzlich ein echter `zcode_run` (mode `edit`, kleiner Task) gegen `fixtures/demo-repo` (Mini-Git-Repo mit einer trivialen Datei). Erwartung: Session-ID in State-File, sinnvoller Output.
- **MCP Inspector** (`npx @modelcontextprotocol/inspector`) für manuelle Checks — Doku im README.
- **Plugin-Install-Verifikation:** einmal gegen Grok Build und Cursor installieren; dabei `.mcp.json`-Pfadauflösung prüfen (Verifikationspunkt aus §2).

## 7. Marketplace-Einreichung
1. Repo öffentlich auf GitHub pushen.
2. Formular [x.ai/bot/marketplace/submit-a-plugin](https://x.ai/bot/marketplace/submit-a-plugin): Listing für Grok Bot + Cursor; GitHub-Repo-URL; 1:1-Logo (SVG/PNG, ohne Transparenz); Testing Instructions aus der README (Voraussetzungen Node ≥18 + installiertes/eingeloggtes ZCode, 3 Beispiel-Prompts mit erwarteten Tool-Calls).
3. Optional später: PR in den offiziellen Katalog (`.grok-plugin/marketplace.json`, SHA-gepinnt).

## 8. v2-Backlog (explizit verschoben)
- `zcode_parallel` — Multi-Task-Worktree-Orchestrierung mit Concurrency-Cap.
- Per-Call-Model-/Reasoning-Routing über optionalen `app-server`-Protokoll-Layer.
- Remote-Bridge (HTTP/SSE) für cloud-hostete Grok-Bot-Nutzer ohne lokales ZCode.
- Windows-Pfad-Discovery.
- Aufnahme in den offiziellen xai-org-Katalog.

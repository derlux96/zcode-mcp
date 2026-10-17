# zcode-mcp als Coding-Worker: Job-API und Teststrategie

Stand: 2026-10-17. Basis: HEAD `dd0c6d9` plus die lokalen Änderungen aus
`/Users/Shared/zcode-mcp-update/` (Modus-Fix `yolo`, Leerlauf-Timeout im Protokoll-Pfad,
Zwischenstand bei Timeout, Pfadfix in Tests). Diese Spec baut darauf auf.

## 1. Ziel und Nicht-Ziele

**Ziel.** ZCode soll über diesen MCP-Server der Coding-Worker des Haupt-Agents werden.
Kleine Aufgaben antworten direkt und schnell. Große Aufgaben laufen beliebig lange weiter,
ohne dass der Worker sich selbst beendet, und die Rückmeldung ist jederzeit wahrheitsgemäß.

**Erfolg.**
- Kein Lauf wird allein wegen seiner Dauer abgebrochen, solange er Fortschritt zeigt.
- „completed“ bedeutet: ZCode ist fertig. Fehlende Wirkung (keine Dateiänderung, abgelehnte
  Tool-Aufrufe) wird als Warnung sichtbar, nicht verschwiegen.
- Nach Ende, Abbruch oder Absturz bleibt kein Prozess und keine Sperre zurück.
- Ein Job übersteht Schließen und Neustart des MCP-Servers.

**Nicht-Ziele.** Modellqualität von GLM prüfen. Ein dauerhafter Hintergrunddienst. Ein
Sandbox-Mechanismus für `yolo` (nur Dokumentation und Empfehlung `isolate_worktree`).

## 2. Entscheidungen (mit dem Nutzer abgestimmt)

| Thema | Entscheidung |
|---|---|
| Lebensdauer | Jobs überleben den MCP-Server: ein abgekoppelter Runner-Prozess pro Job |
| Einstieg | Ein Tool `zcode_run`; jede Aufgabe ist ein Job, `wait_ms` entscheidet über direktes Ergebnis oder `job_id` |
| Selber Ordner | Zweiter Job im selben `cwd` wird abgelehnt; parallel nur mit `isolate_worktree` |
| Obergrenze | 3 gleichzeitige Jobs (Annahme, ohne Gegenwort übernommen) |
| Pfadwahl | Ohne `mode`, `resume`, `target` läuft der Job über den Protokoll-Pfad (echte Leerlauf-Erkennung); sonst CLI mit Gesamtlimit |
| Ansatz | Dateibasierter Vertrag unter `~/.zcode-mcp/jobs/<id>/`, kein Daemon |
| Schwerpunkt | PID-Wiederverwendung und Aufräumen sauber lösen |

## 3. Belegte Ausgangsbefunde

- Modell-Modus lief ohne `mode` im Modus `build`; `Write` und `Bash` wurden abgelehnt, der Lauf
  meldete trotzdem Erfolg (im Update-Patch behoben).
- Die CLI (`--json`) schreibt bis zum Ende nichts (15 s Stille gemessen); der Protokoll-Pfad streamt.
- `notifications/cancelled` wird in `protocol.mjs` verworfen (Nachrichten ohne `id`).
- Bei geschlossenem `stdin` wartet der Server offene Aufrufe ab; ZCode-Kindprozesse laufen weiter.
- `sessions.json` wird ohne Sperre geschrieben (innerhalb eines Servers sicher, serverübergreifend nicht).
- `serverInfo.version` meldet `1.0.0`, `package.json` sagt `1.1.0`.

## 4. Architektur

```
MCP-Client ── stdio ──> mcp-server.mjs (zustandslos)
                          │ liest/schreibt Dateien
                          ▼
              ~/.zcode-mcp/ (oder $ZCODE_MCP_HOME)
                jobs/<id>/{job.json,status.json,result.json,output.log,events.log,cancel}
                locks/<sha1(realpath(cwd))>.lock
                sessions.json
                          ▲
                          │ schreibt
              job-runner.mjs (detached, eigene Prozessgruppe)
                          │ spawnt
                          ▼
                 zcode (CLI oder app-server)
```

Neue Module:
- `src/jobs.mjs`: Job-Ordner, Schemas, Identitätsprüfung, Sperren, Reaper, Abbruch. Keine MCP-Kenntnis.
- `src/job-runner.mjs`: Einstiegspunkt des abgekoppelten Prozesses. Nutzt `runZCodeTask` und
  `runTaskWithModel` unverändert weiter.
- `src/mcp-server.mjs`: Tools als dünne Schicht über `jobs.mjs`.

Der Runner wird mit `spawn(process.execPath, ['src/job-runner.mjs', jobDir, token], { detached: true, stdio: 'ignore' })`
gestartet und danach `unref()`t. Er ist damit Leiter einer eigenen Prozessgruppe; ZCode und dessen
Kinder hängen in dieser Gruppe.

## 5. Dateivertrag

`job.json` (unveränderlich nach Start): `jobId`, `token`, `params` (prompt, cwd als realpath, mode,
resume, target, model, reasoning_level, timeout_ms, idle_timeout_ms, isolate_worktree), `path`
(`protocol` | `cli`), `createdAt`, `baseline` (Git-Wurzel oder `null`; bei Git: Liste
`{path, hash}` der vor dem Start bereits geänderten Dateien).

`status.json` (vom Runner atomar überschrieben): `state`, `pid`, `pidStart`, `token`, `childPid`,
`childStart`, `startedAt`, `heartbeatAt`, `lastActivityAt`, `sessionId`, `warnings[]`, `errorKind`,
`progress[]` (letzte Fortschrittszeilen).

`result.json` (einmalig nach Ende): `state`, `sessionId`, `output` (gekürzt), `outputLogPath`,
`changedFiles`, `diffStat`, `worktree` (Branch, Ordner, Startcommit), `warnings`, `deniedTools`,
`errorKind`, `errorMessage`, `timeoutKind`, `durationMs`.

Rechte: Ordner `0700`, Dateien `0600`. Alle Schreibvorgänge sind atomar (temporäre Datei, dann Umbenennen).

## 6. Zustände und Identität

Zustände: `starting` → `running` → `completed` | `failed` | `timeout` | `cancelled`; zusätzlich
`lost` (Runner ohne Abschluss verschwunden). `stalled` ist eine Warnung, kein Zustand.

**Lebt ein Prozess?** Nur wenn alle drei Bedingungen gelten:
1. Der Prozess mit der PID existiert.
2. Seine Startzeit (`ps -o lstart= -p <pid>`) stimmt mit `pidStart` überein.
3. Seine Kommandozeile (`ps -o command= -p <pid>`) enthält das Job-Token.

Eine wiederverwendete PID besteht diese Prüfung nicht. Dieselbe Prüfung gilt für `childPid`.

**Herzschlag.** Der Runner schreibt `heartbeatAt` alle 5 s. Ist die Identität in Ordnung, der
Herzschlag aber älter als 30 s, erhält der Job die Warnung `stalled`; er wird weder abgebrochen
noch als `lost` geführt (schützt vor Zeitsprüngen und kurz blockierten Runnern). `lost` gilt nur
bei fehlgeschlagener Identitätsprüfung ohne Endzustand.

## 7. Abbruch

`zcode_cancel` prüft die Identität und sendet SIGTERM an die Prozessgruppe des Runners. Der Runner
stoppt ZCode (SIGTERM, nach 5 s SIGKILL), schreibt `result.json` mit Zwischenstand, setzt `cancelled`
und endet. Reagiert er nach 10 s nicht, sendet der Server SIGKILL an die Gruppe, erneut nur nach
bestandener Identitätsprüfung. Zusätzlich wird eine Datei `cancel` angelegt, die der Runner beim
Herzschlag prüft (Weg für Fälle, in denen Signale nicht ankommen).

## 8. Sperren, Obergrenze, Reaper

**Sperre pro Ordner.** `locks/<sha1(realpath(cwd))>.lock` wird mit `O_EXCL` angelegt und enthält die
`jobId`. Ist der zugehörige Job laut Identitätsprüfung nicht mehr lebendig, gilt die Sperre als
veraltet und wird atomar ersetzt. Mit `isolate_worktree` wird auf dem Worktree-Ordner gesperrt, nicht
auf dem Ursprungsordner.

**Obergrenze.** Gezählt werden Jobs in `starting`/`running`, die die Identitätsprüfung bestehen.

**Reaper.** Läuft beim Serverstart und lazy bei jedem Tool-Aufruf; idempotent.
- `lost` mit noch lebenden, verifizierten Resten: Gruppe beenden, Job als `lost` mit Zwischenstand
  festhalten.
- Beendete Jobs älter als 7 Tage oder jenseits der neuesten 50 werden gelöscht. Gelöscht wird nur
  unterhalb des Job-Wurzelordners; Symlinks werden nicht verfolgt (`lstat`, `realpath`-Präfixprüfung).
- Worktrees aus `isolate_worktree` löscht der Reaper nie; sie erscheinen in `zcode_status` (Liste).
- Hartes Laufzeitlimit im Runner: `timeout_ms`, Standard und Maximum 6 Stunden.

## 9. Tool-API

**`zcode_run`** (erweitert; bisherige Parameter bleiben).
- Neu: `wait_ms` (Standard 60000, Maximum 300000, 0 = sofort `job_id`), `idle_timeout_ms` (Standard
  600000; nur Protokoll-Pfad, sonst weiterhin Fehler).
- `timeout_ms`: Gesamtlimit, Standard und Maximum 6 Stunden. Das ersetzt die 60 Minuten des
  Update-Patches.
- Pfadwahl: Protokoll-Pfad, wenn weder `mode` noch `resume` noch `target` gesetzt sind; Modell = explizites
  `model`, sonst das aktuelle Modell aus der `session/create`-Antwort, sonst der erste Katalogeintrag.
  Ist kein Katalog verfügbar, fällt der Job mit der Warnung `idle_detection_unavailable` auf die CLI zurück.
- Fertig innerhalb `wait_ms`: dieselbe Textform wie heute, zusätzlich `job_id`. Sonst `status: running`,
  `job_id`, Laufzeit, Hinweis auf `zcode_status` und `zcode_result`; `isError` bleibt aus.
- Ablehnung mit `job_id` des blockierenden Jobs bei: selber Ordner, mehr als 3 laufende Jobs.
- Fehler vor dem Start (Job-Ordner nicht beschreibbar, Platte voll, ungültige Argumente) erzeugen keinen Job.

**`zcode_status`** `{ job_id?, wait_ms? }`. Mit `job_id`: Zustand, Laufzeit, Alter des Lebenszeichens,
Warnungen, bisher geänderte Dateien (Differenz zur Basislinie), letzte Fortschrittszeilen. `wait_ms`
(höchstens 120000) wartet auf eine Zustandsänderung. Ohne `job_id`: Liste aller Jobs und offenen Worktrees.

**`zcode_result`** `{ job_id }`. Inhalt von `result.json`; beliebig oft abrufbar; für laufende Jobs wie `zcode_status`.

**`zcode_cancel`** `{ job_id }`. Siehe Abschnitt 7; Antwort enthält den Zwischenstand.

**`zcode_check`** prüft zusätzlich: Job-Ordner beschreibbar, Reaper-Statistik, ZCode-Version gegen
die bekannt verifizierte Liste (Warnung, kein Fehler).

**Warten und Abbruch.** Wartet der Server in `zcode_run`/`zcode_status` und der Client sendet
`notifications/cancelled`, endet nur das Warten. Der Job läuft weiter. Das wird in den Tool-Beschreibungen genannt.

## 10. Wahrheitsregeln für Ergebnisse

- `completed` ohne Dateiänderung gegenüber der Basislinie in einem Git-Ordner: Warnung `no_changes`.
- Abgelehnte Tool-Aufrufe: `deniedTools`, sofern das Protokoll sie liefert (Spike, siehe 14).
- `errorKind`: `auth`, `quota`, `network`, `model`, `timeout_idle`, `timeout_total`, `cancelled`, `crash`,
  `unknown`; abgeleitet aus Protokoll-Events und `stderr`-Mustern (z. B. `project_token_login_failed`).
- Erkennt der Runner ZCode-interne Wiederholungen (Backoff), steht `retrying` im Status.
- Nicht-Git-Ordner: kein Zwischenstand, keine `no_changes`-Prüfung; die Antwort sagt „unavailable“.
- Der Ergebnistext wird als unvertraute Daten gekennzeichnet (kann Repo-Inhalt enthalten).
- Volle Ausgabe in `output.log`; das Ergebnis liefert Anfang und Ende (insgesamt höchstens 100.000 Zeichen).

## 11. Fehlerbehandlung und Randfälle

- `cwd` wird per `realpath` normalisiert (Sperren, Vergleiche, Basislinie).
- Wiederholung nur bei Startfehlern (Spawn, `settle`, `session/create`), einmal. Nach Arbeitsbeginn nie.
- ZCode-App darf parallel laufen; es wird kein ZCode-Zustand geschrieben.
- Ungültiges UTF-8 wird ersetzt. Zeitsprünge der Uhr führen zu `stalled`, nicht zu Abbruch.
- Mehrere MCP-Server gleichzeitig: Zustand nur in Dateien, atomare Sperren, idempotenter Reaper,
  `sessions.json` atomar und nach `id` zusammengeführt.
- `yolo` kann außerhalb des `cwd` schreiben; das wird dokumentiert, `isolate_worktree` wird für riskante
  Aufgaben empfohlen.
- `serverInfo.version` wird aus `package.json` gelesen.

## 12. Kompatibilität

- Textform des `zcode_run`-Ergebnisses bleibt bei Fertigstellung innerhalb `wait_ms` erhalten.
- Neu: Aufgaben ohne `mode` laufen über den Protokoll-Pfad. Wer die CLI braucht, setzt `mode`.
- `timeout_ms` bedeutet jetzt Gesamtlimit des Jobs (nicht des Wartens); Warten steuert `wait_ms`.
- `zcode_sessions` bleibt unverändert (ZCode-Sessions zum Fortsetzen).

## 13. Teststrategie

Tests mit echter Binary laufen nur mit `--real`; `npm test` bleibt schnell. Jede Suite prüft am Ende
per `ps`, dass keine Prozesse übrig sind. Für Tests überschreibt `ZCODE_MCP_HOME` das Zustandsverzeichnis.

1. **Fehler-Fakes.** Neue Modi in `test/fake-zcode.cjs` und `test/fake-appserver.cjs`: `silent`, `deny-tools`,
   `rate-limit`, `auth-fail`, `crash-mid`, `badutf8`, `slow-start`, `ignore-sigterm`, `spawn-grandchild`, `retrying`.
2. **Protokoll und Job-Kern** (echter MCP-Client über stdio, Fakes): Abbruch durch den Client, `kill -9` des
   Servers während eines Jobs, Neustart und Abruf, `stdin` schließen, parallele Aufrufe, Fehleingaben,
   `wait_ms`-Verhalten, Ablehnung im selben Ordner, Obergrenze 3.
3. **Identität und Aufräumen.** Fremder Prozess mit passender PID gilt als nicht lebendig; veraltete Sperre wird
   ersetzt; Reaper löscht nie außerhalb seines Ordners (Symlink-Test); Abbruch mit SIGKILL-Fallback;
   Zeitsprung → `stalled`; `sessions.json` unter gleichzeitigen Schreibern.
4. **Echter Smoke-Test** (`scripts/smoke-real.mjs`): 6 feste Aufgaben (Datei anlegen, Datei ändern, Tests
   laufen lassen, Mehrdatei-Änderung, unmögliche Aufgabe, nur lesen), je Pfad (Protokoll GLM-5.3,
   Protokoll Flash, CLI yolo); Wirkung prüft das Skript, nicht das Modell. JSON-Bericht.
5. **Dauerlauf.** Eine echte Aufgabe von 20 bis 40 Minuten als Job; währenddessen Server beenden und neu
   starten, Status abfragen.
6. **Fehlerinjektion (echt).** ZCode-Prozess beenden, ungültiger API-Key, parallele Worktree-Jobs, ZCode-App
   geöffnet, Pfad mit Leerzeichen und Symlink, Nicht-Git-Ordner, unsauberer Arbeitsbaum, nicht
   beschreibbarer Job-Ordner.

**Abnahme.** Falsche Erfolgsmeldungen in der Smoke-Matrix: 0. Übrig gebliebene Prozesse und Sperren: 0.
Latenz bei Mini-Aufgaben: Basislinie (p50/p95, Overhead gegenüber direktem ZCode) messen, danach Schwelle festlegen.

## 14. Reihenfolge und Spike

1. **Spike** gegen die echte Binary: (a) liefern Protokoll-Events abgelehnte Tool-Aufrufe? (b) wie dicht
   kommen Events während einer Aufgabe? (c) `session/create` liefert das aktuelle Modell? Ergebnis fließt in
   Abschnitte 9 und 10 ein; bis dahin sind `deniedTools` und die Modellwahl Annahmen.
   Außerdem `scripts/verify-protocol.mjs`.
2. `src/jobs.mjs` und `src/job-runner.mjs` mit Fakes (Tests 1 bis 3).
3. Tool-API in `src/mcp-server.mjs`, Skill und README aktualisieren.
4. Echte Stufen 4 bis 6.

## 15. Offene Annahmen

- Obergrenze 3 Jobs, Aufbewahrung 7 Tage/50 Jobs, `wait_ms`-Standard 60 s: Startwerte, nach den echten
  Tests anpassbar.
- Ob der Host eigene Client-Timeouts für Tool-Aufrufe setzt, ist nicht geprüft; `wait_ms` liegt bewusst
  weit darunter.
- Das Verhalten von `ps -o lstart=`/`command=` wird auf macOS verifiziert; Linux gilt als gleichartig, ist aber
  nicht getestet.

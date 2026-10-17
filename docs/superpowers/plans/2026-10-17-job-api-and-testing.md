# Job-API und Teststrategie Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** zcode-mcp bekommt eine Job-API (abgekoppelter Runner pro Job, PID-sichere Identität, Reaper) und eine Teststrategie in sechs Stufen, damit ZCode als Coding-Worker taugt.

**Architecture:** `mcp-server.mjs` bleibt zustandslos und liest/schreibt Dateien unter `$ZCODE_MCP_HOME` (Standard `~/.zcode-mcp`). Pro Job startet `jobs.mjs` einen detached `job-runner.mjs`, der ZCode über die bestehenden `runZCodeTask` (CLI) oder `runTaskWithModel` (Protokoll) ausführt und `status.json`/`result.json` schreibt. Identität, Sperren, Basislinie, Fehlerklassifikation und Reaper sind eigene, einzeln testbare Module.

**Tech Stack:** Node >= 18, ESM, keine npm-Abhängigkeiten, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-17-job-api-and-testing-design.md` (Abweichung: das dort genannte `src/jobs.mjs` wird in `procid`, `jobstore`, `locks`, `reaper`, `jobs` aufgeteilt, damit jede Datei eine Aufgabe hat).

**Voraussetzung:** Die lokalen Änderungen aus `/Users/Shared/zcode-mcp-update/` liegen im Arbeitsbaum (Modus `yolo`, Leerlauf-Timeout, Zwischenstand, `fileURLToPath`-Fix). Commit-Schritte unten nur ausführen, wenn der Nutzer Commits freigegeben hat.

## Global Constraints

- Zustandsverzeichnis `$ZCODE_MCP_HOME`, sonst `~/.zcode-mcp`; Job-Ordner `0700`, Dateien `0600`; alle JSON-Schreibvorgänge atomar (temporäre Datei, dann `rename`).
- Dateien je Job: `job.json`, `status.json`, `result.json`, `output.log`, `events.log`, `cancel`. Sperren: `locks/<sha1(realpath(cwd))>.lock` mit `O_EXCL`.
- `wait_ms`: Standard 60000, Maximum 300000, 0 = sofort. `zcode_status` `wait_ms` Maximum 120000.
- `idle_timeout_ms` Standard 600000 (nur Protokoll-Pfad). `timeout_ms` Standard und Maximum 21600000 (6 h).
- Herzschlag alle 5 s; `stalled`-Warnung bei Herzschlag älter als 30 s mit lebender Identität; `lost` nur bei fehlgeschlagener Identitätsprüfung ohne Endzustand.
- Identität = PID existiert UND `ps -o lstart=` gleich `pidStart` UND `ps -o command=` enthält Token.
- Abbruch: SIGTERM an Prozessgruppe des Runners; Runner stoppt ZCode (SIGTERM, nach 5 s SIGKILL); nach 10 s ohne Reaktion SIGKILL an die Gruppe, jeweils nur nach bestandener Identitätsprüfung.
- Obergrenze 3 laufende Jobs; zweiter Job im selben realpath-`cwd` wird abgelehnt (mit `blockingJobId`).
- Reaper: Beendete Jobs älter als 7 Tage oder jenseits der neuesten 50 löschen; nur unterhalb des Job-Wurzelordners, Symlinks nicht folgen; Worktrees nie löschen.
- Wiederholung nur bei Startfehlern, einmal; nach Arbeitsbeginn nie. Ergebnisausgabe höchstens 100000 Zeichen, voller Text in `output.log`.
- Pfadwahl: Protokoll-Pfad, wenn weder `mode` noch `resume` noch `target` gesetzt; sonst CLI. `serverInfo.version` kommt aus `package.json`.

## Review Focus

Fünf Fälle, die die Spec nahelegt und die am ehesten stören; jeder hat einen Test in der genannten Task.

1. `cwd` mit Leerzeichen und über Symlink (`/tmp` gegenüber `/private/tmp`) erzeugt dieselbe Sperre (Task 5) und denselben Job-Ablauf (Task 10).
2. Nicht-Git-`cwd` und unsauberer Arbeitsbaum: Bericht zeigt nur Änderungen des Jobs, keine `no_changes`-Falschmeldung (Task 6, Task 7).
3. Fremder Prozess mit wiederverwendeter PID wird nie signalisiert (Task 3, Task 10).
4. MCP-Server wird mit `kill -9` beendet, während ein Job läuft: Job endet sauber, Ergebnis nach Neustart abrufbar, nichts bleibt übrig (Task 14).
5. Zwei MCP-Server starten gleichzeitig einen Job im selben `cwd`: genau einer gewinnt (Task 5, Task 14).

---

### Task 1: Spike und Protokoll-Prüfskript

**Files:**
- Create: `scripts/verify-protocol.mjs`, `test/verify-protocol.test.mjs`, `docs/superpowers/refs/job-api-spike.md`

**Interfaces:**
- Produces: `analyzeEvents(events: object[]): { types: string[], maxGapMs: number, deniedTools: string[] }` (exportiert aus `scripts/verify-protocol.mjs`), CLI `node scripts/verify-protocol.mjs --real` gibt JSON aus.

- [ ] **Step 1: Test** `analyzeEvents` mit vorgefertigten Events: `types` eindeutig und sortiert, `maxGapMs` größte Lücke der `ts`-Werte, `deniedTools` aus Events mit `decision: 'deny'`.
- [ ] **Step 2: Run** `node --test test/verify-protocol.test.mjs` → FAIL (nicht definiert).
- [ ] **Step 3: Implement** `analyzeEvents` und das `--real`-Skript: legt `session/create` mit `mode: 'yolo'` an, sendet eine Mini-Aufgabe, sammelt `session/event`, prüft (a) tauchen abgelehnte Tool-Aufrufe als Events auf, (b) größte Lücke zwischen Events, (c) enthält die `session/create`-Antwort `settings.model.current`.
- [ ] **Step 4: Run** Test → PASS. Dann `node scripts/verify-protocol.mjs --real` einmal ausführen und die drei Ergebnisse in `docs/superpowers/refs/job-api-spike.md` festhalten. Falls (a) oder (c) verneint wird: Spec-Abschnitte 9/10 in diesem Dokument als „nicht verfügbar“ markieren und Task 8 entsprechend verkleinern (nur Vermerk, keine neue Funktion).
- [ ] **Step 5: Commit** `git add scripts test docs && git commit -m "feat: protocol verification script and spike notes"`

### Task 2: Fehler-Fakes (Stufe 1)

**Files:**
- Modify: `test/fake-zcode.cjs`, `test/fake-appserver.cjs`
- Test: `test/fakes.test.mjs`

**Interfaces:**
- Produces: neue `FAKE_ZCODE_MODE`-Werte `silent` (läuft 30 s ohne Ausgabe), `crash-mid` (Exit 1 nach 300 ms), `badutf8` (gibt Bytes `ff fe` aus), `ignore-sigterm` (ignoriert SIGTERM, läuft weiter), `spawn-grandchild` (startet `sleep 60` in derselben Prozessgruppe und gibt dessen PID auf `stderr` aus), `slow-start` (wartet 2 s vor Ausgabe). Neue `FAKE_APPSERVER_MODE`-Werte `deny-tools` (Event mit `decision: 'deny'`), `rate-limit` (turn.failed mit Text `429 rate limit`), `auth-fail` (turn.failed mit `project_token_login_failed`), `retrying` (Events mit Typ `model.retry`), `chatty` (Event alle 150 ms für 1,5 s, dann turn.completed).

- [ ] **Step 1: Test** `test/fakes.test.mjs`: je Modus per `runZCodeTask`/`AppServerClient` starten und das beschriebene Verhalten prüfen (z. B. `ignore-sigterm`: nach `child.kill('SIGTERM')` lebt der Prozess nach 500 ms noch; `badutf8`: `stdout` enthält U+FFFD).
- [ ] **Step 2: Run** `node --test test/fakes.test.mjs` → FAIL.
- [ ] **Step 3: Implement** die Modi in den beiden Fake-Dateien nach dem bestehenden `mode`-Schalter (Muster: Zeile `const mode = process.env.FAKE_ZCODE_MODE || 'ok'`).
- [ ] **Step 4: Run** Test und `npm test` → PASS.
- [ ] **Step 5: Commit** `git add test && git commit -m "test: failure-mode fakes"`

### Task 3: Prozess-Identität

**Files:**
- Create: `src/procid.mjs`
- Test: `test/procid.test.mjs`

**Interfaces:**
- Produces: `getProcessIdentity(pid: number): { pid: number, start: string, command: string } | null`; `matchesIdentity(expected: { pid: number, start: string, token?: string }): boolean`; `signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean` (false bei `ESRCH`).

- [ ] **Step 1: Test** (Namen exakt): `getProcessIdentity returns start and command for the current process`; `returns null for a nonexistent pid` (PID 2147483646); `matchesIdentity is true for own identity with token in argv` (Kindprozess `node -e "setTimeout(()=>{},5000)" TOKEN123`); `matchesIdentity is false when start differs`; `matchesIdentity is false when token is missing from the command` (Fremdprozess `sleep 5` mit richtiger PID und Startzeit); `signalGroup returns false for a dead group`.
- [ ] **Step 2: Run** `node --test test/procid.test.mjs` → FAIL.
- [ ] **Step 3: Implement** mit `execFileSync('ps', ['-o','lstart=','-p',String(pid)])` und `['-o','command=', ...]`; `signalGroup` über `process.kill(-pgid, signal)`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/procid.mjs test/procid.test.mjs && git commit -m "feat: process identity checks"`

### Task 4: Job-Ablage

**Files:**
- Create: `src/jobstore.mjs`
- Test: `test/jobstore.test.mjs`

**Interfaces:**
- Produces: `stateHome(): string`; `jobsRoot(): string`; `newJobId(): string` (Muster `/^job_[0-9a-z]+_[0-9a-f]{6}$/`); `createJobDir(spec: object): { jobId: string, dir: string, token: string }` (wirft `Error` mit `code: 'not-writable'`); `writeJsonAtomic(file: string, obj: object): void`; `readJson(file: string): object | null`; `readStatus(dir)`, `patchStatus(dir, patch): object`, `readResult(dir)`, `writeResult(dir, obj)`; `listJobDirs(): string[]` (älteste zuerst); `TERMINAL_STATES = ['completed','failed','timeout','cancelled','lost']`.
- Consumes: nichts.

- [ ] **Step 1: Test** mit `ZCODE_MCP_HOME` auf Temp-Ordner: Ordner-Modus `0o700` und `job.json`-Modus `0o600`; `writeJsonAtomic` hinterlässt keine `.tmp`-Datei und überschreibt konsistent; `patchStatus` mischt Felder; `createJobDir` wirft `not-writable` bei schreibgeschütztem Home; `listJobDirs` sortiert nach Erstellung.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** gemäß Interfaces (Token: 16 zufällige Bytes hex).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/jobstore.mjs test/jobstore.test.mjs && git commit -m "feat: job store"`

### Task 5: Ordner-Sperren

**Files:**
- Create: `src/locks.mjs`
- Test: `test/locks.test.mjs`

**Interfaces:**
- Consumes: `stateHome()` aus Task 4.
- Produces: `lockKey(cwd: string): string`; `acquireCwdLock(cwd: string, jobId: string, isAlive: (jobId: string) => boolean): { ok: true } | { ok: false, blockingJobId: string }`; `releaseCwdLock(cwd: string, jobId: string): void`.

- [ ] **Step 1: Test:** zweiter `acquire` im selben `cwd` liefert `blockingJobId`; derselbe Ordner über Symlink und über realpath liefert denselben `lockKey` (Pfad mit Leerzeichen); Sperre eines toten Jobs (`isAlive` false) wird ersetzt; `release` mit fremder `jobId` ändert nichts; Rennen: zwei Kindprozesse rufen gleichzeitig `acquire`, genau einer erhält `ok: true`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** mit `openSync(file, 'wx')`; Ersetzen einer veralteten Sperre über `rename` einer neuen Datei und erneute Prüfung des Inhalts.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/locks.mjs test/locks.test.mjs && git commit -m "feat: per-directory locks"`

### Task 6: Basislinie und Änderungen

**Files:**
- Create: `src/changes.mjs`
- Test: `test/changes.test.mjs`

**Interfaces:**
- Produces: `captureBaseline(cwd: string): { gitRoot: string, dirty: { path: string, hash: string }[] } | null`; `changesSince(cwd: string, baseline: object | null): { available: boolean, changedFiles: string[], diffStat: string }`.

- [ ] **Step 1: Test** (Temp-Git-Repos): bereits geänderte Datei erscheint nicht in `changesSince`, bis ihr Inhalt sich ändert; neue Datei und geänderte getrackte Datei erscheinen; Nicht-Git-Ordner → `captureBaseline` null und `available: false`; Pfad mit Leerzeichen funktioniert.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** mit `git status --porcelain` und `git hash-object` je Datei; Vergleich Basislinie gegen aktuellen Hash.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/changes.mjs test/changes.test.mjs && git commit -m "feat: baseline-aware change reporting"`

### Task 7: Fehlerklassifikation

**Files:**
- Create: `src/errorkind.mjs`
- Test: `test/errorkind.test.mjs`

**Interfaces:**
- Produces: `classifyError(input: { message?: string, stderr?: string }): 'auth' | 'quota' | 'network' | 'model' | 'crash' | 'unknown'`.

- [ ] **Step 1: Test** als Tabelle: `project_token_login_failed` → `auth`; `429 rate limit` und `quota exceeded` → `quota`; `ECONNRESET`, `fetch failed` → `network`; `Model is unavailable`, `Select a model before continuing` → `model`; `app-server child exited` → `crash`; leerer Text → `unknown`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** mit geordneten Regex-Regeln.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/errorkind.mjs test/errorkind.test.mjs && git commit -m "feat: error classification"`

### Task 8: Job-Runner (CLI-Pfad, Lebenszyklus)

**Files:**
- Create: `src/job-runner.mjs`
- Test: `test/job-runner.test.mjs`

**Interfaces:**
- Consumes: `patchStatus`, `readJson`, `writeResult` (Task 4); `matchesIdentity`, `getProcessIdentity`, `signalGroup` (Task 3); `captureBaseline`/`changesSince` (Task 6); `classifyError` (Task 7); `runZCodeTask` (`src/runner.mjs`).
- Produces: `runJob(dir: string, opts?: { heartbeatMs?: number }): Promise<void>`; CLI `node src/job-runner.mjs <dir> <token>` (ruft `runJob`, exit 0 nach jedem Endzustand).

- [ ] **Step 1: Tests** mit Fake-Binary (`ZCODE_BIN`) und Temp-`ZCODE_MCP_HOME`, jeweils `job.json` von Hand schreiben: `completed job writes result with sessionId and changedFiles`; `status transitions starting then running then completed`; `heartbeatAt advances while running` (`heartbeatMs: 50`); `cancel file stops the child and ends cancelled with partial changes`; `timeout_ms ends timeout with timeoutKind total`; `crash-mid ends failed with errorKind crash`; `completed without file changes in a git cwd carries warning no_changes`; `non-git cwd carries no no_changes warning`; `status records pid, pidStart, token, childPid`.
- [ ] **Step 2: Run** `node --test test/job-runner.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `runJob`: `status` auf `running` mit Identitätsfeldern; Heartbeat-Intervall; ZCode-Aufruf über `runZCodeTask`; `cancel`-Datei beim Herzschlag prüfen und ZCode stoppen (SIGTERM, nach 5 s SIGKILL); `SIGTERM` des Runners löst denselben Abbruch aus; Endzustand, `result.json`, `output.log`; `process.setsid` entfällt, weil der Aufrufer mit `detached: true` startet. Zeitlimit aus `params.timeout_ms`.
- [ ] **Step 4: Run** Test → PASS.
- [ ] **Step 5: Commit** `git add src/job-runner.mjs test/job-runner.test.mjs && git commit -m "feat: detached job runner (CLI path)"`

### Task 9: Job-Runner (Protokoll-Pfad, Leerlauf, Zusatzfelder)

**Files:**
- Modify: `src/job-runner.mjs`, `src/appserver.mjs`
- Test: `test/job-runner-protocol.test.mjs`

**Interfaces:**
- Consumes: `runTaskWithModel`, `getModelCatalog`, `resolveModel` (`src/appserver.mjs`); `analyzeEvents`-Erkenntnisse aus Task 1.
- Produces: `runTaskWithModel` akzeptiert zusätzlich `onEvent?: (event: object) => void` (aufgerufen für jedes `session/event`); `getDefaultModel(opts: { binPath: string, cwd: string }): Promise<{ providerId: string, modelId: string } | null>` (`settings.model.current`, sonst erster Katalogeintrag, sonst `null`); `describeEvent(event: object): string | null` (Fortschrittszeile).

- [ ] **Step 1: Tests** (Fake-Appserver): `protocol job uses the default model and completes`; `idle timeout ends the job with timeoutKind idle while a chatty job survives`; `deny-tools event yields deniedTools in result`; `retrying events set a retrying warning`; `rate-limit ends failed with errorKind quota`; `no catalog falls back to the CLI path with warning idle_detection_unavailable`; `progress holds the last 5 describeEvent lines`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `onEvent` in `runTaskWithModel` (Weiterreichen im bestehenden `_handleNotification`-Pfad), `getDefaultModel`, `describeEvent` (`<type>` plus Toolname, falls vorhanden) und den Protokoll-Zweig in `runJob` (Pfad aus `job.json`); `lastActivityAt` bei jedem Event aktualisieren; Startfehler (Spawn, `settle`, `session/create`) einmal wiederholen, danach nie.
- [ ] **Step 4: Run** Test und `npm test` → PASS.
- [ ] **Step 5: Commit** `git add src test && git commit -m "feat: protocol path in job runner"`

### Task 10: Job-Verwaltung

**Files:**
- Create: `src/jobs.mjs`
- Test: `test/jobs.test.mjs`

**Interfaces:**
- Consumes: Tasks 3–6, 8, 9.
- Produces: `chooseJobPath(params: object): 'protocol' | 'cli'`; `isJobAlive(dir: string): boolean`; `startJob(params: object): { ok: true, jobId: string } | { ok: false, error: string, blockingJobId?: string }`; `getJob(jobId: string): JobView | null` mit `JobView = { jobId, dir, status, result, alive, stalled }`; `waitJob(jobId: string, opts: { waitMs: number, signal?: AbortSignal, until: 'terminal' | 'change' }): Promise<JobView>`; `cancelJob(jobId: string): Promise<JobView>`; `listJobs(): JobView[]`.

- [ ] **Step 1: Tests** (Fake-Binary, echter detached Runner): `startJob returns before the task finishes`; `second job in same cwd is rejected with blockingJobId`; `fourth concurrent job is rejected`; `cwd via symlink or with spaces maps to the same lock`; `isJobAlive is false for a foreign process with the recorded pid` (status mit PID eines `sleep`-Prozesses, falsches Token); `stalled is true with live identity and heartbeat older than 30 s`, `lost` nie dafür; `waitJob returns running after waitMs and terminal when done`; `aborting waitJob does not stop the job`; `cancelJob ends the job and leaves no process`; `cancelJob escalates to SIGKILL for ignore-sigterm`; `cancelJob does nothing for a foreign process with a reused pid`; `unwritable home returns ok false before spawning`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** gemäß Interfaces; `startJob` prüft Argumente (`validateRunArgs`), Schreibbarkeit, Sperre, Obergrenze, legt Job an, spawnt `process.execPath src/job-runner.mjs <dir> <token>` mit `{ detached: true, stdio: 'ignore' }` und `unref()`; `waitJob` fragt alle 250 ms `status.json`; `cancelJob` schreibt `cancel`, signalisiert nach Identitätsprüfung, eskaliert nach 10 s.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/jobs.mjs test/jobs.test.mjs && git commit -m "feat: job management"`

### Task 11: Reaper

**Files:**
- Create: `src/reaper.mjs`
- Test: `test/reaper.test.mjs`

**Interfaces:**
- Produces: `reap(opts?: { now?: number }): { lost: string[], deleted: string[], killed: number[] }` (idempotent).
- Consumes: `isJobAlive` (Task 10), `listJobDirs`, `jobsRoot` (Task 4), `signalGroup`, `matchesIdentity` (Task 3).

- [ ] **Step 1: Tests:** `marks a dead runner without result as lost`; `kills verified leftover children of a lost job and nothing else`; `deletes finished jobs older than 7 days`; `keeps only the newest 50 finished jobs`; `does not follow a symlink that points outside the jobs root`; `never deletes a worktree directory`; `second reap changes nothing`; `removes the stale lock of a lost job`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** gemäß Spec-Abschnitt 8; Löschen nur nach `lstat` und `realpath`-Präfixprüfung auf `jobsRoot()`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/reaper.mjs test/reaper.test.mjs && git commit -m "feat: reaper"`

### Task 12: Sitzungsablage atomar

**Files:**
- Modify: `src/state.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Produces: `SessionStore.append(entry)` bleibt, schreibt aber atomar und führt nach `id` zusammen (gleiche `id` ersetzt den alten Eintrag).

- [ ] **Step 1: Test:** `concurrent appenders from eight processes lose no entry`; `same id replaces the earlier entry`; bestehende Tests bleiben grün.
- [ ] **Step 2: Run** `node --test test/state.test.mjs` → FAIL.
- [ ] **Step 3: Implement** mit Sperrdatei (`wx`) um Lesen-Ändern-Schreiben und `writeJsonAtomic` aus Task 4.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/state.mjs test/state.test.mjs && git commit -m "fix: atomic session store"`

### Task 13: MCP-Anbindung

**Files:**
- Modify: `src/mcp-server.mjs`, `src/protocol.mjs`, `src/runner.mjs`
- Test: `test/tools.test.mjs`, `test/protocol.test.mjs`

**Interfaces:**
- Consumes: `startJob`, `waitJob`, `getJob`, `cancelJob`, `listJobs` (Task 10); `reap` (Task 11).
- Produces: Tool-Handler haben die Signatur `(args: object, ctx: { signal: AbortSignal }) => Promise<object>`; Tools `zcode_run` (neu `wait_ms`), `zcode_status`, `zcode_result`, `zcode_cancel`; `zcode_check` meldet zusätzlich `jobsDirWritable`, Reaper-Zahlen und eine Warnung bei unbekannter ZCode-Version.

- [ ] **Step 1: Tests:** `zcode_run returns the finished result with job_id inside wait_ms`; `returns status running with job_id after wait_ms` (kein `isError`); `wait_ms 0 returns the job_id immediately`; `notifications/cancelled aborts the wait but the job continues`; `zcode_status without job_id lists jobs and open worktrees`; `zcode_result is repeatable`; `zcode_cancel returns the partial changes`; `idle_timeout_ms together with mode (CLI path) is rejected`; `serverInfo.version equals package.json version`; `timeout_ms above 21600000 is rejected`; `zcode_check reports jobsDirWritable`.
- [ ] **Step 2: Run** `node --test test/tools.test.mjs test/protocol.test.mjs` → FAIL.
- [ ] **Step 3: Implement:** `protocol.mjs` verfolgt laufende `tools/call`-Anfragen nach `id`, `notifications/cancelled` bricht deren `AbortController`; `mcp-server.mjs` ersetzt den CLI-Direktlauf durch `startJob` plus `waitJob` und baut den bisherigen Ergebnistext aus `result.json` (zusätzlich `job_id`, `warnings`, `deniedTools`, `errorKind`, Markierung „unvertraute Daten“); `reap()` beim Start und lazy bei jedem Tool-Aufruf; `MAX_TIMEOUT_MS`/`DEFAULT_TIMEOUT_MS` in `runner.mjs` auf 21600000.
- [ ] **Step 4: Run** Tests und `npm test` → PASS (bestehende `tools.test.mjs`-Erwartungen werden an die neue Ergebnisform angepasst, nicht gelöscht).
- [ ] **Step 5: Commit** `git add src test && git commit -m "feat: job tools in the MCP server"`

### Task 14: Protokoll- und Job-Tests über stdio (Stufe 2)

**Files:**
- Create: `test/jobs-stdio.test.mjs`
- Modify: `test/helpers.mjs`

**Interfaces:**
- Produces: `assertNoLeftoverProcesses(markers: string[]): void` in `test/helpers.mjs` (prüft per `ps` auf Prozesse, deren Kommandozeile einen Marker enthält); `class StdioClient` (spawnt `src/mcp-server.mjs` mit gesetztem `ZCODE_MCP_HOME`/`ZCODE_BIN`, `request(method, params)`, `notify(method, params)`, `kill(signal)`).

- [ ] **Step 1: Tests:** `kill -9 of the server mid-job still ends the job and the result is retrievable after restart`; `closing stdin does not kill a running job`; `two servers starting a job in the same cwd: exactly one wins`; `four parallel zcode_run calls in different cwds: three run, one is rejected`; `malformed JSON line and unknown method keep the server alive`; `no process with the test marker remains after every test`.
- [ ] **Step 2: Run** `node --test test/jobs-stdio.test.mjs` → FAIL.
- [ ] **Step 3: Implement** Helfer und Tests; Fake-Modus `silent`/`chatty` aus Task 2 für Laufzeit.
- [ ] **Step 4: Run** → PASS; danach `npm test` komplett.
- [ ] **Step 5: Commit** `git add test && git commit -m "test: stdio and job lifecycle suite"`

### Task 15: Echte Läufe (Stufen 3 bis 6) und Dokumentation

**Files:**
- Create: `scripts/smoke-real.mjs`, `scripts/soak-real.mjs`, `scripts/faults-real.mjs`, `test/oracles.test.mjs`
- Modify: `skills/zcode-delegate/SKILL.md`, `agents/zcode-worker.md`, `README.md`, `package.json` (Skripte `smoke`, `soak`, `faults`)

**Interfaces:**
- Produces: `checkOracle(task: SmokeTask, dir: string): { ok: boolean, reason?: string }` in `scripts/smoke-real.mjs` (Prüfung der Wirkung, nicht des Modells). `SmokeTask = { id: string, prompt: string, expect: (dir: string) => boolean }`. Sechs Aufgaben: Datei anlegen, Datei ändern, Tests laufen lassen, Mehrdatei-Änderung, unmögliche Aufgabe (erwartet ehrliches `failed` oder Warnung `no_changes`), nur lesen. Pfade: Protokoll GLM-5.3, Protokoll Flash, CLI `yolo`.

- [ ] **Step 1: Test** `test/oracles.test.mjs`: `checkOracle` erkennt eine fehlende Datei, falschen Inhalt und eine unveränderte Datei bei einer Aufgabe, die Änderung verlangt.
- [ ] **Step 2: Run** `node --test test/oracles.test.mjs` → FAIL.
- [ ] **Step 3: Implement** die drei Skripte (alle nur mit `--real`, JSON-Bericht nach `$ZCODE_MCP_HOME/reports/`): `smoke-real` misst Latenz je Aufgabe und zählt falsche Erfolgsmeldungen; `soak-real` fährt eine echte Aufgabe von 20 bis 40 Minuten als Job und startet währenddessen den Server neu; `faults-real` deckt ab: ZCode-Prozess beenden, ungültiger API-Key, parallele Worktree-Jobs, ZCode-App geöffnet, Pfad mit Leerzeichen und Symlink, Nicht-Git-Ordner, unsauberer Arbeitsbaum, nicht beschreibbarer Job-Ordner. Skill, Agent und README beschreiben `wait_ms`, Job-Tools, Pfadwahl und den Hinweis zu `yolo` außerhalb des `cwd`.
- [ ] **Step 4: Run** Oracle-Test → PASS; dann `node scripts/smoke-real.mjs --real`: erwartet 0 falsche Erfolgsmeldungen und 0 übrige Prozesse; Basislinie der Latenz (p50/p95) in `docs/superpowers/refs/job-api-spike.md` eintragen und erst danach eine Schwelle festlegen.
- [ ] **Step 5: Commit** `git add scripts test skills agents README.md package.json docs && git commit -m "feat: real-binary suites and docs"`

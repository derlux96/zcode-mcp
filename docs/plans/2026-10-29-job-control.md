# Job control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graceful cancel, steering, answering ZCode's questions, per-job usage and secret redaction for protocol-path jobs, each falling back to today's behaviour when ZCode does not support it.

**Architecture:** The detached runner stays the only process that talks to ZCode. The MCP server reaches it through files in the job directory: the existing `cancel` file and a new `inbox/` with per-message ack files. `AppServerClient`/`runTaskWithModel` gain a control object (stop, steer, answer) and park `interaction/requestUserInput` instead of answering `{}`.

**Tech Stack:** Node ≥ 18 ESM, `node:test`, no new dependencies.

**Spec:** `docs/specs/2026-10-29-job-control-design.md`

## Global Constraints

- Node ≥ 18, no new npm dependencies; ESM `.mjs` in `src/`, tests in `test/*.test.mjs` run by `npm test`.
- New behaviour applies only to `job.path === 'protocol'`; on the CLI path every new control answers `not_supported`.
- Graceful stop wait: 10 s (`STOP_GRACE_MS = 10000`) before the process group is killed.
- `zcode_send` ack wait: 5 s (`SEND_ACK_WAIT_MS = 5000`), then `queued`.
- `input_timeout_ms` default 30 min (`DEFAULT_INPUT_TIMEOUT_MS = 1800000`), max `MAX_TIMEOUT_MS`.
- Input-timeout answer text, exactly: `No answer available, decide yourself and continue`.
- Unknown server requests other than `interaction/requestUserInput` are still answered `{}`.
- Text from ZCode or callers outside the untrusted output block goes through `oneLine`/`cleanName` (R25).
- Every commit ends with the session's attribution lines.

## Review Focus

1. **`zcode_send` racing the end of the job** — the job finishes before the runner reads the inbox; the caller expects "job finished before the message was delivered", not `queued`. Test in Task 7.
2. **Cancel while `needs_input`** — the parked question must not block the stop/kill path; the job ends `cancelled`. Test in Task 6.
3. **Two concurrent `zcode_send` calls** — both get distinct `seq` numbers and both are delivered in order (exclusive create, retry on `EEXIST`). Test in Task 5.
4. **Redaction false positives** — `sessionId`, `job_…` ids, `totalTokens`, file paths and normal prose stay intact. Test in Task 1.
5. **A turn that fails after `stop()`** — must not trigger a transient retry, even if the error text looks transient. Test in Task 4.

---

### Task 1: Redaction module

**Files:**
- Create: `src/redact.mjs`
- Modify: `src/provider-check.mjs:11-28` (use `isSensitiveKey` from the new module)
- Modify: `src/job-runner.mjs` (apply on `writeResult` payload, `output.log`, status `errorMessage`)
- Test: `test/redact.test.mjs`

**Interfaces:**
- Produces: `redactText(s: string) -> string`, `redactValue(v: unknown) -> unknown` (deep copy, keys by suffix), `isSensitiveKey(name: string) -> boolean`, `REDACTED = '[REDACTED]'`.

- [ ] **Step 1: Write failing tests** `test/redact.test.mjs`:
  - `isSensitiveKey`: true for `apiKey`, `api_key`, `zcodeJwtToken`, `Authorization`, `clientSecret`, `password`; false for `totalTokens`, `inputTokens`, `sessionId`, `apiKeyRequired`, `tokenCount`.
  - `redactText('use sk-abc123def456ghi789jkl now')` → `'use [REDACTED] now'`; `'Bearer eyJhbGciOi.abc.def'` → `'Bearer [REDACTED]'`; `'https://x.io/v1?key=SECRET&a=1'` → `'https://x.io/v1?key=[REDACTED]&a=1'`.
  - Unchanged: `'sess_fakeB1'`, `'job_20261029_abcdef'`, `'/home/u/project/src/api-key-handler.mjs'`, `'totalTokens 32485'`.
  - `redactValue({ apiKey: 'x', usage: { totalTokens: 5 }, sessionId: 's' })` → `{ apiKey: '[REDACTED]', usage: { totalTokens: 5 }, sessionId: 's' }`.
- [ ] **Step 2:** `node --test test/redact.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement `src/redact.mjs`.** Key test: normalise to lowercase alphanumerics, then ends-with one of `apikey`, `token`, `secret`, `password`, `authorization`, `cookie`, `privatekey`. Value patterns: `sk-[A-Za-z0-9_-]{12,}`, `Bearer\s+\S+` (keep the word `Bearer`), query params whose name `isSensitiveKey`, and `[A-Za-z0-9_\-]{40,}` runs that contain both letters and digits (high-entropy tokens). Switch `provider-check.mjs` to `isSensitiveKey`; keep its existing tests green.
- [ ] **Step 4:** In `job-runner.mjs`, pass `output`, `errorMessage`, `stderr` through `redactText` before `writeResult`/`writeFileSync(outputLogPath)`/`setFinalStatus`. Add a case to `test/job-runner-protocol.test.mjs`: fake turn response containing `sk-abc123def456ghi789jkl` → `result.json` output contains `[REDACTED]`, not the key (add fake mode `secret` that answers with that text).
- [ ] **Step 5:** `npm test` → all PASS. Commit `feat: redact secrets in job results and logs`.

### Task 2: Usage in results

**Files:**
- Modify: `src/appserver.mjs` (`runTaskWithModel`)
- Modify: `src/job-runner.mjs` (`runProtocol` return, result write)
- Modify: `src/mcp-server.mjs` (`terminalResult`)
- Modify: `test/fake-appserver.cjs` (`emitTurn` adds `payload.usage`)
- Test: `test/appserver-retry.test.mjs`, `test/tools.test.mjs`

**Interfaces:**
- Produces: `runTaskWithModel` result and thrown errors carry `usage: Usage | null`, `Usage = { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens, modelRequestCount }` (numbers); `addUsage(acc: Usage|null, u: unknown) -> Usage|null` exported from `appserver.mjs`. `result.json.usage` same shape.

- [ ] **Step 1: Failing tests.** `addUsage(null, undefined)` → `null`; `addUsage(null, { inputTokens: 10, totalTokens: 12 })` → all seven fields, missing ones 0; two adds sum. In `appserver-retry.test.mjs`, mode `fail-429-then-ok` with fake usage `{inputTokens:100,outputTokens:5,totalTokens:105,modelRequestCount:1}` on every turn event → `res.usage.totalTokens === 210`, `modelRequestCount === 2`. In `tools.test.mjs`, a finished job's text contains a line `usage: 105 tokens (in 100, out 5, reasoning 0, cache read 0), 1 requests`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Fake: add `usage` (values above) to `turn.completed` and `turn.failed` payloads. `runTaskWithModel`: `addUsage` on every terminal turn event; include in returned object and on thrown errors (like `retries`). Runner: copy `usage` into the result. `terminalResult`: render the line above after `retries`, omitted when `usage` is null.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: report token usage per job`.

### Task 3: Park `requestUserInput` in the client

**Files:**
- Modify: `src/appserver.mjs` (`AppServerClient`)
- Modify: `test/fake-appserver.cjs` (mode `ask`)
- Test: `test/appserver.test.mjs`

**Interfaces:**
- Produces: constructor option `onUserInput(req: { requestId: string, protocolId: string|number, question: string, params: object })`; `client.respond(protocolId, result) -> void`; `client.pendingUserInput -> number`; `buildUserInputAnswer(params: object, text: string) -> object` (exported; the single place to fix the wire shape after Task 9).

- [ ] **Step 1: Failing tests.** Fake mode `ask`: after acking `session/send` it sends `{id:'server-2', method:'interaction/requestUserInput', params:{requestId:'req_1', sessionId, question:'Which port?'}}` without the 2 s trap, waits for any answer, then completes the turn with `response = "answer: " + JSON.stringify(result)`. Tests: `onUserInput` fires once with `question === 'Which port?'`; after `respond(id, buildUserInputAnswer(params, '8080'))` the turn response contains `8080`; an unknown server request (fake sends `interaction/browserList` in mode `ask`) is still answered `{}`; with `idleTimeoutMs: 300` the wait does **not** idle-time-out while the question is parked for 1 s.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `_handleServerRequest`: for `interaction/requestUserInput` store `{protocolId, params}` in `this._parkedInput` (Map by protocol id) and call `onUserInput`; without a hook answer `{}` as before. `respond` deletes from the map and `_send`s. `_armIdle`: when the timer fires and `this._parkedInput.size > 0`, re-arm instead of rejecting. `question` = `params.question ?? params.prompt ?? params.message ?? ''`. `buildUserInputAnswer` returns `{ requestId: params.requestId, answer: text }` until Task 9 confirms the real shape.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: park ZCode user-input requests instead of answering {}`.

### Task 4: Control object in `runTaskWithModel`

**Files:**
- Modify: `src/appserver.mjs`
- Modify: `test/fake-appserver.cjs` (`session/stop`, `v4/command`, `FAKE_APPSERVER_UNSUPPORTED`)
- Test: `test/appserver.test.mjs`, `test/appserver-retry.test.mjs`

**Interfaces:**
- Consumes: Task 3 client API.
- Produces: option `onControl(control)` called once the session is subscribed, with
  `control.stop() -> Promise<'accepted'|'not_supported'>`,
  `control.steer(text: string) -> Promise<{status:'accepted'|'rejected'|'not_supported', reason?: string}>`,
  `control.answer(text: string) -> {status:'accepted'|'rejected', reason?: string}` (rejected `no_question` when nothing is parked),
  `control.capabilities -> { stop: boolean|null, steer: boolean|null, userInput: boolean|null }`.
  `onUserInput` option is passed through to the client.

- [ ] **Step 1: Failing tests.**
  - Fake answers `session/stop` with `{}` and then emits `turn.failed` with `error.code:'aborted'`, message `"429 rate limit"` (deliberately transient-looking). `stop()` → `'accepted'`; the task returns failed **without** any retry (`retries.length === 0`), `capabilities.stop === true`.
  - `FAKE_APPSERVER_UNSUPPORTED=stop,steer` → both answer `-32601`; `stop()` → `'not_supported'`, `steer('x')` → `{status:'not_supported'}`, capabilities false.
  - `steer('use port 8080')` in mode `chatty` → `{status:'accepted'}`; the fake log (`FAKE_APPSERVER_LOG`) shows `v4/command` with `type:'sendText'`, `payload.delivery.requested:'guide'`, `payload.text:'use port 8080'`, `sessionId`.
  - Steer during a retry backoff (mode `fail-429-then-ok`, delays `[300]`) → `{status:'rejected', reason:'retry'}`.
  - `answer('x')` with nothing parked → `{status:'rejected', reason:'no_question'}`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `notSupported(err)` = `err instanceof AppServerError && (err.code === -32601 || /method not found|unknown method/i.test(err.message))`; on the first such answer set the capability false and return `not_supported` for later calls without a request. Steer envelope: `{ commandId: \`steer-${sessionId}-${Date.now()}\`, clientId: 'zcode-delegate', sessionId, type: 'sendText', payload: { text, delivery: { requested: 'guide' } }, issuedAt: Date.now() }`; accepted iff `result.status === 'accepted'`, else rejected with `result.reasonCode`. A `stopRequested` flag makes the retry loop return `failed(null)`. A `backingOff` flag (set around `backoff()`) makes `steer` reject with `retry`. `answer` picks the oldest parked request and calls `client.respond(protocolId, buildUserInputAnswer(params, text))`.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: stop, steer and answer controls with capability fallback`.

### Task 5: Inbox files

**Files:**
- Create: `src/inbox.mjs`
- Test: `test/inbox.test.mjs`

**Interfaces:**
- Produces: `writeInboxEntry(dir, { kind: 'send', text }) -> number` (seq), `readPending(dir, afterSeq: number) -> Array<{seq, kind, text, createdAt}>` sorted by seq, `writeAck(dir, seq, { status, reason? })`, `readAck(dir, seq) -> {status, reason?, at} | null`, `waitAck(dir, seq, ms, { signal }) -> ack | null`. Files: `inbox/000001.json`, `inbox/000001.ack.json`, mode 0600, dir 0700.

- [ ] **Step 1: Failing tests:** first entry seq 1, second 2; `readPending(dir, 1)` returns only seq 2; 20 parallel `writeInboxEntry` calls (via `Promise.all` of async wrappers) yield seqs 1..20 with no duplicates; `waitAck` returns null after the timeout and the ack once written; a half-written `*.tmp` file is ignored by `readPending`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** Next seq = max existing + 1; reserve with `openSync(path, 'wx')` (retry next seq on `EEXIST`), write content to `<seq>.json.tmp`, `renameSync` over the reserved file. `readPending` ignores files that fail to parse (picked up next poll). Reuse `ensurePrivateDir`/`writeJsonAtomic` from `jobstore.mjs`.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: job inbox for messages to the runner`.

### Task 6: Runner: inbox, graceful cancel, `needs_input`

**Files:**
- Modify: `src/job-runner.mjs` (`runProtocol`, `runJob`, `describeEvent` unaffected)
- Test: `test/job-runner-protocol.test.mjs`

**Interfaces:**
- Consumes: Task 4 `onControl`/`onUserInput`, Task 5 inbox API.
- Produces: status fields `state: 'needs_input'` (non-terminal), `question: string|null`, `inputDeadline: ISO|null`, `capabilities: {stop, steer, userInput}`; result field `sessionId` on cancel (already there). Constants `STOP_GRACE_MS`, `DEFAULT_INPUT_TIMEOUT_MS`, `INPUT_TIMEOUT_ANSWER` exported.

- [ ] **Step 1: Failing tests** (fake modes from Tasks 3/4):
  - mode `chatty`, write inbox entry `use port 8080` → ack `accepted` within 2 s; fake log shows the steer.
  - mode `ask` → status becomes `needs_input` with `question: 'Which port?'`; inbox entry `8080` → ack `accepted`, state back to `running`, job `completed`, output contains `8080`.
  - mode `ask`, `input_timeout_ms: 300` → output contains `No answer available, decide yourself and continue`, job `completed`.
  - mode `slowhang` + cancel file → fake log shows `session/stop`; job `cancelled` with `sessionId`.
  - `FAKE_APPSERVER_UNSUPPORTED=stop` + cancel file → job `cancelled` within 3 s (kill fallback), `status.capabilities.stop === false`.
  - Review Focus 2: mode `ask`, cancel file while `needs_input` → job `cancelled`.
  - Inbox entry while no control exists yet (before session) is acked only after the session is up; an entry while the job is on the CLI path is acked `not_supported` (CLI runner loop reads the inbox too).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `runProtocol`: keep `control` from `onControl`; an inbox poll on the existing `CANCEL_POLL_MS` interval handles pending entries in order: if a question is parked → `control.answer(text)`, else `control.steer(text)`; write the ack; remember last seq. `onUserInput` → `setStatus({ state: 'needs_input', question: oneLine(q), inputDeadline })`, start the input timer (`params.input_timeout_ms ?? DEFAULT_INPUT_TIMEOUT_MS`) which calls `control.answer(INPUT_TIMEOUT_ANSWER)`; any answer clears timer and sets `state: 'running', question: null, inputDeadline: null`. Cancel: in `runJob`, the cancel-file poll on the protocol path calls a `ctx.gracefulStop()` hook (provided by `runProtocol`) that calls `control.stop()` and arms `setTimeout(abort, STOP_GRACE_MS)`; without control or on `not_supported` it aborts at once. SIGTERM/SIGINT still abort at once. Write `capabilities` to status after every control call.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: runner handles inbox, graceful cancel and user input`.

### Task 7: Job manager: `sendToJob`, graceful `cancelJob`, `input_timeout_ms`

**Files:**
- Modify: `src/jobs.mjs` (`cancelJob`, new `sendToJob`)
- Modify: `src/runner.mjs` (`validateRunArgs`: `input_timeout_ms`)
- Modify: `src/jobs.mjs` `validateStart` (reject `input_timeout_ms` on CLI path)
- Test: `test/jobs.test.mjs`

**Interfaces:**
- Consumes: Task 5 inbox API, Task 6 status fields.
- Produces: `sendToJob(jobId, text, { ackWaitMs = SEND_ACK_WAIT_MS, signal }) -> { ok: true, status: 'accepted'|'rejected'|'not_supported'|'queued', reason?, view } | { ok: false, error: string }`.

- [ ] **Step 1: Failing tests:** unknown id → `ok:false`, `Unknown job`; CLI-path job → `ok:false` containing `not supported on the CLI path`; terminal job → `ok:false` containing `already finished`; empty text or more than 20000 chars → `ok:false`; no runner ack within `ackWaitMs: 200` on a live job → `status:'queued'`; Review Focus 1: the job turns terminal during the wait without an ack → `ok:false`, `job finished before the message was delivered`. `cancelJob` on a protocol job whose runner honours the cancel file within 1 s sends no SIGTERM (assert via `safeSignal` spy / runner exit reason). `validateRunArgs({ input_timeout_ms: -1 })` invalid; CLI path + `input_timeout_ms` invalid.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `sendToJob`: validate, `writeInboxEntry`, `waitAck`; on null re-read the view and decide queued vs. finished. `cancelJob`: for `job.path === 'protocol'` first `settle(job, dir, STOP_GRACE_MS + 2000)` after writing the cancel file, then the existing SIGTERM → SIGKILL → `markCancelled` path.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: send messages to jobs and cancel protocol jobs gracefully`.

### Task 8: MCP surface and docs

**Files:**
- Modify: `src/mcp-server.mjs` (`zcode_send` schema + handler, `zcode_run.input_timeout_ms`, `runningResult` state/question lines, `zcode_cancel` description)
- Modify: `test/manifests.test.mjs` (`TOOLS` gains `zcode_send`), `agents/zcode-worker.md`, `claude/agents/zcode-worker.md`, `skills/zcode-delegate/SKILL.md`, `README.md`
- Test: `test/tools.test.mjs`

**Interfaces:**
- Consumes: Task 7 `sendToJob`, Task 6 status fields, Task 2 usage line.

- [ ] **Step 1: Failing tests** in `tools.test.mjs`: `tools/list` includes `zcode_send` with required `job_id`, `text`; a `needs_input` job renders `status: needs_input`, `question: Which port?`, `answer with zcode_send <job_id> "<text>"`; `zcode_send` on a running job returns `send: accepted`; on an unknown job `isError` and `Unknown job`. Manifests test lists the new tool.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** `zcode_send` description: "Send a message to a running protocol-path job: while the job waits for an answer (status needs_input) the text answers ZCode's question, otherwise it steers the running turn. Returns accepted, rejected, not_supported, or queued (delivered later)." `runningResult` prints `status: ${view.state}` instead of the fixed `running`, plus `question:` and `input_deadline:` lines (through `oneLine`). Docs: one short section per new capability in README; add `zcode_send` to agent/skill tool lists.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: zcode_send tool and needs_input status`.

### Task 9: Real-ZCode verification (manual, on the owner's Mac)

**Files:**
- Modify: `scripts/verify-protocol.mjs` (`--real --controls`)
- Modify: `docs/protocol/app-server-protocol.md` (record findings)
- Modify: `src/appserver.mjs` `buildUserInputAnswer` if the shape differs

- [ ] **Step 1:** Add `--controls` probes to `runReal`: (a) start a long turn ("count slowly to 50, one line per second"), send `v4/command` steer "stop at 10", record whether `turn.steerQueued`/`turn.steerDrained` arrive and the output stops near 10; (b) a second turn, `session/stop` after 3 s, record the terminal event type and error code; (c) a prompt that asks the agent to request user input ("Ask me which port to use via your ask-user tool, then print it"), log the full `interaction/requestUserInput` params, answer with `buildUserInputAnswer`, then retry with the alternative shapes `{ answer }`, `{ text }`, `{ response: { text } }` until the answer reaches the output; print which one worked.
- [ ] **Step 2:** Owner runs `node scripts/verify-protocol.mjs --real --controls` in a throwaway git repo; paste output into the thread.
- [ ] **Step 3:** Fix `buildUserInputAnswer` (and the Task 3 fake's expectation) to the confirmed shape, record facts in `docs/protocol/app-server-protocol.md`, `npm test` → PASS, commit `docs: verified control methods against real ZCode`.

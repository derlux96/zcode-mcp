# Job API spike: protocol facts (ZCode 0.16.9)

Date: 2026-10-17. Script: `node scripts/verify-protocol.mjs --real` (run once, in a fresh `mktemp -d` git repo).
Task sent: "Create a file hello.txt containing hi" (one throwaway session, model = the session's `settings.model.current`). Result: `turn.completed`, `hello.txt` contained `hi`, 29 events.

## Results

(a) Denied tool calls as events: **not observed.** The run used `mode: 'yolo'`, nothing was denied (1 Write, allowed), so `deniedTools` was `[]`. No permission/deny event type appeared at all. How a denial surfaces (e.g. in `build` mode) was not tested, so it is unknown. Consequence: spec sections 9/10 that depend on reporting denied tool calls are **not available (unverified)**; Task 8 should only note this, no new function.

(b) Largest gap between consecutive events: **11023 ms** (29 events over ~17.4 s; the gap sits before the first `model.streaming` reasoning delta). Idle timeouts must therefore be well above 11 s; a single run is a lower bound only.

(c) `session/create` response contains `settings.model.current`: **yes** -> `{providerId: "zai-coding-plan", modelId: "GLM-5.3", options: {reasoningLevel: "max"}}`.

## Other observations

- Event type names seen (unique, sorted): `checkpoint.created`, `model.streaming`, `session.titleUpdated`, `session.updated`, `streamRecovery.updated`, `tool.updated`, `turn.completed`, `turn.started`.
- Timestamp field on events is **`timestamp`** (ms epoch), not `ts`. Other top-level keys: `deliveryKind`, `eventId`, `payload`, `seq`, `sessionId`, `traceId`, `turnId`, `type`. `analyzeEvents` accepts both `ts` and `timestamp`.
- Tool events: `tool.updated` with `payload.toolName` (`Write`), `payload.toolCallId`, `payload.kind` (`scheduled` seen; other kinds not observed).
- `turn.completed.payload`: `response`, `tokenCount`, `usage`, `toolCallCount`, `duration` (ms), `resultType: "success"`.
- Oddity: the `session/create` response reported `session.mode: "build"` even though `mode: 'yolo'` was passed, yet the Write succeeded. Whether the response echoes the mode wrongly or yolo is applied later was not investigated.
- User plugin hooks (superpowers SessionStart) show up as `session.updated` events.

## Smoke baseline (stage 4, `node scripts/smoke-real.mjs --real`)

Date: 2026-10-17, one run (14:35-14:40 UTC), ZCode 0.16.9, macOS arm64, ZCode desktop app open.
6 tiny tasks (create file, change file, run tests, multi-file change, impossible task, read-only
question) per path, each in a fresh temp git repo, sequential, one MCP server over stdio.
Latency = `zcode_run` call -> `finishedAt` of the job (includes runner spawn, app-server/CLI
start, model work and change collection). First activity = `zcode_run` call -> first protocol
event in `events.log` (protocol path only; the CLI emits nothing until the end).

| Path | Result | p50 latency | p95 latency | first activity p50 / p95 |
|---|---|---|---|---|
| protocol, default model (`zai-coding-plan/GLM-5.3`, reasoning high) | 6/6 ok | 17.6 s | 26.4 s | 0.93 s / 0.95 s |
| protocol, `zai-coding-plan/GLM-5.3-Flash`, reasoning low | 6/6 ok | 13.3 s | 18.6 s | 0.95 s / 0.99 s |
| CLI, `mode: yolo` | 6/6 ok | 14.7 s | 18.7 s | n/a |

False successes: 0. Failed oracles: 0. Leftover processes: 0. The impossible and read-only tasks
ended `completed` with warning `no_changes` and an unchanged working tree on every path; nothing
was invented. With 6 samples per path p95 equals the slowest run; treat the numbers as a first
baseline, not a threshold. The overhead against direct ZCode was not measured separately; the
time to the first protocol event (~0.95 s) bounds the job machinery's start-up cost on the
protocol path. Suggested threshold after more runs: p95 of a tiny task under 60 s per path.

## Known limitations (final)

- Denied tool calls are not reported (`deniedTools` unverified: no deny event observed, see (a)).
- The CLI path has no progress and no idle detection (output only at the end); only `timeout_ms` applies.
- `yolo` and the protocol path can write outside `cwd`; nothing prevents it. `isolate_worktree` only
  keeps the job's in-repo edits off the user's working tree (separate branch/worktree), it does not
  stop writes outside the cwd; worktrees are never removed automatically.
- `timeout_ms` on the protocol path is now a deadline for the whole task from the first
  `session/send` (transient-error backoffs and continues included; fixed on `feature/transient-retry`).
  Only the app-server start-up before that first send (up to ~30 s per request, retried once)
  still comes on top.
- Temporary provider errors are continued in the same session only on the protocol path; the CLI
  path has no continue (rerun with `resume` manually), and `max_transient_retries` is rejected there.
- Z.ai's `[1113] Insufficient balance or no resource package` / `余额不足` is a separate balance
  class (R31): at most 2 retries (30 s, 60 s), then the real message with `error_kind: quota`, so a
  real exhaustion or a wrong endpoint surfaces within ~1.5 min.
- ZCode's `retryable` flag on provider errors is not honoured (R30): it marks provider 429s
  `retryable: false` although they often clear.
- VERIFIED on the real binary (controller): a second `session/send` into the same session after a
  failed turn completed and wrote a file. The real `turn.failed` layout is
  `payload.error = { type, code, message (localized, e.g. Chinese), detail, underlyingErrorMessage, stack }`,
  e.g. `{ code: 'model_not_found', message: 'Provider Registry 中不存在 Model: …', detail: 'Model creation failed' }`;
  classification therefore searches all of those fields.
- A real provider 429 `turn.failed` payload was never observed. An earlier ZCode log showed
  `statusCode: 429` with `statusMessage: [1113][Insufficient balance or no resource package. Please recharge.][…]`
  (marked `retryable: false`); the fake app-server's `fail-status-1113-always` mode mirrors that
  shape, the exact field names on `turn.failed` remain unverified.
- The `sess_` id is lost when a protocol job times out or is cancelled silently after
  `session/create` (no event carried it yet): such a result is not resumable.
- A `session/send` acknowledgement timeout is booked as `timeout_total` with a misleading message.
- Grandchildren of ZCode are only killed on stop signals (cancel, timeout, runner fatal); a normal
  ZCode exit does not sweep leftover grandchildren.
- Reaper residual: during a persistent `ps` outage (>= 3 failed samples) the reaper can signal the
  ZCode child group of a job that is actually alive (the runner itself is never signalled).
- `zcode_cancel` never sets `isError`, even when the cancelled job ends `cancelled`.
- U+2028/U+2029 and C1 control characters are not escaped in rendered file names; only C0 and DEL
  are. "Output cannot forge a header line" holds only for clients that split lines on `\n`.
- Cancelled and timed-out jobs report the changes as of that moment (ZCode may still have been
  writing; nothing is rolled back).
- Smoke oracles: the read-only task only checks that the output contains the answer (7341; the
  prompt does not contain it, but echoing the file would also pass), and the impossible task checks
  the effect (nothing invented, tree clean, `no_changes`) but not that the final text says the
  file does not exist. Stricter text checks were left out to keep real runs from turning flaky.
- Non-git directories: no changed-file report (`changes: unavailable`) and no `no_changes` check.
- `lost`/`stalled` detection relies on `ps -o lstart=,command=`; verified on macOS only.
- The latency baseline above is a single run of 18 tiny tasks; the soak (stage 5) and the real
  fault scenarios (stage 6) are run separately by the controller.
- `zcode_run`'s `wait_ms` (max 300 s) assumes the MCP host has no shorter tool-call timeout (unverified).

## Evidence runs against the real ZCode (2026-10-17, after the follow-up fixes)

Preflight: one tiny real job (create `hi.txt`) completed.

- `node scripts/faults-real.mjs --real`: **8/8 ok** (kill-zcode-mid-run, invalid-api-key,
  parallel-worktree-jobs, zcode-app-open, path-with-spaces-and-symlink, non-git-dir,
  dirty-tree-baseline, unwritable-job-dir). `invalid-api-key` ends `failed` with `error_kind: model`
  plus the fixed login/provider hint (ZCode's CLI prints `Model creation failed` on stderr for a
  missing login; the judge accepts `auth`, or `model` with that text/hint).
- `node scripts/soak-real.mjs --real` (run once): the 25-module task **completed in 422 s** (75/75
  tests, `progress.log` 25 steps, `done.txt` DONE, effect check ok, 0 stalled polls, 0 leftovers),
  but the script's verdict is **not ok**: the planned `kill -9` of the MCP server is scheduled at
  minute max(2, N/3) = 8.3 and the job had already finished, so "no server restart happened".
  The restart/recovery half of the soak is therefore still unproven on the real binary. Rerun with
  a longer task or an earlier restart (`--restart-at 3`, or more `--modules`); not repeated here.

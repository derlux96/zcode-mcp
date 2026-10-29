# Job control: graceful cancel, steer, user input, usage, redaction

Status: design approved in chat on 2026-10-29, spec awaiting review.

## Goal

Make protocol-path jobs more robust, safer and more controllable, using
ZCode features when the installed version offers them and falling back to
today's behaviour when it does not. Ideas taken from
[Mnehmos/mnehmos.zcode.mcp](https://github.com/Mnehmos/mnehmos.zcode.mcp)
(MIT); no code is copied.

Scope is the protocol path (`job.path === 'protocol'`) only. On the CLI path
every new control answers `not_supported` and nothing else changes.

## User-visible behaviour

1. **Graceful cancel.** `zcode_cancel` still writes the cancel file. On the
   protocol path the runner first sends `session/stop` and waits up to 10 s
   for a terminal turn event, then kills the process group as today. The
   result of a cancelled job carries its `session_id` so it can be resumed.
2. **New tool `zcode_send { job_id, text }`.**
   - Job `running`: the text is sent as a steer (`v4/command`, type
     `sendText`, `payload.delivery.requested = "guide"`).
   - Job `needs_input`: the text answers the pending user-input request.
   - Returns the receipt: `accepted`, `rejected` (with reason) or
     `not_supported`; `queued` if no receipt arrived within 5 s (the message
     is still delivered later).
3. **New non-terminal state `needs_input`.** Set when ZCode sends
   `interaction/requestUserInput`. `zcode_status` shows the question. The
   idle timeout is paused while waiting; the total timeout keeps running.
   After `input_timeout_ms` (default 30 min, new `zcode_run` parameter)
   without an answer the runner answers "No answer available, decide
   yourself and continue" and the state returns to `running`.
4. **Usage.** `zcode_result` gains `usage`: `inputTokens`, `outputTokens`,
   `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`,
   `modelRequestCount`, summed over all turns and transient retries.
5. **Redaction.** API keys and tokens are masked in `result.json`
   (output, error message), `output.log` and status error messages.

## Internals

### Inbox (MCP server → runner)

- `zcode_send` validates the job (exists, protocol path, state `running` or
  `needs_input`) and otherwise fails without writing anything.
- It writes `<jobDir>/inbox/<seq>.json` (`{ seq, kind: "send", text,
  createdAt }`) atomically (tmp file + rename). `seq` is zero-padded and
  monotonic per job.
- The runner reads the inbox in its existing 250 ms loop, handles entries in
  `seq` order and writes `<jobDir>/inbox/<seq>.ack.json` (`{ status,
  reason?, at }`). Handled entries are not re-read (the runner tracks the
  last handled `seq`).
- `zcode_send` polls for the ack for up to 5 s.

### Protocol client (`src/appserver.mjs`)

- `interaction/requestUserInput` is no longer answered with `{}`. It is
  parked (protocol id kept) and reported through a new `onUserInput` hook.
  Every other unknown server request is still answered `{}`.
- New methods: `stop(sessionId)`, `steer(sessionId, text)`,
  `answer(requestId, text)`. `runTaskWithModel` exposes them to the runner
  through a `control` callback once the session exists.
- The exact result shape for `requestUserInput` is unknown and must be
  established against a real ZCode before this part ships (see Tests).

### Capability detection

- Each control is tried on first use. A `-32601` (method not found) or a
  protocol validation error marks it unavailable for the rest of the job
  and triggers the fallback: kill instead of stop, `not_supported` receipt
  instead of steer.
- Findings are recorded in `status.capabilities`
  (`{ stop, steer, userInput }`: `true` / `false` / `null` = untried).

### Retries

A steer that has not been delivered when a transient retry starts is
rejected with reason `retry`; it is not silently carried over. A pending
user-input request ends with the failed attempt.

### Usage

Summed from `payload.usage` of every `turn.completed` and `turn.failed`
event, across retries. Missing fields count as 0; no usage at all yields
`usage: null`.

### Redaction (`src/redact.mjs`)

- Key-name matching by normalised suffix (lowercase alphanumerics; suffixes
  such as `apikey`, `token`, `secret`, `password`, `authorization`) so that
  `totalTokens` and `sessionId` survive.
- Value-shape matching for bare strings (`sk-…`, `Bearer …`, long
  high-entropy tokens, `key=…` in URLs).
- Applied when writing result, log lines and status error messages.
  `provider-check.mjs` switches to the shared module.

## Error cases

- `zcode_send` on a CLI job, finished job or unknown id: error, no file.
- Runner dies while `needs_input`: the job is derived as `lost` on read, as
  today.
- Ack timeout: `queued`, see above.

## Tests

- `test/fake-appserver.cjs` learns `session/stop`, steer via `v4/command`,
  emitting `interaction/requestUserInput`, `usage` on turn events, and
  switches that make each method answer `-32601`.
- Unit tests: inbox ordering and acks, fallback to kill, `needs_input`
  timeout (shortened), idle-timeout pause, usage sums across retries,
  redaction (positive and negative cases), `zcode_send` validation.
- Manual check against a real ZCode: `scripts/verify-protocol.mjs` gains
  probes for stop, steer and user input; it settles the user-input answer
  shape and runs on the owner's Mac.

## Out of scope

Approval policy for `requestPermission` (sessions run in `mode: yolo`),
compact/fork, plugin and settings management.

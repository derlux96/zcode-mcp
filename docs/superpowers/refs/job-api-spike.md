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

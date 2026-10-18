# ZCode app-server protocol notes (v3.15.3, spike findings)

Date: 2026-10-16. Binary: `node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server --stdio`
Method: wire probes (scripts in `/tmp/zt/`, logs `p1.out`..`p8.out`) + static reading of the bundle (`zcode.cjs`, dispatcher at ~offset 14958000, schemas at ~offset 820000-850000).
Decisive result: **a `session/send` with `modelSelection` = `new-provider/qwen3.8-max` (reasoningLevel `low`) completed a turn (`turn.completed`, response `"ok"`) while the session default was the dead `new-provider/space-bunny-free`** — BUT only after making qwen3.8-max registry-visible via a patched copy of the personal provider config (see §7). On this machine's stock config qwen3.8-max is `enabled:false` in `~/.zcode/v2/provider_config.json` and the registry rejects it.

## 1. Transport and envelope

Newline-delimited JSON over stdio (one JSON object per line, UTF-8). No JSON-RPC framing, no Content-Length. Three message shapes, discriminated exactly like this (source: `Yoi/Qoi/eii/Xoi` in bundle):

- Client→server request: `{"id":<number|string>,"method":"...","params":{...}}` (request = has `method` AND `id`)
- Client→server response to a server request: `{"id":<same id>,"result":{...}}` or `{"id":<same id>,"error":{"code":N,"message":"..."}}`
- Server→client response: `{"id":<your id>,"result":{...}}` or `{"id":<your id>,"error":{"code":N,"message":"...","data":{...}}}` (error key order on the wire: code, data, message)
- Notification (either direction, no id): `{"method":"...","params":{...}}`

There is **NO initialize/handshake step**. Requests are answered immediately after startup (session/list answered 3ms after send). Startup noise: ~5 `startup/storageState` notifications in the first ~600ms; later `process/resourceSample` every ~60s. Just ignore notifications and match responses by `id`.

## 2. CRITICAL: the server sends requests TO the client — you must answer them

This is the "handshake" that earlier probes were missing. The app-server is a bidirectional protocol; during `session/create` (and again at first `session/send`) it sends:

```
{"id":"server-1","method":"session/requestRuntimePreferences","params":{"sessionId":"sess_...","scope":"runtime-materialization"}}
```

You MUST reply (timeout is 15s, `att=15e3` in bundle; unanswered, `session/create` never returns within that window):

```
{"id":"server-1","result":{"nativeSearchEnhancementsEnabled":false}}
```

Schema of the expected result (strict): `{nativeSearchEnhancementsEnabled: boolean (required), subagentRuntimeConfigEnabled?: boolean, memoryEnabled?: boolean (default false), askUserQuestionAutoResolutionEnabled?: boolean (default true), integratedTerminalShell?: object, modelContextBudgetStrategy?: "legacy"|"preflight-v1" (default "preflight-v1")}`.

A second request with `"scope":"user-execution"` arrives at first send — answer identically. You will also see:

```
{"id":"server-2","method":"interaction/requestOfficialMcpAuthHeaders","params":{"mcpKey":"image_search","pluginId":"image-search@zcode-plugins-official","requestId":"official-mcp-auth:1","targetOrigin":"https://zcode.z.ai","workspace":{...}}}
```

Replying with an error (`{"id":"server-2","error":{"code":-332601,...}}` — any error) is fine and non-fatal; the session keeps working.

## 3. session/create

There is NO top-level `cwd`/`workingDirectory` param. The cwd lives in a nested `workspace` object with BOTH keys required (strict zod: trimmed non-empty strings):

```
{"id":1,"method":"session/create","params":{"workspace":{"workspacePath":"/tmp/zt/ws","workspaceKey":"/tmp/zt/ws"}}}
```

In practice every existing session on this machine has `workspaceKey === workspacePath` (see session/list output), so use the absolute cwd for both. Optional params: `sessionId?`, `parentSessionId?`, `mode?` ("plan"|"build"|"edit"|"yolo"|"guarded"|"auto"), `model?` (see §5), `thoughtLevel?`, `persistence?` ("immediate"|"deferred"), `titleGenerationEnabled?`, `mcpServers?`, `toolAllowlist?`, `toolDenylist?`, `importedHistory?`, `offPeakToolEnabled?`, `dynamicWorkflowEnabled?`, `dynamicWorkflowMode?`.

Success response (id-correlated) — session id is at `result.session.sessionId`; the response also embeds the model catalog at `result.settings.model`:

```
{"id":1,"result":{"messages":[],"projection":{"activeToolCalls":[],"backgroundJobs":[],"contextUsed":0,"contextWindow":200000,"mode":"build","pendingPermissions":[],"sessionId":"unknown","status":"idle","target":null,"totalTokenCount":0,"turnCount":0},"protocol":{"name":"ZCode Protocol","version":1},"runtime":{"eventSeq":0,"pendingRequestIds":[],"goalVerifications":[],"goalVerificationTimeline":[],"stateRevision":0},"session":{"createdAt":1792184652807,"mode":"build","model":{"providerId":"new-provider","modelId":"space-bunny-free"},"traceId":"ebd62caf-...","sessionId":"sess_b67ffaa3-3fcb-4c10-86fc-5630208fda12","sessionKind":"interactive","status":"idle","target":null,"title":"","updatedAt":1792184652807,"workspace":{"workspacePath":"/tmp/zt/ws","workspaceKey":"/tmp/zt/ws"}},"settings":{"mode":{"current":"build"},"model":{"available":[...see §6...],"current":{"providerId":"new-provider","modelId":"space-bunny-free","options":{"reasoningLevel":"xhigh"}},"lastUsed":{"providerId":"new-provider","modelId":"space-bunny-free"}},"permission":{"mode":"build"},"thoughtLevel":{"available":[...],"current":"xhigh","enabled":true}},"slashCommands":[...]}}
```

`session/list` (no params needed) returns `{"id":N,"result":{"sessions":[{"createdAt":...,"mode":"build","sessionId":"sess_...","sessionKind":"interactive","status":"idle","title":"...","titleSource":"first_input","updatedAt":...,"workspace":{...}},...]}}`.

## 4. session/subscribe (do this before send — it gates event delivery)

```
{"id":2,"method":"session/subscribe","params":{"sessionId":"sess_...","deliveryKind":"desktop-continuous"}}
```

Params (strict): `{sessionId: string, deliveryKind: "desktop-continuous"|"web-remote-replayable", afterSeq?: int, includeSnapshot?: bool (default false)}`. Response: `{"id":2,"result":{"eventSeq":0,"events":[],"sessionId":"sess_..."}}`. Setting `legacyStreamSubscribed` is what turns on `session/event` notification streaming to you.

## 5. session/send + modelSelection — the decisive surface

```
{"id":3,"method":"session/send","params":{"sessionId":"sess_...","content":"Reply with exactly: ok","modelSelection":{"providerId":"new-provider","modelId":"qwen3.8-max","options":{"reasoningLevel":"low"}}}}
```

- `modelSelection` (strict zod): `{providerId: string, modelId: string, options?: {reasoningLevel?: string}}` — same shape as create's `model` param. Key is `modelId`, NOT `model`. Optional params also seen in schema: `inputId?`, `queryId?`, `expectedRevision?`, `attachments?`, `toolDenylist?`, `automationId?/offPeakTaskId?` (mutually exclusive), `modelExecution?` (requires modelSelection).
- Send is fire-and-forget. Immediate response: `{"id":3,"result":{"accepted":true,"sessionId":"sess_...","stateRevision":1}}` — acceptance says NOTHING about model validity; bad models fail later as `turn.failed`.
- **`options.reasoningLevel` is REQUIRED at send time whenever the model's spec declares reasoning levels** (this machine's specs all do). Without it: `turn.failed` with `code:"invalid_model_request"`, message `"Reasoning level is required for new-provider/qwen3.8-max"`. Allowed values come from the catalog entry (`reasoning.levels`, e.g. low/medium/xhigh for Opencode GO models, low/xhigh/max for the openrouter one).
- The same shape validates at create time via `params.model` (failure there is a synchronous request error, see §8).

## 6. Event stream to completion

All turn traffic arrives as `session/event` notifications (after subscribe). Envelope:

```
{"method":"session/event","params":{"deliveryKind":"desktop-continuous","eventId":"uuid","payload":{...},"seq":13,"sessionId":"sess_...","timestamp":1792184703455,"traceId":"...","turnId":"turn_...","type":"model.streaming"}}
```

`params.type` (== `payload.kind`) values observed in one tiny turn, in order: several `session.updated` (tool snapshots, title, model selection…), `session.titleUpdated`, `turn.started`, `model.streaming` (repeated), `session.updated`, `turn.completed`. Plus `turn.failed` on error runs.

`turn.started` payload: `{executionStartedAt, turnNumber:0, input:"Reply with exactly: ok", messageId:"msg_...", inputId, foregroundExecutionId, queryId, intent:{...}}`

`model.streaming` payload (deltas; kind `reasoning_delta` seen; text deltas use the same envelope):

```
{"assistantMessageId":"msg_mvbghwdj_...","delta":"The","done":false,"kind":"reasoning_delta"}
```

`turn.completed` payload — `response` is the final assistant text (fastest way to get output):

```
{"response":"ok","tokenCount":32485,"usage":{"source":"provider","modelRequestCount":1,"inputTokens":32467,"outputTokens":18,"totalTokens":32485,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":14,"webFetchRequests":0,"webSearchRequests":0},"toolCallCount":0,"historyRoundCount":1,"duration":12532,"resultType":"success","cacheStats":{"totalMessages":9,"cachedMessages":5,"lastCacheHit":false},"inputId":"2c539837-..."}
```

`turn.failed` payload (model_not_found example):

```
{"error":{"type":"unknown_error","code":"model_not_found","message":"Provider Registry 中不存在 Model: new-provider/qwen3.8-max","detail":"Model creation failed","underlyingErrorMessage":"Provider Registry 中不存在 Model: new-provider/qwen3.8-max","stack":"Error: Model creation failed\n    at ..."},"turnPhase":"model_creation","inputId":"..."}
```

Note: a `computer-use/operation-event` notification with `kind:"turn-failed"` (no error payload) arrives in parallel — ignore that channel for completion logic; use `session/event` `turn.completed`/`turn.failed`.

Timing: turn.started ~230ms after send; qwen3.8-max answered in ~12.5s (duration field), ~4s of which was pre-model runtime (MCP plugins starting: `process/mcpTelemetry` for mimosa/ios-simulator/android-emulator/node_repl).

## 7. Model registry reality on this machine (the gotcha that matters)

The registry only contains models that are `enabled:true` WITH full specs in `~/.zcode/v2/provider_config.json` → `config.modelConfigRules.providerModelRules[]`. Stock state:

- `new-provider/space-bunny-free` — enabled, ctx 1048576, reasoning low/medium/xhigh (this is the DEFAULT and it is DEAD upstream → default-model sends fail)
- `openrouter/stealth/space-bunny-alpha` — enabled, ctx 1000000, reasoning low/xhigh/max
- `new-provider/qwen3.8-max`, `fledge-alpha`, `muse-spark-1.3-contributor-free`, `mimo-v2.6-flash-free` and all other openrouter models — `enabled:false`, NO specs → registry lookup fails: "Provider Registry 中不存在 Model" (code `model_not_found`)

So "qwen3.8-max exists on the Opencode GO API" is NOT sufficient; it must also be enabled+specified in the personal provider config. For the decisive test I made a COPY at `/tmp/zt/provider_config.qwen.json` flipping that one rule to `enabled:true` with specs cloned from space-bunny-free (`properties.contextWindow:1048576`, `inputFormat:{supportsImage:true,supportsVideo:true}`, `supportsJsonSchemaOutput:true`, `optionSpecs.reasoningLevel.values:["low","medium","xhigh"]`, `maxOutputTokens.max:524288`) and ran the server with `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=/tmp/zt/provider_config.qwen.json`. The user's real config was NOT modified.

Env requirements for spawning app-server outside the app:
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (already inherited by shells spawned from ZCode; points into `~/.zcode/v2/runtime/provider/darwin-aarch64/3.15.3/endpoint-.../zcode-builtin.json`)
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (optional; defaults to `~/.zcode/v2/provider_config.json`; set it to a patched copy to enable extra models). If you set ONE of the two env vars you should set BOTH (source `YSr` throws if exactly one is present; the inherited BUILTIN var covers the other).

## 8. Error shapes (verbatim)

Request-level error (create with registry-unknown model):

```
{"error":{"code":-32603,"data":{"name":"ModelProtocolError","stack":"ModelProtocolError: Provider Registry 中不存在 Model: new-provider/qwen3.8-max\n    at createRegistrySelectionProtocolError (...zcode.cjs:14827:2489)\n    at resolveRegistryOwnedModelSelection (...)\n    ...","code":"model_not_found"},"message":"Provider Registry 中不存在 Model: new-provider/qwen3.8-max"},"id":1}
```

Session-scoped errors seen/known: `-32004 "Session is not active: sess_..."` (session/messages or send against a persisted-but-inactive session), `-32010 "A prompt is already running for this session"` (concurrent send), `-32010 "Subagent sessions are read-only"`, `-32031` restore warning, `-32602` zod invalid params. Turn-level failures arrive as `turn.failed` events (§6), not as send-response errors.

## 9. session/messages and session/resume

`session/messages` only works while the session is ACTIVE in this server process:

```
{"id":4,"method":"session/messages","params":{"sessionId":"sess_..."}}  ->  {"error":{"code":-32004,"message":"Session is not active: sess_..."},"id":4}
```

Reactivate a persisted session first (no model call):

```
{"id":1,"method":"session/resume","params":{"sessionId":"sess_d565c105-4f40-4557-a1b0-529acd944a02"}}
```

Response has the same snapshot shape as create (`messages`, `projection`, `session{...}`, `settings{...}`), then `session/messages` succeeds. Messages response: `{"messages":[{info:{...},parts:[...]},...]}`.

- User message: `info.role="user"`, `info.semantics={origin:"real_user",kind:"user_prompt",...}`; parts: `[{type:"text","text":"Reply with exactly: ok","time":{start,end},id,sessionID,messageID}]`
- Synthetic injections: `info.role="user"`, `semantics.origin="agent_runtime"`, `kind:"system_reminder"` (e.g. agent listings) — filter these out when displaying history.
- Assistant message: `info.role="assistant"`, `semantics={origin:"agent_runtime",kind:"assistant_response"}`, `info.modelId:"qwen3.8-max"`, `info.providerId:"new-provider"`, `info.tokens/cost/finish`; parts sequence: `step-start`, `reasoning` (thinking text), **`text` (the answer)**, `step-finish`. For the decisive turn the text part was exactly `{"type":"text","text":"ok",...}`.

## 10. Model catalog (no dedicated method needed)

No `model/list` method exists; the catalog rides on `session/create` / `session/resume` responses (and `state.updated` notifications) at `result.settings.model.available`:

```
{"ref":{"providerId":"new-provider","modelId":"space-bunny-free"},"label":"space-bunny-free","providerLabel":"Opencode GO","contextWindow":1048576,"maxOutputTokens":524288,"reasoning":{"levels":[{"value":"low","label":"low"},{"value":"medium","label":"medium"},{"value":"xhigh","label":"xhigh"}],"defaultLevel":"xhigh"},"properties":{"inputFormat":{"supportsText":true,"supportsImage":true,"supportsVideo":true,"supportsAudio":false,"supportsPdf":false},"outputFormat":{"supportsText":true}}}
```

`session/subscribe` with `includeSnapshot:true` also returns it. `/model` as send content is a LOCAL slash command (no LLM call) that returns the catalog as text — workable fallback.

## 11. Minimal implementation recipe for the MCP wrapper

1. Spawn `node <app>/Resources/glm/zcode.cjs app-server --stdio` with env: inherit `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`; optionally set `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` to a config copy where the target model is `enabled:true` with specs (see §7). Use node (v26 works).
2. Read lines; dispatch by shape: `method`+`id` from server → answer it (`session/requestRuntimePreferences` → `{"id":theirId,"result":{"nativeSearchEnhancementsEnabled":false}}`; anything else → error reply is safe). `method` only → notification; buffer `session/event` by seq. `id` only → resolve your pending call.
3. `session/create` with `params.workspace = {workspacePath: <abs cwd>, workspaceKey: <same>}`. Answer the prefs request when it arrives (create blocks up to 15s otherwise). Take `result.session.sessionId`; read the catalog from `result.settings.model.available`; pick model + a `reasoningLevel` from `reasoning.levels`.
4. `session/subscribe` `{sessionId, deliveryKind:"desktop-continuous"}` (required to receive events).
5. `session/send` `{sessionId, content, modelSelection:{providerId, modelId, options:{reasoningLevel}}}` — ALWAYS include reasoningLevel (catalog-driven). Treat the `{accepted:true,...}` response as ACK only.
6. Consume `session/event` notifications until `turn.completed` (answer at `payload.response`, usage at `payload.usage`) or `turn.failed` (error at `payload.error.code/message`). Ignore `computer-use/operation-event`, `v4/telemetry/event`, `process/*`, `state.updated` unless you want progress.
7. For fuller transcript: `session/messages` `{sessionId}` while active; filter `info.role==="assistant"` parts `type==="text"`. For an older session: `session/resume` `{sessionId}` first.
8. Return `sessionId` to the caller for `--resume`-style continuation; re-resume in a fresh server process and send again.

Gotchas summary: bidirectional requests (answer within 15s); no handshake but heavy startup notifications; `workspace{workspacePath,workspaceKey}` not `cwd`; send is ACK-only (real result is an event); reasoningLevel mandatory; registry membership = enabled+specs in personal provider config, not API reality; dead default model (`space-bunny-free`) means model override is REQUIRED, not optional; `~32k` input tokens of system-prompt overhead per tiny turn (quota math); MCP plugins spin up per session (adds a few seconds and child processes).

## 12. Not determined / open

- Exact behavior when `session/requestRuntimePreferences` times out after 15s (create presumably errors; we always answered — did not spend a probe on the timeout path).
- Whether text deltas use `kind:"text_delta"` exactly (only `reasoning_delta` observed; text arrived in one `session.updated` content event for this tiny reply).
- `session/setModel`, `session/setThoughtLevel`, `session/fork`, `session/stop`, `modelExecution`, attachments, permission-request flow (`_F` decision schema exists in bundle) — schemas located in the bundle but not exercised.
- Whether `workspaceKey` must equal `workspacePath` in all cases (all observed sessions had them equal; schema allows them to differ).
- Whether the desktop app uses extra methods (`workspace/*`, `plugins/*`, `automation/*`, conversation gateway `Sg.*` family) relevant to a delegation MCP — out of scope.

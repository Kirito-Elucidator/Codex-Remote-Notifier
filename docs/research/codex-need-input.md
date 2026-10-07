# Codex Need-Input Notifications

Investigated 2026-10-07. Research only; no production changes or deployment.

## Official OpenAI Documentation

- Async questions are a supported user-facing concept: the changelog records TUI question notifications (#46574), cleanup when turns end (#47424), and answering live questions while Codex keeps working. It also records Shift-arrow hints for queued messages/questions (#47618). This supports a distinction between an outstanding question and a blocked task. [ChatGPT & Codex changelog](https://learn.chatgpt.com/docs/changelog)
- The user's "Shift + left" plausibly means Shift+Left Arrow, not Shift+mouse click. That is an inference: the changelog does not specify which arrow opens questions. Shift-click is separately documented for transcript selection. [ChatGPT & Codex changelog](https://learn.chatgpt.com/docs/changelog)
- App-server documents `item/tool/requestUserInput` and `serverRequest/resolved`: resolution follows an answer or cleanup at turn start/completion/interruption. Its prose still describes `autoResolutionMs`. [Request lifecycle](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput)
- `item/completed` is authoritative for a completed item. The prose's `agentMessage` summary lists `id`, `text`, and `phase`, not the newer async-question fields. Version-specific schemas can be generated from the installed binary. [Items](https://learn.chatgpt.com/docs/app-server#items), [Message schema](https://learn.chatgpt.com/docs/app-server#message-schema)
- Desktop question alerts have separate controls; CLI/IDE external `notify` is described for turn completion, not as a universal question callback. [Notifications](https://learn.chatgpt.com/docs/notifications)
- The documented hook event list has no generic `Notification`/need-input event. Transcript format is explicitly unstable, so transcript scraping is not a durable replacement. [Hooks](https://learn.chatgpt.com/docs/hooks)

## Installed Codex Schema Evidence

The installed Codex 0.160.0 binary generated experimental TypeScript schemas offline. This is local primary evidence, not a claim that the web documentation publishes these fields or that all deployed versions share them. The temporary schema directory may later be removed; regenerate using the actual installed executable, not a notifier PATH shim:

```powershell
& '<installed-codex.exe>' app-server generate-ts --experimental --out '<temporary-schema-directory>'
```

- `agentMessage` has `delivery: AgentMessageDelivery | null` and `questions: AsyncUserInputQuestion[] | null`. [ThreadItem.ts](C:/Users/zyc/AppData/Local/Temp/remote-notifier-need-input-schema-1791353241872/v2/ThreadItem.ts:34)
- `AgentMessageDelivery` is `"async"`; each async question has `title` and nullable `options`. [AgentMessageDelivery.ts](C:/Users/zyc/AppData/Local/Temp/remote-notifier-need-input-schema-1791353241872/v2/AgentMessageDelivery.ts:5), [AsyncUserInputQuestion.ts](C:/Users/zyc/AppData/Local/Temp/remote-notifier-need-input-schema-1791353241872/v2/AsyncUserInputQuestion.ts:5)
- The separate tool-request params contain `isBlocking`; the generated comment deprecates `autoResolutionMs` in favor of `isBlocking`. [ToolRequestUserInputParams.ts](C:/Users/zyc/AppData/Local/Temp/remote-notifier-need-input-schema-1791353241872/v2/ToolRequestUserInputParams.ts:9)

These establish two distinct representations. An async agent-message question is an item, not itself a JSON-RPC request with a request ID. The documented request-resolution lifecycle therefore should not be assumed to apply to it.

## Current Notifier Coverage

- Capture already recognizes `item/completed` + `agentMessage` + `delivery: "async"` + nonempty `questions`, requires the active root thread/turn, and emits internal `agent/queuedQuestions` with the item ID. It does not forward question text. [CodexProtocolCapture.ts](E:/Programming/Scientic-Research/remote-notifier/packages/router/src/codex/CodexProtocolCapture.ts:194)
- The handler already displays `Codex has a question for you`, deduplicating by instance/thread/turn/item and remembering delivery only after success. [CodexEventHandler.ts](E:/Programming/Scientic-Research/remote-notifier/packages/router/src/codex/CodexEventHandler.ts:130)
- Unit tests cover one alert, privacy, rejected ordinary/unfinished messages, retries, and distinct question items. [CodexEventHandler.test.ts](E:/Programming/Scientic-Research/remote-notifier/packages/router/test/unit/CodexEventHandler.test.ts:156)
- A sidecar integration test forwards async questions despite unavailable exact qualification, using a synthetic 0.154 event. This proves forwarding logic, not that a real 0.154 launch emits that event. Its simplified question object differs from the generated 0.160 schema, but production capture only checks array presence/count. [codex-sidecar.test.ts](E:/Programming/Scientic-Research/remote-notifier/packages/router/test/integration/codex-sidecar.test.ts:128)
- Local VS Code settings disable protocol monitoring. `codex-b` sets its separate `CODEX_HOME` and uses a VPN wrapper with an absolute Codex executable, bypassing a PATH-based notifier shim. These are observed launch/configuration facts, not proof of the user's historical missed event. [settings.json](C:/Users/zyc/AppData/Roaming/Code/User/settings.json:30), [codex-b.cmd](E:/AppData/Local/bin/codex-b.cmd:3), [launcher invocation](E:/AppData/Local/bin/codex-b.cmd:7)

## Judgment And Remaining Verification

Treat async questions as "answer requested", not task completion and not necessarily "execution blocked". Detect structured protocol fields, independent of Plan Mode; do not guess from question marks, natural-language messages, screen text, or the keyboard gesture. Keep the blocking tool-request path distinct and version-aware.

The code already implements the async alert path. Before changing that code, verify that each actual `codex`, `codex-b`, and remote launcher traverses the monitored transport and that protocol monitoring is enabled. Preserve account, `CODEX_HOME`, VPN, and launcher semantics when repairing activation. Capture one real non-Plan question per launcher, including item ID/thread ID/turn ID and lifecycle, without storing question text. Existing synthetic tests do not prove launch-path activation, real notification clicks, or a stable async-answer-resolution event across versions.

# Claude request pipeline

Read for Claude transport, request assembly, routing, canary or notice work.
Inputs by concern (load only the relevant row):

| Concern | Source | Tests in `test/` |
| --- | --- | --- |
| Composition/HTTP | `src/index.ts`, `src/app.ts`, `src/middleware/proxy.ts`, `src/middleware/health.ts` | `proxy.test.ts`, `serverLifecycle.test.ts` |
| Assembly/thinking/notices | `src/services/messagePreparer.ts`, `src/services/noticeMemory.ts`, `src/services/turn.ts` | `messagePreparer.test.ts`, `noticeMemory.test.ts`, `proxy.test.ts` |
| Routing | `src/services/modelRouter.ts`, `src/services/conversation.ts`, `src/services/savedChoice.ts` | `modelRouter.test.ts`, `conversation.test.ts`, `savedChoice.test.ts`, `proxy.test.ts` |
| Canary/commands | `src/services/canary.ts`, `src/services/turn.ts`, `commands/` | `canary.test.ts`, `turn.test.ts`, `slashCommands.test.ts`, `proxy.test.ts` |

`createApp` exposes local `/health`, parses JSON, and forwards `/v1/*`.
Only POST `/v1/messages` with a messages array enters `MessagePreparer`.
Canary runs first; prune and route run concurrently on the original request.
Then pruning metrics, replayed notices, model override and thinking binding
prepare the send. Do not serialize pruning and routing or route a pruned input.

Preserve unchanged request identity: `body === request` suppresses edit-only
thinking controls. Changed requests add binding controls only for `enabled`
or `adaptive` thinking. `NoticeMemory` replays notices at their original turn;
changing notice placement can invalidate preserved thinking/history.

Routing changes only at user boundaries, uses session/agent conversation keys,
and bypasses side requests and explicit non-default models. Compaction retains
thread routing. Ask mode needs main-thread notices. Fallback cancels the rejected
body, retries on the original model, and confirms refusal only after success.
A successful retry after 400 disables that conversation; 403/404 or nonretryable
429 disables routing across conversations. Canary misses are advisory, not a
measured quality score. Saved choices update memory only after persistence succeeds.

HTTP responses stream through pipelines; pre-header fetch failures return 502,
post-header failures destroy the response. Express JSON parsing is not a raw-byte
pass-through guarantee. Shared header edits also require [Codex](codex.md).
Output: preserve wire/status behavior and run the row's suites using [Testing](testing.md).
For pruning use [Pruning](pruning.md); for stream taps use [Observability](observability.md).

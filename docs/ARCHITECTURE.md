# Architecture

## Scope

`claude-code-jev-prune` is a local HTTP proxy for Anthropic-compatible `/v1/*` requests. It prunes eligible tool context from `POST /v1/messages`; all other routes pass through without pruning.

## Request Flow

```text
Claude Code
  │
  │ Anthropic request + Anthropic auth headers
  ▼
Express application
  ├── GET /health ───────────────► local status response
  └── /v1/*
       ├── POST /v1/messages
       │    ├── estimate tokens
       │    ├── extract safe candidates
       │    ├── apply protection policy
       │    ├── score candidates with Jev
       │    └── remove selected pairs
       └── forward to ANTHROPIC_UPSTREAM_URL
                    │
                    ▼
              Anthropic response
                    │
                    ▼
          streamed to Claude Code
```

## Component Ownership

| Component | Responsibility |
| --- | --- |
| `src/config.ts` | Parse and validate every environment variable. |
| `src/services/jevService.ts` | Build TypeSafe requests, batch questions, enforce timeout, and validate answers. |
| `src/services/contextPruner.ts` | Find safe pairs, apply policy, cache drops, and immutably filter requests. |
| `src/middleware/proxy.ts` | Forward headers/body, track statistics, and stream upstream responses. |
| `src/middleware/health.ts` | Report process-local readiness and counters without external calls. |
| `src/utils/logger.ts` | Write redacted structured events to console and disk. |
| `src/index.ts` | Compose dependencies, listen locally, and shut down gracefully. |
| `jev-prune` | Install, build, and run setup when needed, then launch. |
| `src/setup.ts` | Save the TypeSafe key and canary choice; install slash commands. |
| `src/launch.ts` | Start or reuse the shared proxy, then run `claude` through it. |
| `src/sessions.ts` | Count launchers so the last one to exit stops the proxy. |
| `src/proxyHealth.ts` | Read a running proxy's `/health` for the launcher and CLI tools. |
| `src/stats.ts`, `src/logSummary.ts` | Report prune totals from the log and the running proxy. |
| `src/doctor.ts` | Check the install and explain how to fix each problem. |

## Candidate Pairing Invariants

A tool call is eligible only when all of these statements are true:

1. An assistant array-content block has `type: "tool_use"`, a string `id`, a string `name`, and an `input` property.
2. A user array-content block has `type: "tool_result"` and a matching string `tool_use_id`.
3. The tool-use ID appears exactly once among valid assistant tool-use blocks.
4. The result ID appears exactly once among valid user tool-result blocks.

The blocks do not need to be in adjacent messages. Candidates are ordered by the assistant block's location. Duplicate, unmatched, and malformed blocks remain untouched.

When a candidate is dropped, the exact tool-use block and matching result block are removed. Any array-content message made empty by that removal is also removed. Surrounding blocks, message properties, top-level request properties, and system content are preserved.

## Protection and Scoring Policy

The proxy applies protection before any content is sent to TypeSafe:

- The newest `JEV_PRUNE_KEEP_RECENT` pairs are protected.
- Tools named by `JEV_PRUNE_EXCLUDE_TOOLS` are protected.
- Results that contain `tool_reference` blocks (tool search) are protected, because removing them would unload deferred tool definitions.
- Previously cached drops are not scored again.
- Previously kept candidates are scored again when the latest user goal changes, or after configured context growth.

The current goal is the newest nonempty user text that is not a tool result. If none exists, the proxy uses the neutral fallback `Complete the current task.`

Each TypeSafe request uses this shape:

```json
{
  "model": "jev-latest",
  "state": {
    "current_goal": "Fix JWT validation",
    "candidates": [
      {
        "key": "candidate_0",
        "tool_use_id": "call_123",
        "tool_name": "read_file",
        "input": { "path": "src/auth.ts" },
        "result": "tool output"
      }
    ]
  },
  "questions": {
    "candidate_0": {
      "type": "noul",
      "instructions": "Is candidates[0] still needed to complete current_goal?",
      "criteria": {
        "true": "The current task depends on this tool input or result.",
        "false": "The tool call is stale, superseded, exploratory, or unrelated to the current task."
      }
    }
  }
}
```

A response answer must be `{ "type": "noul", "noul": number }`, with the number between zero and one. Batches contain at most 32 questions.

## Thresholds

The estimate is:

```text
ceil(JSON.stringify(request).length / 4)
```

| Estimated size | Behavior |
| --- | --- |
| Below `JEV_PRUNE_THRESHOLD` after earlier drops | Forward without TypeSafe. |
| Mid-task (last message is a `tool_result`) | Re-apply earlier drops only; no scoring. |
| At/above normal threshold | Drop relevance scores below `0.50`. |
| At/above `JEV_PRUNE_TRIGGER_TOKENS` | Drop relevance scores below `0.70`. |

The second threshold is an aggressive policy switch, not a hard output-size guarantee. Scoring only runs on a new user turn. When a prune leaves the request above `JEV_PRUNE_TARGET_TOKENS`, the proxy warns and suggests a handoff.

## Failure Model

| Failure | Behavior |
| --- | --- |
| TypeSafe timeout or network error | Forward original request. |
| TypeSafe non-2xx response | Forward original request. |
| Invalid TypeSafe JSON or answer shape | Forward original request. |
| Missing candidate answer | Forward original request. |
| Unsupported or malformed Anthropic message body | Forward unchanged. |
| Anthropic connection failure before headers | Return local HTTP 502. |
| Anthropic non-2xx response | Relay status, safe headers, and body. |
| Streaming error after response headers | Terminate the downstream response. |

A Jev error invalidates the entire prune attempt. The proxy never applies a partial set of scores from successful batches.

## Header and Credential Boundaries

The proxy removes hop-by-hop request headers, stale body-length/encoding headers, `typesafe-api-key`, and `x-typesafe-api-key` before contacting Anthropic. It preserves Claude Code's Anthropic authentication and version headers.

The Jev client constructs its own request containing only:

- `Authorization: Bearer <TYPESAFE_API_KEY>`
- `Content-Type: application/json`
- The scoring payload described above

Anthropic request headers are not reused for TypeSafe calls.

## Response Streaming

The proxy waits only for Anthropic's response headers. It copies the upstream status and non-hop-by-hop headers, converts the web response body to a Node readable stream, and pipelines it to the downstream response. It does not buffer a full server-sent event response.

Because native `fetch` may decompress an upstream response, stale `content-encoding` and `content-length` headers are removed before relay.

## Observability

Logs are written to stderr and `~/.claude/jev-prune.log`. Normal pruning events contain estimated before/after sizes, evaluated and dropped counts, duration, and safe error messages. Debug decision events add tool name, tool-use ID, relevance, cutoff, and outcome. Payload content and credentials are never logged.

`GET /health` reports configuration presence, enabled state, counters, and uptime. It deliberately does not call TypeSafe or Anthropic.

## Verification Strategy

- Configuration tests cover defaults and invalid environment values.
- Jev client tests capture real emitted request bodies and validate response/error handling.
- Pruner tests cover structural invariants, immutability, cutoffs, caching, and fail-open behavior.
- Proxy tests use local HTTP upstreams for headers, bodies, errors, pass-through routes, and server-sent events.
- Logger tests write to a temporary path.
- A subprocess test starts the compiled server, checks health, sends SIGTERM, and requires exit code zero.
- The optional live Jev check uses synthetic content and is excluded from the default suite.

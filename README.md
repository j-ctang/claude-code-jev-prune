# claude-code-jev-prune

A local HTTP proxy that removes stale Claude tool-call context without summarizing retained messages.

Claude Code sends Anthropic Messages API requests to this proxy. Once a request reaches a configurable estimated-token threshold, the proxy asks TypeSafe Jev whether older, matched tool calls are still relevant to the latest user goal. Low-relevance `tool_use` and `tool_result` blocks are removed as pairs, and the cleaned request is forwarded to Anthropic.

## Status

The proxy, pruning engine, TypeSafe client, health endpoint, logging, streaming transport, and automated tests are implemented. The default test suite uses local fakes and does not require API keys. A live Jev validation with a user-supplied key remains an explicit pre-release step.

This project is an HTTP proxy, not an MCP server or MCP plugin.

## Safety Properties

- Only uniquely matched assistant `tool_use` and user `tool_result` blocks are eligible for removal.
- Both halves of an eligible tool pair are removed together.
- System content, ordinary user/assistant text, unmatched tools, duplicate IDs, malformed blocks, recent tools, and excluded tools are preserved.
- Retained JSON values are not rewritten or summarized. JSON whitespace and object-key ordering may change when the request is serialized.
- TypeSafe timeouts, HTTP errors, malformed answers, and missing scores fail open: Anthropic receives the original request.
- Anthropic response statuses and server-sent event streams are relayed to Claude Code.

## Requirements

- Node.js 20 or newer
- A TypeSafe API key when pruning is enabled
- Whatever Anthropic authentication Claude Code normally sends

## Installation

```bash
git clone https://github.com/j-ctang/claude-code-jev-prune
cd claude-code-jev-prune
npm install
cp .env.example .env
```

Edit `.env` and set your TypeSafe key:

```dotenv
TYPESAFE_API_KEY=tsf_replace_with_your_key
JEV_PRUNE_ENABLED=true
PORT=5590
```

Build and start the proxy:

```bash
npm run build
npm start
```

In a separate terminal, point Claude Code at the local proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5590
claude
```

The proxy forwards requests to `https://api.anthropic.com` by default. Its upstream setting is deliberately named `ANTHROPIC_UPSTREAM_URL`, so it cannot be confused with the `ANTHROPIC_BASE_URL` that Claude Code uses to reach the proxy.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for pairing invariants, failure handling, and transport details.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | Required when pruning is enabled. Sent only to TypeSafe. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | TypeSafe API origin. |
| `JEV_MODEL` | `jev-latest` | Model name sent to `/v1/systemone`. |
| `JEV_PRUNE_ENABLED` | `true` | Enables relevance scoring and pruning. |
| `JEV_PRUNE_THRESHOLD` | `120000` | Estimated tokens at which pruning runs on the next new user turn. |
| `JEV_PRUNE_TRIGGER_TOKENS` | `140000` | Estimated tokens at which the aggressive cutoff is used. |
| `JEV_PRUNE_TARGET_TOKENS` | `80000` | Size a prune aims for. Above it, the proxy warns and suggests a handoff. |
| `JEV_PRUNE_NOTIFY` | `true` | Appends a one-line pruning notice to the new user turn so Claude can tell the user. |
| `JEV_PRUNE_KEEP_RECENT` | `5` | Number of newest matched tool pairs never evaluated or removed. |
| `JEV_PRUNE_EXCLUDE_TOOLS` | empty | Comma-separated tool names never evaluated or removed. |
| `JEV_TIMEOUT_MS` | `2000` | Timeout for each TypeSafe batch. |
| `JEV_PRUNE_DEBUG` | `false` | Logs safe per-decision metadata: tool name/ID, score, cutoff, and outcome. |
| `ANTHROPIC_UPSTREAM_URL` | `https://api.anthropic.com` | Anthropic-compatible upstream used by the proxy. |
| `PORT` | `5590` | Local listening port. |

All integer and boolean values are validated at startup. The aggressive threshold must be greater than or equal to the normal threshold, and the target must be less than or equal to it.

## Decision Policy

The proxy estimates tokens as `ceil(JSON.stringify(request).length / 4)`. This is a deterministic trigger heuristic, not Anthropic's billing-token count.

- Earlier drop decisions are re-applied to every request, so the pruned prefix stays identical and keeps its prompt-cache discount.
- Below `JEV_PRUNE_THRESHOLD` (after earlier drops): forward without contacting TypeSafe.
- Mid-task requests (the last message is a `tool_result`) are never scored. Pruning waits for the next new user turn so it never cuts context the agent is using.
- On a new user turn at or above `JEV_PRUNE_THRESHOLD`: drop eligible pairs with relevance below `0.50`.
- At or above `JEV_PRUNE_TRIGGER_TOKENS`: drop eligible pairs with relevance below `0.70`.
- After a prune, the proxy logs `prune_complete`. If the result is still above `JEV_PRUNE_TARGET_TOKENS`, it also logs `prune_above_target`, and the notice suggests writing a handoff file for a fresh session.

The proxy will not delete protected content merely to hit the target.

Jev requests contain no more than 32 named `noul` questions per batch. Drop decisions are cached by a fingerprint of the tool-use ID, name, input, and result. Kept candidates are evaluated again at the next prune because the task goal may change.

Each `/v1/messages` response is logged as `anthropic_usage` with Anthropic's real `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`.

## Manual Pruning

Run `/jev-prune` in Claude Code to prune immediately, even below `JEV_PRUNE_THRESHOLD`. Install the command once:

```bash
mkdir -p ~/.claude/commands
cp commands/jev-prune.md ~/.claude/commands/
```

The proxy recognizes the command in the request itself, prunes that turn, and attaches a notice that Claude reports back. If nothing is eligible (the newest `JEV_PRUNE_KEEP_RECENT` pairs are always kept), the notice says so.

Scripts can queue the same thing for a session's next user turn:

```bash
curl -X POST http://127.0.0.1:5590/jev-prune/prune-next \
  -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$CLAUDE_CODE_SESSION_ID\"}"
```

The session is matched against Claude Code's `x-claude-code-session-id` request header. Queued requests expire after ten minutes.

## Privacy Boundary

When pruning activates, the following data is sent to TypeSafe:

- The latest non-tool user text used as the current goal
- Each eligible tool name and tool-use ID
- Each eligible tool input
- Each eligible tool result

The TypeSafe API key is never forwarded to Anthropic. Anthropic credentials and request headers are never sent to TypeSafe. Proxy logs do not contain authorization headers, full prompts, tool inputs, tool results, or upstream response bodies.

Review TypeSafe's privacy and retention terms before using pruning on sensitive conversations. Jev returns a constrained numeric answer, but that answer can still be wrong.

## Health and Logs

```bash
curl --fail --silent http://127.0.0.1:5590/health
tail -f ~/.claude/jev-prune.log
```

Example health response:

```json
{
  "status": "ok",
  "proxy_version": "1.0.0",
  "jev_configured": true,
  "pruning_enabled": true,
  "requests": 3,
  "pruning_decisions": 8,
  "dropped_pairs": 2,
  "fail_open_events": 0,
  "uptime_seconds": 42
}
```

`jev_configured` means a key is present. Health checks do not call TypeSafe, spend API credits, or claim that the external service is reachable.

## Troubleshooting

If startup reports that `TYPESAFE_API_KEY` is required, add the key to `.env` or run in pass-through mode:

```bash
JEV_PRUNE_ENABLED=false npm start
```

If Claude Code reports connection refused, verify the proxy and client-side URL:

```bash
curl --fail http://127.0.0.1:5590/health
echo "$ANTHROPIC_BASE_URL"
```

If requests loop back to the proxy, check `ANTHROPIC_UPSTREAM_URL`. It should normally be unset or `https://api.anthropic.com`; it must not be the local proxy URL.

If no pruning occurs, check the health response, thresholds, recent-pair count, and excluded-tool list. Short conversations and conversations containing only protected or unmatched tools have no eligible candidates.

Claude Code's built-in compaction remains separate and may still run after proxy pruning. If TypeSafe is unavailable, the proxy records `prune_fail_open` and forwards the original request.

## Development

```bash
npm run dev
npm test
npm run lint
npm run build
npm run check
```

Tests cover configuration, token estimation, the TypeSafe wire contract, pair-safe pruning, caching, fail-open behavior, upstream forwarding, error relay, server-sent events, file logging, startup, and graceful shutdown.

## Limitations

- Token counts are estimates.
- Relevance pruning can discard context that later becomes useful.
- Request JSON is parsed and reserialized, so byte-identical HTTP payloads are not promised.
- Drop caching is process-local and resets when the proxy restarts.
- Built-in Claude Code compaction remains independent and may still run.
- Published savings, latency, and quality numbers require workload-specific benchmarks and are not asserted by this repository.

## License

MIT

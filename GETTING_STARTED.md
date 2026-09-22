# Getting Started

This guide starts the local proxy, verifies its health, and points Claude Code at it.

## 1. Prerequisites

Confirm Node.js 20 or newer is installed:

```bash
node --version
```

Obtain a TypeSafe API key for live pruning. You can run and health-check the proxy without a key by setting `JEV_PRUNE_ENABLED=false`.

## 2. Install

```bash
git clone https://github.com/j-ctang/claude-code-jev-prune
cd claude-code-jev-prune
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
TYPESAFE_API_KEY=tsf_replace_with_your_key
TYPESAFE_BASE_URL=https://api.typesafe.ai
JEV_MODEL=jev-latest
JEV_PRUNE_ENABLED=true
JEV_PRUNE_THRESHOLD=100000
JEV_PRUNE_TRIGGER_TOKENS=150000
JEV_PRUNE_KEEP_RECENT=5
JEV_PRUNE_EXCLUDE_TOOLS=
JEV_TIMEOUT_MS=2000
JEV_PRUNE_DEBUG=false
ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
PORT=5590
```

Do not put Anthropic credentials in this file solely for the proxy. It forwards the authentication headers Claude Code sends.

## 3. Verify the Repository

```bash
npm run check
```

This runs linting, the complete Jest suite, and the strict TypeScript build. Default tests use local fakes and do not call Anthropic or TypeSafe.

## 4. Start the Proxy

```bash
npm start
```

Expected console event:

```text
info: proxy_listening {"port":5590,"pruningEnabled":true}
```

For a pass-through-only smoke test without a TypeSafe key:

```bash
JEV_PRUNE_ENABLED=false npm start
```

## 5. Check Health

In another terminal:

```bash
curl --fail --silent http://127.0.0.1:5590/health
```

The response should contain `"status":"ok"`. The field `jev_configured` reports whether a TypeSafe key was loaded; it does not make a network request to TypeSafe.

## 6. Point Claude Code at the Proxy

In the terminal where you will run Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5590
claude
```

These two settings serve different processes:

```text
Claude Code: ANTHROPIC_BASE_URL=http://127.0.0.1:5590
Proxy:       ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
```

The distinct names prevent a forwarding loop.

## 7. Observe Pruning

The default threshold is intentionally high. For a synthetic local check, lower it temporarily and avoid real repository or conversation content:

```bash
JEV_PRUNE_THRESHOLD=1 \
JEV_PRUNE_TRIGGER_TOKENS=1000000 \
JEV_PRUNE_KEEP_RECENT=0 \
JEV_PRUNE_DEBUG=true \
npm start
```

Watch safe logs:

```bash
tail -f ~/.claude/jev-prune.log
```

Debug entries include tool name, tool-use ID, numeric relevance, cutoff, and keep/drop outcome. They do not include tool inputs or results.

## How a Request Is Handled

1. The proxy estimates the request size.
2. Requests below the threshold are forwarded unchanged.
3. The proxy finds unique, matched `tool_use`/`tool_result` pairs.
4. Recent and excluded tool pairs are removed from consideration.
5. Remaining candidates are sent to TypeSafe in batches of at most 32.
6. Pairs below the active relevance cutoff are removed together.
7. The request is forwarded to Anthropic.
8. Anthropic's status, headers, body, or event stream is relayed to Claude Code.

If TypeSafe fails at any point, step 6 is skipped and the original request is forwarded.

## Troubleshooting

### `TYPESAFE_API_KEY is required when pruning is enabled`

Add the key to `.env`, or start in pass-through mode:

```bash
JEV_PRUNE_ENABLED=false npm start
```

### Claude Code reports connection refused

Confirm the proxy is running and the client-side URL is correct:

```bash
curl --fail http://127.0.0.1:5590/health
echo "$ANTHROPIC_BASE_URL"
```

### Requests loop or repeatedly hit the local proxy

Check the proxy's upstream setting:

```bash
echo "$ANTHROPIC_UPSTREAM_URL"
```

It should normally be empty, which uses the default, or `https://api.anthropic.com`. It must not be the proxy's own local URL.

### No pruning occurs

Check the health response, threshold, recent-pair count, and excluded-tool list. A short conversation may be below the threshold, and a conversation containing only recent or unmatched tool calls has no eligible candidates.

### Claude Code still compacts context

This proxy does not disable Claude Code's built-in compaction. Pruning reduces eligible tool context before the request reaches Anthropic; native compaction remains a separate behavior.

### TypeSafe is unavailable

The proxy records a `prune_fail_open` event and forwards the original request. Check connectivity and the TypeSafe key without placing either key or payload content in an issue report.

## More Detail

Read [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for pairing invariants, cutoffs, transport behavior, and failure handling.

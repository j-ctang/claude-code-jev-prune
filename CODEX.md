# Codex CLI (experimental)

Jev Prune can proxy Codex CLI's HTTP Responses requests and replace old,
low-relevance tool outputs. Your local conversation history stays intact.
This integration has offline fixture evidence with codex-cli 0.166.0; live
OpenAI authentication and TypeSafe pruning quality still need testing.

## Run

Install Node.js 20+ and Codex CLI, then sign in with Codex normally. From this
checkout:

```sh
npm ci
npm run build
TYPESAFE_API_KEY=your_key node dist/codexLaunch.js --model your_model
```

For a transport-only smoke test without a TypeSafe key:

```sh
JEV_PRUNE_ENABLED=false node dist/codexLaunch.js exec 'Reply hello'
```

Disabled mode does not prune or contact TypeSafe, and proves only transport.
The launcher reads `.env` in the current directory. Shared configuration validation
also checks Claude-only settings; invalid values can prevent Codex startup.
It does not run the Claude setup wizard. Pass Codex arguments directly, including `exec`, `resume`, `-C`,
and `--model`. The existing `jev-prune` command still launches Claude Code.

The default upstream is `https://chatgpt.com/backend-api/codex`. If your Codex
login uses an API key, explicitly set `JEV_CODEX_UPSTREAM_URL=https://api.openai.com/v1`.
Existing Codex credentials travel through the local proxy to that upstream;
the launcher does not read or edit credential/configuration files. HTTPS
upstreams and loopback HTTP fixtures are accepted. Only configure an upstream
you trust with those credentials.

## Scope and controls

Each invocation owns a loopback proxy on an automatically allocated port. The
launcher selects its `jev_prune` provider for that invocation and forces HTTP.
Provider/configuration overrides (`-c`, `--config`, `-p`, `--profile`, `--oss`,
`--local-provider`) are rejected so they cannot bypass interception. The
`jev_prune` provider name is reserved for this launcher.

The existing `JEV_PRUNE_THRESHOLD`, `JEV_PRUNE_TRIGGER_TOKENS`,
`JEV_PRUNE_KEEP_RECENT`, `JEV_PRUNE_EXCLUDE_TOOLS`, `JEV_MODEL`,
`JEV_TIMEOUT_MS`, and `TYPESAFE_BASE_URL` settings apply. Token counts are
estimates. Decisions persist separately from Claude under
`~/.local/state/jev-prune/codex-state.json`; override with `JEV_CODEX_STATE_PATH`.

Only old string or text-only array outputs with unique matching function or
custom tool calls are eligible. New scoring happens at a user-message boundary;
saved drops replay during tool execution and across launcher restarts. Recent
outputs, call arguments, reasoning, instructions, tool definitions, images and
unknown items are retained. Tool outputs and the latest user goal are sent to
TypeSafe for relevance scoring. Eligible kept candidates are rescored whenever
a new user turn passes the scoring gates; scoring adds latency and usage.

Scorer failures retain unscored output. Unsupported server-state requests
(`previous_response_id` or `conversation`), compressed requests, malformed JSON,
and unsafe integer metadata pass through. Disabling pruning preserves the
original request, including previously dropped outputs. No hard context-size
target is guaranteed.

Claude slash commands, canaries, skill shadowing, model routing, automatic
trimming, WebSockets, T3 Code and other harnesses are outside this integration.
Non-Responses provider endpoints pass through; provider-independent telemetry
and account traffic are not intercepted by this proxy.

## Live testing still needed

1. Run the disabled smoke test with your existing Codex login.
2. With a TypeSafe key, use a disposable task containing old tool output.
3. Start a new user turn above the pruning threshold and check the terminal notice.
4. Resume the session, exercise tools, and inspect task correctness and rereads.
5. Compare against an unpruned run before relying on pruning quality or savings.

Offline tests verify structure, fail-open behavior, streaming, and lifecycle.
They do not establish that the relevance policy preserves real task quality.

## Repeat the real-CLI fixture

After building, run `node test/manual/codexCli.mjs` in an environment with
external egress blocked and loopback available. It needs the installed Codex
CLI, uses a temporary home and dummy credentials, executes a fixed synthetic
tool response, resumes the session, and verifies pruning and restart replay.
Run again with `JEV_FIXTURE_FAIL_SCORE=1` to verify scorer-failure pass-through.
It makes no live model or TypeSafe calls. The hosted Jest suite does not need
Codex installed; this fixture is a separate local compatibility check.

# Architecture

Jev Prune has two HTTP proxy implementations sharing TypeSafe relevance scoring
and persistent pruning decisions. Start at [AGENTS.md](../AGENTS.md) for task
routing; load the linked contract for the subsystem you are changing.

## Runtime paths

```text
Claude: jev-prune -> setup/launch -> shared detached index/createApp
  POST /v1/messages -> canary -> prune + route concurrently on original input
    -> replay/add notices -> model override -> edit-only thinking controls
    -> upstream send -> optional original-model retry -> streamed response
  /health -> local counters; other /v1 routes bypass message preparation

Codex: codexLaunch -> launchCodex -> per-invocation loopback HTTP server
  POST /responses -> supported full-history input -> replay/scoring/output stubs
    -> upstream send -> streamed response
  unsupported traffic -> original bytes; disconnect/shutdown -> upstream abort

Shared: config -> JevService / JevRelevanceScorer
  DecisionMemory -> versioned PruneState -> atomic JSON persistence
```

Claude parses and reserializes JSON; Codex preserves original bytes unless it
changes the parsed body. Do not transfer one transport's guarantees to the other.
Claude uses notices, canaries, routing, mechanical rewrites and optional shadow
observation. Codex uses output-only stubs and separate state, without those features.

## Contract owners

| Concern | Detailed reference |
| --- | --- |
| Request preparation, thinking, retry, HTTP | [Claude pipeline](agents/claude.md) |
| Pair safety, turn gates, replay, rewrites | [Claude pruning](agents/pruning.md) |
| Responses envelopes, raw fallback, child lifecycle | [Codex](agents/codex.md) |
| Configuration, scoring budgets, persistence | [Shared core](agents/shared.md) |
| Install, process reuse, shutdown, commands | [Lifecycle](agents/lifecycle.md) |
| Logs, streaming taps, advisory shadow | [Observability](agents/observability.md) |
| Offline proof and coverage limits | [Testing](agents/testing.md) |

Scoring failure means no new scored drops. Earlier decisions can still replay;
Claude also retains new mechanical rewrites. Disabled pruning bypasses replay.
New scoring occurs only after the relevant user-turn and size/trigger gates.
Both paths preserve history structure; neither guarantees a hard context-size
limit or demonstrated real-task pruning quality.

## Maintaining the context structure

This adapts [ICM](https://arxiv.org/html/2603.16021v2)'s layered context and explicit
contracts to code navigation: root identity/routing, selected task contracts,
and stable source-backed references. Working artifacts remain private. The paper
addresses sequential human-reviewed workflows; its practitioner reports do not
establish coding-agent accuracy or token savings here.

Task routing fits this flat, cross-cutting service layout better than loading
all documentation or relying solely on directory rules. Keep one owner for each
contract, update its guide with relevant source changes, and verify its links and
suite names. Agents without automatic instruction discovery should open root
`AGENTS.md` explicitly. `CLAUDE.md` imports that same entry point for compatibility;
no vendor-specific copy of the guidance is maintained.

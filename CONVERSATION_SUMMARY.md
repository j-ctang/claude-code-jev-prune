# Project State Summary

## Original Idea

The project began with a proposal to reduce long Claude Code requests by asking TypeSafe Jev which older context remains relevant. The desired distinction from summarization was preservation: retained content should stay intact, while stale tool-call bulk could be deleted.

Early notes described the project as a completed MCP plugin and listed source files that were not present in the repository. The initial checkout actually contained three Markdown documents and a manifest with a nonexistent `typesafe` npm dependency.

## Implemented Design

The project is now a local HTTP proxy, not an MCP server.

```text
Claude Code
    │ POST /v1/messages
    ▼
Local Express proxy
    ├── estimate request tokens
    ├── identify unique tool-use/result pairs
    ├── protect recent and excluded tools
    ├── ask TypeSafe Jev for relevance scores
    ├── remove low-relevance pairs together
    └── forward to Anthropic
             │
             ▼
       stream response back
```

Implemented components include:

- Strict environment parsing and startup validation
- TypeSafe `POST /v1/systemone` client using native `fetch`
- Batches of at most 32 named `noul` questions
- Pair-safe, immutable pruning
- Normal and aggressive relevance cutoffs
- Process-local caching of drop decisions
- Fail-open handling for every Jev-side error
- Transparent `/v1/*` forwarding
- Anthropic status, header, error-body, and event-stream relay
- Structured file and console logging without prompt/tool payloads
- A nonbillable `/health` endpoint
- Graceful SIGINT/SIGTERM shutdown
- Unit, integration, streaming, logging, and subprocess tests

## Correctness Boundaries

The implementation guarantees structural preservation, not perfect relevance decisions.

- Retained values are not summarized or rewritten.
- JSON wire bytes can change through parsing and serialization.
- Only unique matched `tool_use`/`tool_result` pairs are removable.
- TypeSafe failures forward the original request.
- A valid Jev score can still make a poor relevance judgment.
- The token counter is a deterministic size estimate, not a provider billing count.
- The aggressive threshold changes the cutoff; it does not guarantee a hard context cap.
- Claude Code's own compaction remains independent.

## Privacy Boundary

When the threshold is reached, the latest non-tool user goal and eligible tool names, IDs, inputs, and results are sent to TypeSafe. Anthropic credentials are not sent to TypeSafe, and the TypeSafe key is not forwarded to Anthropic. Logs contain aggregate counts and safe decision metadata only.

## Current File Structure

```text
claude-code-jev-prune/
├── src/
│   ├── index.ts
│   ├── app.ts
│   ├── config.ts
│   ├── types.ts
│   ├── middleware/
│   │   ├── health.ts
│   │   └── proxy.ts
│   ├── services/
│   │   ├── contextPruner.ts
│   │   └── jevService.ts
│   └── utils/
│       ├── logger.ts
│       └── tokenCounter.ts
├── test/
├── docs/
│   ├── ARCHITECTURE.md
│   └── superpowers/plans/
├── .env.example
├── package.json
├── tsconfig.json
├── README.md
└── GETTING_STARTED.md
```

## Verification State

The default automated suite does not require external keys and verifies the local implementation against controlled fakes. Before a release, run the complete local gate and then perform a synthetic live Jev contract check with a user-supplied key. Do not use a real conversation, repository file, environment dump, or credential-bearing output for that live check.

Performance, cost, token-savings, and quality claims from the original notes have not been retained as guarantees. They require reproducible benchmarks on representative workloads.

# Agent entry point

Jev Prune is a TypeScript HTTP proxy with two paths: shared Claude Code
Messages transport and per-invocation Codex Responses transport. Both use
TypeSafe scoring. Node.js 20+; install locked dependencies with `npm ci`.

## Load context for the task

Read only matching guides, then their named source and tests. Paths in guides
are relative to the repository root. For cross-area work, follow every matching
route; do not load this entire documentation tree automatically.

| Before doing this | Required guide |
| --- | --- |
| Starting implementation or dispatching work | [Workflow](docs/agents/workflow.md) |
| Writing on GitHub, committing, reviewing a PR, or delivering | [Delivery](docs/agents/delivery.md) |
| Running or changing verification | [Testing](docs/agents/testing.md) |
| Investigating, editing, or reviewing Claude HTTP, thinking/history, notices, routing, canaries | [Claude pipeline](docs/agents/claude.md) |
| Investigating, editing, or reviewing Claude pruning, pairing, rewrites | [Pruning](docs/agents/pruning.md) |
| Investigating, editing, or reviewing Codex launch, transport, outputs | [Codex](docs/agents/codex.md) |
| Investigating, editing, or reviewing config, scoring, persistence, shared helpers | [Shared core](docs/agents/shared.md) |
| Investigating, editing, or reviewing installation, processes, CLI commands | [Lifecycle](docs/agents/lifecycle.md) |
| Investigating, editing, or reviewing logs, counters, streaming taps, skill shadow | [Observability](docs/agents/observability.md) |
| Orienting across the whole system | [Architecture](docs/ARCHITECTURE.md) |

## Always enforce

- Work from a real user report or automated signal. Before implementation,
  claim the issue, complete its brief, and apply exactly one risk label.
- Use one isolated worktree per task; preserve unrelated changes and claims.
- Do not change CI, test gates (including check scripts and Jest/lint config),
  authentication/credentials, this file, or policy in the workflow, delivery,
  and testing guides without explicit scoped user authorization. Open an issue instead.
- Never weaken, skip, or delete tests to make a check pass. Never put API/agent
  credentials in Actions or add a public self-hosted runner.
- Stop after two unsuccessful correction attempts; report the blocker.
- At quota limits, record state and next step in the task issue and resume
  after reset. Do not start unattended loops.
- Human schedules and merges; neither risk label grants auto-merge authority.
- Report actual evidence and limitations. A pruning-disabled smoke check
  does not prove live TypeSafe pruning works.

# AGENTS.md

## Project and commands

jev-prune is a local TypeScript HTTP proxy for Claude Code. It calls TypeSafe
for pruning/routing. Tests use injected responses and local HTTP servers.

- Install locked dependencies: `npm ci`.
- Full check: `npm run check` (lint, TypeScript build, Jest).
- Focused tests: `npm test -- --runTestsByPath test/NAME.test.ts`.
- Required hosted check: `offline-check`; it runs with external networking blocked.

## Before starting

- Work only from a real user report or automated signal.
- Claim the issue before implementation. Record model, branch, and worktree
  in a claim comment; never work on another agent's claim.
- Use one isolated worktree per task; preserve unrelated user changes.
- Require a brief with GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX,
  FORBIDDEN, and REPORT. Missing or empty fields block dispatch.
- Bug fixes require a confirmed reproduction or failing test before a fix.
- Triage with exactly one risk label before implementation. An issue template
  does not replace triage or establish that a reported bug is reproduced.

## Risk and delivery

- `risk:low`: reproduced bug fixes, tests, behavior-preserving refactors,
  lint/type debt, and dependency patches. Everything else is `risk:feature`.
- Current coordination is by hand and sequential: human schedules and merges.
  Neither risk label grants auto-merge authority. A specific user delegation
  must be recorded in the issue/PR.
- Keep one concern per PR, under approximately 300 changed lines.
- PRs target `staging`. Run the full local check before opening a PR.
- Attach the issue, acceptance criteria, tested SHA, before/after evidence,
  command results, hosted CI URL, and rollback instructions.
- Green hosted CI comes before independent review by the other model.
  An agent must not review its own change; AI review is additional evidence.
- Human tests staging before promotion. Main only moves by fast-forward
  from tested staging. Check ancestry and verify equal remote SHAs afterward.
- Revert broken staging within the hour; never fix forward. Preserve history.

## Protected paths and failure handling

- Do not change CI configuration, test gates (including check scripts and
  Jest/lint configuration), authentication/credentials, or this file. Open
  an issue instead; explicit user authorization can permit a scoped exception.
- Never weaken, skip, or delete tests to make a check pass.
- Ordinary PR verification uses dummy keys, injected API responses, and
  blocked external networking. Preserve loopback for local HTTP tests.
- Never put API/agent credentials in Actions or add a public self-hosted runner.
- Stop after two unsuccessful correction attempts; report the blocker.
- At quota limits, write state and next step into the task issue and resume
  after reset. Do not start unattended loops.
- Report actual evidence and limitations. A passing smoke check with pruning
  disabled does not prove live TypeSafe pruning works.

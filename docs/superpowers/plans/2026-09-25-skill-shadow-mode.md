# Skill Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Observe full skill content and report conservative potential cleanup savings without modifying requests.

**Architecture:** A session-scoped observer matches on-disk SKILL.md bodies against request text, then scores task completion after a finished response. It emits metadata-only events; the launcher relays per-session notices and stats summarizes the events.

**Tech Stack:** TypeScript, Express, Node streams, Jest.

**Spec:** `docs/superpowers/specs/2026-09-25-skill-shadow-mode-design.md`

## Global Constraints

- Default disabled with `JEV_PRUNE_SKILL_SHADOW=false`.
- No request mutation, no stored prompt or skill text, and no claimed actual savings.
- Unknown/ambiguous matches and uncertain completion fail open.
- Use the existing TypeSafe Jev endpoint with timeout and structured answer.

---

### Task 1: Skill matching and session observations

**Files:** Create `src/services/skillShadow.ts`; create `test/skillShadow.test.ts`; modify `src/config.ts`.

**Interfaces:** `SkillShadow.observe(request, sessionId)` returns matched metadata and tracks each session; `SkillShadow.complete(sessionId, reply)` scores and records events.

- [x] **Step 1: Write failing tests** for exact and normalized full-body match, ambiguous/unknown skip, duplicate accounting, and disabled-by-default config. Use a temporary skill root and literal request fixtures.
- [x] **Step 2: Run** `npm test -- --runInBand test/skillShadow.test.ts test/config.test.ts`; confirm expected missing-feature failures.
- [x] **Step 3: Implement minimal matcher and bounded session state.** Match only complete normalized body spans, estimate with `Math.ceil(body.length / 4)`, and store only metadata.
- [x] **Step 4: Run** the same tests and confirm pass.
- [x] **Step 5: Commit** matching behavior and tests.

### Task 2: Completion scoring and response capture

**Files:** Modify `src/services/skillShadow.ts`, `src/middleware/proxy.ts`, `src/app.ts`, `src/index.ts`; create `src/utils/responseTextTap.ts`; create `test/responseTextTap.test.ts`; modify `test/proxy.test.ts`.

**Interfaces:** Response tap passes bytes unchanged and emits bounded final text after `message_stop` or complete JSON. Observer calls a structured Jev completion scorer only for observed skills.

- [x] **Step 1: Write failing tests** for final vs incomplete response, fail-open scorer errors, high-confidence completion, and unchanged upstream request content.
- [x] **Step 2: Run** focused tests and confirm failures are caused by missing behavior.
- [x] **Step 3: Add response tap and observer integration.** The observer runs beside existing pruning and never affects forwarding.
- [x] **Step 4: Run** focused tests and confirm pass.
- [x] **Step 5: Commit** capture and completion behavior.

### Task 3: Local reporting and launcher notice

**Files:** Create `src/services/skillShadowLog.ts`; modify `src/stats.ts`, `src/launch.ts`; create `test/skillShadowLog.test.ts`; modify `test/bootstrap.test.ts`.

**Interfaces:** Metadata-only `skill_shadow_complete` events include session ID and event ID. Launcher polls only its session's events and prints each once; stats reports observed, completed, and potential tokens separately.

- [x] **Step 1: Write failing tests** for summary accounting, malformed log lines, event deduplication, and session-specific notices.
- [x] **Step 2: Run** focused tests and confirm failures.
- [x] **Step 3: Implement** log summary, launcher relay, and one-line notice.
- [x] **Step 4: Run** focused tests and confirm pass.
- [x] **Step 5: Commit** reporting behavior.

### Task 4: Docs and final verification

**Files:** Modify `README.md` and `.env.example`.

- [x] **Step 1: Document** opt-in flag, advisory estimates, cost behavior, and no actual cleanup.
- [x] **Step 2: Run** `npm run check`; confirm lint, build, and all tests pass.
- [x] **Step 3: Review** diff and spec line by line for privacy, fail-open behavior, unchanged requests, and separate actual/potential tokens.
- [x] **Step 4: Commit** docs and any focused fixes.

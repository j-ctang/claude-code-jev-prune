# Skill Shadow Proxy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shadow-mode observation cheaper and terminal notices reliable without changing Anthropic traffic or authorizing skill cleanup.

**Architecture:** A byte-aware log follower owns file reading for the launcher. An immutable skill catalog owns filesystem discovery and refresh; `SkillShadow` consumes snapshots. A narrow shadow observer owns completion bookkeeping while the proxy retains HTTP and stream control.

**Tech Stack:** Node.js 20, TypeScript, Jest, Express, Node streams and filesystem APIs. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-25-skill-shadow-proxy-hardening-design.md`

## Global Constraints

- `JEV_PRUNE_SKILL_SHADOW=true` remains opt-in; the default is `false`.
- Shadow mode never changes outbound Anthropic requests or response bytes and never removes skill content.
- Completion cutoff remains `0.95`; exact normalized full-body matching and ambiguity skipping remain unchanged.
- Mixed-project proxies observe only user skills. Logs and notices contain metadata only.
- Refresh uncertainty, malformed data, and Jev errors fail open for proxy traffic and yield no shadow finding.
- The log follower caps a partial line at 64 KiB and resets all decoding state on truncate or replacement.
- No new runtime dependency or general event bus.

## File map

| File | Responsibility |
| --- | --- |
| `src/services/skillShadowLogFollower.ts` | Follow appended log bytes; own file identity, offset, decoder, partial line, and JSONL event delivery. |
| `src/services/skillShadowLog.ts` | Validate shadow events, format notices, and summarize log data. Remove the string cursor once the follower replaces it. |
| `src/launch.ts` | Poll the follower and apply the existing sole-launcher notice rule. |
| `src/services/skillCatalog.ts` | Discover, normalize, and cache eligible skill entries. |
| `src/services/skillShadow.ts` | Match catalog entries; own task state and completion judgment. |
| `src/services/skillShadowObserver.ts` | Coordinate observations, final-reply callbacks, and metadata-only log events. |
| `src/index.ts` | Compose catalog, shadow, observer, and logger. |
| `src/middleware/proxy.ts` | Forward HTTP and install response tap when observer returns a callback. |

### Task 1: Byte-aware log follower

**Files:** Create `src/services/skillShadowLogFollower.ts`, `test/skillShadowLogFollower.test.ts`; modify `src/services/skillShadowLog.ts`, `src/launch.ts`, `test/skillShadowLog.test.ts`.

**Interfaces:** Export `createSkillShadowLogFollower(path: string): { poll(): ShadowEvent[] }` and a metadata-only `ShadowEvent` type from `skillShadowLog.ts`. `poll()` returns complete parsed JSONL objects; it never prints. Keep `skillShadowNotices(events, seen, soleLauncher)` responsible for formatting and deduplication. Update `summarizeSkillShadowLog(raw)` to use the same event validation.

```ts
export interface ShadowEvent {
  message?: unknown;
  eventId?: unknown;
  sessionId?: unknown;
  skill?: unknown;
  potentialTokens?: unknown;
  confidence?: unknown;
}
export function createSkillShadowLogFollower(path: string): {
  poll(): ShadowEvent[];
};
```

The first test should append two byte slices of one JSONL line, splitting inside `é` rather than between characters:

```ts
const bytes = Buffer.from(`${JSON.stringify({ message: "skill_shadow_complete", skill: "café", eventId: "1" })}\n`);
const split = bytes.indexOf(Buffer.from("é")) + 1;
appendFileSync(path, bytes.subarray(0, split));
expect(follower.poll()).toEqual([]);
appendFileSync(path, bytes.subarray(split));
expect(follower.poll()).toEqual([expect.objectContaining({ skill: "café" })]);
```

- [ ] **Step 1: Write failing tests.** Use temporary files. Assert that construction starts at the current end, two appended byte slices containing a split UTF-8 character produce one valid event only after the newline, malformed lines do not suppress later valid lines, and a line over 64 KiB is discarded through its newline. Assert a truncated or replaced file resets the partial line and yields only the new file's event. Keep the existing sole-launcher and duplicate-ID tests.
- [ ] **Step 2: Run the focused tests.** `npx jest test/skillShadowLogFollower.test.ts test/skillShadowLog.test.ts --runInBand` must fail for the missing follower before implementation.
- [ ] **Step 3: Implement the follower.** On construction, `statSync` the path and remember `{dev, ino, size}` if present. On each `poll`, stat again; if identity changes or size shrinks, replace `TextDecoder`, offset, and pending bytes/text together and read from byte zero. Use `openSync/readSync/closeSync` in a `try/finally` to read only `[offset, currentSize)`, decode with `{stream:true}`, emit complete lines, and keep at most 64 KiB of a partial line. A discard flag ignores the rest of an oversized line until its newline. Missing/read failures return `[]` and preserve no uncertain partial line. Parse only complete JSON objects into `ShadowEvent[]`.
- [ ] **Step 4: Wire the launcher.** Replace `readFileSync(logPath)` and `createSkillShadowLogCursor()` with one follower instance. Keep the 750 ms interval, `seen` set, `wasShared`/`liveSessions` rule, and final `poll()` on exit. Format events through `skillShadowNotices`.
- [ ] **Step 5: Run focused tests, lint, and build.** `npx jest test/skillShadowLogFollower.test.ts test/skillShadowLog.test.ts --runInBand && npm run lint && npm run build`; fix only failures in this task.
- [ ] **Step 6: Commit.** `git add src/services/skillShadowLogFollower.ts src/services/skillShadowLog.ts src/launch.ts test/skillShadowLogFollower.test.ts test/skillShadowLog.test.ts && git commit -m "fix: follow shadow log by bytes"`.

### Task 2: Snapshot skill catalog

**Files:** Create `src/services/skillCatalog.ts`, `test/skillCatalog.test.ts`, `scripts/bench-skill-catalog.ts`; modify `src/services/skillShadow.ts`, `src/index.ts`, `test/skillShadow.test.ts`.

**Interfaces:** Export `SkillEntry` with `{skill, body, key, potentialTokens}` and `SkillCatalog` with `start(): Promise<void>` and `entries(): readonly SkillEntry[]`. Constructor accepts `roots: () => readonly string[]`, `refreshIntervalMs?: number`, and injectable `now?: () => number` for tests. `entries()` schedules one asynchronous refresh when root set changes or snapshot age reaches the interval; it returns `[]` for a new root set or a snapshot older than 30 seconds. `start()` loads an initial snapshot before the proxy listens. The catalog performs matching-independent discovery and normalization.

```ts
export interface SkillEntry {
  readonly skill: string;
  readonly body: string;
  readonly key: string;
  readonly potentialTokens: number;
}
export class SkillCatalog {
  constructor(options: {
    roots: () => readonly string[];
    refreshIntervalMs?: number;
    now?: () => number;
  });
  start(): Promise<void>;
  entries(): readonly SkillEntry[];
}
```

The cross-project test must check the value synchronously before the asynchronous refresh resolves:

```ts
roots = [userRoot, projectBRoot];
expect(catalog.entries()).toEqual([]);
await refreshDone;
expect(catalog.entries()).toEqual(expect.arrayContaining([expect.objectContaining({ skill: "project-b" })]));
```

- [ ] **Step 1: Write failing catalog tests.** Temporary roots cover initial load, same-root snapshot reuse, concurrent refresh coalescing, an added/changed/deleted `SKILL.md`, ambiguous bodies, and inaccessible files. Use a controlled clock to assert 30-second expiry. Change project roots while a refresh is pending and assert `entries()` returns no previous project entry. Do not use elapsed-time assertions for correctness.
- [ ] **Step 2: Run focused tests.** `npx jest test/skillCatalog.test.ts --runInBand` must fail because the catalog does not exist.
- [ ] **Step 3: Record the baseline.** Add `scripts/bench-skill-catalog.ts` while `SkillShadow` still uses per-request discovery. Generate temporary synthetic skill files and a large Anthropic request, call `observe` repeatedly with a fake judge, and print median request-path time and skill count. Run `npx tsx scripts/bench-skill-catalog.ts` and record its output before extraction.
- [ ] **Step 4: Extract discovery.** Move `normalize`, `bodyOf`, recursive `SKILL.md` discovery, SHA-256 key, token estimate, identical-name deduplication, and different-name ambiguity filtering from `skillShadow.ts` to `skillCatalog.ts`. Use async filesystem operations for refresh. Sort discovered paths for deterministic snapshots. Publish a new frozen entry array only after a complete successful scan; an unreadable individual file is skipped.
- [ ] **Step 5: Add refresh ownership.** Cache by the ordered eligible root set. Coalesce refreshes for the same root set. Discard an in-flight result if roots change before it resolves. Expired or wrong-root snapshots return `[]`; failed refreshes cannot make an expired snapshot visible. Trigger refresh without awaiting from `entries()`, catching rejection internally so proxy traffic cannot fail.
- [ ] **Step 6: Wire startup and matching.** `index.ts` awaits catalog `start()` before `server.listen`; `SkillShadow` receives a catalog and calls `entries()` without filesystem access. Update existing shadow tests to create a catalog and await `start()`; retain goal, revision, completion, ambiguity, and session assertions. Add a proxy test using a catalog that throws from `entries()` and verify forwarding remains unchanged after the shadow observer catches it.
- [ ] **Step 7: Record the new request-path cost.** Adapt the same benchmark script to the catalog-backed `SkillShadow` constructor; keep the synthetic files, request, call count, and timing method unchanged. Run `npx tsx scripts/bench-skill-catalog.ts` again. Record both runs in the PR description as local observations, with no pass/fail speed threshold or paid Jev call.
- [ ] **Step 8: Run focused tests, lint, and build.** `npx jest test/skillCatalog.test.ts test/skillShadow.test.ts --runInBand && npm run lint && npm run build`.
- [ ] **Step 9: Commit.** `git add src/services/skillCatalog.ts src/services/skillShadow.ts src/index.ts test/skillCatalog.test.ts test/skillShadow.test.ts scripts/bench-skill-catalog.ts && git commit -m "refactor: cache skill catalog outside request path"`.

### Task 3: Narrow proxy shadow integration

**Files:** Create `src/services/skillShadowObserver.ts`, `test/skillShadowObserver.test.ts`; modify `src/middleware/proxy.ts`, `src/index.ts`, `src/app.ts`, `test/proxy.test.ts`.

**Interfaces:** Export `SkillShadowObserver` with `observe(request: AnthropicRequest, sessionId: string): ((reply: string) => void) | undefined`. It owns `SkillShadow.observe`, captures its revision, logs observed findings, and returns a callback that calls `complete` and logs metadata-only completion findings. The callback catches all completion rejections. The observer catches synchronous shadow failures and returns `undefined`; it never mutates the request. `ProxyDependencies` carries `shadowObserver?: SkillShadowObserver` in place of `shadow?: SkillShadow`.

```ts
export class SkillShadowObserver {
  constructor(shadow: SkillShadow, logger: AppLogger);
  observe(request: AnthropicRequest, sessionId: string):
    | ((reply: string) => void)
    | undefined;
}
```

The proxy call site should end with one optional reply callback and retain the current stream pipeline:

```ts
const onFinalReply = sessionId && dependencies.shadowObserver
  ? dependencies.shadowObserver.observe(result.request, sessionId)
  : undefined;
// After a successful upstream response:
const responseTap = onFinalReply
  ? createResponseTextTap(contentType, onFinalReply)
  : undefined;
```

- [ ] **Step 1: Write failing observer tests.** With fake `SkillShadow` and logger, assert observed events contain no body/path, a final reply logs completion once, old revisions cannot complete a new task, and sync/async failures yield no event or exception. Retain current shadow proxy integration tests.
- [ ] **Step 2: Run focused tests.** `npx jest test/skillShadowObserver.test.ts test/proxy.test.ts --runInBand` must fail for the missing observer.
- [ ] **Step 3: Implement observer.** Keep the existing `randomUUID()` event ID generation and metadata schema. Capture the revision in the reply callback. Return no callback when observation is unavailable. Keep the `0.95` cutoff in `SkillShadow`, not in the proxy or observer.
- [ ] **Step 4: Simplify proxy composition.** Remove `shadowSessionId` and `shadowRevision`. After pruning, call `shadowObserver.observe(result.request, sessionId)` and retain its callback. On a successful upstream response, install `createResponseTextTap(contentType, callback)`; otherwise use the existing usage-tap-only pipeline. The proxy keeps status, header, stream, and usage behavior. `index.ts` constructs the observer; `app.ts` passes it through.
- [ ] **Step 5: Verify behavior.** Proxy tests assert outbound request byte-equivalent JSON with shadow on/off, unchanged streamed response chunks, no judgment on non-2xx or incomplete streams, and usage logging with shadow enabled. Run `npx jest test/skillShadowObserver.test.ts test/proxy.test.ts test/responseTextTap.test.ts --runInBand && npm run check`.
- [ ] **Step 6: Commit.** `git add src/services/skillShadowObserver.ts src/middleware/proxy.ts src/index.ts src/app.ts test/skillShadowObserver.test.ts test/proxy.test.ts && git commit -m "refactor: isolate shadow completion orchestration"`.

### Task 4: Final review and PR update

**Files:** No new implementation file. Update PR #10 description only with verified benchmark numbers and test results.

- [ ] **Step 1: Inspect the diff.** `git diff origin/main...HEAD --check` and `git diff --stat origin/main...HEAD`; confirm no file crossed 1,000 lines and no skill text, prompts, or responses enter logs.
- [ ] **Step 2: Run the full gate.** `npm run check`; record lint, build, test-suite and test counts from this run.
- [ ] **Step 3: Review against the spec.** Check each preserved behavior, log rotation, mixed-project catalog isolation, fail-open proxy behavior, and notice suppression. Resolve only concrete gaps found here.
- [ ] **Step 4: Push and update the PR.** Push `feat/skill-shadow`; update PR #10 with implementation summary, benchmark method/results, and verification. Do not claim actual token savings from shadow mode.

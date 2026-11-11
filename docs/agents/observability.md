# Logs, taps and advisory skill observation

Read for telemetry or skill-shadow changes. Inputs by task:

| Task | Source | Tests in `test/` |
| --- | --- | --- |
| Prune counters/logs | `src/services/pruneLog.ts`, `src/utils/logger.ts`, `src/middleware/health.ts`, `src/stats.ts` | `pruneLog.test.ts`, `logger.test.ts`, `proxy.test.ts` |
| Streaming observation | `src/utils/usageTap.ts`, `src/utils/responseTextTap.ts`, `src/middleware/proxy.ts` | `proxy.test.ts`, `responseTextTap.test.ts` |
| Skill lifecycle | `src/services/skillCatalog.ts`, `src/services/skillShadow.ts`, `src/services/skillCompletion.ts`, `src/services/skillShadowObserver.ts` | `skillCatalog.test.ts`, `skillShadow.test.ts`, `skillCompletion.test.ts`, `skillShadowObserver.test.ts`, `proxy.test.ts` |
| Terminal findings | `src/services/skillShadowLog.ts`, `src/services/skillShadowLogFollower.ts`, `src/launch.ts`, `src/sessions.ts` | `skillShadowLog.test.ts`, `skillShadowLogFollower.test.ts`, `sessions.test.ts` |

Preserve byte-for-byte response flow through bounded taps; malformed/incomplete
reply data must not justify completion. Usage taps are covered by proxy tests.
Health is process-local and makes no external call. Prune log event writing and
reading share one owner; distinguish newly removed tokens, replay and scorer usage.
Logger is not a generic redactor: callers must omit payloads/credentials and use
safe error metadata (`src/errors.ts`). Detached Claude discards console output;
the private log file remains. Codex has terminal notices, not this stats pipeline.

Shadow is opt-in and advisory: it never rewrites requests/responses. Catalog
refresh is asynchronous outside the request path; stale/ambiguous entries fail
closed. Project skills are considered only for one live project. Completion
results require matching session revision and sufficient confidence; old async
results cannot complete a new task. Terminal findings deduplicate event IDs and
suppress shared-session attribution. File following must handle UTF-8 boundaries,
rotation, truncation and oversized lines. Potential tokens are not removed tokens.

Output: unchanged wire data, safe metadata and correctly scoped observations.
Run the matching suites via [Testing](testing.md). `scripts/bench-skill-catalog.ts`
is a synthetic optional benchmark (`npx --no-install tsx scripts/bench-skill-catalog.ts`),
not evidence of pruning quality or real savings.

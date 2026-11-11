# Shared dependencies and change impact

Read for shared helpers. Choose the matching inputs; do not read every row.

| Change | Read source | Verification beyond the caller |
| --- | --- | --- |
| Settings/defaults | `src/config.ts`, `.env.example`, `README.md`, `CODEX.md` | `test/config.test.ts`, both launcher/transport paths |
| Scoring/API | `src/services/jevService.ts`, `src/services/relevanceScorer.ts`, `src/types.ts`, `src/errors.ts` | `test/jevService.test.ts`, both pruners, `test/modelRouter.test.ts` |
| Decision replay | `src/services/decisionMemory.ts`, `src/services/pruneState.ts`, `src/utils/jsonFile.ts`, `src/utils/recency.ts` | `test/pruneState.test.ts`, both pruners; notices/choices for JSON changes |
| Token estimates | `src/utils/tokenCounter.ts` | `test/tokenCounter.test.ts`, scorer and both pruners |
| Headers or shared stub | `src/middleware/proxy.ts`, `src/services/toolPairs.ts` | both transports or both pruners respectively |

Both pruners means `test/contextPruner.test.ts` and `test/responsesPruner.test.ts`;
both transports means `test/proxy.test.ts` and `test/codexProxy.test.ts`.
Read [Claude](claude.md), [Pruning](pruning.md), or [Codex](codex.md) for callers
whose contract changes. Shared JSON also serves `NoticeMemory` and `SavedChoice`.

`JevService.ask` owns `/v1/systemone`, its own authentication headers, timeout,
and finite [0,1] noul validation. No provider headers go to TypeSafe.
`JevRelevanceScorer` batches by both 32 questions and estimated token budget;
oversized goals/candidates may be truncated for scoring. Tests live in
`test/jevService.test.ts`, not a separate scorer test. Estimates use JSON length/4,
not a tokenizer; removed estimates are not billing savings.

`DecisionMemory` fingerprints original ID/name/input/result, not rewritten output.
Reused IDs with different payloads must not inherit drops. Bounded maps and
versioned state survive restart; Claude caches keeps, Codex does not. Atomic JSON
writes use restrictive modes and rename. Save failure must not fail forwarding.
`test/noticeMemory.test.ts` and `test/savedChoice.test.ts` cover other state users.

Output: preserved contracts for every affected consumer and the relevant suite
results under [Testing](testing.md). Update settings documentation with defaults
when authorized; never assume a setting is unused merely because its name says Claude.

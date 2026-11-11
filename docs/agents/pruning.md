# Claude pruning contract

Read for pairing, thresholds, rewrites, replay or pruning notices. Inputs:
`src/services/contextPruner.ts` (`ContextPruner.prune`), `toolPairs.ts`,
`toolRewrites.ts`, `turn.ts`, and `pruneNotices.ts` in that same directory.
For config/scoring/persistence changes also read [Shared core](shared.md).

Process and invariants:

1. Disabled pruning returns the original request. With no saved edits, a
   below-threshold automatic request can exit early. Otherwise extract uniquely
   matched valid tool-use/result pairs; exclude configured tools and results
   containing `tool_reference`. Malformed/unmatched/duplicate blocks stay intact.
2. Recall saved drops/rewrites before threshold and turn gates. New decisions
   require a new user turn; trailing system messages do not hide that boundary.
   Manual `/jev-prune` and canary triggers can bypass the size gate, not the turn gate.
3. Supersede older Reads only with a later full or same-range Read containing
   line-numbered file content. Trim eligible large text outputs at line boundaries.
   `Read` is excluded from trim tools. Recent valid pairs are protected from
   scoring and trimming; superseding is a separate mechanical rule.
4. Score nonrecent eligible pairs only when stubbing saves input+output size.
   Kept candidates are reused until goal/context growth or manual rescore requires
   reconsideration. Cutoffs are 0.5 normally and 0.7 at the aggressive threshold;
   the target is advisory, not a hard size guarantee.
5. Missing scores fail the scoring attempt without partial scored drops. TypeSafe
   probability validation belongs to `JevService`. Failure retains replayed edits
   and new mechanical rewrites; it does not necessarily restore the original body.
6. Drop superseded stubs when their replacement is dropped. Never remove blocks
   or messages; preserve metadata and immutability. `DROPPED_STUB` wording explains
   that earlier replies saw full output; it is shared with Codex.

Output: stable replay plus only justified new edits. Verify with
`test/contextPruner.test.ts`, `test/toolRewrites.test.ts`, `test/turn.test.ts`;
include `test/responsesPruner.test.ts` for shared stub/memory changes. Tests cover
restart, changed payload under reused ID, mid-task replay and failed scoring.
Use [Testing](testing.md); request assembly belongs to [Claude pipeline](claude.md).

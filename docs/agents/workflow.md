# Starting and scoping work

Read before implementation or dispatch. Inputs: the actual report/signal,
current issue and comments, checkout status, and the matching technical guide.

1. Inspect `git status --short` and the issue before claiming. Never work on
   another agent's claim. Use one isolated worktree per task.
2. Record model, branch, and worktree identifier in a claim comment. Read
   [Delivery](delivery.md) before writing it; do not publish local paths.
3. Require nonempty GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN,
   and REPORT fields. Missing or empty fields block dispatch. Templates in
   `.github/ISSUE_TEMPLATE/` supply structure, not completed triage.
4. Triage with exactly one risk label before implementation. `risk:low` covers
   reproduced bug fixes, tests, behavior-preserving refactors, lint/type debt,
   and dependency patches. Everything else is `risk:feature`.
5. Bug fixes require confirmed reproduction or a failing test before the fix.
   Name the symptom and changeable root cause; trace callers and tests before
   choosing an edit. An issue template is not reproduction evidence.
6. Read the source and relevant test cases listed by the technical guide.
   Preserve its contracts; extend reading when callers cross a guide boundary.
   Source is authoritative for behavior; report a documentation mismatch and
   update the owning technical guide when its contract changes.

Output: a claimed, triaged task with a complete brief, explicit acceptance
conditions, and scoped source/test inputs. Preserve policy intent; do not
turn an architectural observation into unrelated cleanup. Keep working notes
private and out of commits. Use [Testing](testing.md) for verification and
[Delivery](delivery.md) for the PR and review sequence.

# Delivery and GitHub writing

Read before GitHub writing, commits, PR review, or delivery. Inputs: issue,
current diff, actual verification evidence, and `.github/pull_request_template.md`.

- Keep one concern per PR, under approximately 300 changed lines. PRs target
  `staging`; run the full local `npm run check` before opening one.
- Fill in the repository PR template. Reread every changed Markdown file in
  full before opening/updating a PR and correct stale instructions.
- Write short, first-person singular descriptions of what is ready. Do not name
  which person or agent did what. Say “All tests pass.” without test counts.
  End with a clear verdict reflecting actual checks and remaining blockers.
- Never publish private working notes, local paths, or agent conversation links.
  Do not use internal phase labels. Never add AI attribution to commits or PRs.
  Commit messages use bullets only, each under eight words.
- Green hosted `offline-check` comes before independent review by the other
  model. An agent must not review its own change; AI review is additional evidence.
- Post each review round on the PR immediately, before committing fixes.
  After pushing fixes, post a short comment naming the fixing commits.
- Coordination is manual and sequential: human schedules and merges. Neither
  risk label grants auto-merge authority. Record any specific user delegation
  in the issue/PR; do not infer merge permission from green checks.
- Human tests staging before promotion. Main moves only by fast-forward from
  tested staging: fetch, check ancestry with `git merge-base --is-ancestor`,
  and verify equal remote main/staging SHAs afterward. These checks do not
  authorize promotion. Revert broken staging within the hour; never fix forward.
  Preserve history.

Output: a reviewable PR with public evidence and a truthful readiness verdict.
`.coderabbit.yaml` configures advisory review, not merge authority.
`scripts/check-promote-title.sh` and `.github/workflows/promote-title.yml`
reserve the promotion title for same-repository staging-to-main PRs;
`test/promoteTitle.test.ts` covers that protected gate.

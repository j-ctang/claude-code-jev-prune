#!/usr/bin/env bash
# CodeRabbit skips PRs whose title contains the promote phrase
# (.coderabbit.yaml). Fail any PR that uses it but is not a promote.
set -euo pipefail

phrase="promote staging to main"
title="$(printf '%s' "$PR_TITLE" | tr '[:upper:]' '[:lower:]')"

if [[ "$title" != *"$phrase"* ]]; then
  echo "Title has no promote phrase."
  exit 0
fi

if [[ "$PR_BASE" == "main" && "$PR_HEAD" == "staging" && "$PR_HEAD_REPO" == "$REPO" ]]; then
  echo "Promote PR from staging into main."
  exit 0
fi

echo "::error::The title \"Promote staging to main\" is only for PRs from staging into main. Rename this PR so CodeRabbit reviews it."
exit 1

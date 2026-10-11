---
name: Chore
about: Propose maintenance based on an observed need
title: ''
labels: ''
assignees: ''
---

## GOAL
State the maintenance outcome and why it is useful.

## SCOPE
Define affected files/behavior and the boundaries of the task.

## CONTEXT
Link the lint/type/dependency/test signal or user-requested maintenance.
Do not assume a chore is low-risk; classify its actual scope during triage.

## ACCEPTANCE
State what must change and what behavior must be preserved.

## VERIFY
Specify relevant preservation evidence and the full `npm run check` gate.

## TIMEBOX
Set the session/checkpoint budget and when to report a blocker.

## FORBIDDEN
List excluded changes. No unrelated cleanup, weakened tests, or protected edits.

## REPORT
Require issue/PR links, tested SHA, before/after evidence, check results,
independent review, and rollback.

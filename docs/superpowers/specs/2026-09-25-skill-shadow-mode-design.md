# Skill cleanup shadow mode

## Purpose

Measure whether completed-task skill cleanup is feasible and useful before changing any Anthropic request. Quality takes priority over token savings. The first release is opt-in observation only: it must not remove skill text, alter assistant responses, or claim saved tokens.

Claude Code normally loads skill descriptions at session start and full skill bodies when invoked. This experiment concerns full skill bodies retained in later requests, not the startup skill listing.

## User experience

`JEV_PRUNE_SKILL_SHADOW=true` enables observation. The default is `false`. When Jev reaches a high-confidence judgment that a task using an identified skill has ended, the launcher prints one short line, for example: `Jev: skill "pdf" looks reusable; ~2.1K tokens could be freed after this task.` The line says *could* because no cleanup occurred. A session reports each skill completion once per task. `jev-prune --stats` reports observed skills, high-confidence completion findings, and estimated potential tokens separately from actual tokens removed.

## Identification and lifecycle

The observer runs independently of the existing pruner. It reads the request after existing pruning and records an occurrence only if a text span can be matched exactly, after harmless newline normalization, to a local `SKILL.md` body. It searches installed user and project skill roots available to the launched Claude Code process; ambiguous matches or unsupported content formats are skipped. It never records a skill body, prompt text, or file path in the log. It stores a skill identifier, session identifier, request occurrence, and estimated token count. The estimate uses the project's existing token estimator and is labeled approximate.

For an observed skill, Jev assesses completion using the current user goal and a completed assistant response. Only a high-confidence affirmative result creates a potential-cleanup event; errors, incomplete streams, missing session identifiers, and uncertain answers leave the skill active without a notice. The observer deduplicates repeated request appearances of the same body and reports potential savings once per completed task. A later distinct goal can create a new observation, but this mode still does not modify requests.

Completion assessment uses the existing TypeSafe Jev client conventions with a bounded timeout and structured result. The prompt asks only whether the task that needed the skill is complete. The result is advisory and cannot control existing pruning. Calls are made only for sessions where a full skill body was identified, and only after an assistant response reaches a final boundary. This keeps experiment cost limited and makes it attributable in stats.

## Data flow and notice delivery

The proxy observes messages without mutation, tracks the response's final text through a bounded stream tap, then records a metadata-only completion event in the existing local JSONL log. The detached proxy cannot write to the Claude Code terminal. A launcher prints the one-line notice to stderr only while it is the sole live launcher for the shared proxy. With concurrent launchers it leaves events in stats and prints no notice, because it cannot prove which Claude Code session owns an event. Event IDs prevent duplicate notices after polling or restarts.

The log uses the existing private file permissions. Stored event fields are restricted to time, session ID, skill identifier, estimated potential tokens, completion confidence, and event ID. No request or response text is persisted. The experiment may be disabled at any time with the environment flag. Existing pruning, canary behavior, and upstream forwarding remain independent.

## Validation

Unit fixtures cover exact identification, normalization, ambiguous and unknown formats, deduplication, session isolation, uncertain completion, and approximate token accounting. Proxy tests prove shadow mode makes no additional change to outbound requests and existing pruning behavior is unaffected. Launcher tests prove one notice per event with a sole launcher and no notice with concurrent launchers. These tests use synthetic requests and a fake Jev response, so they require no paid model calls. A small opt-in live pilot can later measure real detection and completion quality; its results will inform a separate cleanup design with a proven reload path.

## Explicit limits

This release does not reduce context. It does not trim the startup skill listing, remove loaded content, or promise a reliable reload mechanism. If Claude Code's full skill content cannot be matched to a local `SKILL.md` in the observed request shape, the mode reports no finding rather than guessing. Completion estimates and potential token counts are evidence for a later decision, not savings claims.

# Skill shadow proxy hardening

## Purpose

Keep the opt-in skill cleanup experiment accurate and advisory while reducing work on the Anthropic request path and fixing terminal notice delivery from a growing log. This design refines PR #10; it does not remove context, alter the outbound Anthropic request, or change the Jev completion threshold.

## Scope and order

1. Give the launcher one byte-aware log follower. This fixes an existing state error and removes repeated whole-file reads.
2. Give skill discovery one catalog owner. This removes recursive skill file reads and hashing from each message request.
3. Narrow the proxy's shadow integration. The proxy remains responsible for HTTP forwarding and response streaming; the shadow module owns its observation revision, completion call, and metadata events.

The work stays behind `JEV_PRUNE_SKILL_SHADOW=true`. No general event bus, plugin framework, new external dependency, or change to normal pruning is part of this design.

## Log follower

The launcher starts following the existing private JSONL log at its current end so earlier sessions do not generate new notices. A dedicated follower owns the file identity, offset, incremental UTF-8 decoder, incomplete line, and parsed event delivery. It reads only appended bytes. If the file shrinks or its identity changes, it resets the offset, decoder, and incomplete line together and starts at the beginning of the new file. Missing or unreadable files yield no events and are retried on the next poll. Malformed JSONL lines are ignored without stopping later lines. A partial line is capped at 64 KiB; an oversized line is discarded through its next newline.

The launcher continues to decide whether to print each completed-skill notice. Its existing sole-launcher rule and event-ID deduplication remain in force, including consuming IDs while shared use suppresses notices. `jev-prune --stats` retains its separate potential-token accounting. The follower is local to the launcher; no proxy-to-launcher network channel is added.

## Skill catalog

A catalog owns root selection, recursive discovery of local `SKILL.md` files, frontmatter removal, normalized full-body content, skill names, ambiguity handling, and approximate token estimates. `SkillShadow` consumes catalog entries and owns only request matching, goal/session state, and completion decisions. The proxy never reads skill files directly.

The catalog caches an immutable snapshot for the currently eligible root set. It refreshes asynchronously when roots change and periodically while shadow mode is active, with a maximum age of 30 seconds. It coalesces concurrent refreshes. Initial loading completes before the proxy begins serving shadow observations. A refresh failure may keep the last known snapshot for the same root set only until it reaches 30 seconds of age; then observation yields no finding until refresh succeeds. A root-set change never serves entries from the former project root. Until the new roots are loaded, observation may yield no finding. Matching still requires the exact normalized body in the outbound request, and ambiguous names still produce no finding. A changed or deleted file can remain in a snapshot for at most 30 seconds; this cannot make the observer remove content, and exact request matching is still required.

Catalog refresh must not block Anthropic forwarding after startup. The matched request is scanned in memory against the current snapshot. A performance check with representative synthetic skills and request sizes compares the current implementation to the catalog implementation and records request-path time, without paid Jev calls. The spec does not promise a token saving or a fixed speedup.

## Shadow integration in the proxy

The proxy calls a shadow observer after pruning with the exact request it will forward, before optional Claude notices are appended. The observer records metadata-only observed events and returns an optional callback for a final assistant reply. The proxy installs the existing bounded response text tap only when that callback is present and the upstream response is successful. The callback owns revision checking, asynchronous Jev completion judgment, and metadata-only completion logging. Errors in shadow observation or completion cannot fail or delay Anthropic forwarding. The proxy continues to stream response bytes unchanged and continues to collect usage separately.

This is a narrow interface change, not a second response pipeline. The design does not merge the usage and reply taps: their parsing and limits differ, and there is no demonstrated benefit from combining them now.

## Preserved behavior

- Shadow mode remains opt-in and disabled by default.
- Project skill roots are eligible only when all live launchers share one project. Mixed projects observe user skills only.
- Exact full-body matching, ambiguity skipping, one finding per skill per task, the 0.95 completion cutoff, and the bounded session state remain unchanged.
- Incomplete responses, uncertain Jev answers, unsupported request shapes, and catalog uncertainty produce no completion event.
- Logs and terminal notices contain metadata only; no skill body, prompt, response, file path, or credentials are persisted.
- A shared proxy still suppresses terminal notices until restart while retaining stats events.

## Validation

Log follower tests cover appended bytes, split multibyte UTF-8, split JSONL lines, malformed lines, file shrink/replacement, missing files, and duplicate event IDs. A bounded-memory assertion verifies that prior log contents are not retained after complete lines are emitted.

Catalog tests cover same-root reuse, coalesced refresh, root changes, added/changed/deleted files, inaccessible paths, normalization, and ambiguous bodies. An integration test proves that a new project root cannot be attributed to a previous project while its refresh is pending. A focused benchmark records request-path time for a synthetic catalog and large request.

Proxy tests verify that shadow failures leave the forwarded request and response unchanged; that completion occurs only for a successful final assistant reply; and that usage logging still works with shadow mode enabled. Existing lint, build, and test commands must pass.

## Exit condition

PR #10 can be merged after the three changes above are implemented, review findings are resolved, and `npm run check` passes. Real-world completion quality remains a later opt-in pilot; this work does not authorize automatic skill cleanup.

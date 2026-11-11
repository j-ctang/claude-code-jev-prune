# Installation and process lifecycle

Read for bootstrap, install, launcher, CLI tools or shutdown. Inputs by task:

| Task | Source | Tests in `test/` |
| --- | --- | --- |
| Bootstrap/setup | `jev-prune`, `src/setup.ts`, `src/setupCanary.ts`, `src/installation.ts`, `commands/` | `bootstrap.test.ts`, `setupCanary.test.ts`, `slashCommands.test.ts` |
| Shared Claude process | `src/launch.ts`, `src/checkout.ts`, `src/proxyClient.ts`, `src/sessions.ts` | `proxyClient.test.ts`, `sessions.test.ts` |
| Server start/stop | `src/index.ts`, `src/serverLifecycle.ts`, `src/version.ts` | `proxy.test.ts`, `serverLifecycle.test.ts` |
| Diagnostics/totals | `src/doctor.ts`, `src/stats.ts`, `src/services/pruneLog.ts` | `pruneLog.test.ts`, plus isolated manual entry-point checks |

`jev-prune` installs/builds when needed, then runs setup or launches Claude.
Its placeholder-key detection must match `src/config.ts`; bootstrap tests enforce
that duplication. Checkout paths belong in `checkout.ts`, installed Claude paths
in `installation.ts`. Claude loads checkout `.env`; Codex loads current-directory
`.env` through its separate entry point ([Codex](codex.md)).

Claude proxy is detached and shared per port. PID registrations track live
launchers and stale entries; only the last launcher stops the proxy. Watchers
restart a dead proxy. Existing upstream mismatch warns, shadow-mode mismatch
rejects reuse. Building does not replace code in an already-running proxy.
Graceful shutdown has a forced deadline and aborts upstream work when forced.

Setup writes private configuration and installs user-only slash commands;
`disable-model-invocation: true` prevents automatic invocation. Do not exercise
setup against a real home for ordinary verification. Bootstrap tests stub compiled
setup/launch entries: they do not test those mains end-to-end. For authorized
changes there, use temporary home/config, fake CLI and loopback services and
report any remaining manual coverage gap. Doctor can contact TypeSafe.

Output: preserved startup, reuse, exit and cleanup behavior. Use [Testing](testing.md)
and the matching suites; stats/shadow details live in [Observability](observability.md).

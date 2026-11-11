# Codex Responses contract

Read for Codex integration. Inputs by concern: `src/codexLaunch.ts` and
`src/codexLauncher.ts` for lifecycle; `src/codexProxy.ts` for HTTP;
`src/services/responsesPruner.ts` for pruning; `CODEX.md` for operator usage.
Read [Shared core](shared.md) when changing its dependencies.

- Each invocation binds `127.0.0.1:0`, adds invocation-only provider overrides,
  forces HTTP Responses, removes the TypeSafe key from the child environment,
  and closes proxy/child resources on exit. It does not edit Codex config/auth.
  Provider-bypassing flags are rejected; TTY Ctrl-C has special handling.
- Upstream must be HTTPS or loopback HTTP without userinfo/query/fragment.
  Redirects are relayed, not followed. Disconnect/shutdown aborts upstream.
- Buffer at most 32 MiB; only POST `/responses` JSON with absent/identity encoding
  and safe numeric values is considered. Unsupported traffic retains raw bytes.
  Reserialize only when pruning returns a changed object; malformed JSON is forwarded.
- Only full-history array input is supported, without server conversation state.
  Require exactly one preceding matching function/custom call and text-only output.
  Change output only; preserve call arguments, reasoning, metadata and unknown items.
- Disabled/unsupported requests bypass replay. Otherwise replay allowed saved drops
  before threshold/turn gates. A real last-item user goal permits new scoring;
  recognized host context is not a goal. Recency counts all output items, including
  rich and excluded outputs. Eligible kept outputs are rescored on scoring turns.
- Validate every score before new drops. Failure keeps earlier replay, adds no new
  drops. There are no Claude mechanical rewrites, notices, canaries, routing,
  shadow observation, shared-proxy sessions, health counters or stats log here.
- `.env` comes from the current directory. Shared `loadConfig` validates even
  unused Claude settings. Codex decisions use a separate state path.

Output: preserved wire envelopes, raw fallback, and deterministic restart replay.
Run `test/responsesPruner.test.ts`, `test/codexProxy.test.ts`, and
`test/codexLauncher.test.ts` as relevant; shared changes require Claude suites too.
[Testing](testing.md) explains the optional real-CLI offline fixture and live limits.

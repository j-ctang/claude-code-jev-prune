# Verification contract

Read before running or changing checks. Inputs: changed behavior, its guide's
suite list, `package.json`, and `.github/workflows/check.yml`.

- Install locked dependencies with `npm ci`; full check is `npm run check`
  (lint, TypeScript build, Jest). Run it before opening a PR.
- Focused checks: `npm test -- --runTestsByPath test/NAME.test.ts` with the exact
  filenames from the area guide. Run `npm run build` first when including
  `test/proxy.test.ts`: its subprocess uses `dist/index.js`. Codex launcher
  tests build their own entry. Never mistake stale `dist/` for current source.
- Ordinary verification uses dummy keys, injected API responses, blocked
  external networking, and available loopback. The required hosted check is
  `offline-check`: dependencies/image download precede a `--network none`
  container, then a loopback/external-denial probe and the full check.
- To reproduce hosted isolation, read the current image and exact `docker run`
  commands in `.github/workflows/check.yml`; do not copy a drifting image tag.
  For a local OS sandbox, prove loopback success and external TCP denial before
  checking. A dummy key alone does not block networking. Report limitations if
  equivalent isolation cannot be established; never change gates to bypass it.
- Use injected scorers/fetch and loopback servers on OS-allocated ports.
  `test/fixtures/messages.ts` supplies Claude pairing fixtures; `test/tempDir.ts`
  cleans temporary files. Close servers, child processes, timers and streams.
- ESM imports use `.js` source specifiers; `tsconfig.json` emits `dist/`, and
  `jest.config.cjs` maps imports for tests. These configurations are protected.
- `test/manual/codexCli.mjs` is an optional real installed-CLI compatibility
  fixture, not a live-provider check. Build first, block egress, and run
  `node test/manual/codexCli.mjs`, then `JEV_FIXTURE_FAIL_SCORE=1 node test/manual/codexCli.mjs`.
  It creates temporary state and dummy credentials; hosted Jest needs no Codex CLI.

Output: commands, actual results, and coverage limits. Offline structural
checks do not prove live authentication, relevance quality, or realized savings.
Do not weaken, skip, or delete tests; stop after two unsuccessful corrections.

import { summarizeLog } from "../src/logSummary.js";

test("totals prune events and ignores other lines", () => {
  const raw = [
    '{"level":"info","message":"proxy_listening","timestamp":"2026-09-01T00:00:00Z"}',
    '{"level":"info","message":"prune_complete","removedTokens":30000,"timestamp":"2026-09-02T10:00:00Z"}',
    "not json",
    '{"level":"info","message":"prune_complete","timestamp":"2026-09-03T10:00:00Z"}',
    '{"level":"warn","message":"prune_fail_open"}',
    '{"level":"info","message":"prune_complete","removedTokens":12000}',
  ].join("\n");

  expect(summarizeLog(raw)).toEqual({
    prunes: 3,
    tokensRemoved: 42_000,
    failOpens: 1,
    since: "2026-09-02",
  });
});

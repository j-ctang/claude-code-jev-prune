import { recordPruneOutcome, summarizeLog } from "../src/services/pruneLog.js";
import type { PruneResult, ProxyStats } from "../src/types.js";
import type { AppLogger } from "../src/utils/logger.js";

/** A logger that writes JSON lines the way the file logger does. */
function lineLogger(lines: string[]): AppLogger {
  const write =
    (level: string) => (message: string, metadata?: Record<string, unknown>) =>
      lines.push(
        JSON.stringify({
          level,
          message,
          ...metadata,
          timestamp: "2026-09-24T10:00:00Z",
        }),
      );
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    debug: write("debug"),
  };
}

const base: PruneResult = {
  request: { messages: [] },
  beforeTokens: 150_000,
  afterTokens: 100_000,
  evaluated: 4,
  dropped: 2,
  reason: "pruned",
};

test("stats reads back exactly what the proxy recorded", () => {
  const lines: string[] = [];
  const stats: ProxyStats = {
    requests: 0,
    pruningDecisions: 0,
    droppedPairs: 0,
    failOpenEvents: 0,
    prunes: 0,
    tokensRemoved: 0,
  };
  const context = {
    stats,
    logger: lineLogger(lines),
    targetTokens: 80_000,
    durationMs: 5,
  };

  recordPruneOutcome(
    {
      ...base,
      removedTokens: 30_000,
      ...{ typesafeInputTokens: 120, typesafeOutputTokens: 7 },
    },
    context,
  );
  recordPruneOutcome(
    { ...base, reason: "mid-task", evaluated: 0, dropped: 0 },
    context,
  );
  recordPruneOutcome(
    { ...base, reason: "fail-open", evaluated: 0, dropped: 0 },
    context,
  );

  expect(JSON.parse(lines[0]!)).toMatchObject({
    typesafeInputTokens: 120,
    typesafeOutputTokens: 7,
  });
  expect(summarizeLog(lines.join("\n"))).toEqual({
    prunes: 1,
    tokensRemoved: 30_000,
    failOpens: 1,
    typesafeInputTokens: 120,
    typesafeOutputTokens: 7,
    since: "2026-09-24",
  });
  expect(stats).toMatchObject({
    prunes: 1,
    tokensRemoved: 30_000,
    droppedPairs: 2,
    pruningDecisions: 4,
    failOpenEvents: 1,
  });
});

test("skips lines that are not prune events", () => {
  const raw = ['{"level":"info","message":"proxy_listening"}', "not json"].join(
    "\n",
  );

  expect(summarizeLog(raw)).toEqual({
    prunes: 0,
    tokensRemoved: 0,
    failOpens: 0,
    typesafeInputTokens: 0,
    typesafeOutputTokens: 0,
  });
});

test("totals usage while accepting legacy and malformed log metadata", () => {
  const raw = [
    {
      message: "prune_complete",
      typesafeInputTokens: 100,
      typesafeOutputTokens: 2,
    },
    {
      message: "prune_complete",
      typesafeInputTokens: 200,
      typesafeOutputTokens: 3,
    },
    { message: "prune_complete" },
    {
      message: "prune_complete",
      typesafeInputTokens: -1,
      typesafeOutputTokens: "bad",
    },
    {
      message: "prune_fail_open",
      typesafeInputTokens: 50,
      typesafeOutputTokens: 1,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  expect(summarizeLog(raw)).toMatchObject({
    typesafeInputTokens: 350,
    typesafeOutputTokens: 6,
  });
});

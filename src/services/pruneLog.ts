import type { PruneResult, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";

/**
 * The prune events `jev-prune --stats` reads back from the log. They are
 * written and read only in this module, so the two sides cannot drift apart.
 */
const PRUNE_COMPLETE = "prune_complete";
const PRUNE_FAIL_OPEN = "prune_fail_open";

interface PruneCompleteEvent {
  beforeTokens: number;
  afterTokens: number;
  evaluated: number;
  dropped: number;
  removedTokens: number;
  superseded: number;
  trimmed: number;
  manual: boolean;
  durationMs: number;
}

export interface PruneLogContext {
  stats: ProxyStats;
  logger: AppLogger;
  targetTokens: number;
  durationMs: number;
}

/** Adds one prune result to the live counters and the log. */
export function recordPruneOutcome(
  result: PruneResult,
  { stats, logger, targetTokens, durationMs }: PruneLogContext,
): void {
  stats.pruningDecisions += result.evaluated;
  stats.droppedPairs += result.dropped;
  if (result.reason === "fail-open") {
    stats.failOpenEvents += 1;
    logger.warn(PRUNE_FAIL_OPEN, {
      error: result.failureReason ?? "unknown pruning error",
      durationMs,
    });
  } else if (result.resumed) {
    logger.info("resume_notice", { tokens: result.afterTokens });
  } else if (result.reason === "pruned") {
    const removedTokens = result.removedTokens ?? 0;
    stats.prunes += 1;
    stats.tokensRemoved += removedTokens;
    const event: PruneCompleteEvent = {
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      evaluated: result.evaluated,
      dropped: result.dropped,
      removedTokens,
      superseded: result.superseded ?? 0,
      trimmed: result.trimmed ?? 0,
      manual: result.manual ?? false,
      durationMs,
    };
    logger.info(PRUNE_COMPLETE, { ...event });
    if (result.aboveTarget) {
      logger.warn("prune_above_target", {
        afterTokens: result.afterTokens,
        targetTokens,
      });
    }
  }
}

export interface LogSummary {
  prunes: number;
  tokensRemoved: number;
  failOpens: number;
  since?: string;
}

/** Totals the prune events recorded above from the log's JSON lines. */
export function summarizeLog(raw: string): LogSummary {
  const summary: LogSummary = { prunes: 0, tokensRemoved: 0, failOpens: 0 };
  for (const line of raw.split("\n")) {
    let entry: { message?: unknown; timestamp?: unknown } & Partial<
      Record<keyof PruneCompleteEvent, unknown>
    >;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.message === PRUNE_COMPLETE) {
      summary.prunes += 1;
      if (typeof entry.removedTokens === "number")
        summary.tokensRemoved += entry.removedTokens;
      if (!summary.since && typeof entry.timestamp === "string")
        summary.since = entry.timestamp.slice(0, 10);
    } else if (entry.message === PRUNE_FAIL_OPEN) {
      summary.failOpens += 1;
    }
  }
  return summary;
}

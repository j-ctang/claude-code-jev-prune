export interface LogSummary {
  prunes: number;
  tokensRemoved: number;
  failOpens: number;
  since?: string;
}

/** Totals prune events from the proxy's JSON log lines. */
export function summarizeLog(raw: string): LogSummary {
  const summary: LogSummary = { prunes: 0, tokensRemoved: 0, failOpens: 0 };
  for (const line of raw.split("\n")) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.message === "prune_complete") {
      summary.prunes += 1;
      if (typeof entry.removedTokens === "number")
        summary.tokensRemoved += entry.removedTokens;
      if (!summary.since && typeof entry.timestamp === "string")
        summary.since = entry.timestamp.slice(0, 10);
    } else if (entry.message === "prune_fail_open") {
      summary.failOpens += 1;
    }
  }
  return summary;
}

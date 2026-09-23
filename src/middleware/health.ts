import type { RequestHandler } from "express";
import type { Config } from "../config.js";
import type { ProxyStats } from "../types.js";

interface HealthDependencies {
  config: Config;
  stats: ProxyStats;
  startedAt: number;
  version: string;
}

export function createHealthHandler(
  dependencies: HealthDependencies,
): RequestHandler {
  return (_request, response) => {
    response.status(200).json({
      status: "ok",
      proxy_version: dependencies.version,
      jev_configured: Boolean(dependencies.config.jevApiKey),
      pruning_enabled: dependencies.config.pruningEnabled,
      requests: dependencies.stats.requests,
      pruning_decisions: dependencies.stats.pruningDecisions,
      dropped_pairs: dependencies.stats.droppedPairs,
      fail_open_events: dependencies.stats.failOpenEvents,
      uptime_seconds: Math.floor((Date.now() - dependencies.startedAt) / 1_000),
    });
  };
}

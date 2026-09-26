import type { RequestHandler } from "express";
import { withoutCredentials, type Config } from "../config.js";
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
      pid: process.pid,
      jev_configured: Boolean(dependencies.config.jevApiKey),
      pruning_enabled: dependencies.config.pruningEnabled,
      skill_shadow_enabled: dependencies.config.skillShadow,
      upstream: withoutCredentials(dependencies.config.anthropicUpstreamUrl),
      requests: dependencies.stats.requests,
      pruning_decisions: dependencies.stats.pruningDecisions,
      dropped_pairs: dependencies.stats.droppedPairs,
      fail_open_events: dependencies.stats.failOpenEvents,
      prunes: dependencies.stats.prunes,
      tokens_removed: dependencies.stats.tokensRemoved,
      started_at: new Date(dependencies.startedAt).toISOString(),
      uptime_seconds: Math.floor((Date.now() - dependencies.startedAt) / 1_000),
    });
  };
}

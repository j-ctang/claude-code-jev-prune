import express, { type Express } from "express";
import type { Config } from "./config.js";
import { createHealthHandler } from "./middleware/health.js";
import {
  createProxyHandler,
  type ProxyDependencies,
} from "./middleware/proxy.js";
import type { ProxyStats } from "./types.js";
import type { AppLogger } from "./utils/logger.js";
import type { SkillShadowObserver } from "./services/skillShadowObserver.js";
import { VERSION } from "./version.js";

interface AppDependencies {
  config: Config;
  pruner: ProxyDependencies["pruner"];
  fetchFn: typeof fetch;
  logger: AppLogger;
  startedAt: number;
  stats?: ProxyStats;
  version?: string;
  upstreamSignal?: AbortSignal;
  shadowObserver?: SkillShadowObserver;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const stats: ProxyStats = dependencies.stats ?? {
    requests: 0,
    pruningDecisions: 0,
    droppedPairs: 0,
    failOpenEvents: 0,
    prunes: 0,
    tokensRemoved: 0,
  };

  app.disable("x-powered-by");
  app.get(
    "/health",
    createHealthHandler({
      config: dependencies.config,
      stats,
      startedAt: dependencies.startedAt,
      version: dependencies.version ?? VERSION,
    }),
  );
  app.use(express.json({ limit: "32mb" }));
  app.use(
    "/v1",
    createProxyHandler({
      config: dependencies.config,
      pruner: dependencies.pruner,
      fetchFn: dependencies.fetchFn,
      logger: dependencies.logger,
      stats,
      ...(dependencies.shadowObserver ? { shadowObserver: dependencies.shadowObserver } : {}),
      ...(dependencies.upstreamSignal
        ? { upstreamSignal: dependencies.upstreamSignal }
        : {}),
    }),
  );
  return app;
}

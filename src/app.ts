import express, { type Express } from "express";
import type { Config } from "./config.js";
import { createHealthHandler } from "./middleware/health.js";
import { createProxyHandler } from "./middleware/proxy.js";
import { CanaryPolicy } from "./services/canary.js";
import {
  MessagePreparer,
  type RequestPruner,
  type RequestRouter,
} from "./services/messagePreparer.js";
import type { ProxyStats } from "./types.js";
import type { AppLogger } from "./utils/logger.js";
import { VERSION } from "./version.js";

interface AppDependencies {
  config: Config;
  pruner: RequestPruner;
  fetchFn: typeof fetch;
  logger: AppLogger;
  startedAt: number;
  stats?: ProxyStats;
  version?: string;
  upstreamSignal?: AbortSignal;
  router?: RequestRouter;
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
      preparer: new MessagePreparer({
        config: dependencies.config,
        canary: new CanaryPolicy(dependencies.config, dependencies.logger),
        pruner: dependencies.pruner,
        router: dependencies.router,
        logger: dependencies.logger,
        stats,
      }),
      fetchFn: dependencies.fetchFn,
      logger: dependencies.logger,
      stats,
      ...(dependencies.upstreamSignal
        ? { upstreamSignal: dependencies.upstreamSignal }
        : {}),
    }),
  );
  return app;
}

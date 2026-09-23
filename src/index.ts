import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { ContextPruner } from "./services/contextPruner.js";
import { JevService } from "./services/jevService.js";
import { createFileStateStore } from "./services/pruneState.js";
import { shutdownServer } from "./serverLifecycle.js";
import { createLogger } from "./utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;

function start(
  config: Config,
  logger: ReturnType<typeof createLogger>,
): void {
  const scorer = new JevService({
    apiKey: config.jevApiKey ?? "disabled",
    baseUrl: config.jevBaseUrl,
    model: config.jevModel,
    timeoutMs: config.jevTimeoutMs,
    fetchFn: fetch,
  });
  const pruner = new ContextPruner({
    config,
    scorer,
    logger,
    stateStore: createFileStateStore(config.statePath),
  });
  const upstreamAbort = new AbortController();
  const app = createApp({
    config,
    pruner,
    fetchFn: fetch,
    logger,
    startedAt: Date.now(),
    upstreamSignal: upstreamAbort.signal,
  });
  const server = createServer(app);
  let shuttingDown = false;

  server.on("error", (error) => {
    logger.error("proxy_server_error", { error: error.message });
    process.exitCode = 1;
  });
  server.listen(config.port, "127.0.0.1", () => {
    logger.info("proxy_listening", {
      port: config.port,
      pruningEnabled: config.pruningEnabled,
    });
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("proxy_stopping", { signal });
    void shutdownServer(server, {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
      logger,
      onForce: () => upstreamAbort.abort(),
    })
      .then(() => {
        logger.info("proxy_stopped");
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error("proxy_shutdown_failed", {
          error: error instanceof Error ? error.message : "unknown error",
        });
        process.exitCode = 1;
      })
      .finally(() => logger.end());
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

let logger: ReturnType<typeof createLogger> | undefined;
try {
  const config = loadConfig(process.env);
  logger = createLogger({ level: config.debug ? "debug" : "info" });
  start(config, logger);
} catch (error) {
  const failureLogger = logger ?? createLogger();
  failureLogger.error("proxy_startup_failed", {
    error: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
  failureLogger.end();
}

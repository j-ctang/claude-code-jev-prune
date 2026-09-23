import type { Server } from "node:http";
import type { AppLogger } from "./utils/logger.js";

interface ShutdownOptions {
  timeoutMs: number;
  logger: AppLogger;
  onForce?: () => void;
}

export function shutdownServer(
  server: Server,
  options: ShutdownOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      options.logger.warn("proxy_shutdown_forced", {
        timeoutMs: options.timeoutMs,
      });
      options.onForce?.();
      server.closeAllConnections();
    }, options.timeoutMs);
    timeout.unref();

    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });
}

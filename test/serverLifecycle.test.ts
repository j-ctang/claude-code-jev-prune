import { once } from "node:events";
import { get, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { shutdownServer } from "../src/serverLifecycle.js";
import type { AppLogger } from "../src/utils/logger.js";

test("forces active connections closed after the shutdown deadline", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("still running");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const request = get(`http://127.0.0.1:${address.port}/stream`);
  const [activeResponse] = (await once(request, "response")) as [
    import("node:http").IncomingMessage,
  ];
  activeResponse.resume();
  const warnings: Array<{
    message: string;
    metadata: Record<string, unknown> | undefined;
  }> = [];
  const logger: AppLogger = {
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    warn(message, metadata) {
      warnings.push({ message, metadata });
    },
  };
  const startedAt = Date.now();

  let forced = 0;
  await shutdownServer(server, {
    timeoutMs: 25,
    logger,
    onForce: () => {
      forced += 1;
    },
  });

  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(server.listening).toBe(false);
  expect(forced).toBe(1);
  expect(warnings).toEqual([
    {
      message: "proxy_shutdown_forced",
      metadata: { timeoutMs: 25 },
    },
  ]);
});

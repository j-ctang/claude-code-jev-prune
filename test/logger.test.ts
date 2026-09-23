import { once } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/utils/logger.js";

test("writes structured events to an injected log path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-prune-log-"));
  const logPath = join(directory, "nested", "jev-prune.log");
  const logger = createLogger({ logPath, console: false });

  logger.info("prune_complete", { beforeTokens: 100, afterTokens: 60 });
  logger.end();
  await once(logger, "finish");

  const contents = await readFile(logPath, "utf8");
  expect(JSON.parse(contents)).toEqual(
    expect.objectContaining({
      level: "info",
      message: "prune_complete",
      beforeTokens: 100,
      afterTokens: 60,
    }),
  );
  expect((await stat(logPath)).mode & 0o777).toBe(0o600);
});

test("writes debug events when configured for debug level", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-prune-debug-log-"));
  const logPath = join(directory, "jev-prune.log");
  const logger = createLogger({ logPath, console: false, level: "debug" });

  logger.debug("prune_decision", { toolUseId: "call-safe", outcome: "keep" });
  logger.end();
  await once(logger, "finish");

  const contents = await readFile(logPath, "utf8");
  expect(JSON.parse(contents)).toEqual(
    expect.objectContaining({
      level: "debug",
      message: "prune_decision",
      toolUseId: "call-safe",
      outcome: "keep",
    }),
  );
});

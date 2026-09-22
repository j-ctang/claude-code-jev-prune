import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
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
});

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { summarizeLog } from "./logSummary.js";
import { formatTokens, probe } from "./proxyHealth.js";

async function main(): Promise<void> {
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  loadEnv({ path: join(repository, ".env"), quiet: true });
  const logPath = join(homedir(), ".claude", "jev-prune.log");
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    // No log yet means nothing has been pruned.
  }
  const summary = summarizeLog(raw);
  const lines = [
    summary.prunes === 0
      ? "No prunes yet."
      : `${summary.prunes} prune${summary.prunes === 1 ? "" : "s"} since ${summary.since ?? "the log started"}, about ${formatTokens(summary.tokensRemoved)} tokens of stale context removed.`,
  ];
  if (summary.failOpens > 0)
    lines.push(
      `${summary.failOpens} request${summary.failOpens === 1 ? "" : "s"} went through unpruned because TypeSafe did not answer.`,
    );
  const port = process.env.PORT ?? "5590";
  const live = await probe(`http://127.0.0.1:${port}`).catch(() => undefined);
  lines.push(
    live
      ? `Proxy running on port ${port}: ${live.prunes ?? 0} prunes, about ${formatTokens(live.tokens_removed ?? 0)} tokens removed since it started.`
      : "Proxy not running.",
  );
  lines.push(`Log: ${logPath}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main();

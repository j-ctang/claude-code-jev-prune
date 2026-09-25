import { readFileSync } from "node:fs";
import { parsePort } from "./config.js";
import { loadInstallEnv, localProxyClient } from "./checkout.js";
import { logPath } from "./installation.js";
import { summarizeLog } from "./logSummary.js";
import { formatTokens } from "./proxyClient.js";

async function main(): Promise<void> {
  loadInstallEnv();
  const proxy = localProxyClient(parsePort(process.env));
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
  const live = await proxy.probe().catch(() => undefined);
  lines.push(
    live
      ? `Proxy running on port ${proxy.port}: ${live.prunes ?? 0} prunes, about ${formatTokens(live.tokens_removed ?? 0)} tokens removed since it started.`
      : "Proxy not running.",
  );
  lines.push(`Log: ${logPath}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Stats failed"}\n`,
  );
  process.exitCode = 1;
});

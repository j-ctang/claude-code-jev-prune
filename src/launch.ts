import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, parsePort, withoutCredentials } from "./config.js";
import { loadInstallEnv, localProxyClient } from "./checkout.js";
import { sessionsDirectory } from "./installation.js";
import { formatTokens } from "./proxyClient.js";
import {
  liveSessions,
  registerSession,
  unregisterSession,
} from "./sessions.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run claude -- --project /path/to/your/project [Claude Code options]\n",
    );
    return;
  }
  loadInstallEnv();
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf("--project");
  const project = resolve(
    projectIndex >= 0 ? (args.splice(projectIndex, 2)[1] ?? "") : process.cwd(),
  );
  if (!statSync(project).isDirectory())
    throw new Error(`${project} is not a directory`);

  const proxy = localProxyClient(parsePort(process.env));
  const existingBase = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
  if (
    existingBase &&
    !process.env.ANTHROPIC_UPSTREAM_URL &&
    existingBase !== proxy.baseUrl &&
    existingBase !== `http://localhost:${proxy.port}`
  ) {
    // Keep a user's existing gateway as the proxy's upstream.
    process.env.ANTHROPIC_UPSTREAM_URL = existingBase;
  }
  const config = loadConfig(process.env);

  const sessions = sessionsDirectory(proxy.port);
  registerSession(sessions, process.pid, project);
  let stopWatching = () => {};
  try {
    const running = await proxy.probe();
    if (running && proxy.isOutdated(running)) {
      process.stderr.write(
        "Jev Prune was updated. Close all jev-prune sessions to load the new version.\n",
      );
    }
    const upstream = withoutCredentials(config.anthropicUpstreamUrl);
    if (running?.upstream && running.upstream !== upstream) {
      process.stderr.write(
        `Jev Prune is already running and forwards to ${running.upstream}, not ${upstream}. Close all jev-prune sessions to switch.\n`,
      );
    }
    const before = running ?? (await proxy.ensureRunning());
    // Restart the proxy if it dies, so Claude Code does not lose its API.
    stopWatching = proxy.watch();
    const noProxy = [
      process.env.NO_PROXY ?? process.env.no_proxy,
      "127.0.0.1",
      "localhost",
    ]
      .filter(Boolean)
      .join(",");
    const claude = spawn("claude", args, {
      cwd: project,
      stdio: "inherit",
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: proxy.baseUrl,
        // Claude Code turns off deferred tool loading for custom base URLs,
        // which adds every tool definition to context. The proxy keeps
        // tool_reference blocks intact, so turn it back on.
        ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? "true",
        NO_PROXY: noProxy,
        no_proxy: noProxy,
      },
    });
    const forward = (signal: NodeJS.Signals) => claude.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(signal, forward);
    process.exitCode = await new Promise<number>((done, reject) => {
      claude.once("error", () =>
        reject(new Error("Claude Code CLI (`claude`) was not found on PATH")),
      );
      claude.once("exit", (exitCode) => done(exitCode ?? 1));
    });
    const after = await proxy.probe().catch(() => undefined);
    const prunes = (after?.prunes ?? 0) - (before.prunes ?? 0);
    const removed = (after?.tokens_removed ?? 0) - (before.tokens_removed ?? 0);
    if (after && prunes > 0 && after.started_at === before.started_at) {
      process.stderr.write(
        `Jev Prune: pruned ${prunes} time${prunes === 1 ? "" : "s"}, removed about ${formatTokens(removed)} tokens of stale context.\n`,
      );
    }
  } finally {
    stopWatching();
    unregisterSession(sessions, process.pid);
    if (liveSessions(sessions).length === 0) await proxy.stop();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Launch failed"}\n`,
  );
  process.exitCode = 1;
});

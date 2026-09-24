import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadConfig } from "./config.js";
import { formatTokens, probe, type ProxyHealth } from "./proxyHealth.js";
import {
  liveSessions,
  registerSession,
  unregisterSession,
} from "./sessions.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

/** A proxy started before the last build still runs the old code. */
function isOutdated(health: ProxyHealth): boolean {
  if (!health.started_at) return false;
  try {
    const built = statSync(join(repository, "dist", "index.js")).mtimeMs;
    return built > Date.parse(health.started_at);
  } catch {
    return false;
  }
}

async function startProxy(baseUrl: string): Promise<void> {
  // Detached so the proxy outlives this launcher while other terminals use it.
  const proxy = spawn(
    process.execPath,
    [fileURLToPath(new URL("./index.js", import.meta.url))],
    { cwd: repository, detached: true, stdio: "ignore", env: process.env },
  );
  let exited = false;
  proxy.once("exit", () => {
    exited = true;
  });
  proxy.unref();
  for (let attempt = 0; attempt < 50 && !exited; attempt += 1) {
    await new Promise((done) => setTimeout(done, 100));
    if (await probe(baseUrl).catch(() => undefined)) return;
  }
  throw new Error(
    "Jev Prune proxy did not start; check ~/.claude/jev-prune.log",
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run claude -- --project /path/to/your/project [Claude Code options]\n",
    );
    return;
  }
  loadEnv({ path: join(repository, ".env") });
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf("--project");
  const project = resolve(
    projectIndex >= 0 ? (args.splice(projectIndex, 2)[1] ?? "") : process.cwd(),
  );
  if (!statSync(project).isDirectory())
    throw new Error(`${project} is not a directory`);

  const port = loadConfig(process.env).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const existingBase = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");
  if (
    existingBase &&
    !process.env.ANTHROPIC_UPSTREAM_URL &&
    existingBase !== baseUrl &&
    existingBase !== `http://localhost:${port}`
  ) {
    // Keep a user's existing gateway as the proxy's upstream.
    process.env.ANTHROPIC_UPSTREAM_URL = existingBase;
  }
  loadConfig(process.env);

  const sessions = join(
    homedir(),
    ".claude",
    "jev-prune-sessions",
    String(port),
  );
  registerSession(sessions, process.pid);
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const running = await probe(baseUrl);
    if (running && isOutdated(running)) {
      process.stderr.write(
        "Jev Prune was updated. Close all jev-prune sessions to load the new version.\n",
      );
    }
    if (!running) await startProxy(baseUrl);
    const before = running ?? (await probe(baseUrl)) ?? {};
    // Restart the proxy if it dies, so Claude Code does not lose its API.
    let restarting = false;
    watchdog = setInterval(() => {
      if (restarting) return;
      restarting = true;
      void probe(baseUrl)
        .then((health) => (health ? undefined : startProxy(baseUrl)))
        .catch(() => undefined)
        .finally(() => {
          restarting = false;
        });
    }, 5_000);
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
        ANTHROPIC_BASE_URL: baseUrl,
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
    const after = await probe(baseUrl).catch(() => undefined);
    const prunes = (after?.prunes ?? 0) - (before.prunes ?? 0);
    const removed = (after?.tokens_removed ?? 0) - (before.tokens_removed ?? 0);
    if (after && prunes > 0 && after.started_at === before.started_at) {
      process.stderr.write(
        `Jev Prune: pruned ${prunes} time${prunes === 1 ? "" : "s"}, removed about ${formatTokens(removed)} tokens of stale context.\n`,
      );
    }
  } finally {
    clearInterval(watchdog);
    unregisterSession(sessions, process.pid);
    if (liveSessions(sessions).length === 0) {
      const pid = (await probe(baseUrl).catch(() => undefined))?.pid;
      if (pid) process.kill(pid, "SIGTERM");
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Launch failed"}\n`,
  );
  process.exitCode = 1;
});

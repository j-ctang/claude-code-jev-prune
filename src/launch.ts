import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadConfig } from "./config.js";
import {
  liveSessions,
  registerSession,
  unregisterSession,
} from "./sessions.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

interface ProxyHealth {
  pid?: number;
}

/** Returns the running proxy's health, undefined if the port is free. */
async function probe(baseUrl: string): Promise<ProxyHealth | undefined> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`);
  } catch {
    return undefined;
  }
  const body = (await response.json().catch(() => undefined)) as
    | { status?: unknown; proxy_version?: unknown; pid?: unknown }
    | undefined;
  if (body?.status !== "ok" || typeof body.proxy_version !== "string") {
    throw new Error(
      `Port ${new URL(baseUrl).port} is used by another program. Set PORT in ${join(repository, ".env")}.`,
    );
  }
  return typeof body.pid === "number" ? { pid: body.pid } : {};
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

  const sessions = join(homedir(), ".claude", "jev-prune-sessions", String(port));
  registerSession(sessions, process.pid);
  try {
    if (!(await probe(baseUrl))) await startProxy(baseUrl);
    const claude = spawn("claude", args, {
      cwd: project,
      stdio: "inherit",
      env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl },
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
  } finally {
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

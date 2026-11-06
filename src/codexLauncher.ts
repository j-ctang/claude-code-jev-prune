import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createCodexServer } from "./codexProxy.js";
import { JevService } from "./services/jevService.js";
import { JevRelevanceScorer } from "./services/relevanceScorer.js";
import { ResponsesPruner } from "./services/responsesPruner.js";
import { createFileStateStore } from "./services/pruneState.js";

/** A separate proxy per invocation keeps provider routing out of persistent config. */
export async function launchCodex(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  if (
    args.some((arg) =>
      /^(?:-c.*|--config(?:=|$)|-p.*|--profile(?:=|$)|--oss$|--local-provider(?:=|$))/.test(
        arg,
      ),
    )
  ) {
    throw new Error(
      "Provider routing overrides (-c, --config, -p, --profile, --oss, --local-provider) are unsupported by this launcher",
    );
  }
  const config = loadConfig(env);
  const statePath =
    env.JEV_CODEX_STATE_PATH ||
    join(homedir(), ".local", "state", "jev-prune", "codex-state.json");
  const pruner = new ResponsesPruner({
    config,
    scorer: new JevRelevanceScorer(
      new JevService({
        apiKey: config.jevApiKey ?? "disabled",
        baseUrl: config.jevBaseUrl,
        model: config.jevModel,
        timeoutMs: config.jevTimeoutMs,
        fetchFn: fetch,
      }),
    ),
    stateStore: createFileStateStore(statePath),
  });
  const abort = new AbortController();
  const server = createCodexServer({
    upstreamUrl:
      env.JEV_CODEX_UPSTREAM_URL || "https://chatgpt.com/backend-api/codex",
    pruner: {
      prune: async (body) => {
        const result = await pruner.prune(body);
        if (result.dropped > 0)
          process.stderr.write(
            `Jev Prune: replaced ${result.dropped} old outputs; approximately ${result.beforeTokens - result.afterTokens} tokens removed.\n`,
          );
        if (result.reason === "fail-open")
          process.stderr.write(
            "Jev Prune: scoring failed; kept unscored outputs.\n",
          );
        return result;
      },
    },
    fetchFn: fetch,
    signal: abort.signal,
  });
  let cleanupSignals = () => {};
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Proxy did not bind");
    const overrides = [
      'model_provider="jev_prune"',
      'model_providers.jev_prune.name="Jev Prune"',
      `model_providers.jev_prune.base_url="http://127.0.0.1:${address.port}"`,
      'model_providers.jev_prune.wire_api="responses"',
      "model_providers.jev_prune.requires_openai_auth=true",
      "model_providers.jev_prune.supports_websockets=false",
    ].flatMap((value) => ["-c", value]);
    if (!config.pruningEnabled)
      process.stderr.write(
        "Jev Prune: pruning disabled; testing proxy transport only.\n",
      );
    const noProxy = [
      env.NO_PROXY,
      env.no_proxy,
      "127.0.0.1",
      "localhost",
      "::1",
    ]
      .filter(Boolean)
      .join(",");
    const childEnv = { ...env, NO_PROXY: noProxy, no_proxy: noProxy };
    delete childEnv.TYPESAFE_API_KEY;
    const child = spawn("codex", [...overrides, ...args], {
      stdio: "inherit",
      env: childEnv,
    });
    let interrupted: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => {
      // A terminal sends Ctrl-C to both processes; let Codex handle its first Ctrl-C.
      if (name === "SIGINT" && process.stdin.isTTY) return;
      interrupted = name === "SIGINT" ? 130 : name === "SIGHUP" ? 129 : 143;
      child.kill(name);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
      process.on(name, signal);
    cleanupSignals = () => {
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.off(name, signal);
      if (killTimer) clearTimeout(killTimer);
    };
    return await new Promise<number>((resolve, reject) => {
      child.once("error", () =>
        reject(
          new Error("Codex CLI (`codex`) was not found or could not start"),
        ),
      );
      child.once("exit", (code, name) =>
        resolve(
          interrupted ??
            code ??
            (name === "SIGINT" ? 130 : name === "SIGTERM" ? 143 : 1),
        ),
      );
    });
  } finally {
    cleanupSignals();
    abort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

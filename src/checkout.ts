import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { ProxyClientDependencies } from "./proxyClient.js";

/** The Jev Prune checkout; compiled files live one level down in dist/. */
export const repository = dirname(dirname(fileURLToPath(import.meta.url)));

export const envPath = join(repository, ".env");

/** Loads the checkout's `.env` into `process.env`; set variables win. */
export function loadInstallEnv(): void {
  loadEnv({ path: envPath, quiet: true });
}

/** Starts and inspects the proxy built in this checkout. */
export const localProxy: Pick<
  ProxyClientDependencies,
  "startProcess" | "builtAt"
> = {
  startProcess() {
    // Detached so the proxy outlives this launcher while other terminals use it.
    const proxy = spawn(
      process.execPath,
      [join(repository, "dist", "index.js")],
      {
        cwd: repository,
        detached: true,
        stdio: "ignore",
        env: process.env,
      },
    );
    let exited = false;
    proxy.once("exit", () => {
      exited = true;
    });
    proxy.unref();
    return { exited: () => exited };
  },
  builtAt() {
    try {
      return statSync(join(repository, "dist", "index.js")).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

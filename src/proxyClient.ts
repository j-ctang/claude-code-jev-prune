import { logPath } from "./installation.js";

/** Health of a running Jev Prune proxy, as reported by GET /health. */
export interface ProxyHealth {
  pid?: number;
  prunes?: number;
  tokens_removed?: number;
  started_at?: string;
  upstream?: string;
}

export interface ProxyClientDependencies {
  fetch: typeof fetch;
  /** Starts a proxy that outlives this process; reports if it died early. */
  startProcess: () => { exited: () => boolean };
  sleep: (milliseconds: number) => Promise<void>;
  /** When `dist/index.js` was last built, if known. */
  builtAt: () => number | undefined;
}

/** Talks to the shared proxy on one port: finds it, starts it, stops it. */
export class ProxyClient {
  readonly baseUrl: string;
  private readonly dependencies: ProxyClientDependencies;

  constructor(
    readonly port: number,
    dependencies: Pick<ProxyClientDependencies, "startProcess" | "builtAt"> &
      Partial<ProxyClientDependencies>,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.dependencies = {
      fetch: globalThis.fetch,
      sleep: (milliseconds) =>
        new Promise((done) => setTimeout(done, milliseconds)),
      ...dependencies,
    };
  }

  /**
   * Returns the running proxy's health, or undefined if the port is free.
   * Throws if another program holds the port.
   */
  async probe(): Promise<ProxyHealth | undefined> {
    let response: Response;
    try {
      response = await this.dependencies.fetch(`${this.baseUrl}/health`);
    } catch {
      return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as
      (ProxyHealth & { status?: unknown; proxy_version?: unknown }) | undefined;
    if (body?.status !== "ok" || typeof body.proxy_version !== "string") {
      throw new Error(
        `Port ${this.port} is used by another program. Set PORT in .env.`,
      );
    }
    return body;
  }

  /** Returns the running proxy's health, starting the proxy if needed. */
  async ensureRunning(): Promise<ProxyHealth> {
    const running = await this.probe();
    if (running) return running;
    const proxy = this.dependencies.startProcess();
    for (let attempt = 0; attempt < 50 && !proxy.exited(); attempt += 1) {
      await this.dependencies.sleep(100);
      const health = await this.probe().catch(() => undefined);
      if (health) return health;
    }
    throw new Error(`Jev Prune proxy did not start; check ${logPath}`);
  }

  /** Restarts the proxy whenever it dies. Returns a function that stops. */
  watch(intervalMilliseconds = 5_000): () => void {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.ensureRunning()
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, intervalMilliseconds);
    return () => clearInterval(timer);
  }

  /** A proxy started before the last build still runs the old code. */
  isOutdated(health: ProxyHealth): boolean {
    const built = this.dependencies.builtAt();
    if (!health.started_at || built === undefined) return false;
    return built > Date.parse(health.started_at);
  }

  async stop(): Promise<void> {
    const pid = (await this.probe().catch(() => undefined))?.pid;
    if (pid) process.kill(pid, "SIGTERM");
  }
}

export function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : String(tokens);
}

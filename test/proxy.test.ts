import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { ContextPruner } from "../src/services/contextPruner.js";
import type {
  AnthropicRequest,
  ProxyStats,
  RelevanceScorer,
} from "../src/types.js";
import { allToolUseIds, twoToolRequest } from "./fixtures/messages.js";

interface CapturedUpstreamRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: unknown;
}

interface FakeUpstream {
  url: string;
  requests: CapturedUpstreamRequest[];
  close(): Promise<void>;
}

const openUpstreams: FakeUpstream[] = [];

async function startUpstream(
  respond: (
    request: CapturedUpstreamRequest,
    response: ServerResponse,
  ) => void,
): Promise<FakeUpstream> {
  const requests: CapturedUpstreamRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const captured: CapturedUpstreamRequest = {
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      };
      requests.push(captured);
      respond(captured, response);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const upstream: FakeUpstream = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
  openUpstreams.push(upstream);
  return upstream;
}

function testConfig(
  upstreamUrl: string,
  overrides: Partial<Config> = {},
): Config {
  return {
    port: 5590,
    pruningEnabled: true,
    pruneThreshold: 0,
    triggerTokens: 1_000_000,
    keepRecent: 0,
    excludeTools: new Set(),
    debug: false,
    jevApiKey: "typesafe-secret",
    jevBaseUrl: "https://api.typesafe.ai",
    jevModel: "jev-latest",
    jevTimeoutMs: 2_000,
    anthropicUpstreamUrl: upstreamUrl,
    ...overrides,
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function appFor(
  upstreamUrl: string,
  scorer: RelevanceScorer,
  overrides: Partial<Config> = {},
) {
  const config = testConfig(upstreamUrl, overrides);
  const pruner = new ContextPruner({ config, scorer });
  return createApp({
    config,
    pruner,
    fetchFn: fetch,
    logger: silentLogger,
    startedAt: Date.now() - 42_000,
  });
}

afterEach(async () => {
  await Promise.all(openUpstreams.splice(0).map((upstream) => upstream.close()));
});

describe("Anthropic proxy", () => {
  test("forwards Anthropic headers and the pruned messages body", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_test", type: "message" }));
    });
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        return new Map(candidates.map((candidate) => [candidate.toolUseId, 0.1]));
      },
    };
    const app = appFor(upstream.url, scorer);

    const response = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "anthropic-secret")
      .set("anthropic-version", "2023-06-01")
      .set("x-typesafe-api-key", "must-not-leak")
      .send(twoToolRequest);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "msg_test", type: "message" });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe(
      "anthropic-secret",
    );
    expect(upstream.requests[0]?.headers["anthropic-version"]).toBe(
      "2023-06-01",
    );
    expect(upstream.requests[0]?.headers["x-typesafe-api-key"]).toBeUndefined();
    expect(
      allToolUseIds(upstream.requests[0]?.body as AnthropicRequest),
    ).toEqual([]);
  });

  test("forwards the original body when relevance scoring fails", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const scorer: RelevanceScorer = {
      async score() {
        throw new Error("TypeSafe timeout");
      },
    };
    const app = appFor(upstream.url, scorer);

    await request(app).post("/v1/messages").send(twoToolRequest).expect(200);

    expect(upstream.requests[0]?.body).toEqual(twoToolRequest);
  });

  test("passes non-message Anthropic routes through unchanged", async () => {
    const upstream = await startUpstream((incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: incoming.url }));
    });
    const scorer: RelevanceScorer = {
      async score() {
        throw new Error("scorer must not be called");
      },
    };
    const body = { model: "claude-sonnet-4-5", messages: [] };
    const app = appFor(upstream.url, scorer);

    const response = await request(app)
      .post("/v1/messages/count_tokens?beta=true")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ path: "/v1/messages/count_tokens?beta=true" });
    expect(upstream.requests[0]?.body).toEqual(body);
  });

  test("relays upstream error status and response body", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3",
      });
      response.end(JSON.stringify({ error: { type: "rate_limit_error" } }));
    });
    const app = appFor(
      upstream.url,
      { async score() { return new Map(); } },
      { pruningEnabled: false },
    );

    const response = await request(app).post("/v1/messages").send(twoToolRequest);

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("3");
    expect(response.body).toEqual({ error: { type: "rate_limit_error" } });
  });

  test("relays a complete server-sent event response", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setImmediate(() => response.end("data: second\n\n"));
    });
    const app = appFor(
      upstream.url,
      { async score() { return new Map(); } },
      { pruningEnabled: false },
    );
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(twoToolRequest),
        },
      );

      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("returns 502 when the Anthropic upstream is unreachable", async () => {
    const app = appFor(
      "http://127.0.0.1:1",
      { async score() { return new Map(); } },
      { pruningEnabled: false },
    );

    const response = await request(app).post("/v1/messages").send(twoToolRequest);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "Anthropic upstream unavailable" });
  });

  test("reports process health and live counters", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.end("{}");
    });
    const stats: ProxyStats = {
      requests: 7,
      pruningDecisions: 3,
      droppedPairs: 2,
      failOpenEvents: 1,
    };
    const config = testConfig(upstream.url);
    const pruner = new ContextPruner({
      config,
      scorer: { async score() { return new Map(); } },
    });
    const app = createApp({
      config,
      pruner,
      fetchFn: fetch,
      logger: silentLogger,
      startedAt: Date.now() - 42_000,
      stats,
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      proxy_version: "1.0.0",
      jev_configured: true,
      pruning_enabled: true,
      requests: 7,
      pruning_decisions: 3,
      dropped_pairs: 2,
      fail_open_events: 1,
      uptime_seconds: expect.any(Number),
    });
    expect(response.body.uptime_seconds).toBeGreaterThanOrEqual(42);
  });

  test("rejects malformed JSON locally", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.end("must not be reached");
    });
    const app = appFor(upstream.url, { async score() { return new Map(); } });

    const response = await request(app)
      .post("/v1/messages")
      .set("content-type", "application/json")
      .send('{"messages":');

    expect(response.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });
});

test(
  "starts from the built entry point and exits cleanly on SIGTERM",
  async () => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as AddressInfo).port;
    reservation.close();
    await once(reservation, "close");
    const temporaryHome = await mkdtemp(join(tmpdir(), "jev-prune-home-"));
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: temporaryHome,
        PORT: String(port),
        JEV_PRUNE_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!output.includes("proxy_listening") && Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`Proxy exited before startup: ${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(output).toContain("proxy_listening");

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual(
        expect.objectContaining({
          status: "ok",
          pruning_enabled: false,
        }),
      );

      child.kill("SIGTERM");
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ code, signal }).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  10_000,
);

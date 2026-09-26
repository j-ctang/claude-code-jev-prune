import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { PruneError } from "../src/errors.js";
import { ContextPruner } from "../src/services/contextPruner.js";
import { SkillShadow } from "../src/services/skillShadow.js";
import type {
  AnthropicRequest,
  ProxyStats,
  RelevanceScorer,
} from "../src/types.js";
import type { AppLogger } from "../src/utils/logger.js";
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
    targetTokens: 0,
    rescoreTokens: 0,
    resumeNoticeTokens: 0,
    statePath: "/nonexistent/jev-prune-state.json",
    supersede: false,
    trim: false,
    trimTools: new Set(["Bash"]),
    trimMinTokens: 10_000,
    trimKeepTokens: 2_000,
    notify: false,
    skillShadow: false,
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

const silentLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function appFor(
  upstreamUrl: string,
  scorer: RelevanceScorer,
  overrides: Partial<Config> = {},
  logger: AppLogger = silentLogger,
  shadow?: SkillShadow,
) {
  const config = testConfig(upstreamUrl, overrides);
  const pruner = new ContextPruner({ config, scorer });
  return createApp({
    config,
    pruner,
    fetchFn: fetch,
    logger,
    startedAt: Date.now() - 42_000,
    ...(shadow ? { shadow } : {}),
  });
}

afterEach(async () => {
  await Promise.all(openUpstreams.splice(0).map((upstream) => upstream.close()));
});

describe("Anthropic proxy", () => {
  test("shadow mode ignores skill text removed by the existing pruner", async () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-pruned-"));
    const skillBody = "Follow this detailed procedure whenever you prepare a report. Check every section carefully and verify the final output before delivering it.";
    mkdirSync(join(root, "report"));
    writeFileSync(join(root, "report", "SKILL.md"), `---\nname: report\n---\n${skillBody}`);
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] }));
    });
    const messages: string[] = [];
    const logger: AppLogger = { ...silentLogger, info: (message) => { messages.push(message); } };
    const config = testConfig(upstream.url, { skillShadow: true });
    const shadow = new SkillShadow({ roots: [root], judge: async () => 0.99 });
    const pruned = { messages: [{ role: "user" as const, content: "Create report." }] };
    try {
      await request(createApp({
        config, shadow, logger, fetchFn: fetch, startedAt: Date.now(),
        pruner: { prune: async () => ({ request: pruned, beforeTokens: 0, afterTokens: 0, evaluated: 0, dropped: 0, reason: "disabled" }) },
      }))
        .post("/v1/messages")
        .set("x-claude-code-session-id", "session-a")
        .send({ messages: [{ role: "user", content: `Create report.\n${skillBody}` }] })
        .expect(200);
      expect(upstream.requests[0]?.body).toEqual(pruned);
      expect(messages).not.toContain("skill_shadow_observed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("shadow mode observes a skill without changing the forwarded request", async () => {
    const root = mkdtempSync(join(tmpdir(), "shadow-proxy-"));
    const skillBody = "Follow this lengthy procedure to make the report. Check each page, record every finding, and verify the final artifact before delivering it.";
    mkdirSync(join(root, "report"));
    writeFileSync(join(root, "report", "SKILL.md"), `---\nname: report\n---\n${skillBody}`);
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "Report complete." }] }));
    });
    const events: string[] = [];
    const logger: AppLogger = { ...silentLogger, info: (message) => { events.push(message); } };
    const shadow = new SkillShadow({ roots: [root], judge: async () => 0.99 });
    const body = { messages: [{ role: "user", content: `Create a report.\n${skillBody}` }] };
    try {
      await request(appFor(upstream.url, { score: async () => new Map() }, { skillShadow: true }, logger, shadow))
        .post("/v1/messages")
        .set("x-claude-code-session-id", "session-a")
        .send(body)
        .expect(200);
      expect(upstream.requests[0]?.body).toEqual(body);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toContain("skill_shadow_complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("adds pruning notices to the user turn only when notices are on", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            candidate.toolUseId === "call-old" ? 0.1 : 0.9,
          ]),
        );
      },
    };

    await request(appFor(upstream.url, scorer, { notify: true }))
      .post("/v1/messages")
      .send(twoToolRequest);
    await request(appFor(upstream.url, scorer, { notify: false }))
      .post("/v1/messages")
      .send(twoToolRequest);

    const lastTurn = (index: number) =>
      JSON.stringify(
        (upstream.requests[index]?.body as AnthropicRequest).messages.at(-1),
      );
    expect(lastTurn(0)).toContain("[jev-prune] Pruned 1 stale tool result");
    expect(lastTurn(1)).not.toContain("[jev-prune]");
  });

  test("suggests manual pruning after repeated configured canary misses", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = appFor(
      upstream.url,
      {
        async score() {
          return new Map();
        },
      },
      {
        canaryPrefix: "Yo:",
        pruneThreshold: 1_000_000,
        notify: true,
      },
    );
    const first: AnthropicRequest = {
      messages: [
        { role: "assistant", content: "First reply" },
        { role: "user", content: "Continue" },
      ],
    };
    const second: AnthropicRequest = {
      messages: [
        ...first.messages.slice(0, 1),
        { role: "user", content: "Another request" },
        { role: "assistant", content: "Second reply" },
        { role: "user", content: "Continue again" },
      ],
    };
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(first);
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(second);

    expect(JSON.stringify(upstream.requests[1]?.body)).toContain("/jev-prune");
  });

  test("automatically requests a prune on the second canary miss when opted in", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = appFor(
      upstream.url,
      {
        async score(_goal, candidates) {
          return new Map(
            candidates.map((candidate) => [candidate.toolUseId, 0.1]),
          );
        },
      },
      {
        canaryPrefix: "Yo:",
        canaryAction: "prune",
        pruneThreshold: 1_000_000,
      },
    );
    const first = structuredClone(twoToolRequest);
    first.messages.splice(-1, 0, { role: "assistant", content: "First reply" });
    const second = structuredClone(first);
    second.messages.splice(-1, 0, {
      role: "assistant",
      content: "Second reply",
    });

    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(first);
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(second);

    expect(
      allToolUseIds(upstream.requests[0]?.body as AnthropicRequest),
    ).toEqual(["call-old", "call-new"]);
    expect(
      allToolUseIds(upstream.requests[1]?.body as AnthropicRequest),
    ).toEqual([]);
  });

  test("slash command enables automatic canary pruning for future misses", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const statePath = join(
      await mkdtemp(join(tmpdir(), "jev-canary-command-")),
      "state.json",
    );
    const app = appFor(
      upstream.url,
      {
        async score(_goal, candidates) {
          return new Map(
            candidates.map((candidate) => [candidate.toolUseId, 0.1]),
          );
        },
      },
      {
        canaryPrefix: "Yo:",
        canaryAction: "notice",
        pruneThreshold: 1_000_000,
        statePath,
      },
    );
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send({
        messages: [
          {
            role: "user",
            content: "<command-name>/jev-prune-auto</command-name>",
          },
        ],
      });
    const first = structuredClone(twoToolRequest);
    first.messages.splice(-1, 0, { role: "assistant", content: "First reply" });
    const second = structuredClone(first);
    second.messages.splice(-1, 0, {
      role: "assistant",
      content: "Second reply",
    });
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(first);
    await request(app)
      .post("/v1/messages")
      .set("x-claude-code-session-id", "s")
      .send(second);

    expect(
      allToolUseIds(upstream.requests[2]?.body as AnthropicRequest),
    ).toEqual([]);
  });

  test("slash command returns automatic canary handling to suggestions", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const statePath = join(await mkdtemp(join(tmpdir(), "jev-canary-off-")), "state.json");
    const app = appFor(upstream.url, {
      async score(_goal, candidates) {
        return new Map(candidates.map((candidate) => [candidate.toolUseId, 0.1]));
      },
    }, { canaryPrefix: "Yo:", canaryAction: "prune", pruneThreshold: 1_000_000, statePath });
    await request(app).post("/v1/messages").set("x-claude-code-session-id", "s")
      .send({ messages: [{ role: "user", content: "<command-name>/jev-prune-auto-off</command-name>" }] });
    const first = structuredClone(twoToolRequest);
    first.messages.splice(-1, 0, { role: "assistant", content: "First reply" });
    const second = structuredClone(first);
    second.messages.splice(-1, 0, { role: "assistant", content: "Second reply" });
    await request(app).post("/v1/messages").set("x-claude-code-session-id", "s").send(first);
    await request(app).post("/v1/messages").set("x-claude-code-session-id", "s").send(second);

    expect(allToolUseIds(upstream.requests[2]?.body as AnthropicRequest)).toEqual(["call-old", "call-new"]);
  });

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
        throw new PruneError("TypeSafe timeout");
      },
    };
    const warnings: Array<{
      message: string;
      metadata: Record<string, unknown> | undefined;
    }> = [];
    const logger: AppLogger = {
      ...silentLogger,
      warn(message, metadata) {
        warnings.push({ message, metadata });
      },
    };
    const app = appFor(upstream.url, scorer, {}, logger);

    await request(app).post("/v1/messages").send(twoToolRequest).expect(200);

    expect(upstream.requests[0]?.body).toEqual(twoToolRequest);
    expect(warnings).toEqual([
      {
        message: "prune_fail_open",
        metadata: expect.objectContaining({
          error: "TypeSafe timeout",
          durationMs: expect.any(Number),
        }) as Record<string, unknown>,
      },
    ]);
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

  test("logs input and cache usage from JSON and streamed responses", async () => {
    const usage = {
      input_tokens: 12,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 300,
      output_tokens: 5,
    };
    const upstream = await startUpstream((incoming, response) => {
      const body = incoming.body as { stream?: boolean };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: message_start\n");
        response.write(
          `data: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n`,
        );
        response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "message", usage }));
    });
    const events: Array<Record<string, unknown> | undefined> = [];
    const logger: AppLogger = {
      ...silentLogger,
      info(message, metadata) {
        if (message === "anthropic_usage") events.push(metadata);
      },
    };
    const app = appFor(
      upstream.url,
      { async score() { return new Map(); } },
      { pruningEnabled: false },
      logger,
    );

    const json = await request(app).post("/v1/messages").send(twoToolRequest);
    const streamed = await request(app)
      .post("/v1/messages")
      .send({ ...twoToolRequest, stream: true });

    expect(json.body).toEqual({ type: "message", usage });
    expect(streamed.text).toContain("message_stop");
    const expected = {
      status: 200,
      inputTokens: 12,
      cacheReadInputTokens: 90_000,
      cacheCreationInputTokens: 300,
      totalInputTokens: 90_312,
    };
    expect(events).toEqual([expected, expected]);
  });

  test("strips static and Connection-declared hop-by-hop headers", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        connection: "x-upstream-private",
        "keep-alive": "timeout=5",
        "x-upstream-private": "must-not-reach-client",
      });
      response.end("{}");
    });
    const app = appFor(
      upstream.url,
      { async score() { return new Map(); } },
      { pruningEnabled: false },
    );

    const response = await request(app)
      .post("/v1/messages/count_tokens")
      .set("connection", "x-client-private")
      .set("keep-alive", "timeout=5")
      .set("x-client-private", "must-not-reach-upstream")
      .send({ messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers["keep-alive"]).toBeUndefined();
    expect(upstream.requests[0]?.headers["x-client-private"]).toBeUndefined();
    expect(response.headers["x-upstream-private"]).toBeUndefined();
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

  test("counts prunes and newly removed tokens in health", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = appFor(upstream.url, {
      async score(_goal, candidates) {
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            candidate.toolUseId === "call-old" ? 0 : 1,
          ]),
        );
      },
    });

    await request(app).post("/v1/messages").send(twoToolRequest);
    const health = await request(app).get("/health");

    expect(health.body.prunes).toBe(1);
    expect(health.body.tokens_removed).toBeGreaterThan(0);
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
      prunes: 4,
      tokensRemoved: 5_000,
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
      version: "9.8.7-test",
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      proxy_version: "9.8.7-test",
      pid: process.pid,
      jev_configured: true,
      pruning_enabled: true,
      upstream: upstream.url,
      requests: 7,
      pruning_decisions: 3,
      dropped_pairs: 2,
      fail_open_events: 1,
      prunes: 4,
      tokens_removed: 5_000,
      started_at: expect.any(String),
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

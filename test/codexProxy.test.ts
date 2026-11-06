import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createCodexServer } from "../src/codexProxy.js";
import { ResponsesPruner } from "../src/services/responsesPruner.js";
import { loadConfig } from "../src/config.js";
import { DROPPED_STUB } from "../src/services/toolPairs.js";

const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .reverse()
      .map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );
});
const unchanged = {
  prune: async (body: Record<string, unknown>) => ({ request: body }),
};
async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  pruner = unchanged,
) {
  const upstream = await listen(createServer(handler));
  const url = await listen(
    createCodexServer({
      upstreamUrl: upstream + "/v1",
      pruner,
      fetchFn: fetch,
    }),
  );
  return { url, upstream };
}
const oldOutput = "stale tool output ".repeat(500);
const payload = {
  model: "test",
  input: [
    {
      type: "custom_tool_call",
      name: "exec",
      call_id: "old",
      input: "text(1)",
    },
    { type: "custom_tool_call_output", call_id: "old", output: oldOutput },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "New task" }],
    },
  ],
};

it("prunes real Responses input and preserves upstream status and headers", async () => {
  let received = "";
  const config = loadConfig({
    TYPESAFE_API_KEY: "dummy",
    JEV_PRUNE_THRESHOLD: "0",
    JEV_PRUNE_TARGET_TOKENS: "0",
    JEV_PRUNE_KEEP_RECENT: "0",
  });
  const pruner = new ResponsesPruner({
    config,
    scorer: { score: async () => new Map([["old", 0.1]]) },
  });
  const { url } = await fixture(async (req, res) => {
    for await (const chunk of req) received += chunk;
    res.writeHead(201, { "x-request-id": "upstream" }).end("OK");
  }, pruner);
  const response = await fetch(url + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-request-id")).toBe("upstream");
  expect(await response.text()).toBe("OK");
  expect(JSON.parse(received).input[1].output).toBe(DROPPED_STUB);
  expect(JSON.parse(received).input[0]).toEqual(payload.input[0]);
});

it.each([
  "{ invalid JSON",
  '{ "input": [], "large": 9007199254740993 }',
  JSON.stringify({ input: "hello", padding: "x".repeat(200000) }),
])("preserves unchanged/invalid bytes including large bodies", async (raw) => {
  let received = "";
  const { url } = await fixture(async (req, res) => {
    for await (const chunk of req) received += chunk;
    res.end("OK");
  });
  await (
    await fetch(url + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    })
  ).text();
  expect(received).toBe(raw);
});

it("passes compressed bytes, encoding, path/query and account headers unchanged", async () => {
  const raw = gzipSync(JSON.stringify(payload));
  let received = Buffer.alloc(0);
  const { url } = await fixture(async (req, res) => {
    expect(req.url).toBe("/v1/responses?trace=1");
    expect(req.headers["content-encoding"]).toBe("gzip");
    expect(req.headers.authorization).toBe("Bearer dummy");
    expect(req.headers["chatgpt-account-id"]).toBe("dummy-account");
    expect(req.headers["x-typesafe-api-key"]).toBeUndefined();
    for await (const chunk of req) received = Buffer.concat([received, chunk]);
    res.writeHead(401).end("denied");
  });
  const response = await fetch(url + "/responses?trace=1", {
    method: "POST",
    headers: {
      "content-encoding": "gzip",
      "content-type": "application/json",
      authorization: "Bearer dummy",
      "chatgpt-account-id": "dummy-account",
      "x-typesafe-api-key": "not-forwarded",
    },
    body: raw,
  });
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("denied");
  expect(received.equals(raw)).toBe(true);
});

it("does not run pruning on other endpoints", async () => {
  const { url } = await fixture((_req, res) => res.end("compact"), {
    prune: async () => {
      throw new Error("must not prune");
    },
  });
  const response = await fetch(url + "/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(await response.text()).toBe("compact");
});

it("delivers SSE incrementally and aborts upstream on client disconnect", async () => {
  let release: (() => void) | undefined;
  const disconnected = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { url } = await fixture((_req, res) => {
    res.on("close", () => release?.());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
  });
  const controller = new AbortController();
  const response = await fetch(url + "/responses", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    "data: first\n\n",
  );
  controller.abort();
  await disconnected;
});

it("does not follow redirects and strips connection-nominated request headers", async () => {
  const { url } = await fixture((req, res) => {
    expect(req.headers["x-private-hop"]).toBeUndefined();
    res
      .writeHead(307, {
        location: "http://127.0.0.1:1/leak",
        connection: "x-response-hop",
        "x-response-hop": "hidden",
      })
      .end();
  });
  // fetch overwrites Connection; use the native client to send a real nomination.
  const response = await new Promise<{
    status: number | undefined;
    headers: IncomingMessage["headers"];
  }>((resolve) => {
    const req = httpRequest(
      url + "/responses",
      {
        method: "POST",
        headers: { connection: "x-private-hop", "x-private-hop": "hidden" },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers }),
        );
      },
    );
    req.end("{}");
  });
  expect(response.status).toBe(307);
  expect(response.headers["x-response-hop"]).toBeUndefined();
});

it("returns 502 on upstream failure", async () => {
  const server = createCodexServer({
    upstreamUrl: "http://127.0.0.1:1",
    pruner: unchanged,
    fetchFn: async () => {
      throw new Error("dummy secret must not be exposed");
    },
  });
  const url = await listen(server);
  const response = await fetch(url + "/responses", {
    method: "POST",
    body: "{}",
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("dummy secret");
});

it.each([
  "http://remote.example/v1",
  "https://user:pass@example.com",
  "https://example.com/v1?key=x",
  "file:///tmp/socket",
])("rejects unsafe upstream %s", (upstreamUrl) => {
  expect(() =>
    createCodexServer({ upstreamUrl, pruner: unchanged, fetchFn: fetch }),
  ).toThrow();
});

it("forwards original bytes when the preparer throws", async () => {
  let received = "";
  const { url } = await fixture(
    async (req, res) => {
      for await (const chunk of req) received += chunk;
      res.end();
    },
    {
      prune: async () => {
        throw new Error("scorer unavailable");
      },
    },
  );
  const raw = JSON.stringify(payload);
  await (
    await fetch(url + "/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    })
  ).text();
  expect(received).toBe(raw);
});

it("preserves empty upstream responses", async () => {
  const { url } = await fixture((_req, res) => res.writeHead(204).end());
  const response = await fetch(url + "/models");
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
});

it("terminates a broken upstream stream", async () => {
  let breakStream: (() => void) | undefined;
  const { url } = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    breakStream = () => res.destroy();
  });
  const response = await fetch(url + "/responses", {
    method: "POST",
    body: "{}",
  });
  const reader = response.body!.getReader();
  await reader.read();
  breakStream!();
  await expect(reader.read()).rejects.toThrow();
});

it("cancels active upstream streams on shutdown", async () => {
  let disconnected: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const upstream = await listen(
    createServer((_req, res) => {
      res.on("close", () => disconnected?.());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
    }),
  );
  const shutdown = new AbortController();
  const url = await listen(
    createCodexServer({
      upstreamUrl: upstream,
      pruner: unchanged,
      fetchFn: fetch,
      signal: shutdown.signal,
    }),
  );
  const response = await fetch(url + "/responses", {
    method: "POST",
    body: "{}",
  });
  const reader = response.body!.getReader();
  await reader.read();
  shutdown.abort();
  await expect(reader.read()).rejects.toThrow();
  await closed;
});

it("rejects bodies above 32 MiB without hanging", async () => {
  const { url } = await fixture((_req, res) => res.end("must not forward"));
  const response = await fetch(url + "/responses", {
    method: "POST",
    body: Buffer.alloc(32 * 1024 * 1024 + 1, 120),
  });
  expect(response.status).toBe(413);
  await response.text();
});

it("does not round unsafe integer metadata when pruning", async () => {
  const { url } = await fixture(
    async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      res.end(raw);
    },
    { prune: async (body) => ({ request: { ...body, input: [] } }) },
  );
  const raw = '{"metadata":9007199254740993,"input":[]}';
  const response = await fetch(url + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  expect(await response.text()).toBe(raw);
});

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { copyResponseHeaders, requestHeaders } from "./middleware/proxy.js";

interface Options {
  upstreamUrl: string;
  pruner: {
    prune(
      request: Record<string, unknown>,
    ): Promise<{ request: Record<string, unknown> }>;
  };
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Credentials remain in transit; they are never read from or written to storage. */
export function createCodexServer(options: Options) {
  const upstream = new URL(options.upstreamUrl);
  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    (upstream.protocol !== "https:" &&
      !(
        upstream.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname)
      ))
  ) {
    throw new Error(
      "Upstream must be HTTPS or loopback HTTP, without credentials, query, or fragment",
    );
  }
  const base = upstream.toString().replace(/\/$/, "");
  return createServer((request, response) => {
    void forward(request, response, base, options).catch(() => {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502, { "content-type": "application/json" })
          .end('{"error":"Codex upstream unavailable"}');
    });
  });
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  base: string,
  options: Options,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!response.writableFinished) abort();
  };
  request.on("aborted", abort);
  response.on("close", close);
  try {
    const path = request.url ?? "/";
    if (!path.startsWith("/")) {
      response.writeHead(400).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    let raw = Buffer.concat(chunks);
    const headers = requestHeaders(request);
    const encoding = request.headers["content-encoding"];
    // Raw compressed traffic is forwarded intact instead of decoded or pruned.
    if (typeof encoding === "string") headers.set("content-encoding", encoding);
    if (
      request.method === "POST" &&
      path.split("?", 1)[0] === "/responses" &&
      (!encoding || encoding === "identity") &&
      request.headers["content-type"]?.split(";", 1)[0]?.trim() ===
        "application/json"
    ) {
      try {
        const body: unknown = JSON.parse(raw.toString("utf8"));
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const prepared = await options.pruner.prune(
            body as Record<string, unknown>,
          );
          if (prepared.request !== body)
            raw = Buffer.from(JSON.stringify(prepared.request));
        }
      } catch {
        /* Parsing or scoring failure leaves the original bytes intact. */
      }
    }
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const upstream = await options.fetchFn(`${base}${path}`, {
      method: request.method ?? "GET",
      headers,
      redirect: "manual",
      signal,
      ...(request.method !== "GET" && request.method !== "HEAD"
        ? { body: new Uint8Array(raw) }
        : {}),
    });
    response.statusCode = upstream.status;
    copyResponseHeaders(upstream, response);
    if (!upstream.body) {
      response.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(
        upstream.body as unknown as NodeReadableStream<Uint8Array>,
      ),
      response,
    );
  } finally {
    request.off("aborted", abort);
    response.off("close", close);
  }
}

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Config } from "../config.js";
import type {
  AnthropicRequest,
  PruneResult,
  ProxyStats,
} from "../types.js";
import type { AppLogger } from "../utils/logger.js";

interface RequestPruner {
  prune(request: AnthropicRequest): Promise<PruneResult>;
}

export interface ProxyDependencies {
  config: Config;
  pruner: RequestPruner;
  fetchFn: typeof fetch;
  logger: AppLogger;
  stats: ProxyStats;
}

const REQUEST_HEADER_BLOCKLIST = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "typesafe-api-key",
  "upgrade",
  "x-typesafe-api-key",
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isAnthropicRequest(value: unknown): value is AnthropicRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "messages" in value &&
    Array.isArray(value.messages)
  );
}

function hopByHopFilter(
  blocklist: ReadonlySet<string>,
  connection: string | null | undefined,
): Set<string> {
  const blockedHeaders = new Set(blocklist);
  for (const name of (connection ?? "").split(",")) {
    if (name.trim()) blockedHeaders.add(name.trim().toLowerCase());
  }
  return blockedHeaders;
}

function requestHeaders(request: Request): Headers {
  const headers = new Headers();
  const blockedHeaders = hopByHopFilter(
    REQUEST_HEADER_BLOCKLIST,
    request.headers.connection,
  );
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (blockedHeaders.has(name.toLowerCase()) || rawValue === undefined) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) headers.append(name, value);
    } else {
      headers.set(name, rawValue);
    }
  }
  return headers;
}

function copyResponseHeaders(upstream: globalThis.Response, response: Response) {
  const blockedHeaders = hopByHopFilter(
    RESPONSE_HEADER_BLOCKLIST,
    upstream.headers.get("connection"),
  );
  upstream.headers.forEach((value, name) => {
    if (!blockedHeaders.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  });
}

async function forward(
  request: Request,
  response: Response,
  dependencies: ProxyDependencies,
): Promise<void> {
  dependencies.stats.requests += 1;
  let body = request.body as unknown;
  const path = request.originalUrl.split("?", 1)[0];

  if (
    request.method === "POST" &&
    path === "/v1/messages" &&
    isAnthropicRequest(body)
  ) {
    const startedAt = Date.now();
    const result = await dependencies.pruner.prune(body);
    body = result.request;
    dependencies.stats.pruningDecisions += result.evaluated;
    dependencies.stats.droppedPairs += result.dropped;
    if (result.reason === "fail-open") {
      dependencies.stats.failOpenEvents += 1;
      dependencies.logger.warn("prune_fail_open", {
        error: result.failureReason ?? "unknown pruning error",
        durationMs: Date.now() - startedAt,
      });
    } else if (result.reason === "pruned") {
      dependencies.logger.info("prune_complete", {
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        evaluated: result.evaluated,
        dropped: result.dropped,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  const headers = requestHeaders(request);
  const canHaveBody = request.method !== "GET" && request.method !== "HEAD";
  const serializedBody = canHaveBody && body !== undefined ? JSON.stringify(body) : undefined;
  if (serializedBody !== undefined) {
    headers.set("content-type", "application/json");
  }

  let upstream: globalThis.Response;
  try {
    upstream = await dependencies.fetchFn(
      `${dependencies.config.anthropicUpstreamUrl}${request.originalUrl}`,
      {
        method: request.method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      },
    );
  } catch (error) {
    dependencies.logger.error("anthropic_upstream_unavailable", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    response.status(502).json({ error: "Anthropic upstream unavailable" });
    return;
  }

  response.status(upstream.status);
  copyResponseHeaders(upstream, response);
  if (!upstream.body) {
    response.end();
    return;
  }

  const stream = Readable.fromWeb(
    upstream.body as unknown as NodeReadableStream<Uint8Array>,
  );
  await pipeline(stream, response);
}

export function createProxyHandler(
  dependencies: ProxyDependencies,
): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    void forward(request, response, dependencies).catch((error: unknown) => {
      dependencies.logger.error("proxy_response_failed", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      next(error);
    });
  };
}

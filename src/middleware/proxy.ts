import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Config } from "../config.js";
import type { AnthropicRequest, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { createUsageTap } from "../utils/usageTap.js";
import {
  AGENT_HEADER,
  identifyConversation,
  SESSION_HEADER,
} from "../services/conversation.js";
import type { MessagePreparer } from "../services/messagePreparer.js";
import { createResponseTextTap } from "../utils/responseTextTap.js";

export interface ProxyDependencies {
  config: Config;
  preparer: Pick<MessagePreparer, "prepare">;
  fetchFn: typeof fetch;
  logger: AppLogger;
  stats: ProxyStats;
  upstreamSignal?: AbortSignal;
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

function copyResponseHeaders(
  upstream: globalThis.Response,
  response: Response,
) {
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
  const body = request.body as unknown;
  const path = request.originalUrl.split("?", 1)[0];
  const headers = requestHeaders(request);
  const canHaveBody = request.method !== "GET" && request.method !== "HEAD";
  const send = (payload: unknown) => {
    const serializedBody =
      canHaveBody && payload !== undefined
        ? JSON.stringify(payload)
        : undefined;
    if (serializedBody !== undefined) {
      headers.set("content-type", "application/json");
    }
    return dependencies.fetchFn(
      `${dependencies.config.anthropicUpstreamUrl}${request.originalUrl}`,
      {
        method: request.method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        ...(dependencies.upstreamSignal
          ? { signal: dependencies.upstreamSignal }
          : {}),
      },
    );
  };
  const prepared =
    request.method === "POST" &&
    path === "/v1/messages" &&
    isAnthropicRequest(body)
      ? await dependencies.preparer.prepare(
          body,
          identifyConversation(
            body,
            request.get(SESSION_HEADER),
            request.get(AGENT_HEADER),
          ),
        )
      : undefined;

  const onFinalReply = prepared?.onFinalReply;

  let upstream: globalThis.Response;
  try {
    upstream = prepared ? await prepared.send(send) : await send(body);
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
  if (request.method === "POST" && path === "/v1/messages") {
    const tap = createUsageTap(
      upstream.headers.get("content-type") ?? "",
      (usage) => {
        dependencies.logger.info("anthropic_usage", {
          status: upstream.status,
          inputTokens: usage.inputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          totalInputTokens: usage.totalInputTokens,
        });
      },
    );
    if (upstream.ok && onFinalReply) {
      const responseTap = createResponseTextTap(
        upstream.headers.get("content-type") ?? "",
        onFinalReply,
      );
      await pipeline(stream, tap, responseTap, response);
    } else {
      await pipeline(stream, tap, response);
    }
    return;
  }
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

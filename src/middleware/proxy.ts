import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Config } from "../config.js";
import type { AnthropicRequest, PruneResult, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { createUsageTap } from "../utils/usageTap.js";
import { CanaryPolicy } from "../services/canary.js";
import type { PruneOptions } from "../services/contextPruner.js";
import { recordPruneOutcome } from "../services/pruneLog.js";
import { appendNotice } from "../services/turn.js";
import type { SkillShadowObserver } from "../services/skillShadowObserver.js";
import { createResponseTextTap } from "../utils/responseTextTap.js";

interface RequestPruner {
  prune(
    request: AnthropicRequest,
    options?: PruneOptions,
  ): Promise<PruneResult>;
}

export const SESSION_HEADER = "x-claude-code-session-id";

export interface ProxyDependencies {
  config: Config;
  pruner: RequestPruner;
  fetchFn: typeof fetch;
  logger: AppLogger;
  stats: ProxyStats;
  upstreamSignal?: AbortSignal;
  shadowObserver?: SkillShadowObserver;
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
  canaryPolicy: CanaryPolicy,
): Promise<void> {
  dependencies.stats.requests += 1;
  let body = request.body as unknown;
  let onFinalReply: ((reply: string) => void) | undefined;
  const path = request.originalUrl.split("?", 1)[0];

  if (
    request.method === "POST" &&
    path === "/v1/messages" &&
    isAnthropicRequest(body)
  ) {
    const startedAt = Date.now();
    const sessionId = request.get(SESSION_HEADER);
    const canary = canaryPolicy.check(body, sessionId);
    const result = await dependencies.pruner.prune(body, {
      ...(sessionId ? { sessionId } : {}),
      ...(canary.prune ? { trigger: "canary" as const } : {}),
    });
    if (dependencies.config.skillShadow && dependencies.shadowObserver && sessionId)
      onFinalReply = dependencies.shadowObserver.observe(result.request, sessionId);
    // Every notice for Claude is added here, and only when notices are on.
    const notices = [result.notice, canary.notice].filter(
      (notice): notice is string => notice !== undefined,
    );
    body = dependencies.config.notify
      ? notices.reduce(appendNotice, result.request)
      : result.request;
    recordPruneOutcome(result, {
      stats: dependencies.stats,
      logger: dependencies.logger,
      targetTokens: dependencies.config.targetTokens,
      durationMs: Date.now() - startedAt,
    });
  }

  const headers = requestHeaders(request);
  const canHaveBody = request.method !== "GET" && request.method !== "HEAD";
  const serializedBody =
    canHaveBody && body !== undefined ? JSON.stringify(body) : undefined;
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
        ...(dependencies.upstreamSignal
          ? { signal: dependencies.upstreamSignal }
          : {}),
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
  const canaryPolicy = new CanaryPolicy(
    dependencies.config,
    dependencies.logger,
  );
  return (request: Request, response: Response, next: NextFunction) => {
    void forward(request, response, dependencies, canaryPolicy).catch(
      (error: unknown) => {
        dependencies.logger.error("proxy_response_failed", {
          error: error instanceof Error ? error.message : "unknown error",
        });
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        next(error);
      },
    );
  };
}

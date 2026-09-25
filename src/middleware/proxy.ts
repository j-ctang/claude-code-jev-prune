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
import type { RouteDecision } from "../services/modelRouter.js";
import { recordPruneOutcome } from "../services/pruneLog.js";
import { appendNotice } from "../services/turn.js";

interface RequestPruner {
  prune(
    request: AnthropicRequest,
    options?: PruneOptions,
  ): Promise<PruneResult>;
}

export interface RequestRouter {
  route(request: AnthropicRequest, sessionId?: string): Promise<RouteDecision>;
  markUnavailable(conversation: string): string;
}

/** Upstream statuses that mean the routed model can't serve this account. */
const ROUTE_UNAVAILABLE_STATUSES = new Set([400, 403, 404]);

export const SESSION_HEADER = "x-claude-code-session-id";

export interface ProxyDependencies {
  config: Config;
  pruner: RequestPruner;
  fetchFn: typeof fetch;
  logger: AppLogger;
  stats: ProxyStats;
  router?: RequestRouter;
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
  canaryPolicy: CanaryPolicy,
): Promise<void> {
  dependencies.stats.requests += 1;
  let body = request.body as unknown;
  // Set only when the router changed the model: builds the request to resend
  // on the original model if the upstream rejects the routed one.
  let fallback:
    | {
        conversation: string;
        body: (notice: string | undefined) => AnthropicRequest;
      }
    | undefined;
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
    // Routing never fails a request: on error, forward with no route.
    let route: RouteDecision = {};
    if (dependencies.router) {
      try {
        route = await dependencies.router.route(body, sessionId);
      } catch (error) {
        dependencies.logger.warn("route_fail_open", {
          error: error instanceof Error ? error.message : "unknown error",
        });
      }
    }
    // Every notice for Claude is added here, and only when notices are on.
    const withNotices = (notices: Array<string | undefined>) =>
      dependencies.config.notify
        ? notices
            .filter((notice): notice is string => notice !== undefined)
            .reduce(appendNotice, result.request)
        : result.request;
    const prepared = withNotices([result.notice, canary.notice, route.notice]);
    body = route.model ? { ...prepared, model: route.model } : prepared;
    if (route.model && route.conversation) {
      fallback = {
        conversation: route.conversation,
        body: (notice) => withNotices([result.notice, canary.notice, notice]),
      };
    }
    recordPruneOutcome(result, {
      stats: dependencies.stats,
      logger: dependencies.logger,
      targetTokens: dependencies.config.targetTokens,
      durationMs: Date.now() - startedAt,
    });
  }

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

  let upstream: globalThis.Response;
  try {
    upstream = await send(body);
    if (fallback && ROUTE_UNAVAILABLE_STATUSES.has(upstream.status)) {
      await upstream.body?.cancel();
      dependencies.logger.warn("route_model_unavailable", {
        status: upstream.status,
        model: (body as AnthropicRequest).model,
      });
      upstream = await send(
        fallback.body(
          dependencies.router?.markUnavailable(fallback.conversation),
        ),
      );
    }
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
    await pipeline(stream, tap, response);
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

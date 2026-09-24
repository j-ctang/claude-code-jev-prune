import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Config } from "../config.js";
import type { AnthropicRequest, PruneResult, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { createUsageTap } from "../utils/usageTap.js";
import { CanaryMonitor } from "../services/canary.js";
import { CanaryMode } from "../services/canaryMode.js";

interface RequestPruner {
  prune(
    request: AnthropicRequest,
    options?: { sessionId?: string },
  ): Promise<PruneResult>;
  requestManualPrune?(sessionId: string): void;
}

export const SESSION_HEADER = "x-claude-code-session-id";

export interface ProxyDependencies {
  config: Config;
  pruner: RequestPruner;
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

function canaryCommand(request: AnthropicRequest): "on" | "off" | undefined {
  const last = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!last) return undefined;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter(
            (block) => block.type === "text" && typeof block.text === "string",
          )
          .map((block) => String(block.text))
          .join("\n");
  if (/<command-name>\/jev-prune-auto<\/command-name>/.test(text)) return "on";
  if (/<command-name>\/jev-prune-auto-off<\/command-name>/.test(text))
    return "off";
  return undefined;
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
  canary: CanaryMonitor,
  canaryMode: CanaryMode,
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
    const sessionId = request.get(SESSION_HEADER);
    const command = canaryCommand(body);
    let commandNotice: string | undefined;
    if (command && dependencies.config.canaryPrefix) {
      try {
        canaryMode.setAutoPrune(command === "on");
        commandNotice =
          command === "on"
            ? "[jev-prune] Automatic pruning on future canary misses is enabled."
            : "[jev-prune] Automatic pruning on canary misses is disabled.";
      } catch (error) {
        dependencies.logger.warn("canary_mode_save_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        });
        commandNotice = "[jev-prune] Could not save the canary setting.";
      }
    }
    const canaryMissed = Boolean(sessionId && canary.observe(sessionId, body));
    const autoPrune = canaryMode.hasPreference
      ? canaryMode.autoPrune
      : dependencies.config.canaryAction === "prune";
    if (canaryMissed && autoPrune && sessionId) {
      dependencies.pruner.requestManualPrune?.(sessionId);
      dependencies.logger.warn("canary_prune_requested", { sessionId });
    }
    const result = await dependencies.pruner.prune(
      body,
      sessionId ? { sessionId } : {},
    );
    body = result.request;
    if (
      ((canaryMissed && !autoPrune) || commandNotice) &&
      dependencies.config.notify
    ) {
      const candidate = body as AnthropicRequest;
      const messages = [...candidate.messages];
      let index = messages.length - 1;
      while (index >= 0 && messages[index]?.role !== "user") index -= 1;
      const last = messages[index];
      if (last) {
        const content =
          typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : last.content;
        messages[index] = {
          ...last,
          content: [
            ...content,
            {
              type: "text",
              text:
                commandNotice ??
                "[jev-prune] The configured response prefix was missed again. This is an advisory signal; run /jev-prune now or /jev-prune-auto to prune automatically on future misses.",
            },
          ],
        };
        body = { ...candidate, messages };
        dependencies.logger.warn("canary_missed", { sessionId });
      }
    }
    dependencies.stats.pruningDecisions += result.evaluated;
    dependencies.stats.droppedPairs += result.dropped;
    if (result.reason === "fail-open") {
      dependencies.stats.failOpenEvents += 1;
      dependencies.logger.warn("prune_fail_open", {
        error: result.failureReason ?? "unknown pruning error",
        durationMs: Date.now() - startedAt,
      });
    } else if (result.resumed) {
      dependencies.logger.info("resume_notice", {
        tokens: result.afterTokens,
      });
    } else if (result.reason === "pruned") {
      dependencies.stats.prunes += 1;
      dependencies.stats.tokensRemoved += result.removedTokens ?? 0;
      dependencies.logger.info("prune_complete", {
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        evaluated: result.evaluated,
        dropped: result.dropped,
        removedTokens: result.removedTokens ?? 0,
        superseded: result.superseded ?? 0,
        trimmed: result.trimmed ?? 0,
        manual: result.manual ?? false,
        durationMs: Date.now() - startedAt,
      });
      if (result.aboveTarget) {
        dependencies.logger.warn("prune_above_target", {
          afterTokens: result.afterTokens,
          targetTokens: dependencies.config.targetTokens,
        });
      }
    }
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
    await pipeline(stream, tap, response);
    return;
  }
  await pipeline(stream, response);
}

export function createProxyHandler(
  dependencies: ProxyDependencies,
): RequestHandler {
  const canary = new CanaryMonitor(dependencies.config.canaryPrefix ?? "");
  const canaryMode = new CanaryMode(
    `${dependencies.config.statePath}.canary-mode.json`,
  );
  return (request: Request, response: Response, next: NextFunction) => {
    void forward(request, response, dependencies, canary, canaryMode).catch(
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

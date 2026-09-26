import type { Config } from "../config.js";
import type { AnthropicRequest, PruneResult, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { CanaryPolicy } from "./canary.js";
import type { PruneOptions } from "./contextPruner.js";
import type { RouteDecision } from "./modelRouter.js";
import { recordPruneOutcome } from "./pruneLog.js";
import { appendNotice } from "./turn.js";

export interface RequestPruner {
  prune(
    request: AnthropicRequest,
    options?: PruneOptions,
  ): Promise<PruneResult>;
}

export interface RequestRouter {
  route(request: AnthropicRequest, sessionId?: string): Promise<RouteDecision>;
}

export type SendRequest = (
  request: AnthropicRequest,
) => Promise<globalThis.Response>;

export interface PreparedMessage {
  /** Sends the request, resending on the original model if routing asks. */
  send(send: SendRequest): Promise<globalThis.Response>;
}

interface MessagePreparerDependencies {
  config: Pick<Config, "notify" | "targetTokens">;
  canary: Pick<CanaryPolicy, "check">;
  pruner: RequestPruner;
  router?: RequestRouter | undefined;
  logger: AppLogger;
  stats: ProxyStats;
}

/**
 * Turns one `/v1/messages` request into what is sent upstream: checks the
 * canary, prunes and routes, and adds every notice for Claude.
 */
export class MessagePreparer {
  constructor(private readonly dependencies: MessagePreparerDependencies) {}

  async prepare(
    request: AnthropicRequest,
    sessionId?: string,
  ): Promise<PreparedMessage> {
    const { canary: canaryPolicy, config, logger, stats } = this.dependencies;
    const canary = canaryPolicy.check(request, sessionId);
    // Pruning and routing both read the original request, so they run together.
    const [{ result, durationMs }, route] = await Promise.all([
      this.prune(request, {
        ...(sessionId ? { sessionId } : {}),
        ...(canary.prune ? { trigger: "canary" as const } : {}),
      }),
      this.route(request, sessionId),
    ]);
    recordPruneOutcome(result, {
      stats,
      logger,
      targetTokens: config.targetTokens,
      durationMs,
    });

    // Every notice for Claude is added here, and only when notices are on.
    const withNotices = (...notices: Array<string | undefined>) =>
      config.notify
        ? notices
            .filter((notice): notice is string => notice !== undefined)
            .reduce(appendNotice, result.request)
        : result.request;
    const unrouted = [result.notice, canary.notice];
    const routed = {
      ...withNotices(...unrouted, route.notice),
      ...(route.model ? { model: route.model } : {}),
    };
    const { fallback } = route;
    return {
      async send(send) {
        const upstream = await send(routed);
        if (!fallback?.retries(upstream.status)) return upstream;
        await upstream.body?.cancel();
        logger.warn("route_retry", { status: upstream.status });
        const retried = await send(withNotices(...unrouted, fallback.notice));
        if (retried.ok) fallback.confirm();
        return retried;
      },
    };
  }

  /** Times the prune alone, so its log never includes routing. */
  private async prune(
    request: AnthropicRequest,
    options: PruneOptions,
  ): Promise<{ result: PruneResult; durationMs: number }> {
    const startedAt = Date.now();
    const result = await this.dependencies.pruner.prune(request, options);
    return { result, durationMs: Date.now() - startedAt };
  }

  /** Routing never fails a request: on error, forward with no route. */
  private async route(
    request: AnthropicRequest,
    sessionId: string | undefined,
  ): Promise<RouteDecision> {
    if (!this.dependencies.router) return {};
    try {
      return await this.dependencies.router.route(request, sessionId);
    } catch (error) {
      this.dependencies.logger.warn("route_fail_open", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return {};
    }
  }
}

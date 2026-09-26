import type { Config } from "../config.js";
import type { AnthropicRequest, PruneResult, ProxyStats } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { CanaryPolicy } from "./canary.js";
import type { Conversation } from "./conversation.js";
import type { PruneOptions } from "./contextPruner.js";
import type { RouteDecision } from "./modelRouter.js";
import { recordPruneOutcome } from "./pruneLog.js";
import type { SkillShadowObserver } from "./skillShadowObserver.js";
import { NoticeMemory } from "./noticeMemory.js";

export interface RequestPruner {
  prune(
    request: AnthropicRequest,
    options?: PruneOptions,
  ): Promise<PruneResult>;
}

export interface RequestRouter {
  route(
    request: AnthropicRequest,
    conversation: Conversation,
  ): Promise<RouteDecision>;
}

export type SendRequest = (
  request: AnthropicRequest,
  beta?: string,
) => Promise<globalThis.Response>;

/**
 * Preserved thinking is bound to the history and model it was made with.
 * Pruning, notices, and routing change those, which a newer account's API
 * rejects with a 400. This beta and `drop_block` make the API drop only the
 * thinking that no longer matches instead.
 */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** Thinking types that make blocks the API can drop; `disabled` rejects the field. */
const THINKING_TYPES = new Set(["adaptive", "enabled"]);

/** Sends `body`, letting the API drop thinking an edit invalidated. */
function sendEdited(
  send: SendRequest,
  body: AnthropicRequest,
): Promise<globalThis.Response> {
  const thinking =
    typeof body.thinking === "object" && body.thinking !== null
      ? (body.thinking as Record<string, unknown>)
      : {};
  const { type } = thinking;
  if (typeof type !== "string" || !THINKING_TYPES.has(type)) return send(body);
  return send(
    {
      ...body,
      thinking: {
        ...thinking,
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
    },
    THINKING_BINDING_BETA,
  );
}

export interface PreparedMessage {
  /** Sends the request, resending on the original model if routing asks. */
  send(send: SendRequest): Promise<globalThis.Response>;
  /** Called with Claude's finished reply text, when skill shadow mode watches. */
  onFinalReply?: ((reply: string) => void) | undefined;
}

interface MessagePreparerDependencies {
  config: Pick<Config, "notify" | "targetTokens" | "skillShadow">;
  canary: Pick<CanaryPolicy, "check">;
  pruner: RequestPruner;
  router?: RequestRouter | undefined;
  shadowObserver?: SkillShadowObserver | undefined;
  logger: AppLogger;
  stats: ProxyStats;
}

/**
 * Turns one `/v1/messages` request into what is sent upstream: checks the
 * canary, prunes and routes, and adds every notice for Claude.
 */
export class MessagePreparer {
  private readonly notices = new NoticeMemory();

  constructor(private readonly dependencies: MessagePreparerDependencies) {}

  async prepare(
    request: AnthropicRequest,
    conversation: Conversation,
  ): Promise<PreparedMessage> {
    const { canary: canaryPolicy, config, logger, stats } = this.dependencies;
    const canary = canaryPolicy.check(request, conversation);
    const { sessionId } = conversation;
    // Pruning and routing both read the original request, so they run together.
    const [{ result, durationMs }, route] = await Promise.all([
      this.prune(request, {
        ...(sessionId ? { sessionId } : {}),
        ...(canary.prune ? { trigger: "canary" as const } : {}),
      }),
      this.route(request, conversation),
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
        ? this.notices.apply(
            conversation.key,
            result.request,
            notices.filter((notice): notice is string => notice !== undefined),
          )
        : result.request;
    const unrouted = [result.notice, canary.notice];
    const noticed = withNotices(...unrouted, route.notice);
    const routed = route.model ? { ...noticed, model: route.model } : noticed;
    const { fallback } = route;
    const { shadowObserver } = this.dependencies;
    const onFinalReply =
      config.skillShadow && shadowObserver && sessionId
        ? shadowObserver.observe(result.request, sessionId)
        : undefined;
    // Only a request jev-prune changed can mismatch its thinking.
    const sendChanged = (send: SendRequest, body: AnthropicRequest) =>
      body === request ? send(body) : sendEdited(send, body);
    return {
      onFinalReply,
      async send(send) {
        const upstream = await sendChanged(send, routed);
        if (!fallback?.retries(upstream.status)) return upstream;
        await upstream.body?.cancel();
        logger.warn("route_retry", { status: upstream.status });
        const retried = await sendChanged(
          send,
          withNotices(...unrouted, fallback.notice),
        );
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
    conversation: Conversation,
  ): Promise<RouteDecision> {
    if (!this.dependencies.router) return {};
    try {
      return await this.dependencies.router.route(request, conversation);
    } catch (error) {
      this.dependencies.logger.warn("route_fail_open", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return {};
    }
  }
}

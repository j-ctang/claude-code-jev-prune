import type { Config } from "../config.js";
import type { AnthropicRequest } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { CanaryMode } from "./canaryMode.js";
import { lastTurnIndex, messageText } from "./messages.js";

interface CanaryState {
  lastReply: string;
  misses: number;
}

/** Checks completed assistant text carried into the next user request. */
export class CanaryMonitor {
  private readonly sessions = new Map<string, CanaryState>();

  constructor(private readonly prefix: string) {}

  get enabled(): boolean {
    return this.prefix !== "";
  }

  observe(sessionId: string, request: AnthropicRequest): boolean {
    if (!this.enabled) return false;
    const current = request.messages[lastTurnIndex(request)];
    if (current?.role !== "user") return false;
    if (
      Array.isArray(current.content) &&
      current.content.some((block) => block.type === "tool_result")
    )
      return false;
    const reply = [...request.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !reply ||
      (Array.isArray(reply.content) &&
        reply.content.some((block) => block.type === "tool_use"))
    ) {
      return false;
    }
    const text = messageText(reply);
    if (!text.trim()) return false;
    const previous = this.sessions.get(sessionId);
    if (previous?.lastReply === text) return false;
    const matched = text.trimStart().startsWith(this.prefix);
    const misses = matched ? 0 : (previous?.misses ?? 0) + 1;
    this.sessions.set(sessionId, { lastReply: text, misses });
    return misses >= 2;
  }
}

export interface CanaryDecision {
  /** Prune on this request, as if the user ran /jev-prune. */
  prune: boolean;
  /** Text to show Claude on this request. */
  notice?: string | undefined;
}

const MISS_NOTICE =
  "[jev-prune] The configured response prefix was missed again. This is an advisory signal; run /jev-prune now or /jev-prune-auto to prune automatically on future misses.";

function autoPruneCommand(request: AnthropicRequest): boolean | undefined {
  const last = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  const text = last ? messageText(last) : "";
  if (/<command-name>\/jev-prune-auto<\/command-name>/.test(text)) return true;
  if (/<command-name>\/jev-prune-auto-off<\/command-name>/.test(text))
    return false;
  return undefined;
}

/**
 * Decides what a missed response canary means for one request: handles the
 * /jev-prune-auto commands, then either prunes or suggests /jev-prune.
 */
export class CanaryPolicy {
  private readonly monitor: CanaryMonitor;
  private readonly mode: CanaryMode;

  constructor(
    config: Pick<Config, "canaryPrefix" | "canaryAction" | "statePath">,
    private readonly logger: AppLogger,
  ) {
    this.monitor = new CanaryMonitor(config.canaryPrefix ?? "");
    this.mode = new CanaryMode(
      `${config.statePath}.canary-mode.json`,
      config.canaryAction === "prune",
    );
  }

  check(request: AnthropicRequest, sessionId?: string): CanaryDecision {
    const commandNotice = this.applyCommand(request);
    const missed = Boolean(
      sessionId && this.monitor.observe(sessionId, request),
    );
    if (missed && this.mode.autoPrune) {
      this.logger.warn("canary_prune_requested", { sessionId });
      return { prune: true, notice: commandNotice };
    }
    if (missed) this.logger.warn("canary_missed", { sessionId });
    return {
      prune: false,
      notice: commandNotice ?? (missed ? MISS_NOTICE : undefined),
    };
  }

  private applyCommand(request: AnthropicRequest): string | undefined {
    const enable = autoPruneCommand(request);
    if (enable === undefined || !this.monitor.enabled) return undefined;
    try {
      this.mode.setAutoPrune(enable);
      return enable
        ? "[jev-prune] Automatic pruning on future canary misses is enabled."
        : "[jev-prune] Automatic pruning on canary misses is disabled.";
    } catch (error) {
      this.logger.warn("canary_mode_save_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      });
      return "[jev-prune] Could not save the canary setting.";
    }
  }
}

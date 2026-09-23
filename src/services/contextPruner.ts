import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { PruneError, loggableReason } from "../errors.js";
import type {
  AnthropicRequest,
  ContentBlock,
  PruneResult,
  RelevanceScorer,
  ToolCandidate,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";
import type { AppLogger } from "../utils/logger.js";

interface ContextPrunerOptions {
  config: Config;
  scorer: RelevanceScorer;
  logger?: AppLogger;
  maxCachedDrops?: number;
}

interface LocatedToolUse {
  messageIndex: number;
  blockIndex: number;
  block: ToolUseBlock;
}

interface LocatedToolResult {
  messageIndex: number;
  blockIndex: number;
  block: ToolResultBlock;
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    Object.hasOwn(block, "input")
  );
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result" && typeof block.tool_use_id === "string";
}

function cacheKey(candidate: ToolCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        toolUseId: candidate.toolUseId,
        toolName: candidate.toolName,
        input: candidate.input,
        result: candidate.result,
      }),
    )
    .digest("base64url");
}

export class ContextPruner {
  private readonly config: Config;
  private readonly scorer: RelevanceScorer;
  private readonly logger: AppLogger | undefined;
  private readonly maxCachedDrops: number;
  private readonly dropCache = new Map<string, true>();

  constructor(options: ContextPrunerOptions) {
    this.config = options.config;
    this.scorer = options.scorer;
    this.logger = options.logger;
    this.maxCachedDrops = options.maxCachedDrops ?? 10_000;
  }

  async prune(request: AnthropicRequest): Promise<PruneResult> {
    const beforeTokens = estimateTokens(request);
    if (!this.config.pruningEnabled) {
      return this.passThrough(request, beforeTokens, "disabled");
    }
    if (beforeTokens < this.config.pruneThreshold) {
      return this.passThrough(request, beforeTokens, "below-threshold");
    }

    // Earlier drops are re-applied on every request so the pruned prefix stays
    // byte-identical and keeps its prompt-cache discount.
    const cachedIds = new Set<string>();
    let cachedRequest = request;
    try {
      const candidates = this.extractCandidates(request);
      if (candidates.length === 0) {
        return this.passThrough(request, beforeTokens, "no-candidates");
      }

      const protectedIds = new Set<string>();
      if (this.config.keepRecent > 0) {
        for (const candidate of candidates.slice(-this.config.keepRecent)) {
          protectedIds.add(candidate.toolUseId);
        }
      }

      const eligibleByPolicy = candidates.filter(
        (candidate) =>
          !protectedIds.has(candidate.toolUseId) &&
          !this.config.excludeTools.has(candidate.toolName),
      );
      const eligibleForScoring: ToolCandidate[] = [];
      for (const candidate of eligibleByPolicy) {
        if (this.touchCachedDrop(cacheKey(candidate))) {
          cachedIds.add(candidate.toolUseId);
        } else {
          eligibleForScoring.push(candidate);
        }
      }
      if (cachedIds.size > 0) {
        cachedRequest = this.removePairs(request, cachedIds);
      }
      const cachedTokens = estimateTokens(cachedRequest);

      if (cachedTokens < this.config.pruneThreshold) {
        return this.cachedOnly(
          cachedRequest,
          beforeTokens,
          cachedTokens,
          cachedIds.size,
          "below-threshold",
        );
      }
      // Pruning mid-task would cut context the agent is actively using, so new
      // scoring only happens when the user starts a new turn.
      if (!this.isNewUserTurn(request)) {
        return this.cachedOnly(
          cachedRequest,
          beforeTokens,
          cachedTokens,
          cachedIds.size,
          "mid-task",
        );
      }
      if (eligibleForScoring.length === 0) {
        return this.cachedOnly(
          cachedRequest,
          beforeTokens,
          cachedTokens,
          cachedIds.size,
          "no-candidates",
        );
      }

      const goal = this.latestUserGoal(request);
      const scores = await this.scorer.score(goal, eligibleForScoring);
      const cutoff = cachedTokens >= this.config.triggerTokens ? 0.7 : 0.5;
      const scoredCandidates = eligibleForScoring.map((candidate) => {
        const score = scores.get(candidate.toolUseId);
        if (score === undefined) {
          throw new PruneError(`Missing score for ${candidate.toolUseId}`);
        }
        return { candidate, score };
      });
      const newlyDroppedCandidates: ToolCandidate[] = [];

      for (const { candidate, score } of scoredCandidates) {
        if (this.config.debug) {
          this.logger?.debug("prune_decision", {
            toolName: candidate.toolName,
            toolUseId: candidate.toolUseId,
            relevance: score,
            cutoff,
            outcome: score < cutoff ? "drop" : "keep",
          });
        }
        if (score < cutoff) {
          newlyDroppedCandidates.push(candidate);
        }
      }
      const droppedIds = new Set(cachedIds);
      for (const candidate of newlyDroppedCandidates) {
        droppedIds.add(candidate.toolUseId);
        this.cacheDrop(candidate);
      }

      const prunedRequest =
        droppedIds.size === cachedIds.size
          ? cachedRequest
          : this.removePairs(request, droppedIds);
      const afterTokens = estimateTokens(prunedRequest);
      const aboveTarget = afterTokens > this.config.targetTokens;
      const notice = this.notice(
        newlyDroppedCandidates.length,
        cachedTokens,
        afterTokens,
        aboveTarget,
      );
      return {
        request: this.config.notify
          ? this.appendNotice(prunedRequest, notice)
          : prunedRequest,
        beforeTokens,
        afterTokens,
        evaluated: eligibleForScoring.length,
        dropped: droppedIds.size,
        reason: "pruned",
        aboveTarget,
        notice,
      };
    } catch (error) {
      const tokens = estimateTokens(cachedRequest);
      return {
        request: cachedRequest,
        beforeTokens,
        afterTokens: tokens,
        evaluated: 0,
        dropped: cachedIds.size,
        reason: "fail-open",
        failureReason: loggableReason(error),
      };
    }
  }

  private cachedOnly(
    request: AnthropicRequest,
    beforeTokens: number,
    afterTokens: number,
    dropped: number,
    reason: "below-threshold" | "mid-task" | "no-candidates",
  ): PruneResult {
    return {
      request,
      beforeTokens,
      afterTokens,
      evaluated: 0,
      dropped,
      reason,
    };
  }

  /**
   * Claude Code may append `system` messages (hook context) after the user's
   * turn, so the turn boundary is judged from the last user/assistant message.
   */
  private lastTurnIndex(request: AnthropicRequest): number {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const role = request.messages[index]?.role;
      if (role === "user" || role === "assistant") return index;
    }
    return -1;
  }

  private isNewUserTurn(request: AnthropicRequest): boolean {
    const last = request.messages[this.lastTurnIndex(request)];
    if (!last || last.role !== "user") return false;
    if (typeof last.content === "string") return true;
    return !last.content.some((block) => isToolResult(block));
  }

  private notice(
    newlyDropped: number,
    beforeTokens: number,
    afterTokens: number,
    aboveTarget: boolean,
  ): string {
    const summary =
      `[jev-prune] Pruned ${newlyDropped} stale tool result(s): context ` +
      `~${Math.round(beforeTokens / 1000)}K -> ~${Math.round(afterTokens / 1000)}K tokens.`;
    if (!aboveTarget) {
      return `${summary} Mention this to the user in one short line.`;
    }
    return (
      `${summary} Context is still above the ` +
      `~${Math.round(this.config.targetTokens / 1000)}K target, so answer quality may drop. ` +
      "Tell the user in one short line and suggest writing a handoff file " +
      "for a fresh session."
    );
  }

  private appendNotice(
    request: AnthropicRequest,
    notice: string,
  ): AnthropicRequest {
    const index = this.lastTurnIndex(request);
    const last = request.messages[index];
    if (!last) return request;
    const content =
      typeof last.content === "string"
        ? [{ type: "text", text: last.content }]
        : last.content;
    const messages = [...request.messages];
    messages[index] = {
      ...last,
      content: [...content, { type: "text", text: notice }],
    };
    return { ...request, messages };
  }

  private touchCachedDrop(key: string): boolean {
    if (!this.dropCache.has(key)) return false;
    this.dropCache.delete(key);
    this.dropCache.set(key, true);
    return true;
  }

  private cacheDrop(candidate: ToolCandidate): void {
    if (this.maxCachedDrops <= 0) return;
    const key = cacheKey(candidate);
    this.dropCache.delete(key);
    this.dropCache.set(key, true);
    while (this.dropCache.size > this.maxCachedDrops) {
      const oldestKey = this.dropCache.keys().next().value as
        string | undefined;
      if (oldestKey === undefined) return;
      this.dropCache.delete(oldestKey);
    }
  }

  private passThrough(
    request: AnthropicRequest,
    tokens: number,
    reason: "disabled" | "below-threshold" | "no-candidates",
  ): PruneResult {
    return {
      request,
      beforeTokens: tokens,
      afterTokens: tokens,
      evaluated: 0,
      dropped: 0,
      reason,
    };
  }

  private extractCandidates(request: AnthropicRequest): ToolCandidate[] {
    const uses = new Map<string, LocatedToolUse[]>();
    const results = new Map<string, LocatedToolResult[]>();

    request.messages.forEach((message, messageIndex) => {
      if (!Array.isArray(message.content)) return;
      message.content.forEach((block, blockIndex) => {
        if (message.role === "assistant" && isToolUse(block)) {
          const entries = uses.get(block.id) ?? [];
          entries.push({ messageIndex, blockIndex, block });
          uses.set(block.id, entries);
        }
        if (message.role === "user" && isToolResult(block)) {
          const entries = results.get(block.tool_use_id) ?? [];
          entries.push({ messageIndex, blockIndex, block });
          results.set(block.tool_use_id, entries);
        }
      });
    });

    const candidates: ToolCandidate[] = [];
    for (const [toolUseId, useEntries] of uses) {
      const resultEntries = results.get(toolUseId) ?? [];
      if (useEntries.length !== 1 || resultEntries.length !== 1) continue;
      const use = useEntries[0];
      const result = resultEntries[0];
      if (!use || !result) continue;
      candidates.push({
        toolUseId,
        toolName: use.block.name,
        assistantMessageIndex: use.messageIndex,
        assistantBlockIndex: use.blockIndex,
        resultMessageIndex: result.messageIndex,
        resultBlockIndex: result.blockIndex,
        input: use.block.input,
        result: result.block.content,
      });
    }

    return candidates.sort(
      (left, right) =>
        left.assistantMessageIndex - right.assistantMessageIndex ||
        left.assistantBlockIndex - right.assistantBlockIndex,
    );
  }

  private latestUserGoal(request: AnthropicRequest): string {
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const message = request.messages[index];
      if (!message || message.role !== "user") continue;
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content;
      }
      if (!Array.isArray(message.content)) continue;
      const text = message.content
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => String(block.text))
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "Complete the current task.";
  }

  private removePairs(
    request: AnthropicRequest,
    droppedIds: ReadonlySet<string>,
  ): AnthropicRequest {
    const messages = request.messages.flatMap((message) => {
      if (!Array.isArray(message.content)) return [message];
      const content = message.content.filter((block) => {
        if (
          message.role === "assistant" &&
          isToolUse(block) &&
          droppedIds.has(block.id)
        ) {
          return false;
        }
        if (
          message.role === "user" &&
          isToolResult(block) &&
          droppedIds.has(block.tool_use_id)
        ) {
          return false;
        }
        return true;
      });
      if (content.length === message.content.length) return [message];
      if (content.length === 0) return [];
      return [{ ...message, content }];
    });

    return { ...request, messages };
  }
}

import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { PruneError, loggableReason } from "../errors.js";
import type {
  PruneStateSnapshot,
  PruneStateStore,
  Rewrite,
} from "./pruneState.js";
import { findSuperseded, trimOutput } from "./toolRewrites.js";
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
  now?: () => number;
  stateStore?: PruneStateStore;
}

export interface PruneOptions {
  sessionId?: string;
}

// Claude Code wraps an invoked slash command as `<command-name>/name</command-name>`.
// Plugin commands are namespaced, e.g. `/jev-prune:jev-prune`.
const MANUAL_COMMAND = /<command-name>\/(?:[\w-]+:)?jev-prune<\/command-name>/;

const DEFAULT_SESSION = "default";
const MAX_TRACKED_SESSIONS = 1_000;

/** Inserts or refreshes `key` as most recent, evicting the oldest past `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number) {
  if (max <= 0) return;
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

const MANUAL_PRUNE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_MANUAL_PRUNES = 1_000;

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
  private readonly keepCache = new Map<string, true>();
  private readonly rewriteCache = new Map<string, Rewrite>();
  private readonly lastFullScoreTokens = new Map<string, number>();
  private readonly lastScoredGoals = new Map<string, string>();
  private readonly now: () => number;
  private readonly manualPrunes = new Map<string, number>();
  private readonly seenSessions = new Map<string, true>();
  private readonly stateStore: PruneStateStore | undefined;

  constructor(options: ContextPrunerOptions) {
    this.config = options.config;
    this.scorer = options.scorer;
    this.logger = options.logger;
    this.maxCachedDrops = options.maxCachedDrops ?? 10_000;
    this.now = options.now ?? Date.now;
    this.stateStore = options.stateStore;
    const saved = this.stateStore?.load();
    if (saved) this.restore(saved);
  }

  /**
   * Queues a prune for the session's next new user turn, even below the
   * automatic threshold. Pending requests expire after ten minutes.
   */
  requestManualPrune(sessionId: string): void {
    this.manualPrunes.delete(sessionId);
    this.manualPrunes.set(sessionId, this.now() + MANUAL_PRUNE_TTL_MS);
    while (this.manualPrunes.size > MAX_PENDING_MANUAL_PRUNES) {
      const oldest = this.manualPrunes.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.manualPrunes.delete(oldest);
    }
  }

  async prune(
    request: AnthropicRequest,
    options: PruneOptions = {},
  ): Promise<PruneResult> {
    const beforeTokens = estimateTokens(request);
    if (!this.config.pruningEnabled) {
      return this.passThrough(request, beforeTokens, "disabled");
    }
    const firstSeen = this.markSessionSeen(options.sessionId);
    const manual =
      this.takeManualPrune(request, options.sessionId) ||
      this.invokesManualCommand(request);
    // A small request can skip the work below only when nothing has been
    // pruned yet: a /jev-prune below the threshold leaves saved decisions that
    // must still be re-applied, or the pruned output would come back.
    const nothingSaved =
      this.dropCache.size === 0 && this.rewriteCache.size === 0;
    if (!manual && nothingSaved && beforeTokens < this.config.pruneThreshold) {
      return this.resumeNotice(
        this.passThrough(request, beforeTokens, "below-threshold"),
        request,
        firstSeen,
      );
    }

    // Earlier drops and rewrites are re-applied on every request so the pruned
    // prefix stays byte-identical and keeps its prompt-cache discount.
    const cachedIds = new Set<string>();
    const rewrites = new Map<string, unknown>();
    let cachedRequest = request;
    let newRewrites = false;
    try {
      const candidates = this.extractCandidates(request);
      if (
        !manual &&
        candidates.length === 0 &&
        beforeTokens < this.config.pruneThreshold
      ) {
        return this.resumeNotice(
          this.passThrough(request, beforeTokens, "below-threshold"),
          request,
          firstSeen,
        );
      }
      if (candidates.length === 0) {
        return this.nothingToPrune(
          this.passThrough(request, beforeTokens, "no-candidates"),
          manual,
        );
      }

      const protectedIds = new Set<string>();
      if (this.config.keepRecent > 0) {
        for (const candidate of candidates.slice(-this.config.keepRecent)) {
          protectedIds.add(candidate.toolUseId);
        }
      }

      const allowed = candidates.filter(
        (candidate) => !this.config.excludeTools.has(candidate.toolName),
      );
      const keys = new Map<ToolCandidate, string>();
      for (const candidate of allowed) {
        const key = cacheKey(candidate);
        keys.set(candidate, key);
        if (this.touchCachedDrop(key)) {
          cachedIds.add(candidate.toolUseId);
          continue;
        }
        const content = this.cachedRewrite(key, candidate);
        if (content !== undefined) rewrites.set(candidate.toolUseId, content);
      }
      if (cachedIds.size > 0 || rewrites.size > 0) {
        cachedRequest = this.rewriteRequest(request, cachedIds, rewrites);
      }
      const cachedTokens = estimateTokens(cachedRequest);

      if (!manual && cachedTokens < this.config.pruneThreshold) {
        return this.resumeNotice(
          this.cachedOnly(
            cachedRequest,
            beforeTokens,
            cachedTokens,
            cachedIds.size,
            "below-threshold",
          ),
          request,
          firstSeen,
        );
      }
      // Pruning mid-task would cut context the agent is actively using, so new
      // decisions only happen when the user starts a new turn.
      if (!this.isNewUserTurn(request)) {
        return this.cachedOnly(
          cachedRequest,
          beforeTokens,
          cachedTokens,
          cachedIds.size,
          "mid-task",
        );
      }

      // Cheap mechanical rewrites run before Jev: superseded outputs become a
      // stub, then large outputs Claude has already seen are trimmed.
      const live = allowed.filter(
        (candidate) => !cachedIds.has(candidate.toolUseId),
      );
      let superseded = 0;
      let trimmed = 0;
      const stubbedIds = new Set<string>();
      if (this.config.supersede) {
        for (const [toolUseId, stub] of findSuperseded(live)) {
          stubbedIds.add(toolUseId);
          if (rewrites.get(toolUseId) === stub) continue;
          const candidate = live.find((item) => item.toolUseId === toolUseId);
          const key = candidate && keys.get(candidate);
          if (!key) continue;
          remember(
            this.rewriteCache,
            key,
            { kind: "stub", text: stub },
            this.maxCachedDrops,
          );
          rewrites.set(toolUseId, stub);
          superseded += 1;
        }
      }
      if (this.config.trim) {
        for (const candidate of live) {
          if (
            protectedIds.has(candidate.toolUseId) ||
            rewrites.has(candidate.toolUseId) ||
            !this.config.trimTools.has(candidate.toolName) ||
            estimateTokens(candidate.result) <= this.config.trimMinTokens
          ) {
            continue;
          }
          const result = trimOutput(
            candidate.result,
            this.config.trimKeepTokens,
          );
          const key = keys.get(candidate);
          if (!result || !key) continue;
          remember(
            this.rewriteCache,
            key,
            { kind: "trim", keepTokens: this.config.trimKeepTokens },
            this.maxCachedDrops,
          );
          rewrites.set(candidate.toolUseId, result.content);
          trimmed += 1;
        }
      }
      newRewrites = superseded + trimmed > 0;
      if (newRewrites) {
        cachedRequest = this.rewriteRequest(request, cachedIds, rewrites);
      }

      // Superseded results are never sent to Jev; trimmed ones are scored in
      // their short form.
      const eligibleForScoring = live
        .filter(
          (candidate) =>
            !protectedIds.has(candidate.toolUseId) &&
            !stubbedIds.has(candidate.toolUseId),
        )
        .map((candidate) =>
          rewrites.has(candidate.toolUseId)
            ? { ...candidate, result: rewrites.get(candidate.toolUseId) }
            : candidate,
        );
      const originalKey = (candidate: ToolCandidate) =>
        keys.get(
          live.find((item) => item.toolUseId === candidate.toolUseId) ??
            candidate,
        ) ?? cacheKey(candidate);
      const rewrittenTokens = estimateTokens(cachedRequest);

      // Keep decisions are reused until the context grows by rescoreTokens
      // since the last full scoring (or the user runs /jev-prune), so stable
      // candidates are not re-sent to Jev on every turn.
      const sessionKey = options.sessionId ?? DEFAULT_SESSION;
      const goal = this.latestUserGoal(request);
      const lastFull = this.lastFullScoreTokens.get(sessionKey);
      const fullRescore =
        manual ||
        lastFull === undefined ||
        this.lastScoredGoals.get(sessionKey) !== goal ||
        rewrittenTokens - lastFull >= this.config.rescoreTokens;
      const toScore = fullRescore
        ? eligibleForScoring
        : eligibleForScoring.filter(
            (candidate) => !this.keepCache.has(originalKey(candidate)),
          );
      if (toScore.length === 0 && !newRewrites) {
        const result = this.cachedOnly(
          cachedRequest,
          beforeTokens,
          cachedTokens,
          cachedIds.size,
          "no-candidates",
        );
        return eligibleForScoring.length === 0
          ? this.nothingToPrune(result, manual)
          : result;
      }

      const newlyDroppedCandidates: ToolCandidate[] = [];
      if (toScore.length > 0) {
        const scores = await this.scorer.score(goal, toScore);
        const cutoff = rewrittenTokens >= this.config.triggerTokens ? 0.7 : 0.5;
        const scoredCandidates = toScore.map((candidate) => {
          const score = scores.get(candidate.toolUseId);
          if (score === undefined) {
            throw new PruneError(`Missing score for ${candidate.toolUseId}`);
          }
          return { candidate, score };
        });

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
          const key = originalKey(candidate);
          if (score < cutoff) {
            newlyDroppedCandidates.push(candidate);
            this.keepCache.delete(key);
            this.rewriteCache.delete(key);
            remember(this.dropCache, key, true, this.maxCachedDrops);
          } else {
            remember(this.keepCache, key, true, this.maxCachedDrops);
          }
        }
      }
      const droppedIds = new Set(cachedIds);
      for (const candidate of newlyDroppedCandidates) {
        droppedIds.add(candidate.toolUseId);
      }

      const prunedRequest =
        droppedIds.size === cachedIds.size
          ? cachedRequest
          : this.rewriteRequest(request, droppedIds, rewrites);
      const afterTokens = estimateTokens(prunedRequest);
      if (fullRescore && toScore.length > 0) {
        remember(this.lastScoredGoals, sessionKey, goal, MAX_TRACKED_SESSIONS);
        remember(
          this.lastFullScoreTokens,
          sessionKey,
          afterTokens,
          MAX_TRACKED_SESSIONS,
        );
      }
      this.persist();
      const aboveTarget = afterTokens > this.config.targetTokens;
      const notice = this.notice(manual, {
        dropped: newlyDroppedCandidates.length,
        superseded,
        trimmed,
        beforeTokens: cachedTokens,
        afterTokens,
        aboveTarget,
      });
      return {
        request: this.config.notify
          ? this.appendNotice(prunedRequest, notice)
          : prunedRequest,
        beforeTokens,
        afterTokens,
        evaluated: toScore.length,
        dropped: droppedIds.size,
        superseded,
        trimmed,
        reason: "pruned",
        manual,
        aboveTarget,
        notice,
      };
    } catch (error) {
      if (newRewrites) this.persist();
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

  private restore(saved: PruneStateSnapshot): void {
    for (const key of saved.drops) {
      remember(this.dropCache, key, true, this.maxCachedDrops);
    }
    for (const key of saved.keeps) {
      remember(this.keepCache, key, true, this.maxCachedDrops);
    }
    for (const [key, rewrite] of saved.rewrites) {
      remember(this.rewriteCache, key, rewrite, this.maxCachedDrops);
    }
    for (const [session, tokens] of saved.lastFullScoreTokens) {
      remember(this.lastFullScoreTokens, session, tokens, MAX_TRACKED_SESSIONS);
    }
    for (const session of saved.seenSessions) {
      remember(this.seenSessions, session, true, MAX_TRACKED_SESSIONS);
    }
  }

  private persist(): void {
    if (!this.stateStore) return;
    try {
      this.stateStore.save({
        drops: [...this.dropCache.keys()],
        keeps: [...this.keepCache.keys()],
        rewrites: [...this.rewriteCache.entries()],
        lastFullScoreTokens: [...this.lastFullScoreTokens.entries()],
        seenSessions: [...this.seenSessions.keys()],
      });
    } catch (error) {
      this.logger?.warn("prune_state_save_failed", {
        error: loggableReason(error),
      });
    }
  }

  /** Returns true the first time this proxy (across restarts) sees a session. */
  private markSessionSeen(sessionId: string | undefined): boolean {
    if (sessionId === undefined) return false;
    if (this.seenSessions.has(sessionId)) return false;
    remember(this.seenSessions, sessionId, true, MAX_TRACKED_SESSIONS);
    this.persist();
    return true;
  }

  /**
   * A session seen for the first time that already has history is a resumed
   * conversation. Below the automatic threshold, suggest /jev-prune instead
   * of pruning unasked. First sight does not prove its prompt cache expired.
   */
  private resumeNotice(
    result: PruneResult,
    request: AnthropicRequest,
    firstSeen: boolean,
  ): PruneResult {
    if (
      !firstSeen ||
      this.config.resumeNoticeTokens <= 0 ||
      result.afterTokens < this.config.resumeNoticeTokens ||
      !this.isNewUserTurn(request) ||
      !request.messages.some((message) => message.role === "assistant")
    ) {
      return result;
    }
    const notice =
      `[jev-prune] This is a continued conversation at ~${Math.round(result.afterTokens / 1000)}K tokens. ` +
      `Automatic pruning starts at ~${Math.round(this.config.pruneThreshold / 1000)}K. ` +
      "Tell the user in one short line that they can run /jev-prune to trim stale tool results now.";
    return {
      ...result,
      resumed: true,
      notice,
      request: this.config.notify
        ? this.appendNotice(result.request, notice)
        : result.request,
    };
  }

  private nothingToPrune(result: PruneResult, manual: boolean): PruneResult {
    if (!manual) return result;
    const notice =
      "[jev-prune] Manual prune: no eligible tool results to prune " +
      `(the newest ${this.config.keepRecent} are always kept). ` +
      "Mention this to the user in one short line.";
    return {
      ...result,
      manual,
      notice,
      request: this.config.notify
        ? this.appendNotice(result.request, notice)
        : result.request,
    };
  }

  private invokesManualCommand(request: AnthropicRequest): boolean {
    if (!this.isNewUserTurn(request)) return false;
    const last = request.messages[this.lastTurnIndex(request)];
    if (!last) return false;
    if (typeof last.content === "string") {
      return MANUAL_COMMAND.test(last.content);
    }
    return last.content.some(
      (block) =>
        block.type === "text" &&
        typeof block.text === "string" &&
        MANUAL_COMMAND.test(block.text),
    );
  }

  private takeManualPrune(
    request: AnthropicRequest,
    sessionId: string | undefined,
  ): boolean {
    if (sessionId === undefined || !this.isNewUserTurn(request)) return false;
    const expiresAt = this.manualPrunes.get(sessionId);
    if (expiresAt === undefined) return false;
    this.manualPrunes.delete(sessionId);
    return expiresAt > this.now();
  }

  private isNewUserTurn(request: AnthropicRequest): boolean {
    const last = request.messages[this.lastTurnIndex(request)];
    if (!last || last.role !== "user") return false;
    if (typeof last.content === "string") return true;
    return !last.content.some((block) => isToolResult(block));
  }

  private notice(
    manual: boolean,
    counts: {
      dropped: number;
      superseded: number;
      trimmed: number;
      beforeTokens: number;
      afterTokens: number;
      aboveTarget: boolean;
    },
  ): string {
    const { beforeTokens, afterTokens, aboveTarget } = counts;
    const extras = [
      counts.superseded > 0
        ? `replaced ${counts.superseded} superseded output(s) with a stub`
        : "",
      counts.trimmed > 0 ? `trimmed ${counts.trimmed} large output(s)` : "",
    ].filter(Boolean);
    const summary =
      `[jev-prune] ${manual ? "Manual prune: pruned" : "Pruned"} ${counts.dropped} stale tool result(s)` +
      `${extras.length > 0 ? `, ${extras.join(", ")}` : ""}: context ` +
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

  /**
   * Removes dropped tool pairs and replaces rewritten tool-result content.
   * Every other field on a rewritten block (`cache_control`, `is_error`) is kept.
   */
  private rewriteRequest(
    request: AnthropicRequest,
    droppedIds: ReadonlySet<string>,
    rewrites: ReadonlyMap<string, unknown>,
  ): AnthropicRequest {
    const messages = request.messages.flatMap((message) => {
      if (!Array.isArray(message.content)) return [message];
      let changed = false;
      const content = message.content.flatMap((block) => {
        if (
          message.role === "assistant" &&
          isToolUse(block) &&
          droppedIds.has(block.id)
        ) {
          changed = true;
          return [];
        }
        if (message.role === "user" && isToolResult(block)) {
          if (droppedIds.has(block.tool_use_id)) {
            changed = true;
            return [];
          }
          if (rewrites.has(block.tool_use_id)) {
            changed = true;
            return [{ ...block, content: rewrites.get(block.tool_use_id) }];
          }
        }
        return [block];
      });
      if (!changed) return [message];
      if (content.length === 0) return [];
      return [{ ...message, content }];
    });

    return { ...request, messages };
  }

  /** Recomputes a saved rewrite for this candidate's original output. */
  private cachedRewrite(key: string, candidate: ToolCandidate): unknown {
    const rewrite = this.rewriteCache.get(key);
    if (!rewrite) return undefined;
    remember(this.rewriteCache, key, rewrite, this.maxCachedDrops);
    if (rewrite.kind === "stub") return rewrite.text;
    return trimOutput(candidate.result, rewrite.keepTokens)?.content;
  }
}

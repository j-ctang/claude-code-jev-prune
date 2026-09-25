import type { Config } from "../config.js";
import { PruneError, loggableReason } from "../errors.js";
import type {
  AnthropicRequest,
  PruneResult,
  RelevanceScorer,
  ToolCandidate,
} from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { estimateTokens } from "../utils/tokenCounter.js";
import { DecisionMemory } from "./decisionMemory.js";
import type { PruneStateStore } from "./pruneState.js";
import {
  nothingToPruneNotice,
  prunedNotice,
  resumedNotice,
} from "./pruneNotices.js";
import {
  applyDecisions,
  extractCandidates,
  loadsToolDefinitions,
} from "./toolPairs.js";
import { findSuperseded, trimOutput, type Superseded } from "./toolRewrites.js";
import { appendNotice, readTurn, type Turn } from "./turn.js";

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

const DEFAULT_SESSION = "default";
const MANUAL_PRUNE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_MANUAL_PRUNES = 1_000;

type SkipReason = "disabled" | "below-threshold" | "mid-task" | "no-candidates";

function skipped(
  request: AnthropicRequest,
  beforeTokens: number,
  afterTokens: number,
  dropped: number,
  reason: SkipReason,
): PruneResult {
  return { request, beforeTokens, afterTokens, evaluated: 0, dropped, reason };
}

/**
 * Prunes one request in stages: re-apply saved decisions, stop early when
 * pruning is not due, then stub superseded outputs, trim large ones, score the
 * rest with Jev, and render the result.
 */
export class ContextPruner {
  private readonly config: Config;
  private readonly scorer: RelevanceScorer;
  private readonly logger: AppLogger | undefined;
  private readonly memory: DecisionMemory;
  private readonly now: () => number;
  private readonly manualPrunes = new Map<string, number>();

  constructor(options: ContextPrunerOptions) {
    this.config = options.config;
    this.scorer = options.scorer;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.memory = new DecisionMemory({
      maxEntries: options.maxCachedDrops ?? 10_000,
      rescoreTokens: options.config.rescoreTokens,
      store: options.stateStore,
      logger: options.logger,
    });
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
      return skipped(request, beforeTokens, beforeTokens, 0, "disabled");
    }
    const { sessionId } = options;
    const turn = readTurn(request);
    const firstSeen = this.memory.markSessionSeen(sessionId);
    const manual =
      this.takeManualPrune(turn, sessionId) || turn.command === "jev-prune";
    const belowThreshold = (result: PruneResult) =>
      this.withResumeNotice(result, request, turn, firstSeen);
    const threshold = this.config.pruneThreshold;

    // A small request can skip the work below only when nothing has been
    // pruned yet: a /jev-prune below the threshold leaves saved decisions that
    // must still be re-applied, or the pruned output would come back.
    if (!manual && this.memory.isEmpty && beforeTokens < threshold) {
      return belowThreshold(
        skipped(request, beforeTokens, beforeTokens, 0, "below-threshold"),
      );
    }

    let current = request;
    let dropped = new Set<string>();
    let newRewrites = false;
    try {
      const candidates = extractCandidates(request);
      if (candidates.length === 0) {
        const result = skipped(
          request,
          beforeTokens,
          beforeTokens,
          0,
          manual || beforeTokens >= threshold
            ? "no-candidates"
            : "below-threshold",
        );
        return result.reason === "below-threshold"
          ? belowThreshold(result)
          : this.withNothingToPrune(result, manual);
      }

      // Saved decisions first, so the pruned prefix stays byte-identical.
      const allowed = candidates.filter(
        (candidate) =>
          !this.config.excludeTools.has(candidate.toolName) &&
          !loadsToolDefinitions(candidate.result),
      );
      const saved = this.memory.recall(allowed);
      dropped = saved.dropped;
      const rewrites = saved.rewrites;
      current = applyDecisions(request, dropped, rewrites);
      const cachedTokens = estimateTokens(current);
      if (!manual && cachedTokens < threshold) {
        return belowThreshold(
          skipped(
            current,
            beforeTokens,
            cachedTokens,
            dropped.size,
            "below-threshold",
          ),
        );
      }
      // Pruning mid-task would cut context the agent is actively using, so new
      // decisions only happen when the user starts a new turn.
      if (!turn.newUserTurn) {
        return skipped(
          current,
          beforeTokens,
          cachedTokens,
          dropped.size,
          "mid-task",
        );
      }

      // Cheap mechanical rewrites run before Jev: superseded outputs become a
      // stub, then large outputs Claude has already seen are trimmed.
      const live = allowed.filter(
        (candidate) => !dropped.has(candidate.toolUseId),
      );
      const protectedIds = new Set(
        this.config.keepRecent > 0
          ? candidates
              .slice(-this.config.keepRecent)
              .map((candidate) => candidate.toolUseId)
          : [],
      );
      // Searched across saved drops too, so a stub whose later Read was
      // dropped earlier is still found.
      const superseded: ReadonlyMap<string, Superseded> = this.config.supersede
        ? findSuperseded(allowed)
        : new Map();
      const newStubs = new Set<string>();
      let trimmed = 0;
      for (const candidate of live) {
        const id = candidate.toolUseId;
        const stub = superseded.get(id)?.stub;
        if (stub !== undefined) {
          if (rewrites.get(id) === stub) continue;
          this.memory.rewrite(candidate, { kind: "stub", text: stub });
          rewrites.set(id, stub);
          newStubs.add(id);
        } else if (
          !rewrites.has(id) &&
          this.shouldTrim(candidate, protectedIds)
        ) {
          const result = trimOutput(
            candidate.result,
            this.config.trimKeepTokens,
          );
          if (!result) continue;
          this.memory.rewrite(candidate, {
            kind: "trim",
            keepTokens: this.config.trimKeepTokens,
          });
          rewrites.set(id, result.content);
          trimmed += 1;
        }
      }
      newRewrites = newStubs.size + trimmed > 0;
      if (newRewrites) current = applyDecisions(request, dropped, rewrites);

      // Superseded results are never sent to Jev; trimmed ones are scored in
      // their short form.
      const eligible = live.filter(
        (candidate) =>
          !protectedIds.has(candidate.toolUseId) &&
          !superseded.has(candidate.toolUseId),
      );
      const rewrittenTokens = estimateTokens(current);
      const session = sessionId ?? DEFAULT_SESSION;
      const fullRescore =
        manual ||
        this.memory.needsFullRescore(session, turn.goal, rewrittenTokens);
      const toScore = fullRescore
        ? eligible
        : eligible.filter((candidate) => !this.memory.isKept(candidate));
      const newlyDropped =
        toScore.length > 0
          ? await this.score(turn.goal, toScore, rewrites, rewrittenTokens)
          : [];
      for (const candidate of newlyDropped) dropped.add(candidate.toolUseId);

      // A stub that points to a dropped result points at nothing, so drop it
      // too. Newest first, so a chain of stubs falls together.
      for (const candidate of [...live].reverse()) {
        const by = superseded.get(candidate.toolUseId)?.by;
        if (by === undefined || !dropped.has(by)) continue;
        dropped.add(candidate.toolUseId);
        newStubs.delete(candidate.toolUseId);
        this.memory.drop(candidate);
        newlyDropped.push(candidate);
      }

      if (toScore.length === 0 && !newRewrites && newlyDropped.length === 0) {
        const result = skipped(
          current,
          beforeTokens,
          cachedTokens,
          dropped.size,
          "no-candidates",
        );
        return eligible.length === 0
          ? this.withNothingToPrune(result, manual)
          : result;
      }

      const prunedRequest =
        newlyDropped.length === 0
          ? current
          : applyDecisions(request, dropped, rewrites);
      const afterTokens = estimateTokens(prunedRequest);
      if (fullRescore && toScore.length > 0) {
        this.memory.recordFullScore(session, turn.goal, afterTokens);
      }
      this.memory.save();
      const aboveTarget = afterTokens > this.config.targetTokens;
      const notice = prunedNotice(this.config, manual, {
        dropped: newlyDropped.length,
        superseded: newStubs.size,
        trimmed,
        beforeTokens: cachedTokens,
        afterTokens,
        aboveTarget,
      });
      return {
        request: this.withNotice(prunedRequest, notice),
        beforeTokens,
        afterTokens,
        evaluated: toScore.length,
        dropped: dropped.size,
        removedTokens: Math.max(0, cachedTokens - afterTokens),
        superseded: newStubs.size,
        trimmed,
        reason: "pruned",
        manual,
        aboveTarget,
        notice,
      };
    } catch (error) {
      if (newRewrites) this.memory.save();
      return {
        request: current,
        beforeTokens,
        afterTokens: estimateTokens(current),
        evaluated: 0,
        dropped: dropped.size,
        reason: "fail-open",
        failureReason: loggableReason(error),
      };
    }
  }

  private shouldTrim(
    candidate: ToolCandidate,
    protectedIds: ReadonlySet<string>,
  ): boolean {
    return (
      this.config.trim &&
      !protectedIds.has(candidate.toolUseId) &&
      this.config.trimTools.has(candidate.toolName) &&
      estimateTokens(candidate.result) > this.config.trimMinTokens
    );
  }

  /**
   * Scores candidates against the goal, remembers each decision, and returns
   * the ones to drop. Candidates are scored in their rewritten form.
   */
  private async score(
    goal: string,
    candidates: readonly ToolCandidate[],
    rewrites: ReadonlyMap<string, unknown>,
    tokens: number,
  ): Promise<ToolCandidate[]> {
    const scores = await this.scorer.score(
      goal,
      candidates.map((candidate) =>
        rewrites.has(candidate.toolUseId)
          ? { ...candidate, result: rewrites.get(candidate.toolUseId) }
          : candidate,
      ),
    );
    const cutoff = tokens >= this.config.triggerTokens ? 0.7 : 0.5;
    const scored = candidates.map((candidate) => {
      const score = scores.get(candidate.toolUseId);
      if (score === undefined) {
        throw new PruneError(`Missing score for ${candidate.toolUseId}`);
      }
      return { candidate, score };
    });

    const drops: ToolCandidate[] = [];
    for (const { candidate, score } of scored) {
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
        drops.push(candidate);
        this.memory.drop(candidate);
      } else {
        this.memory.keep(candidate);
      }
    }
    return drops;
  }

  private withNotice(
    request: AnthropicRequest,
    notice: string,
  ): AnthropicRequest {
    return this.config.notify ? appendNotice(request, notice) : request;
  }

  /**
   * A session seen for the first time that already has history is a resumed
   * conversation. Below the automatic threshold, suggest /jev-prune instead
   * of pruning unasked. First sight does not prove its prompt cache expired.
   */
  private withResumeNotice(
    result: PruneResult,
    request: AnthropicRequest,
    turn: Turn,
    firstSeen: boolean,
  ): PruneResult {
    if (
      !firstSeen ||
      this.config.resumeNoticeTokens <= 0 ||
      result.afterTokens < this.config.resumeNoticeTokens ||
      !turn.newUserTurn ||
      !request.messages.some((message) => message.role === "assistant")
    ) {
      return result;
    }
    const notice = resumedNotice(this.config, result.afterTokens);
    return {
      ...result,
      resumed: true,
      notice,
      request: this.withNotice(result.request, notice),
    };
  }

  private withNothingToPrune(
    result: PruneResult,
    manual: boolean,
  ): PruneResult {
    if (!manual) return result;
    const notice = nothingToPruneNotice(this.config);
    return {
      ...result,
      manual,
      notice,
      request: this.withNotice(result.request, notice),
    };
  }

  private takeManualPrune(turn: Turn, sessionId: string | undefined): boolean {
    if (sessionId === undefined || !turn.newUserTurn) return false;
    const expiresAt = this.manualPrunes.get(sessionId);
    if (expiresAt === undefined) return false;
    this.manualPrunes.delete(sessionId);
    return expiresAt > this.now();
  }
}

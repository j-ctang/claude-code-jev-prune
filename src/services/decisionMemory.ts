import { createHash } from "node:crypto";
import { loggableReason } from "../errors.js";
import type { ToolCandidate } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { PruneStateStore, Rewrite } from "./pruneState.js";
import { trimOutput } from "./toolRewrites.js";

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

function fingerprint(candidate: ToolCandidate): string {
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

export interface DecisionMemoryOptions {
  /** Most drop, keep, and rewrite decisions kept; the oldest are forgotten. */
  maxEntries: number;
  /** Context growth after which kept results are scored again. */
  rescoreTokens: number;
  store?: PruneStateStore | undefined;
  logger?: AppLogger | undefined;
}

/** Earlier decisions that apply to a request's tool calls. */
export interface Recalled {
  dropped: Set<string>;
  /** Tool-use ID to the content that replaces its output. */
  rewrites: Map<string, unknown>;
}

/**
 * Every pruning decision, keyed by each tool call's original content. Earlier
 * drops and rewrites are re-applied on every request so the pruned prefix
 * stays byte-identical and keeps its prompt-cache discount. Decisions survive
 * a proxy restart through the state store.
 */
export class DecisionMemory {
  private readonly drops = new Map<string, true>();
  private readonly keeps = new Map<string, true>();
  private readonly rewrites = new Map<string, Rewrite>();
  private readonly lastFullScoreTokens = new Map<string, number>();
  private readonly lastScoredGoals = new Map<string, string>();
  private readonly seenSessions = new Map<string, true>();
  private readonly keys = new WeakMap<ToolCandidate, string>();

  constructor(private readonly options: DecisionMemoryOptions) {
    const saved = options.store?.load();
    if (!saved) return;
    const max = options.maxEntries;
    for (const key of saved.drops) remember(this.drops, key, true, max);
    for (const key of saved.keeps) remember(this.keeps, key, true, max);
    for (const [key, rewrite] of saved.rewrites) {
      remember(this.rewrites, key, rewrite, max);
    }
    for (const [session, tokens] of saved.lastFullScoreTokens) {
      remember(this.lastFullScoreTokens, session, tokens, MAX_TRACKED_SESSIONS);
    }
    for (const [session, goal] of saved.lastScoredGoals) {
      remember(this.lastScoredGoals, session, goal, MAX_TRACKED_SESSIONS);
    }
    for (const session of saved.seenSessions) {
      remember(this.seenSessions, session, true, MAX_TRACKED_SESSIONS);
    }
  }

  /** True until something has been dropped or rewritten. */
  get isEmpty(): boolean {
    return this.drops.size === 0 && this.rewrites.size === 0;
  }

  recall(candidates: readonly ToolCandidate[]): Recalled {
    const recalled: Recalled = { dropped: new Set(), rewrites: new Map() };
    for (const candidate of candidates) {
      const key = this.keyOf(candidate);
      if (this.drops.has(key)) {
        remember(this.drops, key, true, this.options.maxEntries);
        recalled.dropped.add(candidate.toolUseId);
        continue;
      }
      const rewrite = this.rewrites.get(key);
      if (!rewrite) continue;
      remember(this.rewrites, key, rewrite, this.options.maxEntries);
      const content =
        rewrite.kind === "stub"
          ? rewrite.text
          : trimOutput(candidate.result, rewrite.keepTokens)?.content;
      if (content !== undefined) {
        recalled.rewrites.set(candidate.toolUseId, content);
      }
    }
    return recalled;
  }

  drop(candidate: ToolCandidate): void {
    const key = this.keyOf(candidate);
    this.keeps.delete(key);
    this.rewrites.delete(key);
    remember(this.drops, key, true, this.options.maxEntries);
  }

  keep(candidate: ToolCandidate): void {
    remember(this.keeps, this.keyOf(candidate), true, this.options.maxEntries);
  }

  isKept(candidate: ToolCandidate): boolean {
    return this.keeps.has(this.keyOf(candidate));
  }

  rewrite(candidate: ToolCandidate, rewrite: Rewrite): void {
    remember(
      this.rewrites,
      this.keyOf(candidate),
      rewrite,
      this.options.maxEntries,
    );
  }

  /**
   * Keep decisions are reused until the goal changes or the context grows by
   * `rescoreTokens` since the last full scoring, so stable results are not
   * re-sent to Jev on every turn.
   */
  needsFullRescore(session: string, goal: string, tokens: number): boolean {
    const last = this.lastFullScoreTokens.get(session);
    return (
      last === undefined ||
      this.lastScoredGoals.get(session) !== goal ||
      tokens - last >= this.options.rescoreTokens
    );
  }

  recordFullScore(session: string, goal: string, tokens: number): void {
    remember(this.lastScoredGoals, session, goal, MAX_TRACKED_SESSIONS);
    remember(this.lastFullScoreTokens, session, tokens, MAX_TRACKED_SESSIONS);
  }

  /** Returns true the first time this proxy (across restarts) sees a session. */
  markSessionSeen(sessionId: string | undefined): boolean {
    if (sessionId === undefined || this.seenSessions.has(sessionId)) {
      return false;
    }
    remember(this.seenSessions, sessionId, true, MAX_TRACKED_SESSIONS);
    this.save();
    return true;
  }

  save(): void {
    if (!this.options.store) return;
    try {
      this.options.store.save({
        drops: [...this.drops.keys()],
        keeps: [...this.keeps.keys()],
        rewrites: [...this.rewrites.entries()],
        lastFullScoreTokens: [...this.lastFullScoreTokens.entries()],
        lastScoredGoals: [...this.lastScoredGoals.entries()],
        seenSessions: [...this.seenSessions.keys()],
      });
    } catch (error) {
      this.options.logger?.warn("prune_state_save_failed", {
        error: loggableReason(error),
      });
    }
  }

  private keyOf(candidate: ToolCandidate): string {
    let key = this.keys.get(candidate);
    if (key === undefined) {
      key = fingerprint(candidate);
      this.keys.set(candidate, key);
    }
    return key;
  }
}

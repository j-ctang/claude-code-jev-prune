import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";

/** A stub replaces the whole output; a trim is recomputed from the original. */
export type Rewrite =
  | { kind: "stub"; text: string }
  | { kind: "trim"; keepTokens: number };

/**
 * Pruning memory that must survive a proxy restart. Without it, dropped tool
 * results reappear in live conversations and break their prompt cache.
 */
export interface PruneStateSnapshot {
  drops: string[];
  keeps: string[];
  rewrites: Array<[string, Rewrite]>;
  lastFullScoreTokens: Array<[string, number]>;
  lastScoredGoals: Array<[string, string]>;
  seenSessions: string[];
}

export interface PruneStateStore {
  load(): PruneStateSnapshot | undefined;
  save(snapshot: PruneStateSnapshot): void;
}

const STATE_VERSION = 1;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function entries<V>(
  value: unknown,
  isValue: (item: unknown) => item is V,
): Array<[string, V]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is [string, V] =>
      Array.isArray(entry) && typeof entry[0] === "string" && isValue(entry[1]),
  );
}

const isFiniteNumber = (item: unknown): item is number =>
  typeof item === "number" && Number.isFinite(item);

const isString = (item: unknown): item is string => typeof item === "string";

function isRewrite(item: unknown): item is Rewrite {
  if (typeof item !== "object" || item === null) return false;
  const rewrite = item as Record<string, unknown>;
  return (
    (rewrite.kind === "stub" && typeof rewrite.text === "string") ||
    (rewrite.kind === "trim" && isFiniteNumber(rewrite.keepTokens))
  );
}

export function createFileStateStore(path: string): PruneStateStore {
  return {
    load() {
      const parsed = readJson(path);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const saved = parsed as Record<string, unknown>;
      if (saved.version !== STATE_VERSION) return undefined;
      return {
        drops: stringArray(saved.drops),
        keeps: stringArray(saved.keeps),
        rewrites: entries(saved.rewrites, isRewrite),
        lastFullScoreTokens: entries(saved.lastFullScoreTokens, isFiniteNumber),
        lastScoredGoals: entries(saved.lastScoredGoals, isString),
        seenSessions: stringArray(saved.seenSessions),
      };
    },
    save(snapshot) {
      writeJsonAtomic(path, { version: STATE_VERSION, ...snapshot });
    },
  };
}

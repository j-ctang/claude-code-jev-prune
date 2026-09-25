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

function tokenEntries(value: unknown): Array<[string, number]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is [string, number] =>
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "number" &&
      Number.isFinite(entry[1]),
  );
}

function rewriteEntries(value: unknown): Array<[string, Rewrite]> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is [string, Rewrite] => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return false;
    const rewrite = entry[1] as Record<string, unknown> | null;
    if (typeof rewrite !== "object" || rewrite === null) return false;
    return (
      (rewrite.kind === "stub" && typeof rewrite.text === "string") ||
      (rewrite.kind === "trim" &&
        typeof rewrite.keepTokens === "number" &&
        Number.isFinite(rewrite.keepTokens))
    );
  });
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
        rewrites: rewriteEntries(saved.rewrites),
        lastFullScoreTokens: tokenEntries(saved.lastFullScoreTokens),
        seenSessions: stringArray(saved.seenSessions),
      };
    },
    save(snapshot) {
      writeJsonAtomic(path, { version: STATE_VERSION, ...snapshot });
    },
  };
}

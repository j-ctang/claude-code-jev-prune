import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.version !== STATE_VERSION) return undefined;
        return {
          drops: stringArray(parsed.drops),
          keeps: stringArray(parsed.keeps),
          rewrites: rewriteEntries(parsed.rewrites),
          lastFullScoreTokens: tokenEntries(parsed.lastFullScoreTokens),
          seenSessions: stringArray(parsed.seenSessions),
        };
      } catch {
        return undefined;
      }
    },
    save(snapshot) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      writeFileSync(
        temporaryPath,
        JSON.stringify({ version: STATE_VERSION, ...snapshot }),
        { mode: 0o600 },
      );
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, path);
    },
  };
}

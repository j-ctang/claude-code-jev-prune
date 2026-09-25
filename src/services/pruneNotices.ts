import type { Config } from "../config.js";

type NoticeConfig = Pick<
  Config,
  "keepRecent" | "pruneThreshold" | "targetTokens"
>;

const thousands = (tokens: number) => `~${Math.round(tokens / 1000)}K`;

export interface PruneCounts {
  dropped: number;
  superseded: number;
  trimmed: number;
  beforeTokens: number;
  afterTokens: number;
  aboveTarget: boolean;
}

export function prunedNotice(
  config: NoticeConfig,
  manual: boolean,
  counts: PruneCounts,
): string {
  const extras = [
    counts.superseded > 0
      ? `replaced ${counts.superseded} superseded output(s) with a stub`
      : "",
    counts.trimmed > 0 ? `trimmed ${counts.trimmed} large output(s)` : "",
  ].filter(Boolean);
  const summary =
    `[jev-prune] ${manual ? "Manual prune: pruned" : "Pruned"} ${counts.dropped} stale tool result(s)` +
    `${extras.length > 0 ? `, ${extras.join(", ")}` : ""}: context ` +
    `${thousands(counts.beforeTokens)} -> ${thousands(counts.afterTokens)} tokens.`;
  if (!counts.aboveTarget) {
    return `${summary} Mention this to the user in one short line.`;
  }
  return (
    `${summary} Context is still above the ` +
    `${thousands(config.targetTokens)} target, so answer quality may drop. ` +
    "Tell the user in one short line and suggest writing a handoff file " +
    "for a fresh session."
  );
}

export function nothingToPruneNotice(config: NoticeConfig): string {
  return (
    "[jev-prune] Manual prune: no eligible tool results to prune " +
    `(the newest ${config.keepRecent} are always kept). ` +
    "Mention this to the user in one short line."
  );
}

export function resumedNotice(config: NoticeConfig, tokens: number): string {
  return (
    `[jev-prune] This is a continued conversation at ${thousands(tokens)} tokens. ` +
    `Automatic pruning starts at ${thousands(config.pruneThreshold)}. ` +
    "Tell the user in one short line that they can run /jev-prune to trim stale tool results now."
  );
}

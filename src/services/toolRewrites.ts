import type { ToolCandidate } from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";

const CHARS_PER_TOKEN = 4;

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Claude Code returns file content as `<line number>\t<text>` lines. Other
 * Read outputs (an "unchanged since your last Read" notice, an error) carry no
 * content, so they cannot replace an earlier read.
 */
function hasFileContent(result: unknown): boolean {
  return typeof result === "string" && /^\s*\d+\t/.test(result);
}

function isWholeRead(input: unknown): boolean {
  return field(input, "offset") === undefined && field(input, "limit") === undefined;
}

/** Returns why `newer` makes `older`'s output out of date, or undefined. */
function supersededBy(older: ToolCandidate, newer: ToolCandidate): string | undefined {
  if (older.toolName === "Read") {
    const path = field(older.input, "file_path");
    if (typeof path !== "string" || field(newer.input, "file_path") !== path) {
      return undefined;
    }
    if (newer.toolName === "Write") return `a later Write of ${path}`;
    if (newer.toolName !== "Read" || !hasFileContent(newer.result)) {
      return undefined;
    }
    const sameRange =
      field(older.input, "offset") === field(newer.input, "offset") &&
      field(older.input, "limit") === field(newer.input, "limit");
    return isWholeRead(newer.input) || sameRange
      ? `a later Read of ${path}`
      : undefined;
  }
  if (older.toolName === "Bash") {
    const command = field(older.input, "command");
    return newer.toolName === "Bash" &&
      typeof command === "string" &&
      field(newer.input, "command") === command
      ? `a later run of the same command`
      : undefined;
  }
  if (older.toolName === "Grep" || older.toolName === "Glob") {
    return newer.toolName === older.toolName &&
      stableJson(newer.input) === stableJson(older.input)
      ? `a later ${older.toolName} with the same input`
      : undefined;
  }
  return undefined;
}

/**
 * Finds tool results made out of date by a later call. `candidates` must be in
 * conversation order. Returns tool-use ID to the stub text replacing its output.
 */
export function findSuperseded(
  candidates: readonly ToolCandidate[],
): Map<string, string> {
  const stubs = new Map<string, string>();
  candidates.forEach((older, index) => {
    for (const newer of candidates.slice(index + 1)) {
      const reason = supersededBy(older, newer);
      if (reason) {
        stubs.set(
          older.toolUseId,
          `[jev-prune] Output removed: superseded by ${reason}.`,
        );
        return;
      }
    }
  });
  return stubs;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (field(block, "type") !== "text") return undefined;
    const text = field(block, "text");
    if (typeof text !== "string") return undefined;
    texts.push(text);
  }
  return texts.join("\n");
}

export interface TrimResult {
  content: unknown;
  removedLines: number;
  removedTokens: number;
}

/**
 * Keeps about `keepTokens` at the start and end of a text output and replaces
 * the middle with a marker. Cuts fall on line breaks when the output has them.
 * Returns undefined when the output is not text or has nothing to cut.
 */
export function trimOutput(
  content: unknown,
  keepTokens: number,
): TrimResult | undefined {
  const text = textOf(content);
  if (text === undefined) return undefined;
  const keepChars = keepTokens * CHARS_PER_TOKEN;
  if (text.length <= keepChars * 2) return undefined;

  const lines = text.split("\n");
  let headCount = 0;
  let headChars = 0;
  while (
    headCount < lines.length &&
    headChars + (lines[headCount]?.length ?? 0) + 1 <= keepChars
  ) {
    headChars += (lines[headCount]?.length ?? 0) + 1;
    headCount += 1;
  }
  let tailCount = 0;
  let tailChars = 0;
  while (
    tailCount < lines.length - headCount &&
    tailChars + (lines[lines.length - 1 - tailCount]?.length ?? 0) + 1 <= keepChars
  ) {
    tailChars += (lines[lines.length - 1 - tailCount]?.length ?? 0) + 1;
    tailCount += 1;
  }

  let head: string;
  let tail: string;
  let removedLines: number;
  if (headCount === 0 || tailCount === 0) {
    // One very long line: cut by characters instead.
    head = text.slice(0, keepChars);
    tail = text.slice(-keepChars);
    removedLines = 0;
  } else {
    head = lines.slice(0, headCount).join("\n");
    tail = lines.slice(lines.length - tailCount).join("\n");
    removedLines = lines.length - headCount - tailCount;
  }
  const removedTokens = estimateTokens(text) - estimateTokens(head + tail);
  const what =
    removedLines > 0
      ? `${removedLines.toLocaleString("en-US")} lines (~${Math.round(removedTokens / 1000)}K tokens)`
      : `~${Math.round(removedTokens / 1000)}K tokens`;
  const trimmed =
    `${head}\n\n[jev-prune] Trimmed ${what} from the middle of this output. ` +
    `Re-run the command to see it in full.\n\n${tail}`;
  const first = Array.isArray(content) ? (content[0] as object) : undefined;
  return {
    content: first ? [{ ...first, type: "text", text: trimmed }] : trimmed,
    removedLines,
    removedTokens,
  };
}

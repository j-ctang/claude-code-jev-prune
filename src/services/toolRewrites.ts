import type { ToolCandidate } from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";

const CHARS_PER_TOKEN = 4;

function field(input: unknown, name: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[name]
    : undefined;
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
 * the middle with a marker. Cuts always fall on line breaks.
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

  if (headCount === 0 || tailCount === 0 || headCount + tailCount >= lines.length) {
    return undefined;
  }
  const head = lines.slice(0, headCount).join("\n");
  const tail = lines.slice(lines.length - tailCount).join("\n");
  const removedLines = lines.length - headCount - tailCount;
  const removedTokens = estimateTokens(text) - estimateTokens(head + tail);
  const what = `${removedLines.toLocaleString("en-US")} lines (~${Math.round(removedTokens / 1000)}K tokens)`;
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

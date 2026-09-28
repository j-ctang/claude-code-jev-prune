import type {
  AnthropicRequest,
  ContentBlock,
  ToolCandidate,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";

interface Located<Block> {
  messageIndex: number;
  blockIndex: number;
  block: Block;
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

/**
 * Tool search results hold `tool_reference` blocks that load deferred tool
 * definitions. Removing one would unload tools Claude may still call.
 */
export function loadsToolDefinitions(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "tool_reference",
    )
  );
}

/**
 * Returns tool calls whose use and result each appear exactly once, in
 * conversation order. Duplicate, unmatched, and malformed blocks are skipped.
 */
export function extractCandidates(request: AnthropicRequest): ToolCandidate[] {
  const uses = new Map<string, Located<ToolUseBlock>[]>();
  const results = new Map<string, Located<ToolResultBlock>[]>();

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

/**
 * What a dropped tool call's result becomes. It ties the removal to a later
 * user message: vaguer stubs led Claude, in live Claude Code sessions, to
 * decide it never saw the output and to retract answers that were right.
 */
export const DROPPED_STUB =
  "[jev-prune] Pruned from context later, when the user sent a newer message. Every reply you gave before that saw the full output, so those replies were based on the real output.";

const MAX_KEPT_INPUT_CHARS = 200;
const REMOVED_INPUT = "[jev-prune] Removed.";

/**
 * A dropped call keeps its short input fields (a path, a pattern, a command)
 * so Claude knows what it ran. Long strings, like a file written, are removed.
 */
export function stubInput(input: unknown): unknown {
  if (typeof input === "string") {
    return input.length > MAX_KEPT_INPUT_CHARS ? REMOVED_INPUT : input;
  }
  if (Array.isArray(input)) return input.map(stubInput);
  if (typeof input === "object" && input !== null) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, stubInput(value)]),
    );
  }
  return input;
}

/** Whether stubbing a call makes the request smaller. */
export function stubSaves(input: unknown, result: unknown): boolean {
  return (
    estimateTokens(input) + estimateTokens(result) >
    estimateTokens(stubInput(input)) + estimateTokens(DROPPED_STUB)
  );
}

/**
 * Stubs dropped tool pairs and replaces rewritten tool-result content. Blocks
 * and messages are never removed, so the history keeps its shape: removing an
 * emptied message could leave a `system` message where the API rejects it.
 * Every other field on a changed block (`cache_control`, `is_error`) is kept.
 */
export function applyDecisions(
  request: AnthropicRequest,
  droppedIds: ReadonlySet<string>,
  rewrites: ReadonlyMap<string, unknown>,
): AnthropicRequest {
  if (droppedIds.size === 0 && rewrites.size === 0) return request;
  const messages = request.messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (
        message.role === "assistant" &&
        isToolUse(block) &&
        droppedIds.has(block.id)
      ) {
        changed = true;
        return { ...block, input: stubInput(block.input) };
      }
      if (message.role === "user" && isToolResult(block)) {
        if (droppedIds.has(block.tool_use_id)) {
          changed = true;
          return { ...block, content: DROPPED_STUB };
        }
        if (rewrites.has(block.tool_use_id)) {
          changed = true;
          return { ...block, content: rewrites.get(block.tool_use_id) };
        }
      }
      return block;
    });
    return changed ? { ...message, content } : message;
  });

  return { ...request, messages };
}

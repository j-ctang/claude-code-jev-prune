import type {
  AnthropicRequest,
  ContentBlock,
  ToolCandidate,
  ToolResultBlock,
  ToolUseBlock,
} from "../types.js";

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
 * Removes dropped tool pairs and replaces rewritten tool-result content.
 * Every other field on a rewritten block (`cache_control`, `is_error`) is kept.
 */
export function applyDecisions(
  request: AnthropicRequest,
  droppedIds: ReadonlySet<string>,
  rewrites: ReadonlyMap<string, unknown>,
): AnthropicRequest {
  if (droppedIds.size === 0 && rewrites.size === 0) return request;
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

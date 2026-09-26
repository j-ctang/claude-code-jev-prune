import { DROPPED_STUB } from "../../src/services/toolPairs.js";
import type { AnthropicRequest, ContentBlock } from "../../src/types.js";

export const twoToolRequest: AnthropicRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "Preserve this system instruction." }],
  messages: [
    { role: "user", content: "Investigate the login failure." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the old log." },
        {
          type: "tool_use",
          id: "call-old",
          name: "read_file",
          input: { path: "old.log" },
          trace: "preserve-tool-metadata",
        },
      ],
      message_meta: "preserve-message-metadata",
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-old",
          content: `stale output ${"from an earlier investigation ".repeat(12)}`,
          result_meta: "preserve-result-metadata",
        },
      ],
    },
    { role: "user", content: "Now fix JWT validation." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will inspect the current code." },
        {
          type: "tool_use",
          id: "call-new",
          name: "read_file",
          input: { path: "src/auth.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-new",
          content: `current output ${"from the JWT validation code ".repeat(12)}`,
        },
      ],
    },
    { role: "user", content: "Keep going with the JWT fix." },
  ],
};

/** Tool-use IDs whose pair jev-prune stubbed out as dropped. */
export function droppedToolIds(request: AnthropicRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.content === DROPPED_STUB
      ) {
        ids.push(block.tool_use_id);
      }
    }
  }
  return ids;
}

/** Tool-use IDs still carrying their input, i.e. not dropped. */
export function allToolUseIds(request: AnthropicRequest): string[] {
  const dropped = new Set(droppedToolIds(request));
  const ids: string[] = [];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        !dropped.has(block.id)
      ) {
        ids.push(block.id);
      }
    }
  }
  return ids;
}

/** Tool-result IDs still carrying their output, i.e. not dropped. */
export function allToolResultIds(request: AnthropicRequest): string[] {
  const dropped = new Set(droppedToolIds(request));
  const ids: string[] = [];
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        !dropped.has(block.tool_use_id)
      ) {
        ids.push(block.tool_use_id);
      }
    }
  }
  return ids;
}

export function allText(request: AnthropicRequest): string[] {
  const text: string[] = [];
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      text.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        text.push(block.text);
      }
    }
  }
  return text;
}

export function contentBlock(
  block: Record<string, unknown> & { type: string },
): ContentBlock {
  return block as ContentBlock;
}

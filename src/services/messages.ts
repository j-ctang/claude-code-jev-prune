import type { AnthropicRequest, Message } from "../types.js";

/** Joins a message's text blocks; tool blocks carry no text. */
export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

/**
 * Claude Code may append `system` messages (hook context) after the user's
 * turn, so the turn boundary is judged from the last user/assistant message.
 */
export function lastTurnIndex(request: AnthropicRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const role = request.messages[index]?.role;
    if (role === "user" || role === "assistant") return index;
  }
  return -1;
}

/** Adds a text block for Claude to the end of the current turn. */
export function appendNotice(
  request: AnthropicRequest,
  notice: string,
): AnthropicRequest {
  const index = lastTurnIndex(request);
  const last = request.messages[index];
  if (!last) return request;
  const content =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : last.content;
  const messages = [...request.messages];
  messages[index] = {
    ...last,
    content: [...content, { type: "text", text: notice }],
  };
  return { ...request, messages };
}

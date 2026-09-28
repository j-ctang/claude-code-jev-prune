import type { AnthropicRequest, Message } from "../types.js";

/** What the latest turn of a request says about the user. */
export interface Turn {
  /** The user just spoke; false while Claude is working through tool calls. */
  newUserTurn: boolean;
  /** The newest nonempty user text, which pruning scores against. */
  goal: string;
  /** The user text before `goal`; set only on a new user turn. */
  previousGoal?: string;
  /** Slash command the user just ran, without a plugin namespace. */
  command?: string;
  /** Claude's last finished reply, if it ended with text rather than a tool call. */
  lastReply?: string;
}

// Claude Code wraps an invoked slash command as `<command-name>/name</command-name>`.
// Plugin commands are namespaced, e.g. `/jev-prune:jev-prune`.
const COMMAND = /<command-name>\/(?:[\w-]+:)?([\w-]+)<\/command-name>/;

const FALLBACK_GOAL = "Complete the current task.";

export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n");
}

function hasBlock(message: Message, type: string): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === type)
  );
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

export function readTurn(request: AnthropicRequest): Turn {
  const current = request.messages[lastTurnIndex(request)];
  const newUserTurn =
    current?.role === "user" && !hasBlock(current, "tool_result");
  const texts: string[] = [];
  for (
    let index = request.messages.length - 1;
    index >= 0 && texts.length < 2;
    index -= 1
  ) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message).trim();
    if (text) texts.push(text);
  }
  const turn: Turn = { newUserTurn, goal: texts[0] ?? FALLBACK_GOAL };
  if (!newUserTurn || !current) return turn;
  if (texts[1]) turn.previousGoal = texts[1];

  const command = COMMAND.exec(messageText(current))?.[1];
  if (command) turn.command = command;
  const reply = [...request.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const replyText =
    reply && !hasBlock(reply, "tool_use") ? messageText(reply) : "";
  if (replyText.trim()) turn.lastReply = replyText;
  return turn;
}

/** Adds a text block for Claude to the end of the current turn. */
export function appendNotice(
  request: AnthropicRequest,
  notice: string,
): AnthropicRequest {
  return appendNoticeAt(request, lastTurnIndex(request), notice);
}

/** Adds a text block for Claude to the end of message `index`. */
export function appendNoticeAt(
  request: AnthropicRequest,
  index: number,
  notice: string,
): AnthropicRequest {
  const message = request.messages[index];
  if (!message) return request;
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const messages = [...request.messages];
  messages[index] = {
    ...message,
    content: [...content, { type: "text", text: notice }],
  };
  return { ...request, messages };
}

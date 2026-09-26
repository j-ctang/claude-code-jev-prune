import { createHash } from "node:crypto";
import type { AnthropicRequest } from "../types.js";
import { messageText } from "./turn.js";

export const SESSION_HEADER = "x-claude-code-session-id";
/** Claude Code sends this on every subagent request, never on the main thread. */
export const AGENT_HEADER = "x-claude-code-agent-id";

/** One thread of requests: the user's main thread or one subagent. */
export interface Conversation {
  /** Stable for the thread's life, including across /compact. */
  key: string;
  /** Only the main thread can reach the user. */
  main: boolean;
  sessionId?: string;
}

/**
 * Keys a thread by session and subagent. A request without a session header
 * is keyed by its first user message, which is all that identifies it.
 */
export function identifyConversation(
  request: AnthropicRequest,
  sessionId?: string,
  agentId?: string,
): Conversation {
  const thread = agentId ?? "main";
  if (sessionId)
    return { key: `${sessionId}:${thread}`, main: !agentId, sessionId };
  const first = request.messages.find((message) => message.role === "user");
  const digest = createHash("sha256")
    .update(first ? messageText(first) : "")
    .digest("hex")
    .slice(0, 16);
  return { key: `${digest}:${thread}`, main: !agentId };
}

/**
 * Claude Code's session setup call (for example, naming the session) has no
 * tools and wraps the prompt in `<session>`. It is not part of any thread.
 */
export function isSideRequest(request: AnthropicRequest): boolean {
  const tools = request.tools;
  if (Array.isArray(tools) && tools.length > 0) return false;
  const first = request.messages.find((message) => message.role === "user");
  return first !== undefined && messageText(first).startsWith("<session>");
}

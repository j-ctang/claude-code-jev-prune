import type { AnthropicRequest } from "../types.js";

interface CanaryState {
  lastReply: string;
  misses: number;
}

/** Checks completed assistant text carried into the next user request. */
export class CanaryMonitor {
  private readonly sessions = new Map<string, CanaryState>();

  constructor(private readonly prefix: string) {}

  observe(sessionId: string, request: AnthropicRequest): boolean {
    if (!this.prefix) return false;
    const current = [...request.messages]
      .reverse()
      .find((message) => message.role === "user" || message.role === "assistant");
    if (current?.role !== "user") return false;
    if (
      Array.isArray(current.content) &&
      current.content.some((block) => block.type === "tool_result")
    )
      return false;
    const reply = [...request.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !reply ||
      (Array.isArray(reply.content) &&
        reply.content.some((block) => block.type === "tool_use"))
    ) {
      return false;
    }
    const text =
      typeof reply.content === "string"
        ? reply.content
        : reply.content
            .filter(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => String(block.text))
            .join("\n");
    if (!text.trim()) return false;
    const previous = this.sessions.get(sessionId);
    if (previous?.lastReply === text) return false;
    const matched = text.trimStart().startsWith(this.prefix);
    const misses = matched ? 0 : (previous?.misses ?? 0) + 1;
    this.sessions.set(sessionId, { lastReply: text, misses });
    return misses >= 2;
  }
}

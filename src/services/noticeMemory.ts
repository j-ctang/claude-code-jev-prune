import { createHash } from "node:crypto";
import type { AnthropicRequest, Message } from "../types.js";
import { remember } from "../utils/recency.js";
import { appendNoticeAt, lastTurnIndex } from "./turn.js";

interface Noticed {
  index: number;
  /** Which message the notices were added to, so a rewritten history drops them. */
  fingerprint: string;
  notices: readonly string[];
}

const MAX_CONVERSATIONS = 500;

/**
 * Claude Code moves cache_control between requests and may send text as a
 * string or a block, so a message is known by its role, text, and tool IDs.
 */
function fingerprint(message: Message): string {
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const shape = blocks.map((block) => [
    block.type,
    block.text,
    block.id,
    block.tool_use_id,
  ]);
  return createHash("sha256")
    .update(JSON.stringify([message.role, shape]))
    .digest("hex");
}

/**
 * Claude's preserved thinking is bound to the exact history it saw. A notice
 * added once and then missing would change that history and drop the
 * thinking, so every notice is added back where it was on later requests.
 */
export class NoticeMemory {
  private readonly conversations = new Map<string, readonly Noticed[]>();

  constructor(private readonly maxConversations = MAX_CONVERSATIONS) {}

  /**
   * Returns `request` with earlier notices back in place and `notices` added
   * to the current turn. Calling it again for the same turn replaces that
   * turn's notices, as when a rejected request is resent with another notice.
   */
  apply(
    conversation: string,
    request: AnthropicRequest,
    notices: readonly string[],
  ): AnthropicRequest {
    const saved = (this.conversations.get(conversation) ?? []).filter(
      (entry) => {
        const message = request.messages[entry.index];
        return (
          message !== undefined && fingerprint(message) === entry.fingerprint
        );
      },
    );
    const index = lastTurnIndex(request);
    const current = request.messages[index];
    const entries =
      current && notices.length > 0
        ? [
            ...saved.filter((entry) => entry.index !== index),
            { index, fingerprint: fingerprint(current), notices },
          ]
        : saved;
    remember(this.conversations, conversation, entries, this.maxConversations);

    let noticed = request;
    for (const entry of entries) {
      for (const notice of entry.notices) {
        noticed = appendNoticeAt(noticed, entry.index, notice);
      }
    }
    return noticed;
  }
}

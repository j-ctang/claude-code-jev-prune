import { createHash } from "node:crypto";
import type { AnthropicRequest, Message } from "../types.js";
import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";
import type { AppLogger } from "../utils/logger.js";
import { remember } from "../utils/recency.js";
import { appendNoticeAt, lastTurnIndex } from "./turn.js";

interface Noticed {
  index: number;
  /** Which message the notices were added to, so a rewritten history drops them. */
  fingerprint: string;
  notices: readonly string[];
}

interface NoticeMemoryOptions {
  /** Where notices are saved, so a restarted proxy adds them back too. */
  path?: string | undefined;
  logger?: AppLogger | undefined;
  maxConversations?: number;
  maxEntries?: number;
}

const MAX_CONVERSATIONS = 500;
const MAX_ENTRIES = 200;
const STATE_VERSION = 1;

function isNoticed(value: unknown): value is Noticed {
  const entry = value as Record<string, unknown> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    Number.isInteger(entry.index) &&
    typeof entry.fingerprint === "string" &&
    Array.isArray(entry.notices) &&
    entry.notices.every((notice) => typeof notice === "string")
  );
}

/** Saved conversations, skipping any entry that is malformed. */
function loadConversations(path: string): Array<[string, Noticed[]]> {
  const saved = readJson(path) as Record<string, unknown> | undefined;
  if (saved?.version !== STATE_VERSION || !Array.isArray(saved.conversations)) {
    return [];
  }
  return saved.conversations.flatMap((item: unknown) =>
    Array.isArray(item) && typeof item[0] === "string" && Array.isArray(item[1])
      ? [[item[0], item[1].filter(isNoticed)] as [string, Noticed[]]]
      : [],
  );
}

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
  private readonly maxConversations: number;
  private readonly maxEntries: number;

  constructor(private readonly options: NoticeMemoryOptions = {}) {
    this.maxConversations = options.maxConversations ?? MAX_CONVERSATIONS;
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    if (!options.path) return;
    for (const [conversation, entries] of loadConversations(options.path)) {
      remember(
        this.conversations,
        conversation,
        entries,
        this.maxConversations,
      );
    }
  }

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
    // Entries that don't match are kept: a side request or rewound history
    // shares the conversation, and the thread may come back to them.
    let entries = this.conversations.get(conversation) ?? [];
    const index = lastTurnIndex(request);
    const current = request.messages[index];
    if (current && notices.length > 0) {
      const print = fingerprint(current);
      entries = [
        ...entries.filter(
          (entry) => entry.index !== index || entry.fingerprint !== print,
        ),
        { index, fingerprint: print, notices },
      ].slice(-this.maxEntries);
      remember(
        this.conversations,
        conversation,
        entries,
        this.maxConversations,
      );
      this.save();
    } else if (entries.length > 0) {
      remember(
        this.conversations,
        conversation,
        entries,
        this.maxConversations,
      );
    }

    let noticed = request;
    for (const entry of entries) {
      const message = request.messages[entry.index];
      if (!message || fingerprint(message) !== entry.fingerprint) continue;
      for (const notice of entry.notices) {
        noticed = appendNoticeAt(noticed, entry.index, notice);
      }
    }
    return noticed;
  }

  /** A failed save never fails the request; notices stay in memory. */
  private save(): void {
    if (!this.options.path) return;
    try {
      writeJsonAtomic(this.options.path, {
        version: STATE_VERSION,
        conversations: [...this.conversations.entries()],
      });
    } catch (error) {
      this.options.logger?.warn("notice_state_save_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      });
    }
  }
}

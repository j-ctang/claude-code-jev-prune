import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { AnthropicRequest, NoulAsker, NoulQuestion } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { RouteMode } from "./routeMode.js";
import { messageText, readTurn, type Turn } from "./turn.js";

export interface RouteDecision {
  /** Model to send upstream; set only when it differs from the request's. */
  model?: string;
  /** Text to show Claude on this request. */
  notice?: string;
  /** Conversation this decision belongs to, for markUnavailable. */
  conversation?: string;
}

type RouterConfig = Pick<
  Config,
  | "routeDefaultModel"
  | "routeHardModel"
  | "routeUpThreshold"
  | "routeDownThreshold"
  | "notify"
>;

interface ConversationState {
  model: string;
  /** The hard model was rejected upstream; never route again. */
  unavailable: boolean;
  /** Claude was told to ask the user about routing for this prompt. */
  askedHard: boolean;
}

const MAX_CONVERSATIONS = 500;
const MAX_REPLY_CHARS = 4_000;
const CONTINUES_THRESHOLD = 0.5;

const QUESTIONS: Record<"hard" | "continues", NoulQuestion> = {
  hard: {
    instructions:
      "Does newest_request need deep, multi-step reasoning to do well?",
    criteria: {
      true: "The request needs careful design, debugging, or reasoning across many steps or files.",
      false: "The request is simple, routine, or a quick question.",
    },
  },
  continues: {
    instructions:
      "Is newest_request a follow-up that depends on the work in previous_request and last_reply?",
    criteria: {
      true: "The request continues or builds on the work just done.",
      false: "The request starts a new, unrelated task.",
    },
  },
};

const AUTO_ON_NOTICE =
  "[jev-prune] Automatic model routing is on. Tell the user in one short line.";
const OFF_NOTICE =
  "[jev-prune] Automatic model routing is off. Tell the user in one short line. If you paused a request to ask about routing, continue it now.";
const SAVE_FAILED_NOTICE =
  "[jev-prune] Could not save the model routing setting.";

/**
 * A subagent shares its parent's session header but not its first message.
 * Only the first message's text is hashed: Claude Code moves `cache_control`
 * to the newest message, so other block fields change between requests.
 */
export function conversationKey(
  request: AnthropicRequest,
  sessionId?: string,
): string {
  const first = request.messages.find((message) => message.role === "user");
  const digest = createHash("sha256")
    .update(first ? messageText(first) : "")
    .digest("hex")
    .slice(0, 16);
  return `${sessionId ?? "no-session"}:${digest}`;
}

/**
 * Moves a conversation to the hard model on hard prompts and back to the
 * default model at the next easy, unrelated task. Decides only when the user
 * speaks, so the model never changes inside a tool loop.
 */
export class ModelRouter {
  private readonly conversations = new Map<string, ConversationState>();
  /** First conversation seen per session: the main thread, not a subagent. */
  private readonly mainConversations = new Map<string, string>();

  constructor(
    private readonly config: RouterConfig,
    private readonly asker: NoulAsker,
    private readonly mode: RouteMode,
    private readonly logger: AppLogger,
    /** Tests lower this to check eviction. */
    private readonly maxConversations = MAX_CONVERSATIONS,
  ) {}

  async route(
    request: AnthropicRequest,
    sessionId?: string,
  ): Promise<RouteDecision> {
    const turn = readTurn(request);
    const commandNotice = this.applyCommand(turn.command);
    if (this.mode.choice === "off" || !this.eligible(request)) {
      return commandNotice ? { notice: commandNotice } : {};
    }
    const conversation = conversationKey(request, sessionId);
    const main = this.isMain(conversation, sessionId);
    const state = this.stateFor(conversation);
    if (state.unavailable)
      return this.decision(conversation, state, commandNotice);

    // A skipped routing question expires once the user sends anything else.
    if (turn.newUserTurn && turn.command !== "jev-route-auto") {
      state.askedHard = false;
    }
    // A failed save keeps the question pending and the model unchanged.
    if (
      turn.command === "jev-route-auto" &&
      state.askedHard &&
      commandNotice !== SAVE_FAILED_NOTICE
    ) {
      state.askedHard = false;
      this.switchTo(state, conversation, this.config.routeHardModel, "opt-in");
      return this.decision(
        conversation,
        state,
        `[jev-prune] Automatic model routing is on. This conversation now uses ${this.config.routeHardModel}. Tell the user in one short line, then continue their previous request.`,
      );
    }
    if (turn.newUserTurn && !turn.command) {
      return this.decision(
        conversation,
        state,
        await this.decide(turn, state, conversation, main),
      );
    }
    return this.decision(conversation, state, commandNotice);
  }

  /** Stops routing a conversation whose hard model the upstream rejected. */
  markUnavailable(conversation: string): string {
    const state = this.stateFor(conversation);
    state.model = this.config.routeDefaultModel;
    state.unavailable = true;
    return `[jev-prune] ${this.config.routeHardModel} is not available on this account. Staying on ${this.config.routeDefaultModel}. Tell the user in one short line.`;
  }

  private async decide(
    turn: Turn,
    state: ConversationState,
    conversation: string,
    main: boolean,
  ): Promise<string | undefined> {
    let scores: ReadonlyMap<string, number>;
    try {
      scores = await this.asker.ask(
        {
          newest_request: turn.goal,
          previous_request: turn.previousGoal ?? "",
          last_reply: (turn.lastReply ?? "").slice(-MAX_REPLY_CHARS),
        },
        QUESTIONS,
      );
    } catch (error) {
      this.logger.warn("route_fail_open", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return undefined;
    }
    const hard = scores.get("hard") ?? 0;
    const continues = scores.get("continues") ?? 0;
    const up = state.model === this.config.routeHardModel;

    if (!up && hard >= this.config.routeUpThreshold) {
      if (this.mode.choice === "ask") {
        // Only the main thread can reach the user; subagents stay put.
        if (!this.config.notify || !main) return undefined;
        state.askedHard = true;
        return `[jev-prune] This prompt looks hard. Do not start it yet. In one short line, tell the user that jev-prune can move hard prompts to ${this.config.routeHardModel} automatically, and ask them to run /jev-route-auto to turn it on or /jev-route-off to keep the current model.`;
      }
      this.switchTo(
        state,
        conversation,
        this.config.routeHardModel,
        "hard",
        hard,
        continues,
      );
      return `[jev-prune] Switched this conversation to ${this.config.routeHardModel} for a hard prompt. Tell the user in one short line.`;
    }
    if (
      up &&
      continues < CONTINUES_THRESHOLD &&
      hard <= this.config.routeDownThreshold
    ) {
      this.switchTo(
        state,
        conversation,
        this.config.routeDefaultModel,
        "new-easy-task",
        hard,
        continues,
      );
      return `[jev-prune] Switched this conversation back to ${this.config.routeDefaultModel} for a new, simpler task. Tell the user in one short line.`;
    }
    return undefined;
  }

  private switchTo(
    state: ConversationState,
    conversation: string,
    model: string,
    reason: string,
    hard?: number,
    continues?: number,
  ): void {
    this.logger.info("model_route", {
      conversation,
      from: state.model,
      to: model,
      reason,
      ...(hard === undefined ? {} : { hard }),
      ...(continues === undefined ? {} : { continues }),
    });
    state.model = model;
  }

  private applyCommand(command: string | undefined): string | undefined {
    if (command !== "jev-route-auto" && command !== "jev-route-off") {
      return undefined;
    }
    const choice = command === "jev-route-auto" ? "auto" : "off";
    try {
      this.mode.set(choice);
    } catch (error) {
      this.logger.warn("route_mode_save_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      });
      return SAVE_FAILED_NOTICE;
    }
    return choice === "auto" ? AUTO_ON_NOTICE : OFF_NOTICE;
  }

  private eligible(request: AnthropicRequest): boolean {
    const choice = request.tool_choice;
    const autoChoice =
      choice === undefined ||
      (typeof choice === "object" &&
        choice !== null &&
        "type" in choice &&
        choice.type === "auto");
    return request.model === this.config.routeDefaultModel && autoChoice;
  }

  private stateFor(conversation: string): ConversationState {
    const state = this.conversations.get(conversation) ?? {
      model: this.config.routeDefaultModel,
      unavailable: false,
      askedHard: false,
    };
    this.remember(this.conversations, conversation, state);
    return state;
  }

  private isMain(conversation: string, sessionId?: string): boolean {
    if (sessionId === undefined) return true;
    const main = this.mainConversations.get(sessionId) ?? conversation;
    this.remember(this.mainConversations, sessionId, main);
    return main === conversation;
  }

  /** Map order is recency: re-insert on use, drop the least recent. */
  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.maxConversations) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  private decision(
    conversation: string,
    state: ConversationState,
    notice: string | undefined,
  ): RouteDecision {
    return {
      conversation,
      ...(state.model === this.config.routeDefaultModel
        ? {}
        : { model: state.model }),
      ...(notice ? { notice } : {}),
    };
  }
}

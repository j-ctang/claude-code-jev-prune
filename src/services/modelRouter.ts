import type { Config } from "../config.js";
import type { AnthropicRequest, NoulAsker, NoulQuestion } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import { SavedChoice } from "./savedChoice.js";
import { remember } from "../utils/recency.js";
import {
  isCompactionRequest,
  isSideRequest,
  type Conversation,
} from "./conversation.js";
import { readTurn, type Turn } from "./turn.js";

export interface RouteDecision {
  /** Model to send upstream; set only when it differs from the request's. */
  model?: string;
  /** Text to show Claude on this request. */
  notice?: string;
  /** Set with `model`: what to do if the upstream rejects the routed model. */
  fallback?: RouteFallback;
}

/** The upstream response that refused the routed model. */
export type Rejection = Pick<globalThis.Response, "status" | "headers">;

export interface RouteFallback {
  /** Whether this upstream response means resend on the original model. */
  retries(rejection: Rejection): boolean;
  /** Text to show Claude on the resend. */
  notice: string;
  /** The resend succeeded, so the routed model can't take this request. */
  confirm(rejection: Rejection): void;
}

interface CommandResult {
  choice: "auto" | "off";
  saved: boolean;
  notice: string;
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

/**
 * A 403 or 404 says the account can't use the model at all, as does a 429
 * the API marks not retryable (a plan without the model's usage credits).
 * A 400 may come from this conversation alone.
 */
function refusesModel({ status, headers }: Rejection): boolean {
  return (
    status === 403 ||
    status === 404 ||
    (status === 429 && headers.get("x-should-retry") === "false")
  );
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

export type RouteChoice = "ask" | "auto" | "off";

/** The saved routing choice, next to the pruning state; `ask` until answered. */
export function routeChoice(statePath: string): SavedChoice<RouteChoice> {
  return new SavedChoice<RouteChoice>(
    `${statePath}.route-mode.json`,
    "choice",
    "ask",
    (value): value is RouteChoice => value === "auto" || value === "off",
  );
}

type SwitchReason =
  | { reason: "opt-in" }
  | { reason: "hard" | "new-easy-task"; hard: number; continues: number };

/**
 * The routing policy on one new prompt. Up on a hard prompt. While up, stay
 * for follow-ups and hard prompts; go down only for a new, easy task.
 */
export function nextMove(
  up: boolean,
  { hard, continues }: { hard: number; continues: number },
  thresholds: Pick<Config, "routeUpThreshold" | "routeDownThreshold">,
): "up" | "down" | "stay" {
  if (!up) return hard >= thresholds.routeUpThreshold ? "up" : "stay";
  return continues < CONTINUES_THRESHOLD &&
    hard <= thresholds.routeDownThreshold
    ? "down"
    : "stay";
}

/**
 * Moves a conversation to the hard model on hard prompts and back to the
 * default model at the next easy, unrelated task. Decides only when the user
 * speaks, so the model never changes inside a tool loop.
 */
export class ModelRouter {
  private readonly conversations = new Map<string, ConversationState>();
  /** The account can't use the hard model, so no conversation is routed. */
  private modelRefused = false;

  constructor(
    private readonly config: RouterConfig,
    private readonly asker: NoulAsker,
    private readonly mode: SavedChoice<RouteChoice>,
    private readonly logger: AppLogger,
    /** Tests lower this to check eviction. */
    private readonly maxConversations = MAX_CONVERSATIONS,
  ) {}

  async route(
    request: AnthropicRequest,
    { key: conversation, main }: Conversation,
  ): Promise<RouteDecision> {
    const turn = readTurn(request);
    const command = this.applyCommand(turn.command);
    if (this.mode.value === "off" || !this.eligible(request)) {
      return command ? { notice: command.notice } : {};
    }
    const state = this.stateFor(conversation);
    // Compaction stays on the thread's model: its cache is warm there.
    if (
      state.unavailable ||
      !turn.newUserTurn ||
      isCompactionRequest(request)
    ) {
      return this.decision(conversation, state, command?.notice);
    }

    // A routing question expires once the user sends anything else.
    const asked = state.askedHard;
    state.askedHard = false;
    if (asked && command?.choice === "auto") {
      // A failed save keeps the question pending and the model unchanged.
      if (!command.saved) {
        state.askedHard = true;
        return this.decision(conversation, state, command.notice);
      }
      this.switchTo(state, conversation, this.config.routeHardModel, {
        reason: "opt-in",
      });
      return this.decision(
        conversation,
        state,
        `[jev-prune] Automatic model routing is on. This conversation now uses ${this.config.routeHardModel}. Tell the user in one short line, then continue their previous request.`,
        true,
      );
    }
    // With notices off, ask mode can never ask, so Jev is not needed.
    const silentAsk = this.mode.value === "ask" && !this.config.notify;
    if (turn.command || silentAsk) {
      return this.decision(conversation, state, command?.notice);
    }
    return this.decision(
      conversation,
      state,
      await this.decide(turn, state, conversation, main),
    );
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
    const move = nextMove(
      state.model === this.config.routeHardModel,
      { hard, continues },
      this.config,
    );
    if (move === "up" && this.mode.value === "ask") {
      // Only the main thread can reach the user; subagents stay put.
      if (!this.config.notify || !main) return undefined;
      state.askedHard = true;
      return `[jev-prune] This prompt looks hard. Do not start it yet. In one short line, tell the user that jev-prune can move hard prompts to ${this.config.routeHardModel} automatically, and ask them to run /jev-route-auto to turn it on or /jev-route-off to keep the current model.`;
    }
    if (move === "up") {
      this.switchTo(state, conversation, this.config.routeHardModel, {
        reason: "hard",
        hard,
        continues,
      });
      return `[jev-prune] Switched this conversation to ${this.config.routeHardModel} for a hard prompt. Tell the user in one short line.`;
    }
    if (move === "down") {
      this.switchTo(state, conversation, this.config.routeDefaultModel, {
        reason: "new-easy-task",
        hard,
        continues,
      });
      return `[jev-prune] Switched this conversation back to ${this.config.routeDefaultModel} for a new, simpler task. Tell the user in one short line.`;
    }
    return undefined;
  }

  private switchTo(
    state: ConversationState,
    conversation: string,
    model: string,
    why: SwitchReason,
  ): void {
    this.logger.info("model_route", {
      conversation,
      from: state.model,
      to: model,
      ...why,
    });
    state.model = model;
  }

  private applyCommand(command: string | undefined): CommandResult | undefined {
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
      return { choice, saved: false, notice: SAVE_FAILED_NOTICE };
    }
    return {
      choice,
      saved: true,
      notice: choice === "auto" ? AUTO_ON_NOTICE : OFF_NOTICE,
    };
  }

  private eligible(request: AnthropicRequest): boolean {
    const choice = request.tool_choice;
    const autoChoice =
      choice === undefined ||
      (typeof choice === "object" &&
        choice !== null &&
        "type" in choice &&
        choice.type === "auto");
    return (
      !this.modelRefused &&
      request.model === this.config.routeDefaultModel &&
      autoChoice &&
      !isSideRequest(request)
    );
  }

  private stateFor(conversation: string): ConversationState {
    const state = this.conversations.get(conversation) ?? {
      model: this.config.routeDefaultModel,
      unavailable: false,
      askedHard: false,
    };
    remember(this.conversations, conversation, state, this.maxConversations);
    return state;
  }

  /** `resumes`: the user's message is the opt-in, so the work is the prompt before it. */
  private decision(
    conversation: string,
    state: ConversationState,
    notice: string | undefined,
    resumes = false,
  ): RouteDecision {
    const routed = state.model !== this.config.routeDefaultModel;
    return {
      ...(routed
        ? {
            model: state.model,
            fallback: this.fallback(conversation, state, resumes),
          }
        : {}),
      ...(notice ? { notice } : {}),
    };
  }

  /**
   * Any 400 is retried, since the routed model may be the cause. Only a
   * retry that succeeds proves it was, so only that stops routing.
   */
  private fallback(
    conversation: string,
    state: ConversationState,
    resumes: boolean,
  ): RouteFallback {
    const { routeDefaultModel, routeHardModel } = this.config;
    return {
      retries: (rejection) =>
        rejection.status === 400 || refusesModel(rejection),
      notice: `[jev-prune] ${routeHardModel} rejected this request, so this conversation stays on ${routeDefaultModel}. Tell the user in one short line${resumes ? ", then continue their previous request" : ""}.`,
      confirm: (rejection) => {
        const everywhere = refusesModel(rejection);
        this.logger.warn("route_model_unavailable", {
          conversation,
          model: routeHardModel,
          status: rejection.status,
          everywhere,
        });
        state.model = routeDefaultModel;
        state.unavailable = true;
        if (everywhere) this.modelRefused = true;
      },
    };
  }
}

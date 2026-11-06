import type { Config } from "../config.js";
import type { RelevanceScorer, ToolCandidate } from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";
import { DecisionMemory } from "./decisionMemory.js";
import type { PruneStateStore } from "./pruneState.js";
import { DROPPED_STUB } from "./toolPairs.js";

type Item = Record<string, unknown>;
interface Options {
  config: Pick<
    Config,
    | "pruningEnabled"
    | "pruneThreshold"
    | "triggerTokens"
    | "keepRecent"
    | "excludeTools"
  >;
  scorer: RelevanceScorer;
  stateStore?: PruneStateStore;
}

function isItem(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userGoal(item: Item | undefined): string {
  if (
    !item ||
    item.role !== "user" ||
    (item.type !== undefined && item.type !== "message")
  )
    return "";
  const text =
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content)
        ? item.content
            .filter(isItem)
            .filter(
              (block) =>
                block.type === "input_text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n")
        : "";
  // Host-injected context is not a new task to score old results against.
  return /^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md)/.test(
    text,
  )
    ? ""
    : text.trim();
}

function candidates(items: Item[]): ToolCandidate[] {
  const byId = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (typeof item.call_id !== "string" || !item.call_id) return;
    const positions = byId.get(item.call_id) ?? [];
    positions.push(index);
    byId.set(item.call_id, positions);
  });
  const found: ToolCandidate[] = [];
  for (const [id, positions] of byId) {
    if (positions.length !== 2) continue;
    const [callIndex, resultIndex] = positions as [number, number];
    const call = items[callIndex]!;
    const result = items[resultIndex]!;
    const custom = call.type === "custom_tool_call";
    if (
      (!custom && call.type !== "function_call") ||
      result.type !==
        (custom ? "custom_tool_call_output" : "function_call_output") ||
      typeof call.name !== "string" ||
      !call.name ||
      typeof call[custom ? "input" : "arguments"] !== "string" ||
      typeof result.output !== "string"
    )
      continue;
    found.push({
      toolUseId: id,
      toolName: call.name,
      assistantMessageIndex: callIndex,
      assistantBlockIndex: 0,
      resultMessageIndex: resultIndex,
      resultBlockIndex: 0,
      input: {
        namespace: call.namespace,
        value: call[custom ? "input" : "arguments"],
      },
      result: result.output,
    });
  }
  return found;
}

/** Full-history Responses only: replace output text without changing call envelopes. */
export class ResponsesPruner {
  private readonly memory: DecisionMemory;
  constructor(private readonly options: Options) {
    this.memory = new DecisionMemory({
      maxEntries: 10_000,
      rescoreTokens: 0,
      store: options.stateStore,
    });
  }

  async prune(request: Record<string, unknown>) {
    const beforeTokens = estimateTokens(request);
    let current = request;
    const result = (reason: string, dropped = 0, evaluated = 0) => ({
      request: current,
      beforeTokens,
      afterTokens: estimateTokens(current),
      reason,
      dropped,
      evaluated,
    });
    const { config, scorer } = this.options;
    if (!config.pruningEnabled) return result("disabled");
    if (
      request.previous_response_id != null ||
      request.conversation != null ||
      !Array.isArray(request.input) ||
      !request.input.every(isItem)
    )
      return result("unsupported");
    const items: Item[] = request.input;
    const all = candidates(items);
    const allowed = all.filter(
      (candidate) =>
        !config.excludeTools.has(candidate.toolName) &&
        estimateTokens(candidate.result) > estimateTokens(DROPPED_STUB),
    );
    const { dropped } = this.memory.recall(allowed);
    const render = () => {
      if (!dropped.size) return;
      const indices = new Set(
        allowed
          .filter((candidate) => dropped.has(candidate.toolUseId))
          .map((candidate) => candidate.resultMessageIndex),
      );
      current = {
        ...request,
        input: items.map((item, index) =>
          indices.has(index) ? { ...item, output: DROPPED_STUB } : item,
        ),
      };
    };
    render();
    const goal = userGoal(items.at(-1));
    if (!goal) return result("mid-task");
    const tokens = estimateTokens(current);
    if (tokens < config.pruneThreshold) return result("below-threshold");
    // Count rich and excluded outputs too when protecting the recent tail.
    const outputIndices = items.flatMap((item, index) =>
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
        ? [index]
        : [],
    );
    const recent = new Set(
      config.keepRecent > 0 ? outputIndices.slice(-config.keepRecent) : [],
    );
    const eligible = allowed.filter(
      (candidate) =>
        !dropped.has(candidate.toolUseId) &&
        !recent.has(candidate.resultMessageIndex),
    );
    if (!eligible.length) return result("no-candidates");
    try {
      const scores = await scorer.score(goal, eligible);
      // Validate the entire batch before remembering any new decision.
      const probabilities = eligible.map((candidate) => {
        const score = scores.get(candidate.toolUseId);
        if (
          score === undefined ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1
        )
          throw new Error("Invalid relevance score");
        return { candidate, score };
      });
      const cutoff = tokens >= config.triggerTokens ? 0.7 : 0.5;
      let count = 0;
      for (const { candidate, score } of probabilities) {
        if (score >= cutoff) continue;
        this.memory.drop(candidate);
        dropped.add(candidate.toolUseId);
        count += 1;
      }
      this.memory.save();
      render();
      return result("pruned", count, eligible.length);
    } catch {
      return result("fail-open");
    }
  }
}

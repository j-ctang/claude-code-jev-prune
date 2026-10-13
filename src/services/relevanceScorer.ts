import type {
  NoulAsker,
  NoulQuestion,
  RelevanceScorer,
  ToolCandidate,
} from "../types.js";
import { estimateTokens } from "../utils/tokenCounter.js";
import { MAX_QUESTIONS_PER_REQUEST, MAX_REQUEST_TOKENS } from "./jevService.js";

const STILL_NEEDED: NoulQuestion["criteria"] = {
  true: "The current task depends on this tool input or result.",
  false:
    "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
};

/** Token estimates are approximate, so batches stay well under the limit. */
const BATCH_TOKEN_BUDGET = Math.floor(MAX_REQUEST_TOKENS * 0.75);

/** Room for the model name and the JSON around the candidates. */
const REQUEST_OVERHEAD_TOKENS = 256;

/** A goal too long to send whole is cut to this, leaving room for candidates. */
const MAX_GOAL_TOKENS = Math.floor(BATCH_TOKEN_BUDGET / 4);

/** A candidate as sent to TypeSafe, with its estimated share of a request. */
interface Sendable {
  candidate: ToolCandidate;
  input: unknown;
  result: unknown;
  tokens: number;
}

function question(index: number): NoulQuestion {
  return {
    instructions: `Is candidates[${index}] still needed to complete current_goal?`,
    criteria: STILL_NEEDED,
  };
}

function entryTokens(
  candidate: ToolCandidate,
  input: unknown,
  result: unknown,
): number {
  return (
    estimateTokens({
      key: `candidate_${MAX_QUESTIONS_PER_REQUEST}`,
      tool_use_id: candidate.toolUseId,
      tool_name: candidate.toolName,
      input,
      result,
    }) + estimateTokens(question(MAX_QUESTIONS_PER_REQUEST))
  );
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

function truncated(value: unknown, maxChars: number): unknown {
  const text = asText(value);
  if (text.length <= maxChars) return value;
  return `${text.slice(0, maxChars)} [truncated ${text.length - maxChars} characters]`;
}

/**
 * Fits one candidate into `maxTokens`. An oversized input and result are cut
 * to a prefix, so the call can still be judged instead of failing the prune.
 */
function sendable(candidate: ToolCandidate, maxTokens: number): Sendable {
  let input = candidate.input;
  let result = candidate.result;
  let tokens = entryTokens(candidate, input, result);
  if (tokens <= maxTokens) return { candidate, input, result, tokens };

  const fixed = entryTokens(candidate, "", "");
  // Leave space for the two truncation markers.
  let room = Math.max(0, (maxTokens - fixed) * 4 - 128);
  while (tokens > maxTokens && room > 0) {
    const inputChars = Math.min(
      asText(candidate.input).length,
      Math.floor(room / 2),
    );
    input = truncated(candidate.input, inputChars);
    result = truncated(candidate.result, room - inputChars);
    tokens = entryTokens(candidate, input, result);
    room = Math.floor(room * 0.9);
  }
  if (tokens > maxTokens) {
    input = truncated(candidate.input, 0);
    result = truncated(candidate.result, 0);
    tokens = entryTokens(candidate, input, result);
  }
  return { candidate, input, result, tokens };
}

/**
 * The goal to send: whole if every candidate fits beside it untruncated, so
 * each batch stays under budget. Otherwise cut to `MAX_GOAL_TOKENS`.
 */
function sendableGoal(
  goal: string,
  candidates: readonly ToolCandidate[],
): string {
  const room =
    BATCH_TOKEN_BUDGET - REQUEST_OVERHEAD_TOKENS - estimateTokens(goal);
  if (
    candidates.every(
      (candidate) =>
        entryTokens(candidate, candidate.input, candidate.result) <= room,
    )
  ) {
    return goal;
  }
  let chars = MAX_GOAL_TOKENS * 4;
  let sent = String(truncated(goal, chars));
  while (estimateTokens(sent) > MAX_GOAL_TOKENS && chars > 0) {
    chars = Math.floor(chars * 0.9);
    sent = String(truncated(goal, chars));
  }
  return sent;
}

/** Splits candidates by question count and by estimated request size. */
function batches(
  goal: string,
  candidates: readonly ToolCandidate[],
): Sendable[][] {
  const room =
    BATCH_TOKEN_BUDGET - REQUEST_OVERHEAD_TOKENS - estimateTokens(goal);
  const result: Sendable[][] = [];
  let batch: Sendable[] = [];
  let batchTokens = 0;
  for (const candidate of candidates) {
    const item = sendable(candidate, room);
    if (
      batch.length === MAX_QUESTIONS_PER_REQUEST ||
      (batch.length > 0 && batchTokens + item.tokens > room)
    ) {
      result.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(item);
    batchTokens += item.tokens;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

/** Asks Jev whether each tool call is still needed for the current goal. */
export class JevRelevanceScorer implements RelevanceScorer {
  constructor(private readonly asker: NoulAsker) {}

  async score(
    goal: string,
    candidates: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const sentGoal = sendableGoal(goal, candidates);
    const scores = new Map<string, number>();
    for (const batch of batches(sentGoal, candidates)) {
      for (const [toolUseId, score] of await this.scoreBatch(sentGoal, batch)) {
        scores.set(toolUseId, score);
      }
    }
    return scores;
  }

  private async scoreBatch(
    goal: string,
    batch: readonly Sendable[],
  ): Promise<ReadonlyMap<string, number>> {
    const answers = await this.asker.ask(
      {
        current_goal: goal,
        candidates: batch.map(({ candidate, input, result }, index) => ({
          key: `candidate_${index}`,
          tool_use_id: candidate.toolUseId,
          tool_name: candidate.toolName,
          input,
          result,
        })),
      },
      Object.fromEntries(
        batch.map((_item, index) => [`candidate_${index}`, question(index)]),
      ),
    );
    const scores = new Map<string, number>();
    for (const [index, { candidate }] of batch.entries()) {
      const score = answers.get(`candidate_${index}`);
      if (score !== undefined) scores.set(candidate.toolUseId, score);
    }
    return scores;
  }
}

import type {
  NoulAsker,
  NoulQuestion,
  RelevanceScorer,
  ToolCandidate,
} from "../types.js";
import { MAX_QUESTIONS_PER_REQUEST } from "./jevService.js";

const STILL_NEEDED: NoulQuestion["criteria"] = {
  true: "The current task depends on this tool input or result.",
  false:
    "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
};

/** Asks Jev whether each tool call is still needed for the current goal. */
export class JevRelevanceScorer implements RelevanceScorer {
  constructor(private readonly asker: NoulAsker) {}

  async score(
    goal: string,
    candidates: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const scores = new Map<string, number>();
    for (
      let offset = 0;
      offset < candidates.length;
      offset += MAX_QUESTIONS_PER_REQUEST
    ) {
      const batch = candidates.slice(
        offset,
        offset + MAX_QUESTIONS_PER_REQUEST,
      );
      for (const [toolUseId, score] of await this.scoreBatch(goal, batch)) {
        scores.set(toolUseId, score);
      }
    }
    return scores;
  }

  private async scoreBatch(
    goal: string,
    batch: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const answers = await this.asker.ask(
      {
        current_goal: goal,
        candidates: batch.map((candidate, index) => ({
          key: `candidate_${index}`,
          tool_use_id: candidate.toolUseId,
          tool_name: candidate.toolName,
          input: candidate.input,
          result: candidate.result,
        })),
      },
      Object.fromEntries(
        batch.map((_candidate, index) => [
          `candidate_${index}`,
          {
            instructions: `Is candidates[${index}] still needed to complete current_goal?`,
            criteria: STILL_NEEDED,
          },
        ]),
      ),
    );
    const scores = new Map<string, number>();
    for (const [index, candidate] of batch.entries()) {
      const score = answers.get(`candidate_${index}`);
      if (score !== undefined) scores.set(candidate.toolUseId, score);
    }
    return scores;
  }
}

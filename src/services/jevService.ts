import type { RelevanceScorer, ToolCandidate } from "../types.js";

const MAX_QUESTIONS_PER_REQUEST = 32;

interface JevServiceOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}

interface NoulAnswer {
  type: "noul";
  noul: number;
}

export class JevService implements RelevanceScorer {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: JevServiceOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn;
  }

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
      const batchScores = await this.scoreBatch(goal, batch);
      for (const [toolUseId, score] of batchScores) {
        scores.set(toolUseId, score);
      }
    }
    return scores;
  }

  private async scoreBatch(
    goal: string,
    batch: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const body = {
      model: this.model,
      state: {
        current_goal: goal,
        candidates: batch.map((candidate, index) => ({
          key: `candidate_${index}`,
          tool_use_id: candidate.toolUseId,
          tool_name: candidate.toolName,
          input: candidate.input,
          result: candidate.result,
        })),
      },
      questions: Object.fromEntries(
        batch.map((_candidate, index) => [
          `candidate_${index}`,
          {
            type: "noul",
            instructions: `Is candidates[${index}] still needed to complete current_goal?`,
            criteria: {
              true: "The current task depends on this tool input or result.",
              false:
                "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
            },
          },
        ]),
      ),
    };

    const response = await this.fetchFn(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`TypeSafe request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    const answers = this.readAnswers(payload);
    const scores = new Map<string, number>();
    for (const [index, candidate] of batch.entries()) {
      const key = `candidate_${index}`;
      const answer = answers[key];
      if (!this.isNoulAnswer(answer)) {
        throw new Error(`TypeSafe returned an invalid answer for ${key}`);
      }
      scores.set(candidate.toolUseId, answer.noul);
    }
    return scores;
  }

  private readAnswers(payload: unknown): Record<string, unknown> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("answers" in payload) ||
      typeof payload.answers !== "object" ||
      payload.answers === null ||
      Array.isArray(payload.answers)
    ) {
      return {};
    }
    return payload.answers as Record<string, unknown>;
  }

  private isNoulAnswer(value: unknown): value is NoulAnswer {
    if (typeof value !== "object" || value === null) return false;
    if (!("type" in value) || value.type !== "noul") return false;
    if (!("noul" in value) || typeof value.noul !== "number") return false;
    return Number.isFinite(value.noul) && value.noul >= 0 && value.noul <= 1;
  }
}

import { PruneError } from "../errors.js";
import type {
  NoulAsker,
  NoulQuestion,
  RelevanceScorer,
  ToolCandidate,
} from "../types.js";

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

export class JevService implements RelevanceScorer, NoulAsker {
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

  /** Sends named noul questions about `state` and returns each answer by name. */
  async ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, NoulQuestion>>,
  ): Promise<ReadonlyMap<string, number>> {
    const keys = Object.keys(questions);
    if (keys.length > MAX_QUESTIONS_PER_REQUEST) {
      throw new PruneError(
        `TypeSafe accepts at most ${MAX_QUESTIONS_PER_REQUEST} questions per request`,
      );
    }
    const body = {
      model: this.model,
      state,
      questions: Object.fromEntries(
        keys.map((key) => [key, { type: "noul", ...questions[key] }]),
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
      throw new PruneError(`TypeSafe request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    const answers = this.readAnswers(payload);
    const scores = new Map<string, number>();
    for (const key of keys) {
      const answer = answers[key];
      if (!this.isNoulAnswer(answer)) {
        throw new PruneError(`TypeSafe returned an invalid answer for ${key}`);
      }
      scores.set(key, answer.noul);
    }
    return scores;
  }

  private async scoreBatch(
    goal: string,
    batch: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const answers = await this.ask(
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
            criteria: {
              true: "The current task depends on this tool input or result.",
              false:
                "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
            },
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

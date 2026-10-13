import { PruneError } from "../errors.js";
import type { NoulAsker, NoulQuestion, UsageReporter } from "../types.js";

/** TypeSafe answers at most this many questions per request. */
export const MAX_QUESTIONS_PER_REQUEST = 32;

/** TypeSafe rejects a request above this many input tokens. */
export const MAX_REQUEST_TOKENS = 64_000;

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

/** The TypeSafe client: sends noul questions and validates the answers. */
export class JevService implements NoulAsker {
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

  /** Sends named noul questions about `state` and returns each answer by name. */
  async ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, NoulQuestion>>,
    onUsage?: UsageReporter,
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
      throw new PruneError(
        `TypeSafe request failed with status ${response.status}`,
      );
    }

    const payload: unknown = await response.json();
    if (onUsage) {
      const usage =
        typeof payload === "object" && payload !== null && "usage" in payload
          ? payload.usage
          : undefined;
      const valid =
        typeof usage === "object" &&
        usage !== null &&
        !Array.isArray(usage) &&
        "input_tokens" in usage &&
        "output_tokens" in usage &&
        validTokenCount(usage.input_tokens) &&
        validTokenCount(usage.output_tokens);
      onUsage(
        valid
          ? {
              inputTokens: usage.input_tokens as number,
              outputTokens: usage.output_tokens as number,
            }
          : { inputTokens: 0, outputTokens: 0 },
      );
    }
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

/** Token counts must be finite, nonnegative integers. */
export function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

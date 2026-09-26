import { PruneError } from "../errors.js";

interface SkillCompletionOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}

/** Advisory Jev judgment; callers treat errors as no finding. */
export class SkillCompletionJudge {
  constructor(private readonly options: SkillCompletionOptions) {}

  async score(goal: string, reply: string): Promise<number> {
    const { apiKey, baseUrl, model, timeoutMs, fetchFn } = this.options;
    const response = await fetchFn(`${baseUrl.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        state: { current_goal: goal, final_reply: reply },
        questions: {
          complete: {
            type: "noul",
            instructions: "Has the assistant completed current_goal in final_reply? Answer conservatively; partial work is incomplete.",
            criteria: {
              true: "The reply confirms the original task is fully completed.",
              false: "Work remains, the reply is uncertain, or it asks for more information.",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new PruneError(`TypeSafe request failed with status ${response.status}`);
    const payload: unknown = await response.json();
    const answer = (payload as { answers?: { complete?: { type?: unknown; noul?: unknown } } })?.answers?.complete;
    if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw new PruneError("TypeSafe returned an invalid completion answer");
    return answer.noul;
  }
}

import { JevService } from "../src/services/jevService.js";
import type { ToolCandidate } from "../src/types.js";

function candidate(toolUseId: string): ToolCandidate {
  return {
    toolUseId,
    toolName: "read_file",
    assistantMessageIndex: 1,
    assistantBlockIndex: 0,
    resultMessageIndex: 2,
    resultBlockIndex: 0,
    input: { path: `/tmp/${toolUseId}.ts` },
    result: `contents for ${toolUseId}`,
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function responseForBatch(body: string): Response {
  const request = JSON.parse(body) as {
    questions: Record<string, unknown>;
  };
  const answers = Object.fromEntries(
    Object.keys(request.questions).map((key, index) => [
      key,
      { type: "noul", noul: index % 2 === 0 ? 0.91 : 0.08 },
    ]),
  );
  return Response.json({
    model: "jev-1.13.0",
    answers,
    usage: { input_tokens: 100, output_tokens: Object.keys(answers).length },
  });
}

function createService(
  fetchFn: typeof fetch,
  overrides: Partial<{
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
  }> = {},
): JevService {
  return new JevService({
    apiKey: "secret",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 2_000,
    fetchFn,
    ...overrides,
  });
}

describe("JevService", () => {
  test("sends named noul questions and returns scores by tool-use ID", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), init });
      return responseForBatch(String(init?.body));
    };
    const service = createService(fetchFn);

    const scores = await service.score("Fix JWT validation", [
      candidate("call-a"),
      candidate("call-b"),
    ]);

    expect(scores).toEqual(
      new Map([
        ["call-a", 0.91],
        ["call-b", 0.08],
      ]),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(captured[0]?.init?.method).toBe("POST");
    expect(captured[0]?.init?.headers).toEqual({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
      model: "jev-latest",
      state: {
        current_goal: "Fix JWT validation",
        candidates: [
          {
            key: "candidate_0",
            tool_use_id: "call-a",
            tool_name: "read_file",
            input: { path: "/tmp/call-a.ts" },
            result: "contents for call-a",
          },
          {
            key: "candidate_1",
            tool_use_id: "call-b",
            tool_name: "read_file",
            input: { path: "/tmp/call-b.ts" },
            result: "contents for call-b",
          },
        ],
      },
      questions: {
        candidate_0: {
          type: "noul",
          instructions:
            "Is candidates[0] still needed to complete current_goal?",
          criteria: {
            true: "The current task depends on this tool input or result.",
            false:
              "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
          },
        },
        candidate_1: {
          type: "noul",
          instructions:
            "Is candidates[1] still needed to complete current_goal?",
          criteria: {
            true: "The current task depends on this tool input or result.",
            false:
              "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
          },
        },
      },
    });
  });

  test("splits more than 32 candidates into multiple requests", async () => {
    const batchSizes: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      const request = JSON.parse(body) as {
        questions: Record<string, unknown>;
      };
      batchSizes.push(Object.keys(request.questions).length);
      return responseForBatch(body);
    };
    const service = createService(fetchFn);
    const candidates = Array.from({ length: 33 }, (_, index) =>
      candidate(`call-${index}`),
    );

    const scores = await service.score("goal", candidates);

    expect(batchSizes).toEqual([32, 1]);
    expect(scores.size).toBe(33);
    expect(scores.get("call-32")).toBe(0.91);
  });

  test.each([401, 429, 500])(
    "throws a redacted error for HTTP %s",
    async (status) => {
      const fetchFn: typeof fetch = async () =>
        new Response("sensitive upstream body", { status });

      await expect(
        createService(fetchFn).score("goal", [candidate("call-a")]),
      ).rejects.toThrow(`TypeSafe request failed with status ${status}`);
    },
  );

  test("rejects missing answers", async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({
        model: "jev-latest",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 0 },
      });

    await expect(
      createService(fetchFn).score("goal", [candidate("call-a")]),
    ).rejects.toThrow("TypeSafe returned an invalid answer for candidate_0");
  });

  test.each([
    { type: "choice", choice: "yes" },
    { type: "noul", noul: -0.1 },
    { type: "noul", noul: 1.1 },
    { type: "noul", noul: "yes" },
  ])("rejects malformed answer $type", async (answer) => {
    const fetchFn: typeof fetch = async () =>
      Response.json({
        model: "jev-latest",
        answers: { candidate_0: answer },
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await expect(
      createService(fetchFn).score("goal", [candidate("call-a")]),
    ).rejects.toThrow("TypeSafe returned an invalid answer for candidate_0");
  });
});

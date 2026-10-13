import { JevService } from "../src/services/jevService.js";
import { JevRelevanceScorer } from "../src/services/relevanceScorer.js";
import type { ToolCandidate } from "../src/types.js";
import { estimateTokens } from "../src/utils/tokenCounter.js";

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

/** The pruning scorer over a real client, so request shapes are checked. */
function scorerFor(fetchFn: typeof fetch): JevRelevanceScorer {
  return new JevRelevanceScorer(createService(fetchFn));
}

describe("JevService", () => {
  test("asks named noul questions about any state", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), init });
      return responseForBatch(String(init?.body));
    };
    const hard = {
      instructions: "Is it hard?",
      criteria: { true: "Hard.", false: "Easy." },
    };
    const continues = {
      instructions: "Does it continue?",
      criteria: { true: "Continues.", false: "New task." },
    };

    const answers = await createService(fetchFn).ask(
      { newest_request: "Fix it" },
      { hard, continues },
    );

    expect(answers).toEqual(
      new Map([
        ["hard", 0.91],
        ["continues", 0.08],
      ]),
    );
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
      model: "jev-latest",
      state: { newest_request: "Fix it" },
      questions: {
        hard: { type: "noul", ...hard },
        continues: { type: "noul", ...continues },
      },
    });
  });

  test("ask rejects an invalid or missing answer", async () => {
    const question = {
      instructions: "Is it hard?",
      criteria: { true: "Hard.", false: "Easy." },
    };
    const invalid: typeof fetch = async () =>
      Response.json({ answers: { hard: { type: "noul", noul: 2 } } });
    const missing: typeof fetch = async () => Response.json({ answers: {} });

    await expect(
      createService(invalid).ask({}, { hard: question }),
    ).rejects.toThrow("TypeSafe returned an invalid answer for hard");
    await expect(
      createService(missing).ask({}, { hard: question }),
    ).rejects.toThrow("TypeSafe returned an invalid answer for hard");
  });

  test("sends named noul questions and returns scores by tool-use ID", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), init });
      return responseForBatch(String(init?.body));
    };
    const service = scorerFor(fetchFn);

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
    const service = scorerFor(fetchFn);
    const candidates = Array.from({ length: 33 }, (_, index) =>
      candidate(`call-${index}`),
    );

    const scores = await service.score("goal", candidates);

    expect(batchSizes).toEqual([32, 1]);
    expect(scores.size).toBe(33);
    expect(scores.get("call-32")).toBe(0.91);
  });

  test("keeps each request under the TypeSafe input token limit", async () => {
    const requestTokens: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      requestTokens.push(estimateTokens(JSON.parse(body)));
      return responseForBatch(body);
    };
    // 32 file reads of about 4K tokens each: a normal context past 120K.
    const candidates = Array.from({ length: 32 }, (_, index) => ({
      ...candidate(`call-${index}`),
      result: "x".repeat(16_000),
    }));

    const scores = await scorerFor(fetchFn).score("goal", candidates);

    expect(scores.size).toBe(32);
    for (const tokens of requestTokens) expect(tokens).toBeLessThan(64_000);
  });

  test("truncates a candidate too large for one request and still scores it", async () => {
    const sent: { tokens: number; result: unknown; input: unknown }[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      const request = JSON.parse(body) as {
        state: { candidates: { input: unknown; result: unknown }[] };
      };
      sent.push({
        tokens: estimateTokens(request),
        result: request.state.candidates[0]?.result,
        input: request.state.candidates[0]?.input,
      });
      return responseForBatch(body);
    };
    const huge = {
      ...candidate("call-huge"),
      input: { content: "i".repeat(400_000) },
      result: [{ type: "text", text: "r".repeat(400_000) }],
    };

    const scores = await scorerFor(fetchFn).score("goal", [huge]);

    expect(scores.get("call-huge")).toBe(0.91);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tokens).toBeLessThan(64_000);
    expect(String(sent[0]?.result)).toMatch(/\[truncated \d+ characters\]$/);
    expect(String(sent[0]?.input)).toMatch(/\[truncated \d+ characters\]$/);
  });

  test("keeps a small input whole when only the result is too large", async () => {
    let sent: { input: unknown; result: unknown } | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      const request = JSON.parse(body) as {
        state: { candidates: { input: unknown; result: unknown }[] };
      };
      sent = request.state.candidates[0];
      return responseForBatch(body);
    };
    const bigRead = { ...candidate("call-big"), result: "r".repeat(400_000) };

    await scorerFor(fetchFn).score("goal", [bigRead]);

    expect(sent?.input).toEqual({ path: "/tmp/call-big.ts" });
    expect(String(sent?.result).length).toBeGreaterThan(100_000);
    expect(String(sent?.result)).toMatch(/\[truncated \d+ characters\]$/);
  });

  test("truncates an oversized goal so the request stays under the limit", async () => {
    const requestTokens: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      requestTokens.push(estimateTokens(JSON.parse(body)));
      return responseForBatch(body);
    };

    const scores = await scorerFor(fetchFn).score("g".repeat(400_000), [
      candidate("call-a"),
    ]);

    expect(scores.get("call-a")).toBe(0.91);
    expect(requestTokens).toHaveLength(1);
    expect(requestTokens[0]).toBeLessThan(64_000);
  });

  test("keeps a long goal whole when the request already fits", async () => {
    const goals: unknown[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      goals.push(
        (JSON.parse(body) as { state: { current_goal: unknown } }).state
          .current_goal,
      );
      return responseForBatch(body);
    };
    const goal = "g".repeat(80_000);

    await scorerFor(fetchFn).score(goal, [candidate("call-a")]);

    expect(goals).toEqual([goal]);
  });

  test("keeps a goal of escaped characters under the limit", async () => {
    const requestTokens: number[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      requestTokens.push(estimateTokens(JSON.parse(body)));
      return responseForBatch(body);
    };

    await scorerFor(fetchFn).score("\u0001".repeat(200_000), [
      candidate("call-a"),
    ]);

    expect(requestTokens).toHaveLength(1);
    expect(requestTokens[0]).toBeLessThan(64_000);
  });

  test("leaves small candidates unchanged", async () => {
    const bodies: unknown[] = [];
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = String(init?.body);
      bodies.push(JSON.parse(body));
      return responseForBatch(body);
    };

    await scorerFor(fetchFn).score("goal", [candidate("call-a")]);

    expect(bodies).toMatchObject([
      {
        state: {
          candidates: [
            {
              input: { path: "/tmp/call-a.ts" },
              result: "contents for call-a",
            },
          ],
        },
      },
    ]);
  });

  test.each([401, 429, 500])(
    "throws a redacted error for HTTP %s",
    async (status) => {
      const fetchFn: typeof fetch = async () =>
        new Response("sensitive upstream body", { status });

      await expect(
        scorerFor(fetchFn).score("goal", [candidate("call-a")]),
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
      scorerFor(fetchFn).score("goal", [candidate("call-a")]),
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
      scorerFor(fetchFn).score("goal", [candidate("call-a")]),
    ).rejects.toThrow("TypeSafe returned an invalid answer for candidate_0");
  });
});

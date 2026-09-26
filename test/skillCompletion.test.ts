import { SkillCompletionJudge } from "../src/services/skillCompletion.js";

test("asks Jev whether the original goal is complete using a structured answer", async () => {
  let sent: unknown;
  const judge = new SkillCompletionJudge({
    apiKey: "secret",
    baseUrl: "https://typesafe.example",
    model: "jev-latest",
    timeoutMs: 1000,
    fetchFn: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ answers: { complete: { type: "noul", noul: 0.98 } } }),
        { status: 200 },
      );
    },
  });
  expect(await judge.score("Prepare report", "The report is ready.")).toBe(
    0.98,
  );
  expect(sent).toEqual(
    expect.objectContaining({
      state: {
        current_goal: "Prepare report",
        final_reply: "The report is ready.",
      },
    }),
  );
});

test("rejects malformed completion answers", async () => {
  const judge = new SkillCompletionJudge({
    apiKey: "secret",
    baseUrl: "https://typesafe.example",
    model: "jev-latest",
    timeoutMs: 1000,
    fetchFn: async () =>
      new Response(
        JSON.stringify({ answers: { complete: { type: "noul", noul: 3 } } }),
        { status: 200 },
      ),
  });
  await expect(judge.score("Goal", "Done")).rejects.toThrow(
    "invalid completion answer",
  );
});

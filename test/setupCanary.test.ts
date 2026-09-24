import { findCanaryCandidates } from "../src/setupCanary.js";

test("finds a quoted prefix in an existing response instruction", () => {
  expect(
    findCanaryCandidates(
      "# Rules\nStart every response with `Yo:`.\n",
      "CLAUDE.md",
    ),
  ).toEqual([{ file: "CLAUDE.md", prefix: "Yo:" }]);
});

test("does not invent a canary from unrelated instructions", () => {
  expect(
    findCanaryCandidates(
      "Keep answers brief. Use tools carefully.",
      "AGENTS.md",
    ),
  ).toEqual([]);
});

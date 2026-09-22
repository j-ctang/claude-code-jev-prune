import { estimateTokens } from "../src/utils/tokenCounter.js";

describe("estimateTokens", () => {
  test("returns the four-character JSON estimate", () => {
    const value = { messages: [{ role: "user", content: "abcdefgh" }] };

    expect(estimateTokens(value)).toBe(13);
  });

  test("rounds a partial token upward", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

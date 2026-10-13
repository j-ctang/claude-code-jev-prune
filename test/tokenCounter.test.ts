import { estimateTokens, validTokenCount } from "../src/utils/tokenCounter.js";

describe("estimateTokens", () => {
  test("returns the four-character JSON estimate", () => {
    const value = { messages: [{ role: "user", content: "abcdefgh" }] };

    expect(estimateTokens(value)).toBe(13);
  });

  test("rounds a partial token upward", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("validTokenCount", () => {
  test("accepts zero and positive safe integers", () => {
    expect(validTokenCount(0)).toBe(true);
    expect(validTokenCount(120)).toBe(true);
  });

  test("rejects negatives, fractions, unsafe integers, and non-numbers", () => {
    for (const value of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, "7", null]) {
      expect(validTokenCount(value)).toBe(false);
    }
  });
});

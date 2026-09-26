import {
  identifyConversation,
  isSideRequest,
} from "../src/services/conversation.js";
import type { AnthropicRequest } from "../src/types.js";

const request = (first: unknown, extra: Partial<AnthropicRequest> = {}) =>
  ({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: first }],
    ...extra,
  }) as AnthropicRequest;

describe("identifyConversation", () => {
  test("keys the main thread by session, so /compact keeps it", () => {
    const before = identifyConversation(request("Redesign auth"), "s");
    const after = identifyConversation(
      request("This session is being continued from a previous conversation."),
      "s",
    );

    expect(before).toEqual({ key: "s:main", main: true, sessionId: "s" });
    expect(after).toEqual(before);
  });

  test("gives each subagent its own thread in the session", () => {
    const subagent = identifyConversation(request("Find it"), "s", "a1");

    expect(subagent).toEqual({ key: "s:a1", main: false, sessionId: "s" });
    expect(identifyConversation(request("Find it"), "s", "a2").key).not.toBe(
      subagent.key,
    );
  });

  test("without a session, keys by the first message's text only", () => {
    const plain = identifyConversation(request("Redesign auth"));
    const cached = identifyConversation(
      request([
        {
          type: "text",
          text: "Redesign auth",
          cache_control: { type: "ephemeral" },
        },
      ]),
    );

    expect(plain.main).toBe(true);
    expect(plain.sessionId).toBeUndefined();
    expect(cached.key).toBe(plain.key);
    expect(identifyConversation(request("Redesign billing")).key).not.toBe(
      plain.key,
    );
  });
});

describe("isSideRequest", () => {
  test("matches only a tool-less <session> request", () => {
    expect(isSideRequest(request("<session>\nRedesign auth"))).toBe(true);
    expect(
      isSideRequest(request("<session>\nRedesign auth", { tools: [] })),
    ).toBe(true);
    expect(
      isSideRequest(
        request("<session>\nRedesign auth", { tools: [{ name: "Read" }] }),
      ),
    ).toBe(false);
    expect(isSideRequest(request("Redesign auth"))).toBe(false);
  });
});

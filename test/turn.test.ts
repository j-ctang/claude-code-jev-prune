import { appendNotice, readTurn } from "../src/services/turn.js";
import type { AnthropicRequest } from "../src/types.js";

const toolUse = {
  role: "assistant" as const,
  content: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
};
const toolResult = {
  role: "user" as const,
  content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
};

describe("readTurn", () => {
  test("reads a new user turn after hook system messages", () => {
    const turn = readTurn({
      messages: [
        { role: "user", content: "Fix auth." },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
        { role: "user", content: [{ type: "text", text: "Now billing." }] },
        { role: "system", content: "hook context" },
      ],
    });

    expect(turn).toEqual({
      newUserTurn: true,
      goal: "Now billing.",
      lastReply: "Done.",
    });
  });

  test("a tool result is not a new user turn and has no reply", () => {
    const turn = readTurn({
      messages: [{ role: "user", content: "Fix auth." }, toolUse, toolResult],
    });

    expect(turn).toEqual({ newUserTurn: false, goal: "Fix auth." });
  });

  test("reads plain and plugin-namespaced slash commands", () => {
    const command = (text: string) =>
      readTurn({ messages: [{ role: "user", content: text }] }).command;

    expect(command("<command-name>/jev-prune</command-name>")).toBe(
      "jev-prune",
    );
    expect(
      command("<command-name>/jev-prune:jev-prune-auto-off</command-name>"),
    ).toBe("jev-prune-auto-off");
    expect(command("run /jev-prune please")).toBeUndefined();
  });

  test("ignores a command mid-task", () => {
    const turn = readTurn({
      messages: [
        { role: "user", content: "<command-name>/jev-prune</command-name>" },
        toolUse,
        toolResult,
      ],
    });

    expect(turn.command).toBeUndefined();
  });

  test("falls back to a neutral goal", () => {
    expect(readTurn({ messages: [] }).goal).toBe("Complete the current task.");
  });
});

describe("appendNotice", () => {
  test("adds a text block to the current turn only", () => {
    const request: AnthropicRequest = {
      messages: [
        { role: "user", content: "Hi" },
        { role: "system", content: "hook" },
      ],
    };

    expect(appendNotice(request, "note").messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Hi" },
          { type: "text", text: "note" },
        ],
      },
      { role: "system", content: "hook" },
    ]);
    expect(request.messages[0]?.content).toBe("Hi");
  });
});

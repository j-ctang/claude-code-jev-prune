import { CanaryMonitor } from "../src/services/canary.js";
import { readTurn } from "../src/services/turn.js";
import type { AnthropicRequest } from "../src/types.js";

function observe(
  monitor: CanaryMonitor,
  sessionId: string,
  request: AnthropicRequest,
): boolean {
  return monitor.observe(sessionId, readTurn(request));
}

function turn(reply: string): AnthropicRequest {
  return {
    messages: [
      { role: "user", content: "Work on the task." },
      { role: "assistant", content: reply },
      { role: "user", content: "Continue." },
    ],
  };
}

test("signals on every distinct missed reply after the second", () => {
  const monitor = new CanaryMonitor("Yo:");
  expect(observe(monitor, "s", turn("First reply"))).toBe(false);
  expect(observe(monitor, "s", turn("First reply"))).toBe(false);
  const second = turn("Second reply");
  second.messages.splice(-1, 0, { role: "user", content: "One more thing" });
  expect(observe(monitor, "s", second)).toBe(true);
  expect(observe(monitor, "s", turn("Third reply"))).toBe(true);
  expect(observe(monitor, "s", turn("Yo: back on track"))).toBe(false);
});

test("ignores tool calls and other sessions", () => {
  const monitor = new CanaryMonitor("Yo:");
  const toolTurn: AnthropicRequest = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "Read", input: {} }],
      },
      { role: "user", content: "Continue" },
    ],
  };
  expect(observe(monitor, "a", toolTurn)).toBe(false);
  expect(observe(monitor, "a", turn("Missing"))).toBe(false);
  expect(observe(monitor, "b", turn("Missing"))).toBe(false);
  expect(
    observe(monitor, "a", {
      messages: [
        { role: "assistant", content: "Another missing prefix" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "done" }],
        },
      ],
    }),
  ).toBe(false);
});

test("checks a completed reply when hook context follows the user turn", () => {
  const monitor = new CanaryMonitor("Yo:");
  const first = turn("Missing one");
  const second = turn("Missing two");
  first.messages.push({ role: "system", content: "hook context" });
  second.messages.push({ role: "system", content: "hook context" });
  expect(observe(monitor, "s", first)).toBe(false);
  expect(observe(monitor, "s", second)).toBe(true);
});

import { NoticeMemory } from "../src/services/noticeMemory.js";
import type { AnthropicRequest, Message } from "../src/types.js";

const user = (text: string): Message => ({ role: "user", content: text });
const reply = (text: string): Message => ({ role: "assistant", content: text });
const request = (...messages: Message[]): AnthropicRequest => ({
  model: "claude-opus-5-5",
  messages,
});

describe("NoticeMemory", () => {
  test("adds a notice back in the same place on later requests", () => {
    const memory = new NoticeMemory();
    const first = memory.apply("s:main", request(user("Redesign auth")), [
      "[jev-prune] Pruned.",
    ]);
    const later = memory.apply(
      "s:main",
      request(user("Redesign auth"), reply("Done."), user("Add tests")),
      [],
    );

    expect(later.messages[0]).toEqual(first.messages[0]);
    expect(later.messages[2]).toEqual(user("Add tests"));
  });

  test("a side request on the same conversation keeps saved notices", () => {
    const memory = new NoticeMemory();
    const first = memory.apply("s:main", request(user("Redesign auth")), [
      "[jev-prune] Pruned.",
    ]);
    memory.apply("s:main", request(user("<session>title</session>")), []);
    const later = memory.apply(
      "s:main",
      request(user("Redesign auth"), reply("Done."), user("Add tests")),
      [],
    );

    expect(later.messages[0]).toEqual(first.messages[0]);
  });

  test("a rewound history keeps notices for when it comes back", () => {
    const memory = new NoticeMemory();
    memory.apply("s:main", request(user("A"), reply("ok"), user("B")), [
      "[jev-prune] Pruned.",
    ]);
    const rewound = memory.apply(
      "s:main",
      request(user("A"), reply("ok"), user("C")),
      [],
    );
    const back = memory.apply(
      "s:main",
      request(user("A"), reply("ok"), user("B"), reply("done"), user("D")),
      [],
    );

    expect(JSON.stringify(rewound.messages)).not.toContain("Pruned");
    expect(JSON.stringify(back.messages[2])).toContain("Pruned");
  });

  test("keeps only the newest entries of a long conversation", () => {
    const memory = new NoticeMemory(500, 2);
    const history: Message[] = [];
    for (const text of ["A", "B", "C"]) {
      history.push(user(text));
      memory.apply("s:main", request(...history), [`notice ${text}`]);
      history.push(reply("ok"));
    }
    const later = JSON.stringify(
      memory.apply("s:main", request(...history, user("D")), []).messages,
    );

    expect(later).not.toContain("notice A");
    expect(later).toContain("notice B");
    expect(later).toContain("notice C");
  });

  test("keeps each turn's notices in order beside new ones", () => {
    const memory = new NoticeMemory();
    memory.apply("s:main", request(user("A")), ["one", "two"]);
    const later = memory.apply(
      "s:main",
      request(user("A"), reply("ok"), user("B")),
      ["three"],
    );

    expect(later.messages[0]?.content).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
    expect(later.messages[2]?.content).toEqual([
      { type: "text", text: "B" },
      { type: "text", text: "three" },
    ]);
  });

  test("a resend of the same turn replaces that turn's notices", () => {
    const memory = new NoticeMemory();
    const turn = request(user("Redesign auth"));
    memory.apply("s:main", turn, ["[jev-prune] Switched."]);
    const resent = memory.apply("s:main", turn, ["[jev-prune] Rejected."]);
    const later = memory.apply(
      "s:main",
      request(user("Redesign auth"), reply("ok"), user("Next")),
      [],
    );

    expect(JSON.stringify(resent.messages)).not.toContain("Switched");
    expect(JSON.stringify(later.messages[0])).toContain("Rejected");
    expect(JSON.stringify(later.messages[0])).not.toContain("Switched");
  });

  test("ignores cache_control moving off the noticed message", () => {
    const memory = new NoticeMemory();
    memory.apply(
      "s:main",
      request({
        role: "user",
        content: [
          { type: "text", text: "A", cache_control: { type: "ephemeral" } },
        ],
      }),
      ["notice"],
    );
    const later = memory.apply(
      "s:main",
      request(user("A"), reply("ok"), user("B")),
      [],
    );

    expect(JSON.stringify(later.messages[0])).toContain("notice");
  });

  test("drops notices whose message was rewritten, as after /compact", () => {
    const memory = new NoticeMemory();
    memory.apply("s:main", request(user("A")), ["notice"]);
    const compacted = memory.apply(
      "s:main",
      request(user("Summary of A"), reply("ok"), user("B")),
      [],
    );

    expect(JSON.stringify(compacted.messages)).not.toContain("notice");
  });

  test("keeps each conversation's notices apart", () => {
    const memory = new NoticeMemory();
    memory.apply("s:main", request(user("A")), ["main notice"]);
    const subagent = memory.apply(
      "s:a1",
      request(user("A"), reply("ok"), user("B")),
      [],
    );

    expect(JSON.stringify(subagent.messages)).not.toContain("main notice");
  });
});

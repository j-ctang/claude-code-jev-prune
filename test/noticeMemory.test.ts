import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const memory = new NoticeMemory({ maxEntries: 2 });
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

  describe("saved to a file", () => {
    const statePath = () =>
      join(
        mkdtempSync(join(tmpdir(), "jev-notices-")),
        "nested",
        "notices.json",
      );

    test("adds notices back after a restart", () => {
      const path = statePath();
      const first = new NoticeMemory({ path }).apply(
        "s:main",
        request(user("Redesign auth")),
        ["[jev-prune] Pruned."],
      );
      const later = new NoticeMemory({ path }).apply(
        "s:main",
        request(user("Redesign auth"), reply("Done."), user("Add tests")),
        [],
      );

      expect(later.messages[0]).toEqual(first.messages[0]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("starts empty from a missing, malformed, or foreign file", () => {
      const path = statePath();
      const fresh = () =>
        new NoticeMemory({ path }).apply("s:main", request(user("A")), []);

      expect(fresh().messages[0]).toEqual(user("A"));
      new NoticeMemory({ path }).apply("s:main", request(user("A")), ["n"]);
      writeFileSync(path, "{not json");
      expect(fresh().messages[0]).toEqual(user("A"));
      writeFileSync(path, JSON.stringify({ version: 99, conversations: [] }));
      expect(fresh().messages[0]).toEqual(user("A"));
    });

    test("skips malformed entries and keeps valid ones", () => {
      const path = statePath();
      new NoticeMemory({ path }).apply("s:main", request(user("A")), ["n"]);
      const saved = JSON.parse(readFileSync(path, "utf8")) as {
        conversations: Array<[string, unknown[]]>;
      };
      saved.conversations[0]?.[1].push({ index: "0", notices: [1] });
      saved.conversations.push(["broken", "nope"] as never);
      writeFileSync(path, JSON.stringify(saved));

      const later = new NoticeMemory({ path }).apply(
        "s:main",
        request(user("A"), reply("ok"), user("B")),
        [],
      );

      expect(JSON.stringify(later.messages[0])).toContain('"n"');
    });

    test("a failed save keeps notices in memory and logs a warning", () => {
      const warnings: string[] = [];
      const log = () => undefined;
      const memory = new NoticeMemory({
        path: "/dev/null/notices.json",
        logger: {
          info: log,
          debug: log,
          error: log,
          warn: (message) => warnings.push(message),
        },
      });

      memory.apply("s:main", request(user("A")), ["n"]);
      const later = memory.apply(
        "s:main",
        request(user("A"), reply("ok"), user("B")),
        [],
      );

      expect(JSON.stringify(later.messages[0])).toContain('"n"');
      expect(warnings).toEqual(["notice_state_save_failed"]);
    });
  });
});

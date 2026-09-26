import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identifyConversation,
  type Conversation,
} from "../src/services/conversation.js";
import { ModelRouter, nextMove } from "../src/services/modelRouter.js";
import { RouteMode } from "../src/services/routeMode.js";
import type { AnthropicRequest, Message, NoulAsker } from "../src/types.js";
import type { AppLogger } from "../src/utils/logger.js";

const DEFAULT = "claude-opus-5-5";
const HARD = "claude-fable-5-1";

const config = {
  routeDefaultModel: DEFAULT,
  routeHardModel: HARD,
  routeUpThreshold: 0.7,
  routeDownThreshold: 0.4,
  notify: true,
};

const silentLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

type Answer = { hard: number; continues: number } | Error;

/** Answers Jev calls in order; records how many were made. */
function scriptedAsker(...answers: Answer[]): NoulAsker & { calls: number } {
  const asker = {
    calls: 0,
    async ask() {
      const answer = answers[asker.calls] ?? { hard: 0, continues: 0 };
      asker.calls += 1;
      if (answer instanceof Error) throw answer;
      return new Map([
        ["hard", answer.hard],
        ["continues", answer.continues],
      ]);
    },
  };
  return asker;
}

/** A conversation of user texts with a short assistant reply between each. */
function turn(texts: string[], extra: Partial<AnthropicRequest> = {}) {
  const messages: Message[] = [];
  texts.forEach((text, index) => {
    if (index > 0) messages.push({ role: "assistant", content: "ok" });
    messages.push({ role: "user", content: text });
  });
  return { model: DEFAULT, messages, ...extra } as AnthropicRequest;
}

/** The same conversation, mid tool loop. */
function toolLoop(texts: string[]): AnthropicRequest {
  const request = turn(texts);
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
      },
    ],
  };
}

const command = (name: string) => `<command-name>/${name}</command-name>`;

/** The main thread of `session`, or one of its subagents. */
const thread = (session = "s", agent?: string): Conversation =>
  identifyConversation(turn([]), session, agent);

async function router(asker: NoulAsker, choice?: "auto" | "off") {
  const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "mode.json");
  const mode = new RouteMode(path);
  if (choice) mode.set(choice);
  return { router: new ModelRouter(config, asker, mode, silentLogger), path };
}

describe("nextMove", () => {
  test.each([
    [false, 0.7, 0, "up"],
    [false, 0.69, 0, "stay"],
    [false, 0.9, 1, "up"],
    [true, 0.4, 0.49, "down"],
    [true, 0.41, 0, "stay"],
    [true, 0.1, 0.5, "stay"],
    [true, 0.9, 0, "stay"],
  ] as const)(
    "up=%s hard=%s continues=%s moves %s",
    (up, hard, continues, move) => {
      expect(nextMove(up, { hard, continues }, config)).toBe(move);
    },
  );
});

describe("ModelRouter in auto mode", () => {
  test("switches up on a hard prompt and keeps the model in the tool loop", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }),
      "auto",
    );

    const first = await subject.route(turn(["Redesign auth"]), thread());
    const loop = await subject.route(toolLoop(["Redesign auth"]), thread());

    expect(first.model).toBe(HARD);
    expect(first.notice).toContain(`Switched this conversation to ${HARD}`);
    expect(loop).toEqual({ model: HARD, fallback: expect.any(Object) });
  });

  test("a follow-up stays up and a new easy task switches down", async () => {
    const { router: subject } = await router(
      scriptedAsker(
        { hard: 0.9, continues: 0 },
        { hard: 0.1, continues: 0.8 },
        { hard: 0.1, continues: 0.1 },
      ),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const followUp = await subject.route(
      turn(["Redesign auth", "Now the error case"]),
      thread(),
    );
    const newTask = await subject.route(
      turn(["Redesign auth", "Now the error case", "Fix a typo in README"]),
      thread(),
    );

    expect(followUp.model).toBe(HARD);
    expect(followUp.notice).toBeUndefined();
    expect(newTask.model).toBeUndefined();
    expect(newTask.notice).toContain(`back to ${DEFAULT}`);
  });

  test("a hard new task stays up", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.9, continues: 0 }),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const next = await subject.route(
      turn(["Redesign auth", "Redesign billing"]),
      thread(),
    );

    expect(next.model).toBe(HARD);
    expect(next.notice).toBeUndefined();
  });

  test("an easy prompt stays on the default model", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.5, continues: 0 }),
      "auto",
    );

    expect(await subject.route(turn(["Rename a variable"]), thread())).toEqual(
      {},
    );
  });

  test("a Jev failure keeps the current model", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, new Error("timeout")),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const next = await subject.route(
      turn(["Redesign auth", "Fix typo"]),
      thread(),
    );

    expect(next.model).toBe(HARD);
    expect(next.notice).toBeUndefined();
  });

  test("never routes another model or forced tool choice", async () => {
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const { router: subject } = await router(asker, "auto");

    expect(
      await subject.route(
        turn(["Hard"], { model: "claude-haiku-4-5" }),
        thread(),
      ),
    ).toEqual({});
    expect(
      await subject.route(
        turn(["Hard"], { tool_choice: { type: "tool", name: "Read" } }),
        thread(),
      ),
    ).toEqual({});
    expect(asker.calls).toBe(0);
  });

  test("keeps separate state per conversation in one session", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.1, continues: 0 }),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const subagent = await subject.route(
      turn(["Find the config file"]),
      thread("s", "a1"),
    );
    const main = await subject.route(toolLoop(["Redesign auth"]), thread());

    expect(subagent.model).toBeUndefined();
    expect(main.model).toBe(HARD);
  });

  test("a subagent on the default model still routes", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.1, continues: 0 }, { hard: 0.9, continues: 0 }),
      "auto",
    );

    await subject.route(turn(["Rename a variable"]), thread());
    const subagent = await subject.route(
      turn(["Audit every module"]),
      thread("s", "a1"),
    );

    expect(subagent.model).toBe(HARD);
  });

  test("/compact keeps the conversation's model", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.2, continues: 0.9 }),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const compacted = await subject.route(
      turn([
        "This session is being continued from a previous conversation.",
        "Add tests",
      ]),
      thread(),
    );

    expect(compacted).toEqual({ model: HARD, fallback: expect.any(Object) });
  });

  test("skips Claude Code's session setup request", async () => {
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const { router: subject } = await router(asker, "auto");

    const setup = await subject.route(
      turn(["<session>\nRedesign auth"], { tools: [] }),
      thread(),
    );

    expect(setup).toEqual({});
    expect(asker.calls).toBe(0);
  });

  test("retries only statuses the routed model may have caused", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }),
      "auto",
    );

    const { fallback } = await subject.route(turn(["Redesign auth"]), thread());

    expect([400, 403, 404].map((status) => fallback?.retries(status))).toEqual([
      true,
      true,
      true,
    ]);
    expect([401, 429, 500].map((status) => fallback?.retries(status))).toEqual([
      false,
      false,
      false,
    ]);
    expect(fallback?.notice).toContain(`${HARD} rejected this request`);
  });

  test("a confirmed rejection stops routing the conversation", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.9, continues: 0 }),
      "auto",
    );

    const first = await subject.route(turn(["Redesign auth"]), thread());
    first.fallback?.confirm();
    const next = await subject.route(
      turn(["Redesign auth", "Redesign billing"]),
      thread(),
    );

    expect(next).toEqual({});
  });

  test("an unconfirmed rejection keeps routing", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.9, continues: 0 }),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const next = await subject.route(
      turn(["Redesign auth", "Redesign billing"]),
      thread(),
    );

    expect(next.model).toBe(HARD);
  });
});

describe("ModelRouter memory", () => {
  test("evicts the least recently used conversation", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "m.json");
    const mode = new RouteMode(path);
    mode.set("auto");
    const subject = new ModelRouter(
      config,
      scriptedAsker({ hard: 0.9, continues: 0 }),
      mode,
      silentLogger,
      2,
    );

    await subject.route(turn(["Redesign auth"]), thread());
    await subject.route(turn(["Find the config file"]), thread("s", "a1"));
    await subject.route(toolLoop(["Redesign auth"]), thread());
    await subject.route(turn(["List the tests"]), thread("s", "a2"));
    const loop = await subject.route(toolLoop(["Redesign auth"]), thread());

    expect(loop.model).toBe(HARD);
  });
});

describe("ModelRouter in ask mode", () => {
  test("asks on a hard prompt, then switches up on /jev-route-auto", async () => {
    const { router: subject, path } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }),
    );

    const asked = await subject.route(turn(["Redesign auth"]), thread());
    const accepted = await subject.route(
      turn(["Redesign auth", command("jev-route-auto")]),
      thread(),
    );

    expect(asked.model).toBeUndefined();
    expect(asked.notice).toContain("/jev-route-auto");
    expect(accepted.model).toBe(HARD);
    expect(accepted.notice).toContain("continue their previous request");
    expect(new RouteMode(path).choice).toBe("auto");
  });

  test("a skipped question does not resume on a later /jev-route-auto", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.1, continues: 0 }),
    );

    await subject.route(turn(["Redesign auth"]), thread());
    await subject.route(turn(["Redesign auth", "Fix a typo"]), thread());
    const later = await subject.route(
      turn(["Redesign auth", "Fix a typo", command("jev-route-auto")]),
      thread(),
    );

    expect(later.model).toBeUndefined();
    expect(later.notice).toContain("Automatic model routing is on");
    expect(later.notice).not.toContain("continue their previous request");
  });

  test("a failed save does not switch up", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "m.json");
    const mode = new RouteMode(path);
    mode.set = () => {
      throw new Error("disk full");
    };
    const subject = new ModelRouter(
      config,
      scriptedAsker({ hard: 0.9, continues: 0 }),
      mode,
      silentLogger,
    );

    await subject.route(turn(["Redesign auth"]), thread());
    const accepted = await subject.route(
      turn(["Redesign auth", command("jev-route-auto")]),
      thread(),
    );

    expect(accepted).toEqual({
      notice: "[jev-prune] Could not save the model routing setting.",
    });
  });

  test("/jev-route-auto with nothing pending only saves the choice", async () => {
    const { router: subject } = await router(scriptedAsker());

    const result = await subject.route(
      turn([command("jev-route-auto")]),
      thread(),
    );

    expect(result.model).toBeUndefined();
    expect(result.notice).toContain("Automatic model routing is on");
  });

  test("/jev-route-off stops routing", async () => {
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const { router: subject, path } = await router(asker);

    const off = await subject.route(turn([command("jev-route-off")]), thread());
    const later = await subject.route(turn(["x", "Redesign auth"]), thread());

    expect(off.notice).toContain("Automatic model routing is off");
    expect(later).toEqual({});
    expect(asker.calls).toBe(0);
    expect(new RouteMode(path).choice).toBe("off");
  });

  test("asks only in the session's main conversation", async () => {
    const asker = scriptedAsker(
      { hard: 0.9, continues: 0 },
      { hard: 0.9, continues: 0 },
      { hard: 0.9, continues: 0 },
    );
    const { router: subject } = await router(asker);

    const main = await subject.route(turn(["Redesign auth"]), thread());
    const subagent = await subject.route(
      turn(["Audit every module"]),
      thread("s", "a1"),
    );
    const other = await subject.route(turn(["Redesign billing"]), thread("t"));

    expect(main.notice).toContain("/jev-route-auto");
    expect(subagent).toEqual({});
    expect(other.notice).toContain("/jev-route-auto");
  });

  test("does not ask or call Jev when notices are off", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "m.json");
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const subject = new ModelRouter(
      { ...config, notify: false },
      asker,
      new RouteMode(path),
      silentLogger,
    );

    const result = await subject.route(turn(["Redesign auth"]), thread());

    expect(result.model).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(asker.calls).toBe(0);
  });
});

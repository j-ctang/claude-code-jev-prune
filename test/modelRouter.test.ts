import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey, ModelRouter } from "../src/services/modelRouter.js";
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

async function router(asker: NoulAsker, choice?: "auto" | "off") {
  const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "mode.json");
  const mode = new RouteMode(path);
  if (choice) mode.set(choice);
  return { router: new ModelRouter(config, asker, mode, silentLogger), path };
}

describe("ModelRouter in auto mode", () => {
  test("switches up on a hard prompt and keeps the model in the tool loop", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }),
      "auto",
    );

    const first = await subject.route(turn(["Redesign auth"]), "s");
    const loop = await subject.route(toolLoop(["Redesign auth"]), "s");

    expect(first.model).toBe(HARD);
    expect(first.notice).toContain(`Switched this conversation to ${HARD}`);
    expect(loop).toEqual({ conversation: first.conversation, model: HARD });
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

    await subject.route(turn(["Redesign auth"]), "s");
    const followUp = await subject.route(
      turn(["Redesign auth", "Now the error case"]),
      "s",
    );
    const newTask = await subject.route(
      turn(["Redesign auth", "Now the error case", "Fix a typo in README"]),
      "s",
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

    await subject.route(turn(["Redesign auth"]), "s");
    const next = await subject.route(
      turn(["Redesign auth", "Redesign billing"]),
      "s",
    );

    expect(next.model).toBe(HARD);
    expect(next.notice).toBeUndefined();
  });

  test("an easy prompt stays on the default model", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.5, continues: 0 }),
      "auto",
    );

    expect(await subject.route(turn(["Rename a variable"]), "s")).toEqual({
      conversation: conversationKey(turn(["Rename a variable"]), "s"),
    });
  });

  test("a Jev failure keeps the current model", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, new Error("timeout")),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), "s");
    const next = await subject.route(turn(["Redesign auth", "Fix typo"]), "s");

    expect(next.model).toBe(HARD);
    expect(next.notice).toBeUndefined();
  });

  test("never routes another model or forced tool choice", async () => {
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const { router: subject } = await router(asker, "auto");

    expect(
      await subject.route(turn(["Hard"], { model: "claude-haiku-4-5" }), "s"),
    ).toEqual({});
    expect(
      await subject.route(
        turn(["Hard"], { tool_choice: { type: "tool", name: "Read" } }),
        "s",
      ),
    ).toEqual({});
    expect(asker.calls).toBe(0);
  });

  test("keeps separate state per conversation in one session", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.1, continues: 0 }),
      "auto",
    );

    await subject.route(turn(["Redesign auth"]), "s");
    const subagent = await subject.route(turn(["Find the config file"]), "s");
    const main = await subject.route(toolLoop(["Redesign auth"]), "s");

    expect(subagent.model).toBeUndefined();
    expect(main.model).toBe(HARD);
  });

  test("a new first message starts a new conversation", () => {
    expect(conversationKey(turn(["A", "B"]), "s")).toBe(
      conversationKey(turn(["A", "C"]), "s"),
    );
    expect(conversationKey(turn(["Summary of A"]), "s")).not.toBe(
      conversationKey(turn(["A"]), "s"),
    );
  });

  test("an unavailable hard model is never routed again", async () => {
    const { router: subject } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }, { hard: 0.9, continues: 0 }),
      "auto",
    );

    const first = await subject.route(turn(["Redesign auth"]), "s");
    const notice = subject.markUnavailable(first.conversation ?? "");
    const next = await subject.route(
      turn(["Redesign auth", "Redesign billing"]),
      "s",
    );

    expect(notice).toContain(`${HARD} is not available on this account`);
    expect(next.model).toBeUndefined();
  });
});

describe("ModelRouter in ask mode", () => {
  test("asks on a hard prompt, then switches up on /jev-route-auto", async () => {
    const { router: subject, path } = await router(
      scriptedAsker({ hard: 0.9, continues: 0 }),
    );

    const asked = await subject.route(turn(["Redesign auth"]), "s");
    const accepted = await subject.route(
      turn(["Redesign auth", command("jev-route-auto")]),
      "s",
    );

    expect(asked.model).toBeUndefined();
    expect(asked.notice).toContain("/jev-route-auto");
    expect(accepted.model).toBe(HARD);
    expect(accepted.notice).toContain("continue their previous request");
    expect(new RouteMode(path).choice).toBe("auto");
  });

  test("/jev-route-auto with nothing pending only saves the choice", async () => {
    const { router: subject } = await router(scriptedAsker());

    const result = await subject.route(turn([command("jev-route-auto")]), "s");

    expect(result.model).toBeUndefined();
    expect(result.notice).toContain("Automatic model routing is on");
  });

  test("/jev-route-off stops routing", async () => {
    const asker = scriptedAsker({ hard: 0.9, continues: 0 });
    const { router: subject, path } = await router(asker);

    const off = await subject.route(turn([command("jev-route-off")]), "s");
    const later = await subject.route(turn(["x", "Redesign auth"]), "s");

    expect(off.notice).toContain("Automatic model routing is off");
    expect(later).toEqual({});
    expect(asker.calls).toBe(0);
    expect(new RouteMode(path).choice).toBe("off");
  });

  test("does not ask when notices are off", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "jev-router-")), "m.json");
    const subject = new ModelRouter(
      { ...config, notify: false },
      scriptedAsker({ hard: 0.9, continues: 0 }),
      new RouteMode(path),
      silentLogger,
    );

    const result = await subject.route(turn(["Redesign auth"]), "s");

    expect(result.model).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });
});

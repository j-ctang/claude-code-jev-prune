import { ResponsesPruner } from "../src/services/responsesPruner.js";
import { loadConfig } from "../src/config.js";
import { DROPPED_STUB } from "../src/services/toolPairs.js";
import type { RelevanceScorer } from "../src/types.js";
import { createFileStateStore } from "../src/services/pruneState.js";
import { tempDir } from "./tempDir.js";
import { join } from "node:path";

const output = "old output ".repeat(200);
const user = {
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Fix the parser" }],
};
const pair = (
  id: string,
  custom = false,
): [Record<string, unknown>, Record<string, unknown>] => [
  {
    type: custom ? "custom_tool_call" : "function_call",
    call_id: id,
    name: "exec",
    ...(custom ? { input: "text(1)" } : { arguments: '{"cmd":"pwd"}' }),
  },
  {
    type: custom ? "custom_tool_call_output" : "function_call_output",
    call_id: id,
    output,
  },
];
const config = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({
    TYPESAFE_API_KEY: "dummy",
    JEV_PRUNE_THRESHOLD: "0",
    JEV_PRUNE_TARGET_TOKENS: "0",
    JEV_PRUNE_KEEP_RECENT: "0",
    ...env,
  });
const scorer: RelevanceScorer = {
  score: async (_goal, candidates) =>
    new Map(candidates.map((c) => [c.toolUseId, 0.1])),
};
const request = (items: unknown[]) => ({
  model: "test-model",
  input: items,
  instructions: "Keep rules",
  stream: true,
  store: false,
  reasoning: { effort: "low" },
  tools: [{ type: "function", name: "exec" }],
});

describe("ResponsesPruner", () => {
  it.each([false, true])(
    "stubs only old output, preserving the wire envelope (custom=%s)",
    async (custom) => {
      const unknown = { type: "reasoning", encrypted_content: "opaque" };
      const original = request([unknown, ...pair("old", custom), user]);
      const snapshot = JSON.parse(JSON.stringify(original));
      const result = await new ResponsesPruner({
        config: config(),
        scorer,
      }).prune(original);
      expect(result.request).toEqual({
        ...original,
        input: [
          unknown,
          original.input[1],
          { ...(original.input[2] as object), output: DROPPED_STUB },
          user,
        ],
      });
      expect(original).toEqual(snapshot);
      expect(result.dropped).toBe(1);
      expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    },
  );

  it("scores against the latest user text and protects recent/excluded calls", async () => {
    const seen: string[] = [];
    const inspect: RelevanceScorer = {
      score: async (goal, candidates) => {
        expect(goal).toBe("Fix the parser");
        seen.push(...candidates.map((c) => c.toolUseId));
        return new Map(candidates.map((c) => [c.toolUseId, 0.1]));
      },
    };
    const excluded = pair("excluded");
    excluded[0] = { ...excluded[0], name: "Read" };
    const original = request([
      ...pair("old"),
      ...excluded,
      ...pair("recent"),
      user,
    ]);
    const result = await new ResponsesPruner({
      config: config({
        JEV_PRUNE_KEEP_RECENT: "1",
        JEV_PRUNE_EXCLUDE_TOOLS: "Read",
      }),
      scorer: inspect,
    }).prune(original);
    expect(seen).toEqual(["old"]);
    expect(result.request.input).toEqual([
      { ...(original.input[0] as object) },
      { ...(original.input[1] as object), output: DROPPED_STUB },
      ...original.input.slice(2),
    ]);
  });

  it("does not score during tool execution but reapplies saved drops across restart", async () => {
    const stateStore = createFileStateStore(
      join(tempDir("jev-responses-"), "state.json"),
    );
    const original = request([...pair("old"), user]);
    await new ResponsesPruner({ config: config(), scorer, stateStore }).prune(
      original,
    );
    const never: RelevanceScorer = {
      score: async () => {
        throw new Error("must not score");
      },
    };
    const mid = request([...pair("old"), user, ...pair("new")]);
    const result = await new ResponsesPruner({
      config: config(),
      scorer: never,
      stateStore,
    }).prune(mid);
    expect((result.request.input as Record<string, unknown>[])[1]?.output).toBe(
      DROPPED_STUB,
    );
    expect((result.request.input as Record<string, unknown>[])[4]?.output).toBe(
      output,
    );
    const changed = request([
      ...pair("old").map((i) =>
        i.output ? { ...i, output: output + "changed" } : i,
      ),
      user,
      ...pair("new"),
    ]);
    expect(
      (
        await new ResponsesPruner({
          config: config(),
          scorer: never,
          stateStore,
        }).prune(changed)
      ).request,
    ).toEqual(changed);
  });

  it.each([undefined, NaN, Infinity, -0.1, 1.1])(
    "fails open atomically for invalid scores: %s",
    async (invalid) => {
      const bad: RelevanceScorer = {
        score: async () =>
          new Map([
            ["one", 0.1],
            ...(invalid === undefined
              ? []
              : [["two", invalid] as [string, number]]),
          ]),
      };
      const service = new ResponsesPruner({ config: config(), scorer: bad });
      const original = request([...pair("one"), ...pair("two"), user]);
      const result = await service.prune(original);
      expect(result.reason).toBe("fail-open");
      expect(result.request).toEqual(original);
      const mid = request([...original.input, ...pair("next")]);
      expect((await service.prune(mid)).request).toEqual(mid);
    },
  );

  it("keeps previous decisions if scoring fails", async () => {
    let fail = false;
    const service = new ResponsesPruner({
      config: config(),
      scorer: {
        score: async (goal, candidates) => {
          if (fail) throw new Error("upstream failed");
          return scorer.score(goal, candidates);
        },
      },
    });
    await service.prune(request([...pair("old"), user]));
    fail = true;
    const result = await service.prune(
      request([...pair("old"), ...pair("new"), user]),
    );
    expect(result.reason).toBe("fail-open");
    expect((result.request.input as Record<string, unknown>[])[1]?.output).toBe(
      DROPPED_STUB,
    );
    expect((result.request.input as Record<string, unknown>[])[3]?.output).toBe(
      output,
    );
  });

  it.each([
    { previous_response_id: "resp_old" },
    { conversation: "conv_old" },
    { input: "hello" },
    { input: null },
    { input: [null, user] },
  ])("passes unsupported request shapes through: %j", async (override) => {
    const original = { ...request([...pair("old"), user]), ...override };
    expect(
      (await new ResponsesPruner({ config: config(), scorer }).prune(original))
        .request,
    ).toEqual(original);
  });

  it.each([
    [...pair("dup"), ...pair("dup")],
    [pair("reverse")[1], pair("reverse")[0]],
    [pair("orphan")[1]],
    [
      pair("rich")[0],
      {
        ...pair("rich")[1],
        output: [{ type: "input_image", image_url: "opaque" }],
      },
    ],
    [
      pair("mismatch")[0],
      { ...pair("mismatch")[1], type: "custom_tool_call_output" },
    ],
    [pair("small")[0], { ...pair("small")[1], output: "ok" }],
  ])(
    "keeps ambiguous, malformed, rich, and small outputs",
    async (...items) => {
      const original = request([...items, user]);
      expect(
        (
          await new ResponsesPruner({ config: config(), scorer }).prune(
            original,
          )
        ).request,
      ).toEqual(original);
    },
  );

  it("does not prune disabled or below-threshold requests", async () => {
    const original = request([...pair("old"), user]);
    for (const settings of [
      config({ JEV_PRUNE_ENABLED: "false" }),
      config({ JEV_PRUNE_THRESHOLD: "120000" }),
    ]) {
      expect(
        (
          await new ResponsesPruner({ config: settings, scorer }).prune(
            original,
          )
        ).request,
      ).toEqual(original);
    }
  });

  it("does not score host-injected context as a task", async () => {
    const original = request([
      ...pair("old"),
      { ...user, content: "<environment_context>cwd</environment_context>" },
    ]);
    const result = await new ResponsesPruner({
      config: config(),
      scorer,
    }).prune(original);
    expect(result.request).toEqual(original);
    expect(result.reason).toBe("mid-task");
  });

  it("counts rich recent outputs when protecting the tail", async () => {
    const original = request([
      ...pair("old"),
      ...pair("rich").map((i) =>
        i.output
          ? { ...i, output: [{ type: "input_image", image_url: "opaque" }] }
          : i,
      ),
      user,
    ]);
    const result = await new ResponsesPruner({
      config: config({ JEV_PRUNE_KEEP_RECENT: "1" }),
      scorer,
    }).prune(original);
    expect(result.dropped).toBe(1);
    expect((result.request.input as Record<string, unknown>[])[3]).toEqual(
      original.input[3],
    );
  });

  it("keeps high relevance and uses the configured aggressive threshold", async () => {
    const probability: RelevanceScorer = {
      score: async () => new Map([["old", 0.6]]),
    };
    const original = request([...pair("old"), user]);
    expect(
      (
        await new ResponsesPruner({
          config: config(),
          scorer: probability,
        }).prune(original)
      ).request,
    ).toEqual(original);
    expect(
      (
        await new ResponsesPruner({
          config: config({ JEV_PRUNE_TRIGGER_TOKENS: "0" }),
          scorer: probability,
        }).prune(original)
      ).dropped,
    ).toBe(1);
  });
});

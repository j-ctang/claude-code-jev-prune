import type { Config } from "../src/config.js";
import { PruneError } from "../src/errors.js";
import { ContextPruner } from "../src/services/contextPruner.js";
import type {
  PruneStateSnapshot,
  PruneStateStore,
} from "../src/services/pruneState.js";
import { estimateTokens } from "../src/utils/tokenCounter.js";
import type {
  AnthropicRequest,
  RelevanceScorer,
  ToolCandidate,
} from "../src/types.js";
import {
  allText,
  allToolResultIds,
  allToolUseIds,
  contentBlock,
  twoToolRequest,
} from "./fixtures/messages.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 5590,
    pruningEnabled: true,
    pruneThreshold: 0,
    triggerTokens: 1_000_000,
    targetTokens: 0,
    rescoreTokens: 0,
    resumeNoticeTokens: 0,
    statePath: "/nonexistent/jev-prune-state.json",
    supersede: false,
    trim: false,
    trimTools: new Set(["Bash"]),
    trimMinTokens: 10_000,
    trimKeepTokens: 2_000,
    notify: false,
    keepRecent: 0,
    excludeTools: new Set(),
    debug: false,
    jevApiKey: "secret",
    jevBaseUrl: "https://api.typesafe.ai",
    jevModel: "jev-latest",
    jevTimeoutMs: 2_000,
    anthropicUpstreamUrl: "https://api.anthropic.com",
    ...overrides,
  };
}

function scorerReturning(
  values: Record<string, number>,
  observed?: { goals: string[]; batches: ToolCandidate[][] },
): RelevanceScorer {
  return {
    async score(goal, candidates) {
      observed?.goals.push(goal);
      observed?.batches.push([...candidates]);
      return new Map(
        candidates.flatMap((candidate) => {
          const value = values[candidate.toolUseId];
          return value === undefined ? [] : [[candidate.toolUseId, value]];
        }),
      );
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("ContextPruner", () => {
  test("drops matched tool-use and tool-result pairs without mutating retained content", async () => {
    const originalSnapshot = clone(twoToolRequest);
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(allToolUseIds(result.request)).toEqual(["call-new"]);
    expect(allToolResultIds(result.request)).toEqual(["call-new"]);
    expect(allText(result.request)).toEqual(allText(twoToolRequest));
    expect(result.request.system).toEqual(twoToolRequest.system);
    expect(result.request.messages[1]?.message_meta).toBe(
      "preserve-message-metadata",
    );
    expect(twoToolRequest).toEqual(originalSnapshot);
    expect(result.reason).toBe("pruned");
    expect(result.dropped).toBe(1);
  });

  test("protects the configured number of newest matched pairs", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config({ keepRecent: 1 }),
      scorer: scorerReturning({ "call-old": 0.01 }, observed),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(
      observed.batches[0]?.map((candidate) => candidate.toolUseId),
    ).toEqual(["call-old"]);
    expect(allToolUseIds(result.request)).toEqual(["call-new"]);
    expect(allToolResultIds(result.request)).toEqual(["call-new"]);
  });

  test("protects excluded tools from scoring and removal", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config({ excludeTools: new Set(["read_file"]) }),
      scorer: scorerReturning({}, observed),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(result.request).toBe(twoToolRequest);
    expect(observed.batches).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  test("preserves unmatched, duplicate, malformed, text, and system content", async () => {
    const request: AnthropicRequest = {
      system: "never remove",
      messages: [
        { role: "user", content: "Keep every part of this request." },
        {
          role: "assistant",
          content: [
            contentBlock({
              type: "tool_use",
              id: "duplicate",
              name: "test",
              input: {},
            }),
            contentBlock({
              type: "tool_use",
              id: "duplicate",
              name: "test",
              input: {},
            }),
            contentBlock({
              type: "tool_use",
              id: "unmatched",
              name: "test",
              input: {},
            }),
            contentBlock({ type: "tool_use", id: 17, name: "test", input: {} }),
          ],
        },
        {
          role: "user",
          content: [
            contentBlock({
              type: "tool_result",
              tool_use_id: "duplicate",
              content: "one result for two uses",
            }),
            contentBlock({
              type: "tool_result",
              tool_use_id: "orphan",
              content: "no use",
            }),
            contentBlock({ type: "custom", value: true }),
          ],
        },
      ],
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ duplicate: 0 }),
    });

    const result = await pruner.prune(request);

    expect(result.request).toBe(request);
    expect(result.reason).toBe("no-candidates");
  });

  test("fails open when scoring rejects", async () => {
    const scorer: RelevanceScorer = {
      async score() {
        throw new PruneError("timeout");
      },
    };
    const pruner = new ContextPruner({ config: config(), scorer });

    const result = await pruner.prune(twoToolRequest);

    expect(result.request).toBe(twoToolRequest);
    expect(result.reason).toBe("fail-open");
    expect(result.beforeTokens).toBe(result.afterTokens);
    expect(result.failureReason).toBe("timeout");
  });

  test("logs only the error name for errors from other code", async () => {
    const scorer: RelevanceScorer = {
      async score() {
        throw new TypeError("request to https://user:secret@host failed");
      },
    };
    const pruner = new ContextPruner({ config: config(), scorer });

    const result = await pruner.prune(twoToolRequest);

    expect(result.reason).toBe("fail-open");
    expect(result.failureReason).toBe("TypeError");
  });

  test("passes through when disabled or below threshold", async () => {
    const disabled = new ContextPruner({
      config: config({ pruningEnabled: false }),
      scorer: scorerReturning({}),
    });
    const belowThreshold = new ContextPruner({
      config: config({ pruneThreshold: 999_999, triggerTokens: 999_999 }),
      scorer: scorerReturning({}),
    });

    const disabledResult = await disabled.prune(twoToolRequest);
    const thresholdResult = await belowThreshold.prune(twoToolRequest);

    expect(disabledResult.request).toBe(twoToolRequest);
    expect(disabledResult.reason).toBe("disabled");
    expect(thresholdResult.request).toBe(twoToolRequest);
    expect(thresholdResult.reason).toBe("below-threshold");
  });

  test("uses 0.50 normally and 0.70 at the trigger threshold", async () => {
    const scorer = scorerReturning({ "call-old": 0.6, "call-new": 0.9 });
    const normal = new ContextPruner({ config: config(), scorer });
    const aggressive = new ContextPruner({
      config: config({ triggerTokens: 0 }),
      scorer,
    });

    const normalResult = await normal.prune(twoToolRequest);
    const aggressiveResult = await aggressive.prune(twoToolRequest);

    expect(allToolUseIds(normalResult.request)).toEqual([
      "call-old",
      "call-new",
    ]);
    expect(allToolUseIds(aggressiveResult.request)).toEqual(["call-new"]);
  });

  test("reuses cached drop decisions but re-scores kept candidates", async () => {
    const batches: string[][] = [];
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        batches.push(candidates.map((candidate) => candidate.toolUseId));
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            candidate.toolUseId === "call-old" ? 0.1 : 0.9,
          ]),
        );
      },
    };
    const pruner = new ContextPruner({ config: config(), scorer });

    const first = await pruner.prune(twoToolRequest);
    const second = await pruner.prune(twoToolRequest);

    expect(allToolUseIds(first.request)).toEqual(["call-new"]);
    expect(allToolUseIds(second.request)).toEqual(["call-new"]);
    expect(batches).toEqual([["call-old", "call-new"], ["call-new"]]);
  });

  test("does not reuse a drop when the tool payload changes under the same ID", async () => {
    let attempt = 0;
    const batches: string[][] = [];
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        attempt += 1;
        batches.push(candidates.map((candidate) => candidate.toolUseId));
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            attempt === 1 && candidate.toolUseId === "call-old" ? 0.1 : 0.9,
          ]),
        );
      },
    };
    const pruner = new ContextPruner({ config: config(), scorer });
    const changedRequest = clone(twoToolRequest);
    const oldUse = changedRequest.messages[1]?.content;
    const oldResult = changedRequest.messages[2]?.content;
    if (!Array.isArray(oldUse) || !Array.isArray(oldResult)) {
      throw new Error("invalid fixture");
    }
    const useBlock = oldUse.find((block) => block.type === "tool_use");
    const resultBlock = oldResult.find((block) => block.type === "tool_result");
    if (!useBlock || !resultBlock) throw new Error("invalid fixture");
    useBlock.input = { path: "different.log" };
    resultBlock.content = "different output";

    await pruner.prune(twoToolRequest);
    const changed = await pruner.prune(changedRequest);

    expect(allToolUseIds(changed.request)).toEqual(["call-old", "call-new"]);
    expect(batches).toEqual([
      ["call-old", "call-new"],
      ["call-old", "call-new"],
    ]);
  });

  test("evicts old drop fingerprints when the cache reaches its bound", async () => {
    let attempt = 0;
    const batches: string[][] = [];
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        attempt += 1;
        batches.push(candidates.map((candidate) => candidate.toolUseId));
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            attempt < 3 && candidate.toolUseId === "call-old" ? 0.1 : 0.9,
          ]),
        );
      },
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer,
      maxCachedDrops: 1,
    });
    const changedRequest = clone(twoToolRequest);
    const oldUse = changedRequest.messages[1]?.content;
    if (!Array.isArray(oldUse)) throw new Error("invalid fixture");
    const useBlock = oldUse.find((block) => block.type === "tool_use");
    if (!useBlock) throw new Error("invalid fixture");
    useBlock.input = { path: "second-fingerprint.log" };

    await pruner.prune(twoToolRequest);
    await pruner.prune(changedRequest);
    const revisited = await pruner.prune(twoToolRequest);

    expect(allToolUseIds(revisited.request)).toEqual(["call-old", "call-new"]);
    expect(batches).toEqual([
      ["call-old", "call-new"],
      ["call-old", "call-new"],
      ["call-old", "call-new"],
    ]);
  });

  test("keeps recently hit drop fingerprints when evicting", async () => {
    const batches: string[][] = [];
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        batches.push(candidates.map((candidate) => candidate.toolUseId));
        return new Map(
          candidates.map((candidate) => [
            candidate.toolUseId,
            candidate.toolUseId === "call-old" ? 0.1 : 0.9,
          ]),
        );
      },
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer,
      maxCachedDrops: 2,
    });
    const withOldInput = (path: string) => {
      const request = clone(twoToolRequest);
      const content = request.messages[1]?.content;
      if (!Array.isArray(content)) throw new Error("invalid fixture");
      const useBlock = content.find((block) => block.type === "tool_use");
      if (!useBlock) throw new Error("invalid fixture");
      useBlock.input = { path };
      return request;
    };

    await pruner.prune(twoToolRequest);
    await pruner.prune(withOldInput("b.log"));
    await pruner.prune(twoToolRequest);
    await pruner.prune(withOldInput("c.log"));
    await pruner.prune(twoToolRequest);

    expect(batches).toEqual([
      ["call-old", "call-new"],
      ["call-old", "call-new"],
      ["call-new"],
      ["call-old", "call-new"],
      ["call-new"],
    ]);
  });

  test("removes messages made empty by pruning", async () => {
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.1 }),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(result.request.messages).toHaveLength(5);
    expect(
      result.request.messages.some(
        (message) =>
          Array.isArray(message.content) && message.content.length === 0,
      ),
    ).toBe(false);
  });

  test("does not score while the agent is mid-task", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.1 }, observed),
    });
    const midTask = clone(twoToolRequest);
    midTask.messages.pop();

    const result = await pruner.prune(midTask);

    expect(result.reason).toBe("mid-task");
    expect(result.request).toBe(midTask);
    expect(observed.batches).toEqual([]);
  });

  test("re-applies earlier drops mid-task without scoring again", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
    });
    await pruner.prune(twoToolRequest);
    const midTask = clone(twoToolRequest);
    midTask.messages.push(
      {
        role: "assistant",
        content: [
          contentBlock({
            type: "tool_use",
            id: "call-3",
            name: "bash",
            input: {},
          }),
        ],
      },
      {
        role: "user",
        content: [
          contentBlock({
            type: "tool_result",
            tool_use_id: "call-3",
            content: "ok",
          }),
        ],
      },
    );

    const result = await pruner.prune(midTask);

    expect(result.reason).toBe("mid-task");
    expect(allToolUseIds(result.request)).toEqual(["call-new", "call-3"]);
    expect(observed.batches).toHaveLength(1);
  });

  test("does not score again once earlier drops bring context under the threshold", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config({ pruneThreshold: estimateTokens(twoToolRequest) - 10 }),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
    });

    const first = await pruner.prune(twoToolRequest);
    const second = await pruner.prune(twoToolRequest);

    expect(first.reason).toBe("pruned");
    expect(second.reason).toBe("below-threshold");
    expect(allToolUseIds(second.request)).toEqual(["call-new"]);
    expect(observed.batches).toHaveLength(1);
  });

  test("appends a notice about the cut to the new user turn", async () => {
    const pruner = new ContextPruner({
      config: config({ notify: true, targetTokens: 1_000_000_000 }),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
    });

    const result = await pruner.prune(twoToolRequest);
    const last = result.request.messages.at(-1);

    expect(result.aboveTarget).toBe(false);
    expect(last?.content).toEqual([
      { type: "text", text: "Keep going with the JWT fix." },
      { type: "text", text: result.notice },
    ]);
    expect(result.notice).toMatch(/Pruned 1 stale tool result/);
    expect(result.notice).not.toMatch(/handoff/);
  });

  test("suggests a handoff when pruning cannot reach the target", async () => {
    const pruner = new ContextPruner({
      config: config({ notify: true, targetTokens: 0 }),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(result.aboveTarget).toBe(true);
    expect(result.notice).toMatch(/handoff file/);
  });

  test("treats trailing system hook messages as part of the user turn", async () => {
    const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
    const pruner = new ContextPruner({
      config: config({ notify: true, targetTokens: 1_000_000_000 }),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
    });
    const withHook = clone(twoToolRequest);
    withHook.messages.push({ role: "system", content: "hook context" });
    const midTaskWithHook = clone(twoToolRequest);
    midTaskWithHook.messages.splice(-1, 1, {
      role: "system",
      content: "hook context",
    });

    const midTask = await pruner.prune(midTaskWithHook);
    const result = await pruner.prune(withHook);

    expect(midTask.reason).toBe("mid-task");
    expect(result.reason).toBe("pruned");
    expect(result.request.messages.at(-1)).toEqual({
      role: "system",
      content: "hook context",
    });
    expect(result.request.messages.at(-2)?.content).toEqual([
      { type: "text", text: "Keep going with the JWT fix." },
      { type: "text", text: result.notice },
    ]);
    expect(observed.batches).toHaveLength(1);
  });

  describe("keep decisions", () => {
    const withExtraPair = (id: string, output: string) => {
      const request = clone(twoToolRequest);
      request.messages.splice(-1, 0,
        {
          role: "assistant",
          content: [contentBlock({ type: "tool_use", id, name: "bash", input: {} })],
        },
        {
          role: "user",
          content: [contentBlock({ type: "tool_result", tool_use_id: id, content: output })],
        },
      );
      return request;
    };
    const batchIds = (observed: { batches: ToolCandidate[][] }) =>
      observed.batches.map((batch) => batch.map((candidate) => candidate.toolUseId));

    test("are reused so only new candidates are scored", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config({ rescoreTokens: 1_000_000 }),
        scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9, "call-3": 0.9 }, observed),
      });

      const first = await pruner.prune(twoToolRequest, { sessionId: "s" });
      const second = await pruner.prune(twoToolRequest, { sessionId: "s" });
      const third = await pruner.prune(withExtraPair("call-3", "ok"), { sessionId: "s" });

      expect(first.evaluated).toBe(2);
      expect(second.reason).toBe("no-candidates");
      expect(third.evaluated).toBe(1);
      expect(batchIds(observed)).toEqual([["call-old", "call-new"], ["call-3"]]);
    });

    test("are re-scored when the latest user goal changes", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config({ rescoreTokens: 1_000_000 }),
        scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9 }, observed),
      });
      const changed = clone(twoToolRequest);
      changed.messages[changed.messages.length - 1] = {
        role: "user",
        content: "Investigate the old login log again.",
      };

      await pruner.prune(twoToolRequest, { sessionId: "s" });
      const result = await pruner.prune(changed, { sessionId: "s" });

      expect(result.evaluated).toBe(2);
      expect(observed.goals).toEqual([
        "Keep going with the JWT fix.",
        "Investigate the old login log again.",
      ]);
    });

    test("are re-scored after the context grows by the rescore amount", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const grown = withExtraPair("call-3", "x".repeat(4_000));
      const pruner = new ContextPruner({
        config: config({ rescoreTokens: 500 }),
        scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9, "call-3": 0.9 }, observed),
      });

      await pruner.prune(twoToolRequest, { sessionId: "s" });
      await pruner.prune(grown, { sessionId: "s" });

      expect(batchIds(observed)).toEqual([
        ["call-old", "call-new"],
        ["call-old", "call-new", "call-3"],
      ]);
    });

    test("are re-scored in full by a manual prune", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config({ rescoreTokens: 1_000_000 }),
        scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9 }, observed),
      });

      await pruner.prune(twoToolRequest, { sessionId: "s" });
      pruner.requestManualPrune("s");
      const manual = await pruner.prune(twoToolRequest, { sessionId: "s" });

      expect(manual.evaluated).toBe(2);
      expect(observed.batches).toHaveLength(2);
    });

    test("are tracked separately per session", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config({ rescoreTokens: 1_000_000 }),
        scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9, "call-3": 0.9 }, observed),
      });

      await pruner.prune(twoToolRequest, { sessionId: "a" });
      await pruner.prune(withExtraPair("call-3", "ok"), { sessionId: "b" });

      expect(batchIds(observed)).toEqual([
        ["call-old", "call-new"],
        ["call-old", "call-new", "call-3"],
      ]);
    });
  });

  describe("state across restarts", () => {
    function memoryStore(): PruneStateStore & { saved?: PruneStateSnapshot } {
      const store: PruneStateStore & { saved?: PruneStateSnapshot } = {
        load: () => store.saved,
        save(snapshot) {
          store.saved = clone(snapshot);
        },
      };
      return store;
    }

    test("re-applies earlier drops after a restart without scoring", async () => {
      const store = memoryStore();
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const scorer = scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed);
      const before = new ContextPruner({ config: config(), scorer, stateStore: store });
      await before.prune(twoToolRequest, { sessionId: "s" });

      const after = new ContextPruner({ config: config(), scorer, stateStore: store });
      const midTask = clone(twoToolRequest);
      midTask.messages.pop();
      const result = await after.prune(midTask, { sessionId: "s" });

      expect(allToolUseIds(result.request)).toEqual(["call-new"]);
      expect(observed.batches).toHaveLength(1);
    });

    test("keeps working when the state cannot be saved", async () => {
      const warnings: string[] = [];
      const pruner = new ContextPruner({
        config: config(),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
        logger: {
          info: () => undefined,
          error: () => undefined,
          debug: () => undefined,
          warn: (message) => warnings.push(message),
        },
        stateStore: {
          load: () => undefined,
          save() {
            throw new Error("disk full at /secret/path");
          },
        },
      });

      const result = await pruner.prune(twoToolRequest, { sessionId: "s" });

      expect(result.reason).toBe("pruned");
      expect(warnings).toContain("prune_state_save_failed");
    });
  });

  describe("superseded and trimmed outputs", () => {
    interface Pair {
      id: string;
      name: string;
      input: Record<string, unknown>;
      output: string;
    }
    const bigLog = Array.from({ length: 5_000 }, (_, index) => `log line ${index}`).join("\n");
    const conversation = (pairs: Pair[], lastText = "Next step."): AnthropicRequest => ({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Fix the auth bug." },
        ...pairs.flatMap((pair, index) => [
          {
            role: "assistant" as const,
            content: [contentBlock({ type: "tool_use", id: pair.id, name: pair.name, input: pair.input })],
          },
          {
            role: "user" as const,
            content: [
              contentBlock({
                type: "tool_result",
                tool_use_id: pair.id,
                content: pair.output,
                is_error: false,
                ...(index === pairs.length - 1
                  ? { cache_control: { type: "ephemeral" } }
                  : {}),
              }),
            ],
          },
        ]),
        ...(lastText ? [{ role: "user" as const, content: lastText }] : []),
      ],
    });
    const resultBlock = (request: AnthropicRequest, id: string) =>
      request.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((block) => block.type === "tool_result" && block.tool_use_id === id);
    const pairs: Pair[] = [
      { id: "read-1", name: "Read", input: { file_path: "src/auth.ts" }, output: "1\told" },
      { id: "bash-big", name: "Bash", input: { command: "npm test" }, output: bigLog },
      { id: "read-2", name: "Read", input: { file_path: "src/auth.ts" }, output: "1\tnew" },
    ];
    const rewriteConfig = (overrides: Partial<Config> = {}) =>
      config({
        supersede: true,
        trim: true,
        trimMinTokens: 1_000,
        trimKeepTokens: 100,
        keepRecent: 1,
        notify: true,
        targetTokens: 1_000_000_000,
        ...overrides,
      });

    test("stubs superseded output, trims large output, and scores the rest", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: rewriteConfig(),
        scorer: scorerReturning({ "bash-big": 0.9 }, observed),
      });

      const result = await pruner.prune(conversation(pairs));

      expect(result.reason).toBe("pruned");
      expect(result.superseded).toBe(1);
      expect(result.trimmed).toBe(1);
      expect(resultBlock(result.request, "read-1")).toEqual({
        type: "tool_result",
        tool_use_id: "read-1",
        content: "[jev-prune] Output removed: superseded by a later Read of src/auth.ts.",
        is_error: false,
      });
      const trimmed = resultBlock(result.request, "bash-big")?.content as string;
      expect(trimmed).toMatch(/Trimmed [\d,]+ lines/);
      expect(trimmed.length).toBeLessThan(1_000);
      expect(resultBlock(result.request, "read-2")).toEqual(
        resultBlock(conversation(pairs), "read-2"),
      );
      expect(observed.batches.map((batch) => batch.map((candidate) => candidate.toolUseId))).toEqual([
        ["bash-big"],
      ]);
      expect(observed.batches[0]?.[0]?.result).toBe(trimmed);
      expect(result.notice).toMatch(
        /replaced 1 superseded output\(s\) with a stub, trimmed 1 large output\(s\)/,
      );
    });

    test("keeps repeated Bash output and its cache_control", async () => {
      const pruner = new ContextPruner({
        config: rewriteConfig({ keepRecent: 5 }),
        scorer: scorerReturning({}),
      });
      const recent: Pair[] = [
        { id: "bash-1", name: "Bash", input: { command: "ls" }, output: "a" },
        { id: "bash-2", name: "Bash", input: { command: "ls" }, output: "a b" },
      ];
      const request = conversation(recent);
      const block = resultBlock(request, "bash-2");
      if (block) block.cache_control = undefined;
      const first = resultBlock(request, "bash-1");
      if (first) first.cache_control = { type: "ephemeral" };

      const result = await pruner.prune(request);

      expect(resultBlock(result.request, "bash-1")).toMatchObject({
        content: "a",
        cache_control: { type: "ephemeral" },
      });
      expect(result.trimmed ?? 0).toBe(0);
    });

    test("re-applies rewrites mid-task, after a Jev failure, and after a restart", async () => {
      let saved: PruneStateSnapshot | undefined;
      const store: PruneStateStore = {
        load: () => saved,
        save: (snapshot) => {
          saved = clone(snapshot);
        },
      };
      const failing: RelevanceScorer = {
        async score() {
          throw new PruneError("timeout");
        },
      };
      const pruner = new ContextPruner({
        config: rewriteConfig(),
        scorer: failing,
        stateStore: store,
      });

      const failed = await pruner.prune(conversation(pairs));
      const restarted = new ContextPruner({
        config: rewriteConfig(),
        scorer: scorerReturning({}),
        stateStore: store,
      });
      const midTask = await restarted.prune(conversation(pairs, ""));

      expect(failed.reason).toBe("fail-open");
      expect(resultBlock(failed.request, "read-1")?.content).toMatch(/superseded/);
      expect(resultBlock(failed.request, "bash-big")?.content).toMatch(/Trimmed/);
      expect(midTask.reason).toBe("mid-task");
      expect(resultBlock(midTask.request, "read-1")?.content).toMatch(/superseded/);
      expect(resultBlock(midTask.request, "bash-big")?.content).toBe(
        resultBlock(failed.request, "bash-big")?.content,
      );
    });

    test("leaves excluded tools, Read output, and disabled features alone", async () => {
      const readBig: Pair[] = [
        { id: "read-big", name: "Read", input: { file_path: "big.ts" }, output: bigLog },
        ...pairs.slice(2),
      ];
      const excluded = new ContextPruner({
        config: rewriteConfig({ excludeTools: new Set(["Read", "Bash"]) }),
        scorer: scorerReturning({}),
      });
      const readOnly = new ContextPruner({
        config: rewriteConfig({ trimTools: new Set(["Bash"]) }),
        scorer: scorerReturning({ "read-big": 0.9 }),
      });
      const disabled = new ContextPruner({
        config: rewriteConfig({ supersede: false, trim: false }),
        scorer: scorerReturning({ "read-1": 0.9, "bash-big": 0.9 }),
      });

      const excludedResult = await excluded.prune(conversation(pairs));
      const readResult = await readOnly.prune(conversation(readBig));
      const disabledResult = await disabled.prune(conversation(pairs));

      expect(excludedResult.superseded ?? 0).toBe(0);
      expect(readResult.trimmed).toBe(0);
      expect(resultBlock(readResult.request, "read-big")?.content).toBe(bigLog);
      expect(disabledResult.superseded).toBe(0);
      expect(disabledResult.trimmed).toBe(0);
      expect(resultBlock(disabledResult.request, "bash-big")?.content).toBe(bigLog);
    });
  });

  describe("resume notice", () => {
    const resumeConfig = {
      pruneThreshold: 1_000_000,
      triggerTokens: 1_000_000,
      resumeNoticeTokens: 1,
      notify: true,
    };

    test("suggests /jev-prune once when a conversation is resumed", async () => {
      const pruner = new ContextPruner({
        config: config(resumeConfig),
        scorer: scorerReturning({}),
      });

      const first = await pruner.prune(twoToolRequest, { sessionId: "s" });
      const second = await pruner.prune(twoToolRequest, { sessionId: "s" });

      expect(first.resumed).toBe(true);
      expect(first.notice).toMatch(/continued conversation .* run \/jev-prune/);
      expect(JSON.stringify(first.request.messages.at(-1))).toContain(
        "continued conversation",
      );
      expect(second.resumed).toBeUndefined();
      expect(second.request).toBe(twoToolRequest);
    });

    test("stays quiet for new, small, or already-seen conversations", async () => {
      const store: PruneStateStore = {
        load: () => ({
          drops: [],
          keeps: [],
          rewrites: [],
          lastFullScoreTokens: [],
          seenSessions: ["seen-before-restart"],
        }),
        save: () => undefined,
      };
      const pruner = new ContextPruner({
        config: config(resumeConfig),
        scorer: scorerReturning({}),
        stateStore: store,
      });
      const small = new ContextPruner({
        config: config({ ...resumeConfig, resumeNoticeTokens: 999_999 }),
        scorer: scorerReturning({}),
      });
      const brandNew = {
        ...twoToolRequest,
        messages: [{ role: "user" as const, content: "Start a new task." }],
      };

      const fresh = await pruner.prune(brandNew, { sessionId: "new" });
      const seen = await pruner.prune(twoToolRequest, {
        sessionId: "seen-before-restart",
      });
      const tiny = await small.prune(twoToolRequest, { sessionId: "s" });

      expect(fresh.resumed).toBeUndefined();
      expect(seen.resumed).toBeUndefined();
      expect(tiny.resumed).toBeUndefined();
    });
  });

  describe("manual prune", () => {
    const highThreshold = {
      pruneThreshold: 1_000_000,
      triggerTokens: 1_000_000,
    };

    test("prunes below the threshold once for the requesting session", async () => {
      const observed = {
        goals: [] as string[],
        batches: [] as ToolCandidate[][],
      };
      const pruner = new ContextPruner({
        config: config({ ...highThreshold, notify: true }),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
      });
      pruner.requestManualPrune("session-a");

      const other = await pruner.prune(twoToolRequest, {
        sessionId: "session-b",
      });
      const manual = await pruner.prune(twoToolRequest, {
        sessionId: "session-a",
      });
      const again = await pruner.prune(clone(twoToolRequest), {
        sessionId: "session-a",
      });

      expect(other.reason).toBe("below-threshold");
      expect(manual.reason).toBe("pruned");
      expect(manual.manual).toBe(true);
      expect(manual.notice).toMatch(/Manual prune: pruned 1/);
      expect(allToolUseIds(manual.request)).toEqual(["call-new"]);
      expect(again.reason).toBe("below-threshold");
      expect(observed.batches).toHaveLength(1);
    });

    test("runs when the /jev-prune slash command starts the turn", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config(highThreshold),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
      });
      const withCommand = (name: string) => {
        const request = clone(twoToolRequest);
        request.messages.splice(-1, 1, {
          role: "user",
          content: [
            contentBlock({
              type: "text",
              text: `<command-message>jev-prune</command-message>\n<command-name>${name}</command-name>\n`,
            }),
            contentBlock({ type: "text", text: "Report the notice." }),
          ],
        });
        request.messages.push({ role: "system", content: "hook context" });
        return request;
      };

      const plain = await pruner.prune(withCommand("/jev-prune"));
      const plugin = await pruner.prune(withCommand("/jev-prune:jev-prune"));
      const other = await pruner.prune(withCommand("/review"));

      expect(plain.reason).toBe("pruned");
      expect(plain.manual).toBe(true);
      expect(plugin.manual).toBe(true);
      expect(other.reason).toBe("below-threshold");
    });

    test("keeps a below-threshold prune applied on later requests", async () => {
      const observed = { goals: [] as string[], batches: [] as ToolCandidate[][] };
      const pruner = new ContextPruner({
        config: config(highThreshold),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }, observed),
      });
      pruner.requestManualPrune("session-a");
      await pruner.prune(twoToolRequest, { sessionId: "session-a" });
      const midTask = clone(twoToolRequest);
      midTask.messages.pop();

      const nextTurn = await pruner.prune(clone(twoToolRequest), {
        sessionId: "session-a",
      });
      const during = await pruner.prune(midTask, { sessionId: "session-a" });

      expect(allToolUseIds(nextTurn.request)).toEqual(["call-new"]);
      expect(nextTurn.reason).toBe("below-threshold");
      expect(allToolUseIds(during.request)).toEqual(["call-new"]);
      expect(observed.batches).toHaveLength(1);
    });

    test("waits for a new user turn before running", async () => {
      const pruner = new ContextPruner({
        config: config(highThreshold),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
      });
      const midTask = clone(twoToolRequest);
      midTask.messages.pop();
      pruner.requestManualPrune("session-a");

      const during = await pruner.prune(midTask, { sessionId: "session-a" });
      const after = await pruner.prune(twoToolRequest, {
        sessionId: "session-a",
      });

      expect(during.reason).toBe("below-threshold");
      expect(after.reason).toBe("pruned");
    });

    test("ignores a request older than ten minutes", async () => {
      let now = 0;
      const pruner = new ContextPruner({
        config: config(highThreshold),
        scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
        now: () => now,
      });
      pruner.requestManualPrune("session-a");
      now = 10 * 60 * 1000 + 1;

      const result = await pruner.prune(twoToolRequest, {
        sessionId: "session-a",
      });

      expect(result.reason).toBe("below-threshold");
    });

    test("tells the user when nothing is eligible", async () => {
      const pruner = new ContextPruner({
        config: config({ ...highThreshold, keepRecent: 5, notify: true }),
        scorer: scorerReturning({}),
      });
      pruner.requestManualPrune("session-a");

      const result = await pruner.prune(twoToolRequest, {
        sessionId: "session-a",
      });

      expect(result.reason).toBe("no-candidates");
      expect(result.notice).toMatch(/no eligible tool results/);
      expect(JSON.stringify(result.request.messages.at(-1))).toContain(
        "no eligible tool results",
      );
    });
  });

  test("uses the latest non-tool user text as the goal", async () => {
    const observed = {
      goals: [] as string[],
      batches: [] as ToolCandidate[][],
    };
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.9, "call-new": 0.9 }, observed),
    });

    await pruner.prune(twoToolRequest);

    expect(observed.goals).toEqual(["Keep going with the JWT fix."]);
  });

  test("fails open if a candidate score is missing", async () => {
    const pruner = new ContextPruner({
      config: config(),
      scorer: scorerReturning({ "call-old": 0.1 }),
    });

    const result = await pruner.prune(twoToolRequest);

    expect(result.request).toBe(twoToolRequest);
    expect(result.reason).toBe("fail-open");
  });

  test("does not cache partial drops from a failed scoring attempt", async () => {
    let attempt = 0;
    const batches: string[][] = [];
    const scorer: RelevanceScorer = {
      async score(_goal, candidates) {
        attempt += 1;
        batches.push(candidates.map((candidate) => candidate.toolUseId));
        if (attempt === 1) return new Map([["call-old", 0.1]]);
        return new Map(
          candidates.map((candidate) => [candidate.toolUseId, 0.9]),
        );
      },
    };
    const pruner = new ContextPruner({ config: config(), scorer });

    const failed = await pruner.prune(twoToolRequest);
    const recovered = await pruner.prune(twoToolRequest);

    expect(failed.reason).toBe("fail-open");
    expect(recovered.request).toBe(twoToolRequest);
    expect(allToolUseIds(recovered.request)).toEqual(["call-old", "call-new"]);
    expect(batches).toEqual([
      ["call-old", "call-new"],
      ["call-old", "call-new"],
    ]);
  });

  test("debug logging emits decision metadata without tool content", async () => {
    const events: Array<{
      message: string;
      metadata: Record<string, unknown> | undefined;
    }> = [];
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug(message: string, metadata?: Record<string, unknown>) {
        events.push({ message, metadata });
      },
    };
    const pruner = new ContextPruner({
      config: config({ debug: true }),
      scorer: scorerReturning({ "call-old": 0.1, "call-new": 0.9 }),
      logger,
    });

    await pruner.prune(twoToolRequest);

    expect(events).toEqual([
      {
        message: "prune_decision",
        metadata: {
          toolName: "read_file",
          toolUseId: "call-old",
          relevance: 0.1,
          cutoff: 0.5,
          outcome: "drop",
        },
      },
      {
        message: "prune_decision",
        metadata: {
          toolName: "read_file",
          toolUseId: "call-new",
          relevance: 0.9,
          cutoff: 0.5,
          outcome: "keep",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("old.log");
    expect(JSON.stringify(events)).not.toContain("stale output");
  });
});

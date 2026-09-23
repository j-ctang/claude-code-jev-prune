import type { Config } from "../src/config.js";
import { PruneError } from "../src/errors.js";
import { ContextPruner } from "../src/services/contextPruner.js";
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

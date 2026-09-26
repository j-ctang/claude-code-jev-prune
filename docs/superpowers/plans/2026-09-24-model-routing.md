# Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route hard prompts to a stronger configured model and route the conversation back to the default model at the next easy, unrelated task.

**Architecture:** A new `ModelRouter` runs in the proxy on every `POST /v1/messages`. On a new user turn it asks Jev two `noul` questions ("hard?" and "continues the current task?") and applies a policy table. Tool-loop requests reuse the conversation's model. The proxy rewrites only `body.model`, appends the router's notice, and resends on the original model if the upstream rejects the hard model.

**Tech Stack:** TypeScript (ESM), Express, Jest + supertest, TypeSafe Jev `/v1/systemone`.

**Spec:** `docs/superpowers/specs/2026-09-24-model-routing-design.md`

## Global Constraints

- Only `model` changes. Never touch `effort`, `thinking`, `tool_choice`, or other parameters.
- Route only requests whose `model` equals `JEV_ROUTE_DEFAULT_MODEL` and whose `tool_choice` is absent or `{ "type": "auto" }`.
- Decide only on a new user turn. Tool-loop requests reuse the conversation's current model.
- Defaults: `JEV_ROUTE_DEFAULT_MODEL=claude-opus-5-5`, `JEV_ROUTE_HARD_MODEL=claude-fable-5-1`, `JEV_ROUTE_UP_THRESHOLD=0.7`, `JEV_ROUTE_DOWN_THRESHOLD=0.4`. The continues cut-off is `0.5`.
- Route mode is saved in `${statePath}.route-mode.json` as `ask` / `auto` / `off`, starting at `ask`.
- Jev failure keeps the current model (log `route_fail_open`). Routing never fails a request.
- Upstream 400, 403, or 404 on a routed request: resend on the original model, mark the conversation unavailable, add a notice.
- Every notice for Claude goes through `appendNotice` in `proxy.ts`, and only when `config.notify` is true.
- Commit messages: bullet points only, each under 8 words, no Claude attribution line.

## Review Focus

1. **A real 400 that has nothing to do with the model** (for example "prompt is too long") on a routed request. Expected: one retry on the default model, and that response goes to the client unchanged. The conversation is marked unavailable, which is the safe side. Test in Task 5.
2. **Claude Code compaction replaces the first user message.** Expected: the conversation gets a new key and starts on the default model. It never errors. Test in Task 4 ("new first message starts a new conversation").
3. **`/jev-route-auto` typed with no pending hard prompt.** Expected: mode saves `auto`, and the conversation doesn't switch up on the command itself. Test in Task 4.
4. **Jev returns an answer with a missing key.** Expected: `ask()` throws, the router logs `route_fail_open`, and the model stays. Tests in Task 1 and Task 4.
5. **A subagent in the same session** with the same model. Expected: separate routing state, because its first user message differs. Test in Task 4.

---

### Task 0: Verification spike (throwaway, never committed)

This task answers the spec's "Step 1: verification" questions. Every code change here is temporary and must be discarded. **Stop after Step 5 and report the findings to the user before starting Task 1.**

**Files:**
- Modify temporarily: `src/middleware/proxy.ts`

- [ ] **Step 1: Log the request shape**

In `forward()` in `src/middleware/proxy.ts`, right after `const sessionId = request.get(SESSION_HEADER);`, add:

```ts
    dependencies.logger.info("debug_request_shape", {
      model: body.model,
      toolChoice: body.tool_choice,
      thinking: body.thinking,
      beta: request.get("anthropic-beta"),
      sessionId,
      firstUser: JSON.stringify(
        body.messages.find((message) => message.role === "user")?.content,
      )?.slice(0, 80),
    });
```

- [ ] **Step 2: Report input transformations**

In the same file, add `import { Transform } from "node:stream";`. Before `await pipeline(stream, tap, response);`, add:

```ts
    const peek = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const text = chunk.toString("utf8");
        if (text.includes("input_transformations")) {
          dependencies.logger.warn("debug_input_transformations", {
            text: text.slice(0, 2000),
          });
        }
        done(null, chunk);
      },
    });
```

Change the pipeline to `await pipeline(stream, peek, tap, response);`.

Before `const headers = requestHeaders(request);`, opt the request into the history-editing check without failing it:

```ts
  if (isAnthropicRequest(body) && typeof body.thinking === "object") {
    body = {
      ...body,
      thinking: {
        ...(body.thinking as Record<string, unknown>),
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      },
    };
  }
```

After `const headers = requestHeaders(request);`, add:

```ts
  const beta = headers.get("anthropic-beta");
  headers.set(
    "anthropic-beta",
    beta
      ? `${beta},thinking-binding-controls-2026-08-01`
      : "thinking-binding-controls-2026-08-01",
  );
```

- [ ] **Step 3: Run a real session**

Run: `npm run build && jev-prune` (on Opus 5.5).

In Claude Code:
1. Ask for a task that makes about 8 tool calls (for example "read every file in src/services and summarize each").
2. Ask Claude to use the Explore subagent for a search.
3. Run `/jev-prune`.
4. Send "continue".

Then run: `grep -E "debug_request_shape|debug_input_transformations" ~/.claude/jev-prune.log | tail -40`

- [ ] **Step 4: Record answers**

Write down:
- The exact `model` strings. Do they match `claude-opus-5-5`, or carry a suffix?
- Whether any request has a `tool_choice` other than `auto`.
- Whether subagent requests share the main `sessionId`, and whether their `firstUser` differs.
- Whether any `input_transformations` entry names `prefix_binding_mismatch`, after `/jev-prune` or after a notice.
- Whether Claude Code or the API rejected the extra beta header. If it did, record the error; the preserved-thinking question is then unanswered.

- [ ] **Step 5: Discard the spike and report**

Run: `git checkout -- src/middleware/proxy.ts && git status --short`
Expected: no changes under `src/`.

Report the Step 4 answers to the user. If any `prefix_binding_mismatch` appeared, stop: pruning needs its own spec before routing. If model strings carry a suffix, update `eligible()` in Task 4 to compare with the suffix stripped. Otherwise continue with Task 1.

---

### Task 1: Generic Jev questions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/services/jevService.ts`
- Test: `test/jevService.test.ts`

**Interfaces:**
- Produces:
  - `interface NoulQuestion { instructions: string; criteria: { true: string; false: string } }` in `src/types.ts`
  - `interface NoulAsker { ask(state: Record<string, unknown>, questions: Readonly<Record<string, NoulQuestion>>): Promise<ReadonlyMap<string, number>> }` in `src/types.ts`
  - `JevService` implements `NoulAsker`. `ask()` throws `PruneError` on HTTP failure or any invalid or missing answer.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("JevService", ...)` in `test/jevService.test.ts`:

```ts
  test("asks named noul questions about any state", async () => {
    const captured: CapturedRequest[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      captured.push({ url: String(input), init });
      return responseForBatch(String(init?.body));
    };
    const hard = {
      instructions: "Is it hard?",
      criteria: { true: "Hard.", false: "Easy." },
    };
    const continues = {
      instructions: "Does it continue?",
      criteria: { true: "Continues.", false: "New task." },
    };

    const answers = await createService(fetchFn).ask(
      { newest_request: "Fix it" },
      { hard, continues },
    );

    expect(answers).toEqual(
      new Map([
        ["hard", 0.91],
        ["continues", 0.08],
      ]),
    );
    expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({
      model: "jev-latest",
      state: { newest_request: "Fix it" },
      questions: {
        hard: { type: "noul", ...hard },
        continues: { type: "noul", ...continues },
      },
    });
  });

  test("ask rejects an invalid or missing answer", async () => {
    const question = {
      instructions: "Is it hard?",
      criteria: { true: "Hard.", false: "Easy." },
    };
    const invalid: typeof fetch = async () =>
      Response.json({ answers: { hard: { type: "noul", noul: 2 } } });
    const missing: typeof fetch = async () => Response.json({ answers: {} });

    await expect(
      createService(invalid).ask({}, { hard: question }),
    ).rejects.toThrow("TypeSafe returned an invalid answer for hard");
    await expect(
      createService(missing).ask({}, { hard: question }),
    ).rejects.toThrow("TypeSafe returned an invalid answer for hard");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/jevService.test.ts`
Expected: FAIL. TypeScript reports `Property 'ask' does not exist on type 'JevService'`.

- [ ] **Step 3: Add the types**

Append to `src/types.ts`:

```ts
/** One yes/no question for Jev; the answer is the probability of "true". */
export interface NoulQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

export interface NoulAsker {
  ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, NoulQuestion>>,
  ): Promise<ReadonlyMap<string, number>>;
}
```

- [ ] **Step 4: Implement `ask` and rebuild `scoreBatch` on it**

In `src/services/jevService.ts`:

Change the import to:

```ts
import type {
  NoulAsker,
  NoulQuestion,
  RelevanceScorer,
  ToolCandidate,
} from "../types.js";
```

Change the class line to `export class JevService implements RelevanceScorer, NoulAsker {`.

Replace the whole `scoreBatch` method with these two methods:

```ts
  /** Sends named noul questions about `state` and returns each answer by name. */
  async ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, NoulQuestion>>,
  ): Promise<ReadonlyMap<string, number>> {
    const keys = Object.keys(questions);
    if (keys.length > MAX_QUESTIONS_PER_REQUEST) {
      throw new PruneError(
        `TypeSafe accepts at most ${MAX_QUESTIONS_PER_REQUEST} questions per request`,
      );
    }
    const body = {
      model: this.model,
      state,
      questions: Object.fromEntries(
        keys.map((key) => [key, { type: "noul", ...questions[key] }]),
      ),
    };

    const response = await this.fetchFn(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new PruneError(`TypeSafe request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    const answers = this.readAnswers(payload);
    const scores = new Map<string, number>();
    for (const key of keys) {
      const answer = answers[key];
      if (!this.isNoulAnswer(answer)) {
        throw new PruneError(`TypeSafe returned an invalid answer for ${key}`);
      }
      scores.set(key, answer.noul);
    }
    return scores;
  }

  private async scoreBatch(
    goal: string,
    batch: readonly ToolCandidate[],
  ): Promise<ReadonlyMap<string, number>> {
    const answers = await this.ask(
      {
        current_goal: goal,
        candidates: batch.map((candidate, index) => ({
          key: `candidate_${index}`,
          tool_use_id: candidate.toolUseId,
          tool_name: candidate.toolName,
          input: candidate.input,
          result: candidate.result,
        })),
      },
      Object.fromEntries(
        batch.map((_candidate, index) => [
          `candidate_${index}`,
          {
            instructions: `Is candidates[${index}] still needed to complete current_goal?`,
            criteria: {
              true: "The current task depends on this tool input or result.",
              false:
                "The tool call is stale, superseded, exploratory, or unrelated to the current task.",
            },
          },
        ]),
      ),
    );
    const scores = new Map<string, number>();
    for (const [index, candidate] of batch.entries()) {
      const score = answers.get(`candidate_${index}`);
      if (score !== undefined) scores.set(candidate.toolUseId, score);
    }
    return scores;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest test/jevService.test.ts`
Expected: PASS, including every existing `score()` test.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/services/jevService.ts test/jevService.test.ts
git commit -m "- Add generic Jev noul questions
- Build tool scoring on ask"
```

---

### Task 2: Previous goal on the turn

**Files:**
- Modify: `src/services/turn.ts`
- Test: `test/turn.test.ts`

**Interfaces:**
- Produces: `Turn.previousGoal?: string`. It is the nonempty user text before `goal`, set only when `newUserTurn` is true.

- [ ] **Step 1: Write the failing tests**

In `test/turn.test.ts`, change the expectation in "reads a new user turn after hook system messages" to:

```ts
    expect(turn).toEqual({
      newUserTurn: true,
      goal: "Now billing.",
      previousGoal: "Fix auth.",
      lastReply: "Done.",
    });
```

Add inside `describe("readTurn", ...)`:

```ts
  test("previous goal is set only on a new user turn", () => {
    expect(
      readTurn({ messages: [{ role: "user", content: "Fix auth." }] })
        .previousGoal,
    ).toBeUndefined();
    expect(
      readTurn({
        messages: [
          { role: "user", content: "Fix auth." },
          { role: "assistant", content: "Done." },
          { role: "user", content: "Now billing." },
          toolUse,
          toolResult,
        ],
      }).previousGoal,
    ).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/turn.test.ts`
Expected: FAIL. The first test is missing `previousGoal: "Fix auth."`.

- [ ] **Step 3: Implement**

In `src/services/turn.ts`, add to `interface Turn` after `goal`:

```ts
  /** The user text before `goal`; set only on a new user turn. */
  previousGoal?: string;
```

In `readTurn`, replace everything from `const turn: Turn = { newUserTurn, goal: FALLBACK_GOAL };` through `if (!newUserTurn || !current) return turn;` with:

```ts
  const texts: string[] = [];
  for (
    let index = request.messages.length - 1;
    index >= 0 && texts.length < 2;
    index -= 1
  ) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    const text = messageText(message).trim();
    if (text) texts.push(text);
  }
  const turn: Turn = { newUserTurn, goal: texts[0] ?? FALLBACK_GOAL };
  if (!newUserTurn || !current) return turn;
  if (texts[1]) turn.previousGoal = texts[1];
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. If a `contextPruner` or `canary` test compares a whole `Turn` with `toEqual`, add the matching `previousGoal` to that expectation.

- [ ] **Step 5: Commit**

```bash
git add src/services/turn.ts test/turn.test.ts
git commit -m "- Read previous user goal on turns"
```

---

### Task 3: Routing settings and saved mode

**Files:**
- Modify: `src/config.ts`
- Create: `src/services/routeMode.ts`
- Modify: `test/proxy.test.ts` (the `testConfig` literal)
- Modify: `test/contextPruner.test.ts` (its `Config` literal)
- Modify: `.env.example`
- Test: `test/config.test.ts`, `test/routeMode.test.ts`

**Interfaces:**
- Produces:
  - `Config.routeDefaultModel: string`, `Config.routeHardModel: string`, `Config.routeUpThreshold: number`, `Config.routeDownThreshold: number`
  - `type RouteChoice = "ask" | "auto" | "off"`
  - `routeModePath(statePath: string): string`
  - `class RouteMode { choice: RouteChoice; constructor(path: string); set(choice: "auto" | "off"): void }`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("loadConfig", ...)` in `test/config.test.ts`:

```ts
  test("loads model routing defaults and overrides", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "secret" })).toMatchObject({
      routeDefaultModel: "claude-opus-5-5",
      routeHardModel: "claude-fable-5-1",
      routeUpThreshold: 0.7,
      routeDownThreshold: 0.4,
    });
    expect(
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        JEV_ROUTE_DEFAULT_MODEL: "claude-sonnet-5",
        JEV_ROUTE_HARD_MODEL: "claude-opus-5-5",
        JEV_ROUTE_UP_THRESHOLD: "0.8",
        JEV_ROUTE_DOWN_THRESHOLD: "0.3",
      }),
    ).toMatchObject({
      routeDefaultModel: "claude-sonnet-5",
      routeHardModel: "claude-opus-5-5",
      routeUpThreshold: 0.8,
      routeDownThreshold: 0.3,
    });
  });

  test("rejects invalid model routing settings", () => {
    const load = (env: Record<string, string>) => () =>
      loadConfig({ TYPESAFE_API_KEY: "secret", ...env });

    expect(load({ JEV_ROUTE_UP_THRESHOLD: "1.5" })).toThrow(
      "JEV_ROUTE_UP_THRESHOLD must be a number between 0 and 1",
    );
    expect(load({ JEV_ROUTE_DOWN_THRESHOLD: "0.7" })).toThrow(
      "JEV_ROUTE_DOWN_THRESHOLD must be less than JEV_ROUTE_UP_THRESHOLD",
    );
    expect(load({ JEV_ROUTE_HARD_MODEL: "claude-opus-5-5" })).toThrow(
      "JEV_ROUTE_HARD_MODEL must differ from JEV_ROUTE_DEFAULT_MODEL",
    );
  });
```

Create `test/routeMode.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteMode, routeModePath } from "../src/services/routeMode.js";

test("starts at ask and remembers the answer across restarts", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "jev-route-")), "mode.json");
  const first = new RouteMode(path);
  expect(first.choice).toBe("ask");
  first.set("auto");
  expect(new RouteMode(path).choice).toBe("auto");
  first.set("off");
  expect(new RouteMode(path).choice).toBe("off");
});

test("is saved next to the pruning state", () => {
  expect(routeModePath("/x/state.json")).toBe("/x/state.json.route-mode.json");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/config.test.ts test/routeMode.test.ts`
Expected: FAIL. `routeDefaultModel` is undefined, and `Cannot find module '../src/services/routeMode.js'`.

- [ ] **Step 3: Implement config**

In `src/config.ts`, add to `interface Config` after `jevTimeoutMs: number;`:

```ts
  routeDefaultModel: string;
  routeHardModel: string;
  routeUpThreshold: number;
  routeDownThreshold: number;
```

Add after `parseInteger`:

```ts
function parseProbability(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
}
```

In `loadConfig`, before `const jevApiKey = ...`, add:

```ts
  const routeUpThreshold = parseProbability(
    env.JEV_ROUTE_UP_THRESHOLD ?? "0.7",
    "JEV_ROUTE_UP_THRESHOLD",
  );
  const routeDownThreshold = parseProbability(
    env.JEV_ROUTE_DOWN_THRESHOLD ?? "0.4",
    "JEV_ROUTE_DOWN_THRESHOLD",
  );
  if (routeDownThreshold >= routeUpThreshold) {
    throw new Error(
      "JEV_ROUTE_DOWN_THRESHOLD must be less than JEV_ROUTE_UP_THRESHOLD",
    );
  }
  const routeDefaultModel =
    env.JEV_ROUTE_DEFAULT_MODEL?.trim() || "claude-opus-5-5";
  const routeHardModel = env.JEV_ROUTE_HARD_MODEL?.trim() || "claude-fable-5-1";
  if (routeDefaultModel === routeHardModel) {
    throw new Error(
      "JEV_ROUTE_HARD_MODEL must differ from JEV_ROUTE_DEFAULT_MODEL",
    );
  }
```

In the returned object, after `jevTimeoutMs: parseInteger(...)`, add:

```ts
    routeDefaultModel,
    routeHardModel,
    routeUpThreshold,
    routeDownThreshold,
```

- [ ] **Step 4: Implement the saved mode**

Create `src/services/routeMode.ts`:

```ts
import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";

export type RouteChoice = "ask" | "auto" | "off";

/** Where the routing choice is saved, next to the pruning state. */
export function routeModePath(statePath: string): string {
  return `${statePath}.route-mode.json`;
}

/** The user's saved model routing choice; `ask` until they answer. */
export class RouteMode {
  choice: RouteChoice = "ask";

  constructor(private readonly path: string) {
    // A missing or malformed choice keeps `ask`.
    const saved = readJson(path);
    if (
      typeof saved === "object" &&
      saved !== null &&
      "choice" in saved &&
      (saved.choice === "auto" || saved.choice === "off")
    ) {
      this.choice = saved.choice;
    }
  }

  set(choice: "auto" | "off"): void {
    writeJsonAtomic(this.path, { choice });
    this.choice = choice;
  }
}
```

- [ ] **Step 5: Fix the test `Config` literals**

In `test/proxy.test.ts` `testConfig()` and in the `Config` literal in `test/contextPruner.test.ts`, add after `jevTimeoutMs: 2_000,`:

```ts
    routeDefaultModel: "claude-opus-5-5",
    routeHardModel: "claude-fable-5-1",
    routeUpThreshold: 0.7,
    routeDownThreshold: 0.4,
```

- [ ] **Step 6: Document the settings**

In `.env.example`, after `JEV_TIMEOUT_MS=2000`, add:

```
JEV_ROUTE_DEFAULT_MODEL=claude-opus-5-5
JEV_ROUTE_HARD_MODEL=claude-fable-5-1
JEV_ROUTE_UP_THRESHOLD=0.7
JEV_ROUTE_DOWN_THRESHOLD=0.4
```

- [ ] **Step 7: Run the full check**

Run: `npm run check`
Expected: lint, build, and every test pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/services/routeMode.ts test/config.test.ts test/routeMode.test.ts test/proxy.test.ts test/contextPruner.test.ts .env.example
git commit -m "- Add model routing settings
- Save routing mode choice"
```

---

### Task 4: Model router

**Files:**
- Create: `src/services/modelRouter.ts`
- Test: `test/modelRouter.test.ts`

**Interfaces:**
- Consumes: `NoulAsker`, `NoulQuestion` (Task 1). `readTurn` and `Turn.previousGoal` (Task 2). `Config.route*` and `RouteMode` (Task 3).
- Produces:
  - `interface RouteDecision { model?: string; notice?: string; conversation?: string }`. `model` is set only when it differs from the request's model.
  - `class ModelRouter { constructor(config: RouterConfig, asker: NoulAsker, mode: RouteMode, logger: AppLogger); route(request: AnthropicRequest, sessionId?: string): Promise<RouteDecision>; markUnavailable(conversation: string): string }`. `markUnavailable` returns the notice for Claude.
  - `conversationKey(request: AnthropicRequest, sessionId?: string): string`

- [ ] **Step 1: Write the failing tests**

Create `test/modelRouter.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationKey,
  ModelRouter,
} from "../src/services/modelRouter.js";
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
    const next = await subject.route(turn(["Redesign auth", "Redesign billing"]), "s");

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
    const next = await subject.route(turn(["Redesign auth", "Redesign billing"]), "s");

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/modelRouter.test.ts`
Expected: FAIL with `Cannot find module '../src/services/modelRouter.js'`.

- [ ] **Step 3: Implement the router**

Create `src/services/modelRouter.ts`:

```ts
import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { AnthropicRequest, NoulAsker, NoulQuestion } from "../types.js";
import type { AppLogger } from "../utils/logger.js";
import type { RouteMode } from "./routeMode.js";
import { readTurn, type Turn } from "./turn.js";

export interface RouteDecision {
  /** Model to send upstream; set only when it differs from the request's. */
  model?: string;
  /** Text to show Claude on this request. */
  notice?: string;
  /** Conversation this decision belongs to, for markUnavailable. */
  conversation?: string;
}

type RouterConfig = Pick<
  Config,
  | "routeDefaultModel"
  | "routeHardModel"
  | "routeUpThreshold"
  | "routeDownThreshold"
  | "notify"
>;

interface ConversationState {
  model: string;
  /** The hard model was rejected upstream; never route again. */
  unavailable: boolean;
  /** Claude was told to ask the user about routing for this prompt. */
  askedHard: boolean;
}

const MAX_CONVERSATIONS = 500;
const MAX_REPLY_CHARS = 4_000;
const CONTINUES_THRESHOLD = 0.5;

const QUESTIONS: Record<"hard" | "continues", NoulQuestion> = {
  hard: {
    instructions:
      "Does newest_request need deep, multi-step reasoning to do well?",
    criteria: {
      true: "The request needs careful design, debugging, or reasoning across many steps or files.",
      false: "The request is simple, routine, or a quick question.",
    },
  },
  continues: {
    instructions:
      "Is newest_request a follow-up that depends on the work in previous_request and last_reply?",
    criteria: {
      true: "The request continues or builds on the work just done.",
      false: "The request starts a new, unrelated task.",
    },
  },
};

const AUTO_ON_NOTICE =
  "[jev-prune] Automatic model routing is on. Tell the user in one short line.";
const OFF_NOTICE =
  "[jev-prune] Automatic model routing is off. Tell the user in one short line. If you paused a request to ask about routing, continue it now.";
const SAVE_FAILED_NOTICE =
  "[jev-prune] Could not save the model routing setting.";

/** A subagent shares its parent's session header but not its first message. */
export function conversationKey(
  request: AnthropicRequest,
  sessionId?: string,
): string {
  const first = request.messages.find((message) => message.role === "user");
  const digest = createHash("sha256")
    .update(JSON.stringify(first?.content ?? ""))
    .digest("hex")
    .slice(0, 16);
  return `${sessionId ?? "no-session"}:${digest}`;
}

/**
 * Moves a conversation to the hard model on hard prompts and back to the
 * default model at the next easy, unrelated task. Decides only when the user
 * speaks, so the model never changes inside a tool loop.
 */
export class ModelRouter {
  private readonly conversations = new Map<string, ConversationState>();

  constructor(
    private readonly config: RouterConfig,
    private readonly asker: NoulAsker,
    private readonly mode: RouteMode,
    private readonly logger: AppLogger,
  ) {}

  async route(
    request: AnthropicRequest,
    sessionId?: string,
  ): Promise<RouteDecision> {
    const turn = readTurn(request);
    const commandNotice = this.applyCommand(turn.command);
    if (this.mode.choice === "off" || !this.eligible(request)) {
      return commandNotice ? { notice: commandNotice } : {};
    }
    const conversation = conversationKey(request, sessionId);
    const state = this.stateFor(conversation);
    if (state.unavailable) return this.decision(conversation, state, commandNotice);

    if (turn.command === "jev-route-auto" && state.askedHard) {
      state.askedHard = false;
      this.switchTo(state, conversation, this.config.routeHardModel, "opt-in");
      return this.decision(
        conversation,
        state,
        `[jev-prune] Automatic model routing is on. This conversation now uses ${this.config.routeHardModel}. Tell the user in one short line, then continue their previous request.`,
      );
    }
    if (turn.newUserTurn && !turn.command) {
      return this.decision(conversation, state, await this.decide(turn, state, conversation));
    }
    return this.decision(conversation, state, commandNotice);
  }

  /** Stops routing a conversation whose hard model the upstream rejected. */
  markUnavailable(conversation: string): string {
    const state = this.stateFor(conversation);
    state.model = this.config.routeDefaultModel;
    state.unavailable = true;
    return `[jev-prune] ${this.config.routeHardModel} is not available on this account. Staying on ${this.config.routeDefaultModel}. Tell the user in one short line.`;
  }

  private async decide(
    turn: Turn,
    state: ConversationState,
    conversation: string,
  ): Promise<string | undefined> {
    let scores: ReadonlyMap<string, number>;
    try {
      scores = await this.asker.ask(
        {
          newest_request: turn.goal,
          previous_request: turn.previousGoal ?? "",
          last_reply: (turn.lastReply ?? "").slice(-MAX_REPLY_CHARS),
        },
        QUESTIONS,
      );
    } catch (error) {
      this.logger.warn("route_fail_open", {
        error: error instanceof Error ? error.message : "unknown error",
      });
      return undefined;
    }
    const hard = scores.get("hard") ?? 0;
    const continues = scores.get("continues") ?? 0;
    const up = state.model === this.config.routeHardModel;

    if (!up && hard >= this.config.routeUpThreshold) {
      if (this.mode.choice === "ask") {
        if (!this.config.notify) return undefined;
        state.askedHard = true;
        return `[jev-prune] This prompt looks hard. Do not start it yet. In one short line, tell the user that jev-prune can move hard prompts to ${this.config.routeHardModel} automatically, and ask them to run /jev-route-auto to turn it on or /jev-route-off to keep the current model.`;
      }
      this.switchTo(state, conversation, this.config.routeHardModel, "hard", hard, continues);
      return `[jev-prune] Switched this conversation to ${this.config.routeHardModel} for a hard prompt. Tell the user in one short line.`;
    }
    if (
      up &&
      continues < CONTINUES_THRESHOLD &&
      hard <= this.config.routeDownThreshold
    ) {
      this.switchTo(state, conversation, this.config.routeDefaultModel, "new-easy-task", hard, continues);
      return `[jev-prune] Switched this conversation back to ${this.config.routeDefaultModel} for a new, simpler task. Tell the user in one short line.`;
    }
    return undefined;
  }

  private switchTo(
    state: ConversationState,
    conversation: string,
    model: string,
    reason: string,
    hard?: number,
    continues?: number,
  ): void {
    this.logger.info("model_route", {
      conversation,
      from: state.model,
      to: model,
      reason,
      ...(hard === undefined ? {} : { hard }),
      ...(continues === undefined ? {} : { continues }),
    });
    state.model = model;
  }

  private applyCommand(command: string | undefined): string | undefined {
    if (command !== "jev-route-auto" && command !== "jev-route-off") {
      return undefined;
    }
    const choice = command === "jev-route-auto" ? "auto" : "off";
    try {
      this.mode.set(choice);
    } catch (error) {
      this.logger.warn("route_mode_save_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      });
      return SAVE_FAILED_NOTICE;
    }
    return choice === "auto" ? AUTO_ON_NOTICE : OFF_NOTICE;
  }

  private eligible(request: AnthropicRequest): boolean {
    const choice = request.tool_choice;
    const autoChoice =
      choice === undefined ||
      (typeof choice === "object" &&
        choice !== null &&
        "type" in choice &&
        choice.type === "auto");
    return request.model === this.config.routeDefaultModel && autoChoice;
  }

  private stateFor(conversation: string): ConversationState {
    let state = this.conversations.get(conversation);
    if (!state) {
      state = {
        model: this.config.routeDefaultModel,
        unavailable: false,
        askedHard: false,
      };
      this.conversations.set(conversation, state);
      if (this.conversations.size > MAX_CONVERSATIONS) {
        const oldest = this.conversations.keys().next().value;
        if (oldest !== undefined) this.conversations.delete(oldest);
      }
    }
    return state;
  }

  private decision(
    conversation: string,
    state: ConversationState,
    notice: string | undefined,
  ): RouteDecision {
    return {
      conversation,
      ...(state.model === this.config.routeDefaultModel
        ? {}
        : { model: state.model }),
      ...(notice ? { notice } : {}),
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/modelRouter.test.ts`
Expected: PASS.

Check one case by hand: in "/jev-route-off stops routing", the first request returns only `{ notice }`, because the mode is `off` by the time eligibility is checked.

- [ ] **Step 5: Lint and format**

Run: `npx prettier --write src/services/modelRouter.ts test/modelRouter.test.ts && npm run lint`
Expected: no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/modelRouter.ts test/modelRouter.test.ts
git commit -m "- Add per-conversation model router
- Ask once, then route automatically"
```

---

### Task 5: Proxy wiring and unavailable-model fallback

**Files:**
- Modify: `src/middleware/proxy.ts`
- Modify: `src/app.ts`
- Modify: `src/index.ts`
- Test: `test/proxy.test.ts`

**Interfaces:**
- Consumes: `ModelRouter`, `RouteDecision` (Task 4). `RouteMode`, `routeModePath` (Task 3).
- Produces: `interface RequestRouter { route(request: AnthropicRequest, sessionId?: string): Promise<RouteDecision>; markUnavailable(conversation: string): string }`, and optional `router?: RequestRouter` on `ProxyDependencies` and on `createApp`'s dependencies.

- [ ] **Step 1: Write the failing tests**

In `test/proxy.test.ts`, add the import `import type { RequestRouter } from "../src/middleware/proxy.js";`, then add this helper after `appFor`:

```ts
function appWithRouter(upstreamUrl: string, router: RequestRouter) {
  const config = testConfig(upstreamUrl, {
    pruneThreshold: 1_000_000,
    notify: true,
  });
  const pruner = new ContextPruner({
    config,
    scorer: {
      async score() {
        return new Map();
      },
    },
  });
  return createApp({
    config,
    pruner,
    fetchFn: fetch,
    logger: silentLogger,
    startedAt: Date.now(),
    router,
  });
}

const hardRouter = (unavailable: string[] = []): RequestRouter => ({
  async route() {
    return {
      conversation: "s:abc",
      model: "claude-fable-5-1",
      notice: "[jev-prune] Switched.",
    };
  },
  markUnavailable(conversation) {
    unavailable.push(conversation);
    return "[jev-prune] Not available.";
  },
});

const routedRequest: AnthropicRequest = {
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: "Redesign auth" }],
};
```

Add inside `describe("Anthropic proxy", ...)`:

```ts
  test("sends the routed model and the router's notice", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });

    await request(appWithRouter(upstream.url, hardRouter()))
      .post("/v1/messages")
      .send(routedRequest);

    const sent = upstream.requests[0]?.body as AnthropicRequest;
    expect(sent.model).toBe("claude-fable-5-1");
    expect(JSON.stringify(sent.messages.at(-1))).toContain(
      "[jev-prune] Switched.",
    );
  });

  test("resends on the original model when the routed model is rejected", async () => {
    const upstream = await startUpstream((incoming, response) => {
      const model = (incoming.body as AnthropicRequest).model;
      response.writeHead(model === "claude-fable-5-1" ? 404 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ model }));
    });
    const unavailable: string[] = [];

    const response = await request(
      appWithRouter(upstream.url, hardRouter(unavailable)),
    )
      .post("/v1/messages")
      .send(routedRequest);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ model: "claude-opus-5-5" });
    expect(upstream.requests).toHaveLength(2);
    const retried = upstream.requests[1]?.body as AnthropicRequest;
    expect(retried.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(retried.messages.at(-1))).toContain(
      "[jev-prune] Not available.",
    );
    expect(JSON.stringify(retried.messages.at(-1))).not.toContain(
      "[jev-prune] Switched.",
    );
    expect(unavailable).toEqual(["s:abc"]);
  });

  test("returns the retry's error unchanged when the default model also fails", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "prompt is too long" }));
    });

    const response = await request(appWithRouter(upstream.url, hardRouter()))
      .post("/v1/messages")
      .send(routedRequest);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "prompt is too long" });
    expect(upstream.requests).toHaveLength(2);
  });

  test("does not retry a rejected request that was not routed", async () => {
    const upstream = await startUpstream((_incoming, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end("{}");
    });
    const router: RequestRouter = {
      async route() {
        return { conversation: "s:abc" };
      },
      markUnavailable: () => "",
    };

    await request(appWithRouter(upstream.url, router))
      .post("/v1/messages")
      .send(routedRequest);

    expect(upstream.requests).toHaveLength(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/proxy.test.ts`
Expected: FAIL. TypeScript reports that `RequestRouter` is not exported and that `router` is not a known property.

- [ ] **Step 3: Wire the router into the proxy**

In `src/middleware/proxy.ts`:

Add the import `import type { RouteDecision } from "../services/modelRouter.js";`.

After `interface RequestPruner { ... }`, add:

```ts
export interface RequestRouter {
  route(request: AnthropicRequest, sessionId?: string): Promise<RouteDecision>;
  markUnavailable(conversation: string): string;
}

/** Upstream statuses that mean the routed model can't serve this account. */
const ROUTE_UNAVAILABLE_STATUSES = new Set([400, 403, 404]);
```

Add `router?: RequestRouter;` to `ProxyDependencies`.

In `forward()`, after `let body = request.body as unknown;`, add:

```ts
  // Set only when the router changed the model: builds the request to resend
  // on the original model if the upstream rejects the routed one.
  let fallback:
    | {
        conversation: string;
        body: (notice: string | undefined) => AnthropicRequest;
      }
    | undefined;
```

Replace this block:

```ts
    // Every notice for Claude is added here, and only when notices are on.
    const notices = [result.notice, canary.notice].filter(
      (notice): notice is string => notice !== undefined,
    );
    body = dependencies.config.notify
      ? notices.reduce(appendNotice, result.request)
      : result.request;
```

with:

```ts
    const route: RouteDecision = dependencies.router
      ? await dependencies.router.route(body, sessionId)
      : {};
    // Every notice for Claude is added here, and only when notices are on.
    const withNotices = (notices: Array<string | undefined>) =>
      dependencies.config.notify
        ? notices
            .filter((notice): notice is string => notice !== undefined)
            .reduce(appendNotice, result.request)
        : result.request;
    const prepared = withNotices([result.notice, canary.notice, route.notice]);
    body = route.model ? { ...prepared, model: route.model } : prepared;
    if (route.model && route.conversation) {
      fallback = {
        conversation: route.conversation,
        body: (notice) => withNotices([result.notice, canary.notice, notice]),
      };
    }
```

Replace everything from `const headers = requestHeaders(request);` down to and including the `catch` block that returns 502 with:

```ts
  const headers = requestHeaders(request);
  const canHaveBody = request.method !== "GET" && request.method !== "HEAD";
  const send = (payload: unknown) => {
    const serializedBody =
      canHaveBody && payload !== undefined ? JSON.stringify(payload) : undefined;
    if (serializedBody !== undefined) {
      headers.set("content-type", "application/json");
    }
    return dependencies.fetchFn(
      `${dependencies.config.anthropicUpstreamUrl}${request.originalUrl}`,
      {
        method: request.method,
        headers,
        ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        ...(dependencies.upstreamSignal
          ? { signal: dependencies.upstreamSignal }
          : {}),
      },
    );
  };

  let upstream: globalThis.Response;
  try {
    upstream = await send(body);
    if (fallback && ROUTE_UNAVAILABLE_STATUSES.has(upstream.status)) {
      await upstream.body?.cancel();
      dependencies.logger.warn("route_model_unavailable", {
        status: upstream.status,
        model: (body as AnthropicRequest).model,
      });
      upstream = await send(
        fallback.body(
          dependencies.router?.markUnavailable(fallback.conversation),
        ),
      );
    }
  } catch (error) {
    dependencies.logger.error("anthropic_upstream_unavailable", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    response.status(502).json({ error: "Anthropic upstream unavailable" });
    return;
  }
```

`markUnavailable` runs only when a retry really happens. The retry body is the pruned request with the original model and the "not available" notice, without the "switched" notice.

- [ ] **Step 4: Pass the router through the app**

In `src/app.ts`, add `router?: ProxyDependencies["router"];` to `AppDependencies`. In the `createProxyHandler({...})` call, add after `stats,`:

```ts
      ...(dependencies.router ? { router: dependencies.router } : {}),
```

- [ ] **Step 5: Build the router at startup**

In `src/index.ts`, add the imports:

```ts
import { ModelRouter } from "./services/modelRouter.js";
import { RouteMode, routeModePath } from "./services/routeMode.js";
```

After the `pruner` is created in `start()`, add:

```ts
  // Routing needs Jev; without a key every request keeps its model.
  const router = config.jevApiKey
    ? new ModelRouter(
        config,
        scorer,
        new RouteMode(routeModePath(config.statePath)),
        logger,
      )
    : undefined;
```

In the `createApp({...})` call, add after `upstreamSignal: upstreamAbort.signal,`:

```ts
    ...(router ? { router } : {}),
```

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: lint, build, and every test pass, including the existing proxy tests (no router means `route` is `{}` and behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/middleware/proxy.ts src/app.ts src/index.ts test/proxy.test.ts
git commit -m "- Route model in proxy
- Resend on default when rejected"
```

---

### Task 6: Slash commands and docs

**Files:**
- Create: `commands/jev-route-auto.md`, `commands/jev-route-off.md`
- Modify: `src/installation.ts`
- Modify: `README.md`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: the command names `jev-route-auto` and `jev-route-off` (Task 4).

- [ ] **Step 1: Add the command files**

Create `commands/jev-route-auto.md`:

```markdown
---
description: Route hard prompts to a stronger model automatically (jev-prune proxy)
---

The jev-prune proxy recognizes this command and saves automatic model routing. Follow the `[jev-prune]` notice attached to this message. If no notice is attached, say the jev-prune proxy is not running or routing is not configured.
```

Create `commands/jev-route-off.md`:

```markdown
---
description: Stop routing prompts to a different model (jev-prune proxy)
---

The jev-prune proxy recognizes this command and turns model routing off. Follow the `[jev-prune]` notice attached to this message. If no notice is attached, say the jev-prune proxy is not running or routing is not configured.
```

- [ ] **Step 2: Install them**

In `src/installation.ts`, change `slashCommands` to:

```ts
export const slashCommands = [
  "jev-prune.md",
  "jev-prune-auto.md",
  "jev-prune-auto-off.md",
  "jev-route-auto.md",
  "jev-route-off.md",
] as const;
```

- [ ] **Step 3: Document it in the README**

In `README.md`, add this section before `## Settings`:

```markdown
## Model routing

Jev Prune can answer hard prompts with a stronger model. The first time you send a hard prompt, Claude asks whether to turn this on. Type `/jev-route-auto` to turn it on, or `/jev-route-off` to keep your model. When routing is on, a hard prompt moves the conversation to the hard model, and the next easy, unrelated task moves it back. Claude tells you each time the model changes.

Only requests on `JEV_ROUTE_DEFAULT_MODEL` are routed, so a model you pick with `/model` is never changed. If your account can't use the hard model, Jev Prune stays on your model and tells you.
```

In the Settings table, add these rows after the `JEV_PRUNE_ENABLED` row:

```markdown
| `JEV_ROUTE_DEFAULT_MODEL` | `claude-opus-5-5` | Model for easy prompts; the only model that is routed |
| `JEV_ROUTE_HARD_MODEL` | `claude-fable-5-1` | Model for hard prompts |
```

- [ ] **Step 4: Document it in the architecture notes**

In `docs/ARCHITECTURE.md`, add these rows to the Component Ownership table after the `src/services/canary.ts` row:

```markdown
| `src/services/modelRouter.ts` | Decide per conversation whether to move a hard prompt to the hard model and back, and handle `/jev-route-*` commands. |
| `src/services/routeMode.ts` | Save the `ask` / `auto` / `off` routing choice. |
```

In the Request Flow diagram, add a line `├── route model` under `├── remove selected pairs`.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS. `test/bootstrap.test.ts` or the doctor may list slash commands. If a test pins the exact list, add the two new names to its expectation.

- [ ] **Step 6: Manual end-to-end check (no Fable credit needed)**

In `.env`, set:

```
JEV_ROUTE_DEFAULT_MODEL=claude-sonnet-5
JEV_ROUTE_HARD_MODEL=claude-opus-5-5
```

Run: `rm -f ~/.claude/jev-prune-state.json.route-mode.json && npm run build && jev-prune --model claude-sonnet-5`

1. Send "Design a migration plan to split src/services/contextPruner.ts into three modules, with risks". Expected: Claude asks about routing in one line.
2. Type `/jev-route-auto`. Expected: Claude says it switched to `claude-opus-5-5` and continues the plan.
3. Send "what is 2+2". Expected: Claude says it switched back to `claude-sonnet-5`.
4. Run `grep model_route ~/.claude/jev-prune.log | tail -5`. Expected: an `opt-in` entry and a `new-easy-task` entry.

Undo the `.env` change afterwards.

- [ ] **Step 7: Commit**

```bash
git add commands/jev-route-auto.md commands/jev-route-off.md src/installation.ts README.md docs/ARCHITECTURE.md
git commit -m "- Add route slash commands
- Document model routing"
```

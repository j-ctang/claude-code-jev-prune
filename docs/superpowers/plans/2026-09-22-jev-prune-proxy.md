# Jev Context-Pruning Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the documented local HTTP proxy that forwards Claude Code requests to Anthropic and uses TypeSafe Jev to remove stale, paired tool-use/tool-result blocks without rewriting retained content.

**Architecture:** A small Express application will validate configuration, estimate request size, identify structurally safe tool-call pairs, and batch relevance questions to TypeSafe's `POST /v1/systemone` endpoint. The proxy will prune only matched tool pairs, preserve recent or excluded tools, fail open on every Jev-side error, and stream Anthropic's response back to Claude Code. Core pruning and transport code will use injected interfaces so unit and integration tests never require real API keys.

**Tech Stack:** Node.js 20+, TypeScript 5, Express 4, built-in `fetch`, Winston, Jest, ts-jest, Supertest

**Spec:** `README.md`, `GETTING_STARTED.md`, and `CONVERSATION_SUMMARY.md`

## Global Constraints

- Retained message content must remain value-for-value unchanged; pruning may delete content blocks but must never summarize or rewrite them.
- Never remove system content, plain user text, plain assistant text, unmatched `tool_use` blocks, or unmatched `tool_result` blocks.
- Always preserve the most recent `JEV_PRUNE_KEEP_RECENT` matched tool calls and every tool named by `JEV_PRUNE_EXCLUDE_TOOLS`.
- Begin relevance evaluation at `JEV_PRUNE_THRESHOLD` estimated tokens; at or above `JEV_PRUNE_TRIGGER_TOKENS`, use the more aggressive confidence cutoff defined below.
- A TypeSafe timeout, non-2xx response, malformed response, missing answer, or internal pruning error must forward the original Anthropic request unchanged.
- Anthropic responses, including server-sent event streams and upstream error statuses, must be relayed without buffering the full response.
- Jev requests use `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, model `jev-latest`, and named `noul` questions.
- Use Node.js 20 or newer even though the current manifest says Node.js 18; this makes the built-in web-stream and `fetch` APIs the supported transport baseline.
- Do not describe this server as an MCP server or MCP plugin in code or revised documentation; it is an HTTP proxy.
- Never log API keys, authorization headers, full prompts, full tool results, or upstream response bodies.

---

## Repository Findings and Locked Decisions

The checkout currently contains only the three specification documents and `package.json`; none of the source files described as complete in `CONVERSATION_SUMMARY.md` exist. There is no existing implementation plan.

The documentation leaves several behaviors ambiguous. This plan resolves them as follows:

| Ambiguity | Implementation decision |
| --- | --- |
| "Byte-for-byte" preservation after parsing JSON | Preserve every retained JavaScript value exactly; JSON whitespace and object-key serialization are not guaranteed. |
| What can be dropped | A matched assistant `tool_use` content block and its user `tool_result` block, together. Empty messages created by removing blocks are also removed. |
| Jev score meaning | Each `noul` answer is the probability that the named tool call is still needed. Drop below `0.50` normally and below `0.70` at the trigger threshold. |
| Two token thresholds | `JEV_PRUNE_THRESHOLD` starts normal pruning; `JEV_PRUNE_TRIGGER_TOKENS` selects aggressive pruning. Neither value promises an absolute post-prune cap. |
| Decision caching | Cache only drop decisions by `tool_use.id`; kept candidates are re-evaluated because the current goal can change. |
| Current task signal | Send the latest non-tool user text plus compact metadata for each candidate in Jev's `state`. |
| Jev batching | Send at most 32 named questions per request and merge their answers. Any failed batch fails the entire prune operation open. |
| Token counting | Use a deterministic conservative estimate of `ceil(JSON.stringify(value).length / 4)`; log it as an estimate, never an exact provider count. |
| Unsupported request shapes | Forward unchanged if `messages` is absent, not an array, or contains malformed content blocks. |

## Target File Map

```text
.
├── .env.example                         # Safe configuration template
├── .eslintrc.cjs                        # Type-aware lint rules
├── .gitignore                           # Secrets, build output, dependencies, logs
├── package.json                         # Correct dependencies and verification scripts
├── tsconfig.json                        # Strict NodeNext TypeScript build
├── jest.config.cjs                      # ts-jest test configuration
├── src/
│   ├── index.ts                         # Process entry point and graceful shutdown
│   ├── app.ts                           # Express composition and route ownership
│   ├── config.ts                        # Environment parsing and validation
│   ├── types.ts                         # Anthropic, Jev, and pruning domain types
│   ├── middleware/
│   │   ├── health.ts                    # Health response from live dependencies/stats
│   │   └── proxy.ts                     # Anthropic forwarding and response streaming
│   ├── services/
│   │   ├── contextPruner.ts             # Candidate extraction and immutable filtering
│   │   └── jevService.ts                # TypeSafe batching and response validation
│   └── utils/
│       ├── logger.ts                     # Redacted structured logging
│       └── tokenCounter.ts               # Deterministic token estimate
├── test/
│   ├── fixtures/messages.ts              # Reusable valid Anthropic request fixtures
│   ├── config.test.ts                    # Defaults and invalid environment values
│   ├── tokenCounter.test.ts              # Estimate contract
│   ├── jevService.test.ts                # TypeSafe HTTP contract and failure modes
│   ├── contextPruner.test.ts             # Safety invariants and pruning policy
│   └── proxy.test.ts                     # End-to-end local proxy behavior and streaming
├── README.md                             # Accurate status, privacy, and proxy terminology
├── GETTING_STARTED.md                    # Verified install/run/health workflow
└── docs/
    └── ARCHITECTURE.md                   # Request flow, invariants, and failure model
```

### Task 1: Establish a Reproducible TypeScript and Test Baseline

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `jest.config.cjs`
- Create: `.eslintrc.cjs`
- Create: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: `npm run build`, `npm test`, `npm run lint`, and `npm run check` as the repository-wide verification commands.
- Produces: Node.js 20 as the supported runtime and ESM/NodeNext as the module format.

- [ ] **Step 1: Replace the inaccurate dependency set and add deterministic scripts**

Use Express and native `fetch`; remove the undocumented `typesafe`, `@anthropic-ai/sdk`, and `node-cache` dependencies. Add `supertest`, its types, and ESLint's TypeScript configuration support. Retain the existing package name, version, description, repository metadata, license, and `"type": "module"`; replace the script, engine, dependency, and dev-dependency fields with these values:

```json
{
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "lint": "eslint . --ext .ts",
    "format": "prettier --write \"{src,test}/**/*.ts\" \"*.{json,md}\"",
    "check": "npm run lint && npm test && npm run build",
    "clean": "rm -rf dist"
  },
  "engines": { "node": ">=20.0.0" },
  "dependencies": {
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/jest": "^29.5.8",
    "@types/node": "^20.10.0",
    "@types/supertest": "^6.0.2",
    "@typescript-eslint/eslint-plugin": "^6.13.2",
    "@typescript-eslint/parser": "^6.13.2",
    "eslint": "^8.55.0",
    "jest": "^29.7.0",
    "prettier": "^3.1.0",
    "supertest": "^7.0.0",
    "ts-jest": "^29.1.1",
    "tsx": "^4.19.0",
    "typescript": "^5.3.3"
  }
}
```

- [ ] **Step 2: Add strict build and test configuration**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test"]
}
```

```js
// jest.config.cjs
module.exports = {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      tsconfig: { module: "ESNext", rootDir: "." }
    }]
  },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }
};
```

```js
// .eslintrc.cjs
module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  ignorePatterns: ["dist/", "node_modules/"]
};
```

- [ ] **Step 3: Add safe repository defaults**

```gitignore
node_modules/
dist/
.env
coverage/
*.log
.DS_Store
```

```dotenv
TYPESAFE_API_KEY=tsf_replace_with_your_key
TYPESAFE_BASE_URL=https://api.typesafe.ai
JEV_MODEL=jev-latest
JEV_PRUNE_ENABLED=true
JEV_PRUNE_THRESHOLD=100000
JEV_PRUNE_TRIGGER_TOKENS=150000
JEV_PRUNE_KEEP_RECENT=5
JEV_PRUNE_EXCLUDE_TOOLS=
JEV_TIMEOUT_MS=2000
JEV_PRUNE_DEBUG=false
ANTHROPIC_UPSTREAM_URL=https://api.anthropic.com
PORT=5590
```

- [ ] **Step 4: Install and prove the empty baseline is valid**

Run: `npm install && npx tsc --version`

Expected: dependency installation succeeds, `package-lock.json` is created, and TypeScript reports the installed compiler version. The first real build runs after Task 2 creates source files.

- [ ] **Step 5: Commit the baseline**

```bash
git add package.json package-lock.json tsconfig.json jest.config.cjs .eslintrc.cjs .gitignore .env.example
git commit -m "build: establish TypeScript proxy baseline"
```

### Task 2: Define Configuration, Domain Types, and Token Estimation

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create: `src/utils/tokenCounter.ts`
- Create: `test/config.test.ts`
- Create: `test/tokenCounter.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config`.
- Produces: `estimateTokens(value: unknown): number`.
- Produces: `AnthropicRequest`, `ContentBlock`, `ToolCandidate`, `RelevanceScorer`, `PruneResult`, and `ProxyStats` types used by all later tasks.

- [ ] **Step 1: Write failing configuration and token-estimate tests**

```ts
// test/config.test.ts
import { loadConfig } from "../src/config.js";

test("loads documented defaults", () => {
  const config = loadConfig({ TYPESAFE_API_KEY: "secret" });
  expect(config.port).toBe(5590);
  expect(config.pruneThreshold).toBe(100_000);
  expect(config.triggerTokens).toBe(150_000);
  expect(config.keepRecent).toBe(5);
  expect(config.jevModel).toBe("jev-latest");
});

test("rejects a trigger below the normal threshold", () => {
  expect(() => loadConfig({
    TYPESAFE_API_KEY: "secret",
    JEV_PRUNE_THRESHOLD: "100000",
    JEV_PRUNE_TRIGGER_TOKENS: "90000"
  })).toThrow("JEV_PRUNE_TRIGGER_TOKENS must be greater than or equal to JEV_PRUNE_THRESHOLD");
});

test("allows a missing Jev key only when pruning is disabled", () => {
  expect(loadConfig({ JEV_PRUNE_ENABLED: "false" }).pruningEnabled).toBe(false);
  expect(() => loadConfig({ JEV_PRUNE_ENABLED: "true" })).toThrow("TYPESAFE_API_KEY is required");
});
```

```ts
// test/tokenCounter.test.ts
import { estimateTokens } from "../src/utils/tokenCounter.js";

test("returns the four-character JSON estimate", () => {
  const value = { messages: [{ role: "user", content: "abcdefgh" }] };
  expect(estimateTokens(value)).toBe(Math.ceil(JSON.stringify(value).length / 4));
});
```

- [ ] **Step 2: Run the focused tests and confirm the modules are missing**

Run: `npm test -- --runTestsByPath test/config.test.ts test/tokenCounter.test.ts`

Expected: FAIL because `src/config.ts` and `src/utils/tokenCounter.ts` do not exist.

- [ ] **Step 3: Implement strict environment parsing**

Define the complete configuration shape and reject non-integers, negative values, non-HTTP(S) URLs, and booleans other than `true` or `false`.

```ts
export interface Config {
  port: number;
  pruningEnabled: boolean;
  pruneThreshold: number;
  triggerTokens: number;
  keepRecent: number;
  excludeTools: ReadonlySet<string>;
  debug: boolean;
  jevApiKey?: string;
  jevBaseUrl: string;
  jevModel: string;
  jevTimeoutMs: number;
  anthropicUpstreamUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const pruningEnabled = parseBoolean(env.JEV_PRUNE_ENABLED ?? "true", "JEV_PRUNE_ENABLED");
  const pruneThreshold = parseInteger(env.JEV_PRUNE_THRESHOLD ?? "100000", "JEV_PRUNE_THRESHOLD", 0);
  const triggerTokens = parseInteger(env.JEV_PRUNE_TRIGGER_TOKENS ?? "150000", "JEV_PRUNE_TRIGGER_TOKENS", 0);
  if (triggerTokens < pruneThreshold) {
    throw new Error("JEV_PRUNE_TRIGGER_TOKENS must be greater than or equal to JEV_PRUNE_THRESHOLD");
  }
  if (pruningEnabled && !env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required when pruning is enabled");
  return {
    port: parseInteger(env.PORT ?? "5590", "PORT", 1, 65535),
    pruningEnabled,
    pruneThreshold,
    triggerTokens,
    keepRecent: parseInteger(env.JEV_PRUNE_KEEP_RECENT ?? "5", "JEV_PRUNE_KEEP_RECENT", 0),
    excludeTools: new Set((env.JEV_PRUNE_EXCLUDE_TOOLS ?? "").split(",").map((v) => v.trim()).filter(Boolean)),
    debug: parseBoolean(env.JEV_PRUNE_DEBUG ?? "false", "JEV_PRUNE_DEBUG"),
    ...(env.TYPESAFE_API_KEY ? { jevApiKey: env.TYPESAFE_API_KEY } : {}),
    jevBaseUrl: parseUrl(env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai", "TYPESAFE_BASE_URL"),
    jevModel: env.JEV_MODEL ?? "jev-latest",
    jevTimeoutMs: parseInteger(env.JEV_TIMEOUT_MS ?? "2000", "JEV_TIMEOUT_MS", 1),
    anthropicUpstreamUrl: parseUrl(env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com", "ANTHROPIC_UPSTREAM_URL")
  };
}
```

Use these exact helpers so invalid values cannot silently fall back:

```ts
function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(value: string, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
}
```

- [ ] **Step 4: Define narrow wire and domain types**

```ts
export type TextBlock = { type: "text"; text: string; [key: string]: unknown };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown; [key: string]: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content?: unknown; [key: string]: unknown };
export type UnknownBlock = { type: string; [key: string]: unknown };
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | UnknownBlock;
export type Message = { role: "user" | "assistant"; content: string | ContentBlock[]; [key: string]: unknown };
export type AnthropicRequest = { messages: Message[]; system?: unknown; stream?: boolean; [key: string]: unknown };

export interface ToolCandidate {
  toolUseId: string;
  toolName: string;
  assistantMessageIndex: number;
  assistantBlockIndex: number;
  resultMessageIndex: number;
  resultBlockIndex: number;
  input: unknown;
  result: unknown;
}

export interface RelevanceScorer {
  score(goal: string, candidates: readonly ToolCandidate[]): Promise<ReadonlyMap<string, number>>;
}

export interface PruneResult {
  request: AnthropicRequest;
  beforeTokens: number;
  afterTokens: number;
  evaluated: number;
  dropped: number;
  reason: "disabled" | "below-threshold" | "no-candidates" | "pruned" | "fail-open";
}
```

- [ ] **Step 5: Implement the deterministic estimate and pass the focused tests**

```ts
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
```

Run: `npm test -- --runTestsByPath test/config.test.ts test/tokenCounter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the foundational contracts**

```bash
git add src/types.ts src/config.ts src/utils/tokenCounter.ts test/config.test.ts test/tokenCounter.test.ts
git commit -m "feat: define proxy configuration and request contracts"
```

### Task 3: Implement the TypeSafe Jev Client

**Files:**
- Create: `src/services/jevService.ts`
- Create: `test/jevService.test.ts`

**Interfaces:**
- Consumes: `Config`, `ToolCandidate`, and `RelevanceScorer` from Task 2.
- Produces: `JevService implements RelevanceScorer`.
- Produces: one or more `POST /v1/systemone` requests containing no more than 32 named `noul` questions each.

- [ ] **Step 1: Write contract tests against an injected fetch function**

```ts
test("maps candidates to named noul questions and returns relevance probabilities", async () => {
  const fetchFn = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      candidate_0: { type: "noul", noul: 0.91 },
      candidate_1: { type: "noul", noul: 0.08 }
    },
    usage: { input_tokens: 100, output_tokens: 2 }
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const service = new JevService({
    apiKey: "secret",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    timeoutMs: 2000,
    fetchFn
  });
  const scores = await service.score("Fix JWT validation", [candidate("call-a"), candidate("call-b")]);
  expect(scores).toEqual(new Map([["call-a", 0.91], ["call-b", 0.08]]));
  expect(fetchFn).toHaveBeenCalledWith("https://api.typesafe.ai/v1/systemone", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ Authorization: "Bearer secret" })
  }));
});

test.each([401, 429, 500])("throws a redacted error for HTTP %s", async (status) => {
  const fetchFn = jest.fn().mockResolvedValue(new Response("sensitive upstream body", { status }));
  await expect(serviceWith(fetchFn).score("goal", [candidate("call-a")]))
    .rejects.toThrow(`TypeSafe request failed with status ${status}`);
});

test("rejects missing or non-noul answers", async () => {
  const fetchFn = jest.fn().mockResolvedValue(new Response(JSON.stringify({
    model: "jev-latest", answers: { candidate_0: { type: "choice", choice: "yes" } },
    usage: { input_tokens: 1, output_tokens: 1 }
  }), { status: 200 }));
  await expect(serviceWith(fetchFn).score("goal", [candidate("call-a")]))
    .rejects.toThrow("TypeSafe returned an invalid answer for candidate_0");
});
```

- [ ] **Step 2: Run the client test and verify it fails**

Run: `npm test -- --runTestsByPath test/jevService.test.ts`

Expected: FAIL because `JevService` is not implemented.

- [ ] **Step 3: Implement batching, timeout, and runtime response checks**

The request for each batch must have this exact shape:

```ts
const body = {
  model: this.model,
  state: {
    current_goal: goal,
    candidates: batch.map((candidate, index) => ({
      key: `candidate_${index}`,
      tool_use_id: candidate.toolUseId,
      tool_name: candidate.toolName,
      input: candidate.input,
      result: candidate.result
    }))
  },
  questions: Object.fromEntries(batch.map((_candidate, index) => [
    `candidate_${index}`,
    {
      type: "noul",
      instructions: `Is candidates[${index}] still needed to complete current_goal?`,
      criteria: {
        true: "The current task depends on this tool input or result.",
        false: "The tool call is stale, superseded, exploratory, or unrelated to the current task."
      }
    }
  ]))
};
```

Use `AbortSignal.timeout(timeoutMs)`, parse JSON only after checking `response.ok`, validate every requested answer as `{ type: "noul", noul: number }` with `0 <= noul <= 1`, and translate batch-local keys back to tool-use IDs. Do not include response bodies in thrown errors.

- [ ] **Step 4: Pass the Jev client tests**

Run: `npm test -- --runTestsByPath test/jevService.test.ts`

Expected: PASS, including an additional 33-candidate test proving two fetch calls are made.

- [ ] **Step 5: Commit the Jev adapter**

```bash
git add src/services/jevService.ts test/jevService.test.ts
git commit -m "feat: add batched TypeSafe relevance client"
```

### Task 4: Implement Structurally Safe Context Pruning

**Files:**
- Create: `src/services/contextPruner.ts`
- Create: `test/fixtures/messages.ts`
- Create: `test/contextPruner.test.ts`

**Interfaces:**
- Consumes: `AnthropicRequest`, `Config`, `RelevanceScorer`, and `estimateTokens`.
- Produces: `ContextPruner.prune(request: AnthropicRequest): Promise<PruneResult>`.
- Produces: an immutable request copy only when blocks are removed; pass-through paths return the original request object.

- [ ] **Step 1: Write safety-invariant tests before implementation**

Cover these cases with explicit request fixtures and full equality assertions:

```ts
test("drops a matched tool-use and tool-result pair while preserving surrounding blocks", async () => {
  const scorer = scorerReturning({ "call-old": 0.1, "call-new": 0.9 });
  const result = await pruner({ keepRecent: 0, scorer }).prune(twoToolRequest);
  expect(allToolIds(result.request)).toEqual(["call-new"]);
  expect(allText(result.request)).toEqual(allText(twoToolRequest));
  expect(twoToolRequest).toEqual(twoToolRequestSnapshot);
});

test("preserves the newest configured number of tool pairs without scoring them", async () => {
  const scorer = scorerReturning({ "call-old": 0.01 });
  const result = await pruner({ keepRecent: 1, scorer }).prune(twoToolRequest);
  expect(scorer.score).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ toolUseId: "call-old" })]);
  expect(allToolIds(result.request)).toEqual(["call-new"]);
});

test("preserves excluded, unmatched, malformed, text-only, and system content", async () => {
  const result = await pruner({ excludeTools: new Set(["test"]), scorer: scorerReturning({}) }).prune(safetyFixture);
  expect(result.request).toEqual(safetyFixture);
});

test("fails open when the scorer rejects", async () => {
  const scorer = { score: jest.fn().mockRejectedValue(new Error("timeout")) };
  const result = await pruner({ scorer }).prune(twoToolRequest);
  expect(result.request).toBe(twoToolRequest);
  expect(result.reason).toBe("fail-open");
});
```

Also test disabled pruning, below-threshold pass-through, a cached drop, normal cutoff `0.50`, aggressive cutoff `0.70`, removal of newly empty messages, preservation of extra top-level/message/block properties, and extraction of the latest non-tool user text as the goal.

- [ ] **Step 2: Run the pruning tests and verify they fail**

Run: `npm test -- --runTestsByPath test/contextPruner.test.ts`

Expected: FAIL because the pruner does not exist.

- [ ] **Step 3: Implement candidate extraction with pair integrity**

Scan assistant array content for valid `tool_use` blocks, then scan user array content for a `tool_result.tool_use_id` match. A pair is eligible only when both IDs match exactly, the tool-use ID appears once, and the result ID appears once. Sort candidates by assistant message/block position before applying `keepRecent`.

```ts
function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use" && typeof block.id === "string" &&
    typeof block.name === "string" && Object.hasOwn(block, "input");
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result" && typeof block.tool_use_id === "string";
}
```

Do not assume the result is in the immediately following message; match by ID while preserving all nonmatched blocks.

- [ ] **Step 4: Implement policy, caching, and immutable filtering**

```ts
const cutoff = beforeTokens >= config.triggerTokens ? 0.70 : 0.50;
const protectedIds = new Set(candidates.slice(-config.keepRecent).map((item) => item.toolUseId));
const eligible = candidates.filter((item) =>
  !protectedIds.has(item.toolUseId) &&
  !config.excludeTools.has(item.toolName) &&
  !dropCache.has(item.toolUseId)
);
const scores = eligible.length === 0 ? new Map<string, number>() : await scorer.score(goal, eligible);
const droppedIds = new Set<string>(dropCache);
for (const item of eligible) {
  const score = scores.get(item.toolUseId);
  if (score === undefined) throw new Error(`Missing score for ${item.toolUseId}`);
  if (score < cutoff) {
    droppedIds.add(item.toolUseId);
    dropCache.add(item.toolUseId);
  }
}
```

Filter only the exact assistant/result block coordinates belonging to `droppedIds`, copy changed messages with object spread, remove messages whose array content becomes empty, and copy the request with `{ ...request, messages }`. Wrap scoring and filtering in one `try/catch`; return the original request with reason `fail-open` on any error.

- [ ] **Step 5: Pass the pruning suite**

Run: `npm test -- --runTestsByPath test/contextPruner.test.ts`

Expected: PASS with every safety invariant asserted.

- [ ] **Step 6: Commit the pruning core**

```bash
git add src/services/contextPruner.ts test/fixtures/messages.ts test/contextPruner.test.ts
git commit -m "feat: prune matched stale tool-call pairs"
```

### Task 5: Build the Transparent Anthropic Proxy and Health Endpoint

**Files:**
- Create: `src/utils/logger.ts`
- Create: `src/middleware/health.ts`
- Create: `src/middleware/proxy.ts`
- Create: `src/app.ts`
- Create: `test/proxy.test.ts`

**Interfaces:**
- Consumes: `Config` and `ContextPruner`.
- Produces: `createApp({ config, pruner, fetchFn, logger, startedAt }): Express`.
- Produces: `GET /health` and transparent forwarding for `/v1/*`, with pruning applied only to `POST /v1/messages` JSON bodies.

- [ ] **Step 1: Write integration tests with a local fake upstream**

```ts
test("forwards auth/version headers and the pruned messages body", async () => {
  const upstream = await startFakeAnthropic();
  const app = createTestApp({ anthropicUpstreamUrl: upstream.url, score: 0.1 });
  const response = await request(app)
    .post("/v1/messages")
    .set("x-api-key", "anthropic-secret")
    .set("anthropic-version", "2023-06-01")
    .send(twoToolRequest);
  expect(response.status).toBe(200);
  expect(upstream.lastRequest.headers["x-api-key"]).toBe("anthropic-secret");
  expect(allToolIds(upstream.lastRequest.body)).toEqual([]);
});

test("relays SSE chunks and content type", async () => {
  const upstream = await startStreamingAnthropic(["data: first\n\n", "data: second\n\n"]);
  const response = await rawHttpRequest(createTestServer(upstream.url), "/v1/messages", streamingRequest);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toBe("data: first\n\ndata: second\n\n");
});

test("forwards the original body when pruning fails", async () => {
  const upstream = await startFakeAnthropic();
  const app = createTestApp({ anthropicUpstreamUrl: upstream.url, scorerError: new Error("timeout") });
  await request(app).post("/v1/messages").send(twoToolRequest);
  expect(upstream.lastRequest.body).toEqual(twoToolRequest);
});
```

Also verify upstream 4xx/5xx status and body relay, `/v1/messages/count_tokens` pass-through, a 502 on Anthropic network failure, no TypeSafe key in forwarded headers, and health output.

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `npm test -- --runTestsByPath test/proxy.test.ts`

Expected: FAIL because the Express application and middleware do not exist.

- [ ] **Step 3: Implement redacted logging and process statistics**

Use JSON logs in production and colorized simple logs in development. Write to stderr and to `~/.claude/jev-prune.log`, creating the parent directory with owner read/write/execute permissions when it does not exist. Log only event name, estimated token counts, candidate/drop counts, duration, status, and safe error messages. When `JEV_PRUNE_DEBUG=true`, add tool name, tool-use ID, numeric relevance, cutoff, and keep/drop outcome for each decision, but never tool input or result content. Maintain counters for requests, prune attempts, dropped pairs, and fail-open events in a process-local `ProxyStats` object. Unit-test the logger with an injected log path under a temporary directory so tests never modify the developer's home directory.

- [ ] **Step 4: Implement health without making a billable Jev request**

`GET /health` must return HTTP 200 once the process is ready:

```json
{
  "status": "ok",
  "proxy_version": "1.0.0",
  "jev_configured": true,
  "pruning_enabled": true,
  "requests": 0,
  "pruning_decisions": 0,
  "dropped_pairs": 0,
  "fail_open_events": 0,
  "uptime_seconds": 42
}
```

Name the field `jev_configured`, not `jev_connected`, because health must not spend money or fail startup solely because TypeSafe is temporarily unreachable.

- [ ] **Step 5: Implement forwarding and response streaming**

Build the upstream URL from `config.anthropicUpstreamUrl` plus `req.originalUrl`. Copy incoming headers except `host`, `connection`, `content-length`, `transfer-encoding`, and `content-encoding`; never synthesize Anthropic credentials. Serialize the possibly pruned JSON body, set its content type and length, and call injected `fetchFn`.

Relay upstream headers except hop-by-hop headers and stale `content-length`/`content-encoding`. Convert the web response stream with `Readable.fromWeb(upstream.body)` and use `pipeline` to the Express response. Preserve upstream status codes. Return a small JSON 502 only when Anthropic cannot be reached before response headers arrive.

- [ ] **Step 6: Compose routes in ownership order**

```ts
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", createHealthHandler(deps));
  app.use(express.json({ limit: "32mb" }));
  app.use("/v1", createProxyHandler(deps));
  return app;
}
```

Reject invalid JSON with HTTP 400 locally. Forward well-formed but unsupported Anthropic payloads unchanged.

- [ ] **Step 7: Pass the proxy integration suite**

Run: `npm test -- --runTestsByPath test/proxy.test.ts`

Expected: PASS, including streaming and fail-open tests.

- [ ] **Step 8: Commit the HTTP application**

```bash
git add src/app.ts src/middleware src/utils/logger.ts test/proxy.test.ts
git commit -m "feat: add transparent Anthropic HTTP proxy"
```

### Task 6: Add Startup, Shutdown, and Full-System Verification

**Files:**
- Create: `src/index.ts`
- Modify: `test/proxy.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `JevService`, `ContextPruner`, `createApp`, and logger.
- Produces: the runnable `dist/index.js` server.

- [ ] **Step 1: Add a subprocess smoke test**

Build first, start `node dist/index.js` with pruning disabled and an ephemeral port supplied by the test harness, wait for the listening log, request `/health`, then send `SIGTERM`. Assert health returns 200 and the process exits with code 0 within two seconds.

- [ ] **Step 2: Run the smoke test and verify it fails before the entry point exists**

Run: `npm run build && npm test -- --runTestsByPath test/proxy.test.ts`

Expected: FAIL because `dist/index.js` is absent.

- [ ] **Step 3: Wire dependencies once at startup**

```ts
import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ContextPruner } from "./services/contextPruner.js";
import { JevService } from "./services/jevService.js";
import { logger } from "./utils/logger.js";

const config = loadConfig(process.env);
const scorer = new JevService({
  apiKey: config.jevApiKey ?? "disabled",
  baseUrl: config.jevBaseUrl,
  model: config.jevModel,
  timeoutMs: config.jevTimeoutMs,
  fetchFn: fetch
});
const pruner = new ContextPruner({ config, scorer, logger });
const app = createApp({ config, pruner, fetchFn: fetch, logger, startedAt: Date.now() });
const server = createServer(app);
server.listen(config.port, () => logger.info("proxy_listening", { port: config.port }));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
```

Log configuration validation failures once and exit nonzero without printing secrets.

- [ ] **Step 4: Run every automated gate**

Run: `npm run check`

Expected: lint, all Jest suites, and the strict TypeScript build pass.

- [ ] **Step 5: Perform a local pass-through smoke test**

```bash
JEV_PRUNE_ENABLED=false PORT=5590 npm start
curl --fail --silent http://localhost:5590/health
```

Expected: health JSON contains `"status":"ok"` and `"pruning_enabled":false`.

- [ ] **Step 6: Commit the runnable server**

```bash
git add src/index.ts test/proxy.test.ts
git commit -m "feat: wire proxy startup and graceful shutdown"
```

### Task 7: Reconcile Documentation with the Shipped Behavior

**Files:**
- Modify: `README.md`
- Modify: `GETTING_STARTED.md`
- Modify: `CONVERSATION_SUMMARY.md`
- Create: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: verified commands, environment variables, health fields, and limitations from Tasks 1–6.
- Produces: one consistent user-facing description of an HTTP proxy whose claims are backed by tests.

- [ ] **Step 1: Correct terminology and unsupported claims**

Replace “MCP plugin” with “local HTTP proxy.” Remove “production ready,” fixed savings/latency/quality claims, the nonexistent MCP Registry install command, missing-file links, and claims that pruning prevents Claude Code's own compaction. State that JSON values are preserved but wire-level JSON bytes may be reserialized.

- [ ] **Step 2: Document privacy and failure boundaries prominently**

State that candidate tool inputs/results and the latest user goal are sent to TypeSafe when pruning activates; Anthropic request credentials are never sent to TypeSafe; Jev failures pass the original request to Anthropic; and Jev can make incorrect relevance decisions even though its output schema is constrained.

- [ ] **Step 3: Make setup match the implemented configuration**

Document Node.js 20+, `npm install`, copying `.env.example`, `npm run build`, `npm start`, and setting Claude Code's `ANTHROPIC_BASE_URL=http://localhost:5590`. Explain that the proxy uses the separate `ANTHROPIC_UPSTREAM_URL` setting, which defaults to `https://api.anthropic.com`; this separation prevents the proxy from forwarding requests back to itself.

- [ ] **Step 4: Add the architecture document**

Include the request sequence, candidate-pair matching rules, normal/aggressive cutoffs, cache semantics, streaming path, safe-to-prune matrix, health semantics, and fail-open table. Link it from both root guides.

- [ ] **Step 5: Check documentation commands and links mechanically**

Run:

```bash
rg -n "MCP plugin|production.ready|claude install|jev_connected|ARCHITECTURE.md|CONTRIBUTING.md|QUICK_REFERENCE.md|GITHUB_SETUP.md" README.md GETTING_STARTED.md CONVERSATION_SUMMARY.md docs/ARCHITECTURE.md
npm run check
```

Expected: the search finds only the valid `docs/ARCHITECTURE.md` links and explicit historical clarification in the summary; all verification gates pass.

- [ ] **Step 6: Commit the reconciled documentation**

```bash
git add README.md GETTING_STARTED.md CONVERSATION_SUMMARY.md docs/ARCHITECTURE.md
git commit -m "docs: align guides with the implemented proxy"
```

### Task 8: Validate with a Real Jev Key Without Sending Repository Secrets

**Files:**
- Modify: `src/services/jevService.ts` only if the live contract differs.
- Modify: `test/jevService.test.ts` only if the live contract differs.
- Modify: `README.md` only if user-visible behavior differs.

**Interfaces:**
- Consumes: a user-supplied `TYPESAFE_API_KEY` in the shell environment.
- Produces: evidence that the live TypeSafe request schema and configured model work; no automated test depends on this key.

- [ ] **Step 1: Build and start the proxy with a low test threshold**

```bash
JEV_PRUNE_THRESHOLD=1 JEV_PRUNE_TRIGGER_TOKENS=1000000 JEV_PRUNE_KEEP_RECENT=0 npm start
```

- [ ] **Step 2: Send a synthetic Anthropic-format request to a controlled fake Anthropic upstream**

Use only invented tool content such as `{"query":"synthetic example"}`. Do not use a real conversation, source file, environment dump, or credential-bearing command output for the live Jev check.

- [ ] **Step 3: Verify observable behavior**

Confirm exactly one TypeSafe batch is logged, the fake Anthropic upstream receives a structurally valid request, tool-use/result IDs remain paired, and no secret or full payload appears in logs. If TypeSafe rejects the schema, retain fail-open behavior, update only the adapter and its recorded contract test, and rerun `npm run check`.

- [ ] **Step 4: Run the final release gate**

Run: `npm run check && git status --short`

Expected: every automated gate passes; status shows only intentional documentation changes from the live check, or is clean.

- [ ] **Step 5: Commit any live-contract correction**

```bash
git add src/services/jevService.ts test/jevService.test.ts README.md
git commit -m "fix: align Jev adapter with live API contract"
```

Skip this commit when the live contract required no changes.

## Final Acceptance Checklist

- [ ] `npm run check` passes from a clean install on Node.js 20.
- [ ] Requests below the normal threshold do not contact TypeSafe.
- [ ] Only unique matched `tool_use`/`tool_result` pairs can be removed.
- [ ] Recent and excluded tools are never submitted for relevance scoring.
- [ ] Retained content, unknown fields, system content, and plain conversational text survive unchanged as values.
- [ ] TypeSafe failures and malformed answers send the original request to Anthropic.
- [ ] Anthropic streaming responses and upstream error responses are relayed correctly.
- [ ] Logs and health output contain no credentials or prompt/tool payloads.
- [ ] Documentation calls the project an HTTP proxy and accurately explains privacy, estimates, and limitations.
- [ ] The live Jev check uses synthetic content only and is not part of the default test suite.

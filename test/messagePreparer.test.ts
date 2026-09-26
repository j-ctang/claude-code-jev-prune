import {
  MessagePreparer,
  THINKING_BINDING_BETA,
  type RequestRouter,
} from "../src/services/messagePreparer.js";
import { identifyConversation } from "../src/services/conversation.js";
import type { AnthropicRequest, ProxyStats } from "../src/types.js";
import type { AppLogger } from "../src/utils/logger.js";

const request: AnthropicRequest = {
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: "Redesign auth" }],
};

const main = identifyConversation(request, "s");

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function preparer(router: RequestRouter, pruneMs = 0) {
  const events: Array<{ message: string; metadata?: Record<string, unknown> }> =
    [];
  const log = (message: string, metadata?: Record<string, unknown>) => {
    events.push({ message, ...(metadata ? { metadata } : {}) });
  };
  const logger: AppLogger = { info: log, warn: log, error: log, debug: log };
  const stats: ProxyStats = {
    requests: 0,
    pruningDecisions: 0,
    droppedPairs: 0,
    failOpenEvents: 0,
    prunes: 0,
    tokensRemoved: 0,
  };
  const subject = new MessagePreparer({
    config: { notify: true, targetTokens: 0, skillShadow: false },
    canary: { check: () => ({ prune: false }) },
    pruner: {
      async prune(pruned) {
        await sleep(pruneMs);
        return {
          request: pruned,
          beforeTokens: 10,
          afterTokens: 5,
          evaluated: 1,
          dropped: 1,
          reason: "pruned",
        };
      },
    },
    router,
    logger,
    stats,
  });
  return { subject, events };
}

const response = (status: number) =>
  new Response("{}", {
    status,
    headers: { "content-type": "application/json" },
  });

test("times the prune without the routing wait", async () => {
  const { subject, events } = preparer({
    async route() {
      await sleep(200);
      return {};
    },
  });

  await subject.prepare(request, main);

  const complete = events.find((event) => event.message === "prune_complete");
  expect(complete?.metadata?.durationMs).toBeLessThan(150);
});

test("prunes and routes at the same time", async () => {
  const { subject } = preparer(
    {
      async route() {
        await sleep(150);
        return {};
      },
    },
    150,
  );

  const startedAt = Date.now();
  await subject.prepare(request, main);

  expect(Date.now() - startedAt).toBeLessThan(280);
});

test("confirms a rejection only when the resend succeeds", async () => {
  const confirmed: number[] = [];
  const router: RequestRouter = {
    async route() {
      return {
        model: "claude-fable-5-1",
        fallback: {
          retries: (status) => status === 400,
          notice: "[jev-prune] Rejected.",
          confirm: () => confirmed.push(1),
        },
      };
    },
  };
  const sent: AnthropicRequest[] = [];
  const statuses = [400, 400, 400, 200];
  const send = async (body: AnthropicRequest) => {
    sent.push(body);
    return response(statuses.shift() ?? 500);
  };

  const failed = await (
    await preparer(router).subject.prepare(request, main)
  ).send(send);
  const recovered = await (
    await preparer(router).subject.prepare(request, main)
  ).send(send);

  expect(failed.status).toBe(400);
  expect(recovered.status).toBe(200);
  expect(confirmed).toEqual([1]);
  expect(sent.map((body) => body.model)).toEqual([
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-opus-5-5",
  ]);
  expect(JSON.stringify(sent[3]?.messages)).toContain("[jev-prune] Rejected.");
});

test("does not resend a status the router keeps", async () => {
  let sends = 0;
  const { subject } = preparer({
    async route() {
      return {
        model: "claude-fable-5-1",
        fallback: {
          retries: () => false,
          notice: "",
          confirm: () => undefined,
        },
      };
    },
  });

  const upstream = await (
    await subject.prepare(request, main)
  ).send(async () => {
    sends += 1;
    return response(429);
  });

  expect(upstream.status).toBe(429);
  expect(sends).toBe(1);
});

test("keeps an earlier turn's notice on later requests", async () => {
  let calls = 0;
  const { subject } = preparer({
    async route() {
      calls += 1;
      return calls === 1 ? { notice: "[jev-prune] Switched." } : {};
    },
  });
  const sent: AnthropicRequest[] = [];
  const send = async (body: AnthropicRequest) => {
    sent.push(body);
    return response(200);
  };

  await (await subject.prepare(request, main)).send(send);
  await (
    await subject.prepare(
      {
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant", content: "Done." },
          { role: "user", content: "Add tests" },
        ],
      },
      main,
    )
  ).send(send);

  expect(sent[1]?.messages[0]).toEqual(sent[0]?.messages[0]);
  expect(JSON.stringify(sent[1]?.messages[0])).toContain("Switched");
});

test("lets the API drop mismatched thinking only on requests it changed", async () => {
  const thinking = { type: "adaptive", display: "omitted" };
  const calls: Array<{ body: AnthropicRequest; beta?: string | undefined }> =
    [];
  const send = async (body: AnthropicRequest, beta?: string) => {
    calls.push({ body, beta });
    return response(200);
  };
  const untouched = preparer({ route: async () => ({}) }).subject;
  const routed = preparer({
    route: async () => ({ model: "claude-fable-5-1" }),
  }).subject;

  await (await untouched.prepare({ ...request, thinking }, main)).send(send);
  await (await routed.prepare({ ...request, thinking }, main)).send(send);

  expect(calls[0]?.beta).toBeUndefined();
  expect(calls[0]?.body.thinking).toEqual(thinking);
  expect(calls[1]?.beta).toBe(THINKING_BINDING_BETA);
  expect(calls[1]?.body.thinking).toEqual({
    ...thinking,
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
});

import { SkillShadow } from "../src/services/skillShadow.js";
import { SkillShadowObserver } from "../src/services/skillShadowObserver.js";
import type { AppLogger } from "../src/utils/logger.js";

const body = "Follow this complete reporting procedure, inspect every page, verify all results, and clearly document every issue before delivery.";
const entry = { skill: "pdf", body, key: "body-key", potentialTokens: 32 };

function eventsLogger(events: Array<{ message: string; metadata?: Record<string, unknown> }>): AppLogger {
  const log = (message: string, metadata?: Record<string, unknown>) => {
    events.push({ message, ...(metadata ? { metadata } : {}) });
  };
  return { info: log, warn: log, error: log, debug: log };
}

test("logs only metadata after a final reply", async () => {
  const events: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const shadow = new SkillShadow({ catalog: { entries: () => [entry] }, judge: async () => 0.99 });
  const observer = new SkillShadowObserver(shadow, eventsLogger(events));
  const onFinal = observer.observe({ messages: [{ role: "user", content: `Create report.\n${body}` }] }, "s");
  expect(events[0]?.message).toBe("skill_shadow_observed");
  onFinal?.("The report is complete.");
  await new Promise(setImmediate);
  expect(events[1]?.message).toBe("skill_shadow_complete");
  expect(JSON.stringify(events)).not.toContain(body);
  expect(events[1]?.metadata).toEqual(expect.objectContaining({ skill: "pdf", confidence: 0.99 }));
});

test("an old reply cannot complete a newer task", async () => {
  const events: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const shadow = new SkillShadow({ catalog: { entries: () => [entry] }, judge: async () => 0.99 });
  const observer = new SkillShadowObserver(shadow, eventsLogger(events));
  const oldReply = observer.observe({ messages: [{ role: "user", content: `Create A.\n${body}` }] }, "s");
  observer.observe({ messages: [{ role: "user", content: `Create B.\n${body}` }] }, "s");
  oldReply?.("A is complete.");
  await new Promise(setImmediate);
  expect(events.filter((event) => event.message === "skill_shadow_complete")).toEqual([]);
});

test("observation and judgment failures never throw", async () => {
  const events: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const request = { messages: [{ role: "user" as const, content: `Create report.\n${body}` }] };
  const brokenCatalog = new SkillShadow({ catalog: { entries: () => { throw new Error("disk"); } }, judge: async () => 1 });
  expect(new SkillShadowObserver(brokenCatalog, eventsLogger(events)).observe(request, "s")).toBeUndefined();
  const brokenJudge = new SkillShadow({ catalog: { entries: () => [entry] }, judge: async () => { throw new Error("offline"); } });
  const callback = new SkillShadowObserver(brokenJudge, eventsLogger(events)).observe(request, "s");
  callback?.("Complete.");
  await new Promise(setImmediate);
  expect(events.filter((event) => event.message === "skill_shadow_complete")).toEqual([]);
});

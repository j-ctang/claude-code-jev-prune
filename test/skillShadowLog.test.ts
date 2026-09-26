import {
  createSkillShadowLogCursor,
  skillShadowNotices,
  summarizeSkillShadowLog,
} from "../src/services/skillShadowLog.js";

const observed = JSON.stringify({
  message: "skill_shadow_observed",
  sessionId: "a",
  skill: "pdf",
  potentialTokens: 400,
});
const complete = JSON.stringify({
  message: "skill_shadow_complete",
  eventId: "event-1",
  sessionId: "a",
  skill: "pdf",
  potentialTokens: 400,
  confidence: 0.98,
});

test("summarizes potential tokens separately from actual pruning", () => {
  expect(
    summarizeSkillShadowLog(`${observed}\n${complete}\nnot-json\n`),
  ).toEqual({ observed: 1, completed: 1, potentialTokens: 400 });
});

test("prints each finding once only while one launcher owns the proxy", () => {
  const seen = new Set<string>();
  expect(skillShadowNotices(complete, seen, false)).toEqual([]);
  expect(skillShadowNotices(complete, seen, true)).toEqual([]);
  const second = JSON.stringify({
    message: "skill_shadow_complete",
    eventId: "event-2",
    sessionId: "a",
    skill: "reports",
    potentialTokens: 2500,
    confidence: 0.99,
  });
  expect(skillShadowNotices(second, seen, true)).toEqual([
    'Jev: skill "reports" looks reusable; ~3K potential tokens after this task.',
  ]);
  expect(skillShadowNotices(second, seen, true)).toEqual([]);
});

test("waits for a complete log line across polls", () => {
  const cursor = createSkillShadowLogCursor();
  expect(cursor.push(complete.slice(0, 20))).toBe("");
  expect(cursor.push(`${complete.slice(20)}\n`)).toBe(`${complete}\n`);
});

test("does not print control characters from a skill identifier", () => {
  const event = JSON.stringify({
    message: "skill_shadow_complete",
    eventId: "bad",
    skill: "\u001b[31m",
    potentialTokens: 500,
  });
  expect(skillShadowNotices(event, new Set(), true)).toEqual([]);
});

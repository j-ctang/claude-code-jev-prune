import { formatTokens } from "../proxyClient.js";

interface ShadowEvent {
  message?: unknown;
  eventId?: unknown;
  sessionId?: unknown;
  skill?: unknown;
  potentialTokens?: unknown;
  confidence?: unknown;
}

/** Keeps a partial JSONL line until the next file read supplies its newline. */
export function createSkillShadowLogCursor(): { push(chunk: string): string } {
  let pending = "";
  return {
    push(chunk: string): string {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end < 0) return "";
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      return complete;
    },
  };
}

function events(raw: string): ShadowEvent[] {
  const parsed: ShadowEvent[] = [];
  for (const line of raw.split("\n")) {
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object") parsed.push(event as ShadowEvent);
    } catch {
      // Ignore incomplete and malformed log lines.
    }
  }
  return parsed;
}

export interface SkillShadowSummary {
  observed: number;
  completed: number;
  potentialTokens: number;
}

export function summarizeSkillShadowLog(raw: string): SkillShadowSummary {
  const summary: SkillShadowSummary = {
    observed: 0,
    completed: 0,
    potentialTokens: 0,
  };
  const seen = new Set<string>();
  for (const event of events(raw)) {
    if (event.message === "skill_shadow_observed") summary.observed += 1;
    if (
      event.message !== "skill_shadow_complete" ||
      typeof event.eventId !== "string" ||
      seen.has(event.eventId)
    )
      continue;
    seen.add(event.eventId);
    summary.completed += 1;
    if (
      typeof event.potentialTokens === "number" &&
      Number.isFinite(event.potentialTokens) &&
      event.potentialTokens > 0
    )
      summary.potentialTokens += event.potentialTokens;
  }
  return summary;
}

/** Consumes event IDs even when notices are suppressed by shared usage. */
export function skillShadowNotices(
  raw: string,
  seen: Set<string>,
  soleLauncher: boolean,
): string[] {
  const lines: string[] = [];
  for (const event of events(raw)) {
    if (
      event.message !== "skill_shadow_complete" ||
      typeof event.eventId !== "string" ||
      seen.has(event.eventId)
    )
      continue;
    seen.add(event.eventId);
    if (
      !soleLauncher ||
      typeof event.skill !== "string" ||
      !/^[\w:.-]+$/.test(event.skill) ||
      typeof event.potentialTokens !== "number" ||
      !Number.isFinite(event.potentialTokens) ||
      event.potentialTokens <= 0
    )
      continue;
    lines.push(
      `Jev: skill "${event.skill}" looks reusable; ~${formatTokens(event.potentialTokens)} potential tokens after this task.`,
    );
  }
  return lines;
}

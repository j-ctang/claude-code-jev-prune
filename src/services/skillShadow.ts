import { join } from "node:path";
import type { AnthropicRequest } from "../types.js";
import type { SkillCatalog } from "./skillCatalog.js";

export interface SkillFinding {
  skill: string;
  potentialTokens: number;
}

export interface SkillCompletion extends SkillFinding {
  confidence: number;
  sessionId: string;
}

interface SessionState {
  goal: string;
  revision: number;
  pendingRevision?: number;
  active: Map<string, SkillFinding>;
  completed: Set<string>;
}

interface SkillShadowOptions {
  catalog: Pick<SkillCatalog, "entries">;
  judge: (goal: string, reply: string) => Promise<number>;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Project skills are observable only when every live launcher shares one project. */
export function skillRootsForProjects(userRoot: string, projects: readonly string[]): string[] {
  return projects.length === 1
    ? [userRoot, join(projects[0]!, ".claude", "skills")]
    : [userRoot];
}

function requestText(request: AnthropicRequest): string {
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      Object.values(value).forEach(visit);
  };
  visit(request.system);
  request.messages.forEach((message) => visit(message.content));
  return normalize(strings.join("\n"));
}

function taskGoal(
  request: AnthropicRequest,
  skillBodies: readonly string[],
): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    if (
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result")
    )
      continue;
    const raw =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter(
              (block) =>
                block.type === "text" && typeof block.text === "string",
            )
            .map((block) => String(block.text))
            .join("\n");
    let text = normalize(raw);
    for (const body of skillBodies) text = text.replace(body, "").trim();
    if (text) return text;
  }
  return "";
}

/** Advisory observation only. It never returns a modified request. */
export class SkillShadow {
  private static readonly MAX_SESSIONS = 128;
  private readonly options: SkillShadowOptions;
  private readonly sessions = new Map<string, SessionState>();
  private nextRevision = 1;

  constructor(options: SkillShadowOptions) {
    this.options = options;
  }

  observe(request: AnthropicRequest, sessionId: string): SkillFinding[] {
    if (!sessionId) return [];
    const text = requestText(request);
    const entries = this.options.catalog.entries();
    const matched = entries.filter((entry) => text.includes(entry.body));
    const goal = taskGoal(
      request,
      matched.map((entry) => entry.body),
    );
    const existing = this.sessions.get(sessionId);
    const state = existing ?? {
      goal,
      revision: this.nextRevision++,
      active: new Map<string, SkillFinding>(),
      completed: new Set<string>(),
    };
    if (state.goal !== goal) {
      state.goal = goal;
      state.revision = this.nextRevision++;
      delete state.pendingRevision;
      state.active.clear();
      state.completed.clear();
    }
    if (existing) this.sessions.delete(sessionId);
    else if (this.sessions.size >= SkillShadow.MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(sessionId, state);
    const findings: SkillFinding[] = [];
    for (const entry of matched) {
      if (state.active.has(entry.key) || state.completed.has(entry.key))
        continue;
      const finding = {
        skill: entry.skill,
        potentialTokens: entry.potentialTokens,
      };
      state.active.set(entry.key, finding);
      findings.push(finding);
    }
    return findings;
  }

  revision(sessionId: string): number {
    return this.sessions.get(sessionId)?.revision ?? 0;
  }

  async complete(
    sessionId: string,
    reply: string,
    revision: number,
  ): Promise<SkillCompletion[]> {
    const state = this.sessions.get(sessionId);
    if (
      !state ||
      state.revision !== revision ||
      state.pendingRevision === revision ||
      state.active.size === 0 ||
      !state.goal ||
      !reply.trim()
    )
      return [];
    state.pendingRevision = revision;
    let confidence: number;
    try {
      confidence = await this.options.judge(state.goal, reply.slice(0, 8000));
    } catch {
      if (state.pendingRevision === revision) delete state.pendingRevision;
      return [];
    }
    if (state.pendingRevision === revision) delete state.pendingRevision;
    if (
      this.sessions.get(sessionId) !== state ||
      state.revision !== revision ||
      !Number.isFinite(confidence) ||
      confidence < 0.95 ||
      confidence > 1
    )
      return [];
    const results = [...state.active.values()].map((finding) => ({
      ...finding,
      confidence,
      sessionId,
    }));
    for (const key of state.active.keys()) state.completed.add(key);
    state.active.clear();
    return results;
  }
}

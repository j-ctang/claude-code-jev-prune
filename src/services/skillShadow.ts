import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { AnthropicRequest } from "../types.js";

export interface SkillFinding {
  skill: string;
  potentialTokens: number;
}

export interface SkillCompletion extends SkillFinding {
  confidence: number;
  sessionId: string;
}

interface SkillEntry extends SkillFinding {
  body: string;
  key: string;
}

interface SessionState {
  goal: string;
  revision: number;
  pendingRevision?: number;
  active: Map<string, SkillFinding>;
  completed: Set<string>;
}

interface SkillShadowOptions {
  roots: readonly string[] | (() => readonly string[]);
  judge: (goal: string, reply: string) => Promise<number>;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function bodyOf(raw: string): string {
  const text = normalize(raw);
  if (!text.startsWith("---\n")) return text;
  const closing = text.indexOf("\n---\n", 4);
  return closing < 0 ? text : text.slice(closing + 5).trim();
}

function filesIn(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...filesIn(path));
    else if (entry.isFile() && entry.name === "SKILL.md") paths.push(path);
  }
  return paths;
}

function skillEntries(roots: readonly string[]): SkillEntry[] {
  const entries: SkillEntry[] = [];
  for (const root of roots) {
    for (const path of filesIn(root)) {
      try {
        const body = bodyOf(readFileSync(path, "utf8"));
        if (body.length < 80) continue;
        entries.push({
          skill: basename(join(path, "..")),
          body,
          key: createHash("sha256").update(body).digest("hex"),
          potentialTokens: Math.ceil(body.length / 4),
        });
      } catch {
        // Inaccessible or changed skill files are not candidates.
      }
    }
  }
  return entries;
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
    const entries = skillEntries(
      typeof this.options.roots === "function"
        ? this.options.roots()
        : this.options.roots,
    );
    const matched = entries.filter((entry) => text.includes(entry.body));
    const byBody = new Map<string, SkillEntry[]>();
    for (const entry of matched) {
      byBody.set(entry.body, [...(byBody.get(entry.body) ?? []), entry]);
    }
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
    for (const group of byBody.values()) {
      if (new Set(group.map((entry) => entry.skill)).size !== 1) continue;
      const entry = group[0];
      if (
        !entry ||
        state.active.has(entry.key) ||
        state.completed.has(entry.key)
      )
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

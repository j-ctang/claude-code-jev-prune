import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { AnthropicRequest } from "../types.js";
import { readTurn } from "./turn.js";

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
}

interface SessionState {
  goal: string;
  active: Map<string, SkillFinding>;
  completed: Set<string>;
}

interface SkillShadowOptions {
  roots: readonly string[];
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

/** Advisory observation only. It never returns a modified request. */
export class SkillShadow {
  private readonly options: SkillShadowOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: SkillShadowOptions) {
    this.options = options;
  }

  observe(request: AnthropicRequest, sessionId: string): SkillFinding[] {
    if (!sessionId) return [];
    const text = requestText(request);
    const entries = skillEntries(this.options.roots);
    const matched = entries.filter((entry) => text.includes(entry.body));
    const byBody = new Map<string, SkillEntry[]>();
    for (const entry of matched) {
      byBody.set(entry.body, [...(byBody.get(entry.body) ?? []), entry]);
    }
    const goal = normalize(readTurn(request).goal);
    const state = this.sessions.get(sessionId) ?? {
      goal,
      active: new Map<string, SkillFinding>(),
      completed: new Set<string>(),
    };
    if (state.goal !== goal) {
      state.goal = goal;
      state.active.clear();
      state.completed.clear();
    }
    this.sessions.set(sessionId, state);
    const findings: SkillFinding[] = [];
    for (const group of byBody.values()) {
      if (group.length !== 1) continue;
      const entry = group[0];
      if (!entry || state.active.has(entry.skill) || state.completed.has(entry.skill)) continue;
      const finding = { skill: entry.skill, potentialTokens: entry.potentialTokens };
      state.active.set(entry.skill, finding);
      findings.push(finding);
    }
    return findings;
  }

  async complete(sessionId: string, reply: string): Promise<SkillCompletion[]> {
    const state = this.sessions.get(sessionId);
    if (!state || state.active.size === 0 || !reply.trim()) return [];
    let confidence: number;
    try {
      confidence = await this.options.judge(state.goal, reply.slice(0, 8000));
    } catch {
      return [];
    }
    if (!Number.isFinite(confidence) || confidence < 0.95 || confidence > 1) return [];
    const results = [...state.active.values()].map((finding) => ({
      ...finding,
      confidence,
      sessionId,
    }));
    for (const finding of results) state.completed.add(finding.skill);
    state.active.clear();
    return results;
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const MAX_AGE_MS = 30_000;

export interface SkillEntry {
  readonly skill: string;
  readonly body: string;
  readonly key: string;
  readonly potentialTokens: number;
}

interface Options {
  roots: () => readonly string[];
  refreshIntervalMs?: number;
  now?: () => number;
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

async function filesIn(directory: string): Promise<string[]> {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const child of children) {
    const path = join(directory, child.name);
    if (child.isDirectory()) paths.push(...(await filesIn(path)));
    else if (child.isFile() && child.name === "SKILL.md") paths.push(path);
  }
  return paths;
}

async function loadEntries(roots: readonly string[]): Promise<readonly SkillEntry[]> {
  const paths = (await Promise.all(roots.map(filesIn))).flat().sort();
  const entries: SkillEntry[] = [];
  for (const path of paths) {
    try {
      const body = bodyOf(await readFile(path, "utf8"));
      if (body.length < 80) continue;
      entries.push({
        skill: basename(join(path, "..")),
        body,
        key: createHash("sha256").update(body).digest("hex"),
        potentialTokens: Math.ceil(body.length / 4),
      });
    } catch {
      // A changed or inaccessible file is not a candidate.
    }
  }
  const grouped = new Map<string, SkillEntry[]>();
  for (const entry of entries)
    grouped.set(entry.key, [...(grouped.get(entry.key) ?? []), entry]);
  const unique: SkillEntry[] = [];
  for (const group of grouped.values()) {
    if (new Set(group.map((entry) => entry.skill)).size !== 1) continue;
    unique.push(Object.freeze(group[0]!));
  }
  return Object.freeze(unique);
}

export class SkillCatalog {
  private readonly options: Options;
  private readonly intervalMs: number;
  private desiredKey = "";
  private snapshot: { key: string; at: number; entries: readonly SkillEntry[] } | undefined;
  private pending: { key: string; promise: Promise<void> } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: Options) {
    this.options = options;
    this.intervalMs = Math.min(options.refreshIntervalMs ?? 15_000, MAX_AGE_MS);
  }

  async start(): Promise<void> {
    await this.refreshIfNeeded();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refreshIfNeeded();
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  entries(): readonly SkillEntry[] {
    void this.refreshIfNeeded();
    const snapshot = this.snapshot;
    const now = this.options.now?.() ?? Date.now();
    return snapshot && snapshot.key === this.desiredKey && now - snapshot.at < MAX_AGE_MS
      ? snapshot.entries
      : [];
  }

  private refreshIfNeeded(): Promise<void> {
    let roots: readonly string[];
    try {
      roots = this.options.roots();
    } catch {
      this.snapshot = undefined;
      return Promise.resolve();
    }
    const key = JSON.stringify(roots);
    if (key !== this.desiredKey) {
      this.desiredKey = key;
      this.snapshot = undefined;
    }
    const now = this.options.now?.() ?? Date.now();
    if (this.pending?.key === key) return this.pending.promise;
    if (this.snapshot && now - this.snapshot.at < this.intervalMs)
      return Promise.resolve();
    const promise = loadEntries(roots)
      .then((entries) => {
        if (this.desiredKey === key)
          this.snapshot = { key, at: this.options.now?.() ?? Date.now(), entries };
      })
      .catch(() => undefined)
      .then(() => {
        if (this.pending?.key === key) this.pending = undefined;
      });
    this.pending = { key, promise };
    return promise;
  }
}

import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillCatalog } from "../src/services/skillCatalog.js";

const body = "Follow the complete documented procedure, inspect every result, verify all constraints, and report the final finding clearly.";

function skill(root: string, name: string, content = body): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${content}\n`);
}

test("loads one catalog snapshot and removes ambiguous bodies", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  try {
    skill(root, "pdf");
    const catalog = new SkillCatalog({ roots: () => [root] });
    await catalog.start();
    expect(catalog.entries()).toEqual([expect.objectContaining({ skill: "pdf", body })]);
    skill(root, "copy");
    expect(catalog.entries()).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not expose previous project entries while roots change", async () => {
  const first = mkdtempSync(join(tmpdir(), "catalog-a-"));
  const second = mkdtempSync(join(tmpdir(), "catalog-b-"));
  try {
    skill(first, "first");
    skill(second, "second", `${body} Extra instructions.`);
    let roots = [first];
    const catalog = new SkillCatalog({ roots: () => roots });
    await catalog.start();
    expect(catalog.entries()[0]?.skill).toBe("first");
    roots = [second];
    expect(catalog.entries()).toEqual([]);
    await catalog.start();
    expect(catalog.entries()[0]?.skill).toBe("second");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("expires a snapshot rather than serving stale entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-expiry-"));
  try {
    skill(root, "pdf");
    let now = 0;
    const catalog = new SkillCatalog({ roots: () => [root], now: () => now });
    await catalog.start();
    expect(catalog.entries()).toHaveLength(1);
    now = 30_001;
    expect(catalog.entries()).toEqual([]);
    await catalog.start();
    expect(catalog.entries()).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshes added, changed, and deleted skills without attributing old content", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-refresh-"));
  try {
    skill(root, "pdf");
    let now = 0;
    const catalog = new SkillCatalog({ roots: () => [root], now: () => now, refreshIntervalMs: 1 });
    await catalog.start();
    expect(catalog.entries().map((entry) => entry.skill)).toEqual(["pdf"]);

    skill(root, "report", `${body} The report procedure is different.`);
    now += 2;
    await catalog.start();
    expect(catalog.entries().map((entry) => entry.skill)).toEqual(["pdf", "report"]);

    skill(root, "pdf", `${body} Use the revised procedure.`);
    unlinkSync(join(root, "report", "SKILL.md"));
    now += 2;
    await catalog.start();
    expect(catalog.entries()).toEqual([
      expect.objectContaining({ skill: "pdf", body: `${body} Use the revised procedure.` }),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshes while the proxy is idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "catalog-idle-"));
  const catalog = new SkillCatalog({ roots: () => [root], refreshIntervalMs: 10 });
  try {
    skill(root, "pdf");
    await catalog.start();
    skill(root, "report", `${body} The report procedure is different.`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(catalog.entries().map((entry) => entry.skill)).toEqual(["pdf", "report"]);
  } finally {
    catalog.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillShadow } from "../src/services/skillShadow.js";
import type { AnthropicRequest } from "../src/types.js";

const body =
  "Follow this detailed skill procedure when creating the report. Check every page, record any layout defect, and rerender before delivery.";

describe("SkillShadow", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-shadow-"));
  beforeAll(() => {
    mkdirSync(join(root, "pdf"), { recursive: true });
    writeFileSync(
      join(root, "pdf", "SKILL.md"),
      `---\nname: pdf\ndescription: Reports\n---\n${body}\n`,
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("identifies full skill body in a request and deduplicates repeat appearances", () => {
    const shadow = new SkillShadow({ roots: [root], judge: async () => 1 });
    const request: AnthropicRequest = {
      messages: [{ role: "user", content: `Use the skill:\r\n${body}` }],
    };
    expect(shadow.observe(request, "session-a")).toEqual([
      expect.objectContaining({
        skill: "pdf",
        potentialTokens: Math.ceil(body.length / 4),
      }),
    ]);
    expect(shadow.observe(request, "session-a")).toEqual([]);
  });

  test("skips unknown and ambiguous skill bodies", () => {
    const other = mkdtempSync(join(tmpdir(), "skill-shadow-duplicate-"));
    mkdirSync(join(other, "copy"));
    writeFileSync(
      join(other, "copy", "SKILL.md"),
      `---\nname: copy\n---\n${body}`,
    );
    const shadow = new SkillShadow({
      roots: [root, other],
      judge: async () => 1,
    });
    expect(
      shadow.observe({ messages: [{ role: "user", content: body }] }, "s"),
    ).toEqual([]);
    expect(
      shadow.observe({ messages: [{ role: "user", content: "unknown" }] }, "s"),
    ).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  test("deduplicates the same skill installed in two projects", () => {
    const other = mkdtempSync(join(tmpdir(), "skill-shadow-same-"));
    mkdirSync(join(other, "pdf"));
    writeFileSync(join(other, "pdf", "SKILL.md"), `---\nname: pdf\n---\n${body}`);
    try {
      const shadow = new SkillShadow({ roots: [root, other], judge: async () => 1 });
      expect(shadow.observe({ messages: [{ role: "user", content: `Create report.\n${body}` }] }, "s")).toHaveLength(1);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  test("keeps distinct bodies that share a skill directory name", async () => {
    const other = mkdtempSync(join(tmpdir(), "skill-shadow-variant-"));
    const variant = "Use these alternate instructions for the report. Verify every chart, check every caption, and render the final document again before delivery.";
    mkdirSync(join(other, "pdf"));
    writeFileSync(join(other, "pdf", "SKILL.md"), `---\nname: pdf\n---\n${variant}`);
    try {
      const shadow = new SkillShadow({ roots: [root, other], judge: async () => 0.99 });
      expect(shadow.observe({ messages: [{ role: "user", content: `Create report.\n${body}\n${variant}` }] }, "s")).toHaveLength(2);
      expect(await shadow.complete("s", "Done.", shadow.revision("s"))).toHaveLength(2);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  test("records only high-confidence task completion", async () => {
    const low = new SkillShadow({ roots: [root], judge: async () => 0.8 });
    low.observe(
      { messages: [{ role: "user", content: `Create report.\n${body}` }] },
      "s",
    );
    expect(
      await low.complete("s", "Finished the report.", low.revision("s")),
    ).toEqual([]);

    const high = new SkillShadow({ roots: [root], judge: async () => 0.99 });
    high.observe(
      { messages: [{ role: "user", content: `Create report.\n${body}` }] },
      "s",
    );
    expect(
      await high.complete("s", "Finished the report.", high.revision("s")),
    ).toEqual([expect.objectContaining({ skill: "pdf", confidence: 0.99 })]);
    expect(
      await high.complete("s", "Finished the report.", high.revision("s")),
    ).toEqual([]);
  });

  test("refreshes skill roots supplied by active launchers", () => {
    let roots: string[] = [];
    const shadow = new SkillShadow({
      roots: () => roots,
      judge: async () => 1,
    });
    const request: AnthropicRequest = {
      messages: [{ role: "user", content: body }],
    };
    expect(shadow.observe(request, "s")).toEqual([]);
    roots = [root];
    expect(shadow.observe(request, "s")).toEqual([
      expect.objectContaining({ skill: "pdf" }),
    ]);
  });

  test("scores the user's task rather than an injected skill body", async () => {
    let scoredGoal = "";
    const shadow = new SkillShadow({
      roots: [root],
      judge: async (goal) => {
        scoredGoal = goal;
        return 0.99;
      },
    });
    shadow.observe(
      {
        messages: [
          { role: "user", content: "Create the quarterly report." },
          { role: "user", content: body },
        ],
      },
      "s",
    );
    await shadow.complete("s", "Report complete.", shadow.revision("s"));
    expect(scoredGoal).toBe("Create the quarterly report.");
  });

  test("does not apply an old response to a newer task in the same session", async () => {
    const shadow = new SkillShadow({ roots: [root], judge: async () => 0.99 });
    shadow.observe(
      { messages: [{ role: "user", content: `Make report A.\n${body}` }] },
      "s",
    );
    const oldRevision = shadow.revision("s");
    shadow.observe(
      { messages: [{ role: "user", content: `Make report B.\n${body}` }] },
      "s",
    );
    expect(
      await shadow.complete("s", "Report A complete.", oldRevision),
    ).toEqual([]);
  });

  test("drops a completion result if the task changes while Jev is scoring", async () => {
    let answer!: (confidence: number) => void;
    const shadow = new SkillShadow({
      roots: [root],
      judge: () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    });
    shadow.observe(
      { messages: [{ role: "user", content: `Make report A.\n${body}` }] },
      "s",
    );
    const pending = shadow.complete(
      "s",
      "Report A complete.",
      shadow.revision("s"),
    );
    shadow.observe(
      { messages: [{ role: "user", content: `Make report B.\n${body}` }] },
      "s",
    );
    answer(0.99);
    expect(await pending).toEqual([]);
  });

  test("scores only once while a completion judgment is in flight", async () => {
    let answer!: (confidence: number) => void;
    let calls = 0;
    const pending = new Promise<number>((resolve) => { answer = resolve; });
    const shadow = new SkillShadow({ roots: [root], judge: () => { calls += 1; return pending; } });
    shadow.observe({ messages: [{ role: "user", content: `Make report.\n${body}` }] }, "s");
    const revision = shadow.revision("s");
    const first = shadow.complete("s", "Done.", revision);
    const second = shadow.complete("s", "Done.", revision);
    answer(0.99);
    expect(await second).toEqual([]);
    expect(await first).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("evicts old sessions from the persistent observer", async () => {
    const shadow = new SkillShadow({ roots: [root], judge: async () => 0.99 });
    shadow.observe({ messages: [{ role: "user", content: `Make report.\n${body}` }] }, "old");
    const revision = shadow.revision("old");
    for (let index = 0; index < 129; index += 1)
      shadow.observe({ messages: [{ role: "user", content: `Make report ${index}.\n${body}` }] }, `new-${index}`);
    expect(await shadow.complete("old", "Done.", revision)).toEqual([]);
  });
});

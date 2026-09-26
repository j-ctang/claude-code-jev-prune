import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SkillShadow } from "../src/services/skillShadow.js";
import { SkillCatalog } from "../src/services/skillCatalog.js";

const root = mkdtempSync(join(tmpdir(), "skill-catalog-bench-"));
const bodies = Array.from({ length: 100 }, (_, index) =>
  `Skill ${index}: follow these detailed instructions for the current task. ${"check the output carefully. ".repeat(40)}`,
);
try {
  bodies.forEach((body, index) => {
    const dir = join(root, `skill-${index}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${index}\n---\n${body}`);
  });
  const catalog = new SkillCatalog({ roots: () => [root] });
  await catalog.start();
  const shadow = new SkillShadow({ catalog, judge: async () => 0 });
  const request = {
    messages: [{ role: "user" as const, content: `Do the task.\n${bodies[0]}\n${"context ".repeat(50_000)}` }],
  };
  const durations: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const start = performance.now();
    shadow.observe(request, `session-${index}`);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  process.stdout.write(`skills=100 requestChars=${request.messages[0]?.content.length} medianMs=${durations[15]?.toFixed(2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

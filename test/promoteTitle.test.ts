import { spawnSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "check-promote-title.sh");

type Pr = { title: string; base: string; head: string; headRepo?: string };

function check({ title, base, head, headRepo = "owner/repo" }: Pr) {
  return spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PR_TITLE: title,
      PR_BASE: base,
      PR_HEAD: head,
      PR_HEAD_REPO: headRepo,
      REPO: "owner/repo"
    }
  });
}

describe("check-promote-title", () => {
  it("passes a promote PR from staging into main", () => {
    expect(check({ title: "Promote staging to main", base: "main", head: "staging" }).status).toBe(0);
  });

  it("fails a PR into staging that uses the promote title", () => {
    const result = check({ title: "Fix proxy (Promote staging to main)", base: "staging", head: "fix/1" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/only for PRs from staging into main/);
  });

  it("matches the phrase case-insensitively", () => {
    expect(check({ title: "promote STAGING to Main", base: "staging", head: "fix/1" }).status).toBe(1);
  });

  it("fails a promote title from a fork branch named staging", () => {
    expect(
      check({ title: "Promote staging to main", base: "main", head: "staging", headRepo: "fork/repo" }).status
    ).toBe(1);
  });

  it("ignores PRs without the phrase", () => {
    expect(check({ title: "Fix proxy", base: "staging", head: "fix/1" }).status).toBe(0);
  });

  it("does not run the title as shell code", () => {
    const result = check({ title: "$(echo injected) Promote staging to main", base: "staging", head: "x" });
    expect(result.stdout + result.stderr).not.toMatch(/^injected/m);
    expect(result.status).toBe(1);
  });
});

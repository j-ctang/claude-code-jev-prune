import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillShadowLogFollower } from "../src/services/skillShadowLogFollower.js";

const event = (id: string, skill = "pdf") =>
  JSON.stringify({ message: "skill_shadow_complete", eventId: id, skill });

test("follows only appended events and decodes split UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tail-"));
  const path = join(dir, "events.log");
  try {
    writeFileSync(path, `${event("old")}\n`);
    const follower = createSkillShadowLogFollower(path);
    expect(follower.poll()).toEqual([]);
    const bytes = Buffer.from(`${event("new", "café")}\n`);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    appendFileSync(path, bytes.subarray(0, split));
    expect(follower.poll()).toEqual([]);
    appendFileSync(path, bytes.subarray(split));
    expect(follower.poll()).toEqual([expect.objectContaining({ eventId: "new", skill: "café" })]);
    expect(follower.poll()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discards a partial line when the log shrinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tail-"));
  const path = join(dir, "events.log");
  try {
    writeFileSync(path, "");
    const follower = createSkillShadowLogFollower(path);
    appendFileSync(path, event("old").slice(0, 25));
    expect(follower.poll()).toEqual([]);
    truncateSync(path, 0);
    expect(follower.poll()).toEqual([]);
    appendFileSync(path, `${event("new")}\n`);
    expect(follower.poll()).toEqual([expect.objectContaining({ eventId: "new" })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips malformed and oversized lines while retaining later events", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tail-"));
  const path = join(dir, "events.log");
  try {
    writeFileSync(path, "");
    const follower = createSkillShadowLogFollower(path);
    appendFileSync(path, `not-json\n${"x".repeat(70_000)}`);
    expect(follower.poll()).toEqual([]);
    appendFileSync(path, `\n${event("good")}\n`);
    expect(follower.poll()).toEqual([expect.objectContaining({ eventId: "good" })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resets a partial line when the file is replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tail-"));
  const path = join(dir, "events.log");
  try {
    writeFileSync(path, "");
    const follower = createSkillShadowLogFollower(path);
    appendFileSync(path, event("old").slice(0, 15));
    expect(follower.poll()).toEqual([]);
    const replacement = join(dir, "replacement.log");
    writeFileSync(replacement, `${event("new")}\n`);
    renameSync(replacement, path);
    expect(follower.poll()).toEqual([expect.objectContaining({ eventId: "new" })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumes when a missing log appears", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadow-tail-"));
  const path = join(dir, "events.log");
  try {
    const follower = createSkillShadowLogFollower(path);
    expect(follower.poll()).toEqual([]);
    writeFileSync(path, `${event("new")}\n`);
    expect(follower.poll()).toEqual([expect.objectContaining({ eventId: "new" })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

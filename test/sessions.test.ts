import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  liveSessions,
  readSessionProjects,
  registerSession,
  unregisterSession,
  wasShared,
} from "../src/sessions.js";

test("counts live launchers and forgets crashed ones", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "jev-sessions-")), "5590");
  expect(liveSessions(directory)).toEqual([]);

  registerSession(directory, process.pid);
  writeFileSync(join(directory, "999999999"), "");
  writeFileSync(join(directory, "not-a-pid"), "");
  expect(liveSessions(directory)).toEqual([process.pid]);

  unregisterSession(directory, process.pid);
  expect(liveSessions(directory)).toEqual([]);
});

test("remembers when a proxy has served concurrent launchers", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "jev-shared-sessions-")), "5590");
  registerSession(directory, process.pid);
  expect(wasShared(directory)).toBe(false);
  registerSession(directory, process.ppid);
  expect(wasShared(directory)).toBe(true);
  unregisterSession(directory, process.ppid);
  expect(wasShared(directory)).toBe(true);
  unregisterSession(directory, process.pid);
  registerSession(directory, process.pid);
  expect(wasShared(directory)).toBe(false);
  unregisterSession(directory, process.pid);
});

test("reads project roots only from live launchers", () => {
  const directory = join(
    mkdtempSync(join(tmpdir(), "jev-session-projects-")),
    "5590",
  );
  registerSession(directory, process.pid, "/tmp/project-a");
  writeFileSync(join(directory, "999999999"), "/tmp/stale-project");
  expect(readSessionProjects(directory)).toEqual(["/tmp/project-a"]);
  unregisterSession(directory, process.pid);
});

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("one command sets up once and launches Claude on every run", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-bootstrap-"));
  const project = join(root, "project");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(project);
  mkdirSync(join(root, "dist"));
  mkdirSync(fakeBin);
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const bootstrap = join(root, "jev-prune");
  copyFileSync(join(process.cwd(), "jev-prune"), bootstrap);
  chmodSync(bootstrap, 0o755);
  writeFileSync(join(fakeBin, "npm"),
    '#!/bin/sh\nif [ "$1" = ci ]; then mkdir -p "$JEV_TEST_ROOT/node_modules"; printf "install\\n" >> "$JEV_TEST_LOG"; fi\nexit 0\n',
    { mode: 0o755 });
  writeFileSync(join(root, "dist", "setup.js"),
    "import { appendFileSync, writeFileSync } from 'node:fs'; appendFileSync(process.env.JEV_TEST_LOG, 'setup\\n'); writeFileSync(new URL('../.env', import.meta.url), 'TYPESAFE_API_KEY=tsf_test\\n');");
  writeFileSync(join(root, "dist", "launch.js"),
    "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.JEV_TEST_LOG, 'launch\\n');");
  const log = join(root, "events.txt");
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, JEV_TEST_ROOT: root, JEV_TEST_LOG: log };

  const first = spawnSync(process.execPath, [bootstrap, project], { cwd: root, env });
  const second = spawnSync(process.execPath, [bootstrap, project], { cwd: root, env });
  writeFileSync(join(root, ".env"), "TYPESAFE_API_KEY=tsf_replace_with_your_key\n");
  const placeholder = spawnSync(process.execPath, [bootstrap, project], { cwd: root, env });
  const rerunSetup = spawnSync(process.execPath, [bootstrap, "--setup", project], { cwd: root, env });

  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  expect(placeholder.status).toBe(0);
  expect(rerunSetup.status).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("install\nsetup\nlaunch\nlaunch\nsetup\nlaunch\nsetup\nlaunch\n");
});

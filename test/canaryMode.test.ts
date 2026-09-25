import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanaryMode } from "../src/services/canaryMode.js";

test("remembers automatic pruning across proxy restarts", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "jev-canary-")), "mode.json");
  const first = new CanaryMode(path);
  expect(first.autoPrune).toBe(false);
  first.setAutoPrune(true);
  expect(new CanaryMode(path).autoPrune).toBe(true);
  first.setAutoPrune(false);
  expect(new CanaryMode(path).autoPrune).toBe(false);
});

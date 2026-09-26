import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canaryAutoPrune } from "../src/services/canary.js";
import { routeChoice } from "../src/services/modelRouter.js";

const statePath = async () =>
  join(await mkdtemp(join(tmpdir(), "jev-choice-")), "state.json");

test("remembers automatic pruning across proxy restarts", async () => {
  const path = await statePath();
  const first = canaryAutoPrune(path);
  expect(first.value).toBe(false);
  first.set(true);
  expect(canaryAutoPrune(path).value).toBe(true);
  first.set(false);
  expect(canaryAutoPrune(path).value).toBe(false);
});

test("routing starts at ask and remembers the answer", async () => {
  const path = await statePath();
  const first = routeChoice(path);
  expect(first.value).toBe("ask");
  first.set("auto");
  expect(routeChoice(path).value).toBe("auto");
  first.set("off");
  expect(routeChoice(path).value).toBe("off");
});

test("keeps the file formats earlier versions saved", async () => {
  const path = await statePath();
  await writeFile(`${path}.canary-mode.json`, '{"autoPrune":true}');
  await writeFile(`${path}.route-mode.json`, '{"choice":"off"}');

  expect(canaryAutoPrune(path).value).toBe(true);
  expect(routeChoice(path).value).toBe("off");
  routeChoice(path).set("auto");
  expect(await readFile(`${path}.route-mode.json`, "utf8")).toBe(
    '{"choice":"auto"}',
  );
});

test("a malformed or invalid file keeps the fallback", async () => {
  const path = await statePath();
  await writeFile(`${path}.canary-mode.json`, "{not json");
  await writeFile(`${path}.route-mode.json`, '{"choice":"ask-later"}');

  expect(canaryAutoPrune(path, true).value).toBe(true);
  expect(routeChoice(path).value).toBe("ask");
});

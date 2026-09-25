import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteMode, routeModePath } from "../src/services/routeMode.js";

test("starts at ask and remembers the answer across restarts", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "jev-route-")), "mode.json");
  const first = new RouteMode(path);
  expect(first.choice).toBe("ask");
  first.set("auto");
  expect(new RouteMode(path).choice).toBe("auto");
  first.set("off");
  expect(new RouteMode(path).choice).toBe("off");
});

test("is saved next to the pruning state", () => {
  expect(routeModePath("/x/state.json")).toBe("/x/state.json.route-mode.json");
});

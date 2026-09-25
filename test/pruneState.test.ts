import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStateStore,
  type Rewrite,
} from "../src/services/pruneState.js";

async function statePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jev-prune-state-"));
  return join(directory, "nested", "state.json");
}

test("saves and loads a snapshot with owner-only permissions", async () => {
  const path = await statePath();
  const store = createFileStateStore(path);
  const snapshot = {
    drops: ["drop-a"],
    keeps: ["keep-a"],
    rewrites: [
      ["stub-a", { kind: "stub", text: "[jev-prune] Output removed." }],
      ["trim-a", { kind: "trim", keepTokens: 2_000 }],
    ] as Array<[string, Rewrite]>,
    lastFullScoreTokens: [["session-a", 95_000]] as Array<[string, number]>,
    lastScoredGoals: [["session-a", "Fix auth."]] as Array<[string, string]>,
    seenSessions: ["session-a"],
  };

  store.save(snapshot);

  expect(store.load()).toEqual(snapshot);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
});

test("ignores missing, corrupt, and unknown-version state files", async () => {
  const path = await statePath();
  const store = createFileStateStore(path);

  expect(store.load()).toBeUndefined();
  store.save({
    drops: [],
    keeps: [],
    rewrites: [],
    lastFullScoreTokens: [],
    lastScoredGoals: [],
    seenSessions: [],
  });
  await writeFile(path, "{not json");
  expect(store.load()).toBeUndefined();
  await writeFile(path, JSON.stringify({ version: 99, drops: ["x"] }));
  expect(store.load()).toBeUndefined();
});

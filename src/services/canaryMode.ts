import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";

/** Where the canary choice is saved, next to the pruning state. */
export function canaryModePath(statePath: string): string {
  return `${statePath}.canary-mode.json`;
}

/** The user's persistent choice to prune automatically on canary misses. */
export class CanaryMode {
  /** `autoPrune` is the default until the user saves a choice. */
  constructor(
    private readonly path: string,
    public autoPrune = false,
  ) {
    // A missing or malformed preference keeps the default.
    const saved = readJson(path);
    if (
      typeof saved === "object" &&
      saved !== null &&
      "autoPrune" in saved &&
      typeof saved.autoPrune === "boolean"
    ) {
      this.autoPrune = saved.autoPrune;
    }
  }

  setAutoPrune(enabled: boolean): void {
    writeJsonAtomic(this.path, { autoPrune: enabled });
    this.autoPrune = enabled;
  }
}

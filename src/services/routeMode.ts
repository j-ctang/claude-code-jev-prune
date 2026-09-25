import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";

export type RouteChoice = "ask" | "auto" | "off";

/** Where the routing choice is saved, next to the pruning state. */
export function routeModePath(statePath: string): string {
  return `${statePath}.route-mode.json`;
}

/** The user's saved model routing choice; `ask` until they answer. */
export class RouteMode {
  choice: RouteChoice = "ask";

  constructor(private readonly path: string) {
    // A missing or malformed choice keeps `ask`.
    const saved = readJson(path);
    if (
      typeof saved === "object" &&
      saved !== null &&
      "choice" in saved &&
      (saved.choice === "auto" || saved.choice === "off")
    ) {
      this.choice = saved.choice;
    }
  }

  set(choice: "auto" | "off"): void {
    writeJsonAtomic(this.path, { choice });
    this.choice = choice;
  }
}

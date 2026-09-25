import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** The user's persistent choice to prune automatically on canary misses. */
export class CanaryMode {
  /** `autoPrune` is the default until the user saves a choice. */
  constructor(
    private readonly path: string,
    public autoPrune = false,
  ) {
    try {
      const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof saved === "object" &&
        saved !== null &&
        "autoPrune" in saved &&
        typeof saved.autoPrune === "boolean"
      ) {
        this.autoPrune = saved.autoPrune;
      }
    } catch {
      // A missing or malformed preference keeps the default.
    }
  }

  setAutoPrune(enabled: boolean): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ autoPrune: enabled }), {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    this.autoPrune = enabled;
  }
}

import { readJson, writeJsonAtomic } from "../utils/jsonFile.js";

/**
 * A choice the user saves with a slash command. It is stored as
 * `{ [field]: value }` so the proxy remembers it across restarts.
 */
export class SavedChoice<T> {
  value: T;

  constructor(
    private readonly path: string,
    private readonly field: string,
    fallback: T,
    isValid: (value: unknown) => value is T,
  ) {
    // A missing or malformed file keeps the fallback.
    const saved = readJson(path);
    const value: unknown =
      typeof saved === "object" && saved !== null
        ? Reflect.get(saved, field)
        : undefined;
    this.value = isValid(value) ? value : fallback;
  }

  /** Throws, keeping the old value, if the file can't be written. */
  set(value: T): void {
    writeJsonAtomic(this.path, { [this.field]: value });
    this.value = value;
  }
}

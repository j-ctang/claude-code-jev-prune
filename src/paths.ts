import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Jev Prune checkout; compiled files live one level down in dist/. */
export const repository = dirname(dirname(fileURLToPath(import.meta.url)));

export const logPath = join(homedir(), ".claude", "jev-prune.log");

/** Slash command files that setup copies into ~/.claude/commands. */
export const slashCommands = [
  "jev-prune.md",
  "jev-prune-auto.md",
  "jev-prune-auto-off.md",
] as const;

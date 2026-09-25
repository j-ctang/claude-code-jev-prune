import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Jev Prune keeps its files under ~/.claude. The launcher scripts read
 * every path from here so they cannot disagree. Checkout paths live in
 * checkout.ts.
 */

const claudeHome = join(homedir(), ".claude");

export const logPath = join(claudeHome, "jev-prune.log");

export const claudeSettingsPath = join(claudeHome, "settings.json");

export const commandsDirectory = join(claudeHome, "commands");

/** Slash command files that setup copies into ~/.claude/commands. */
export const slashCommands = [
  "jev-prune.md",
  "jev-prune-auto.md",
  "jev-prune-auto-off.md",
] as const;

/** Launchers sharing the proxy on `port` register here. */
export function sessionsDirectory(port: number): string {
  return join(claudeHome, "jev-prune-sessions", String(port));
}

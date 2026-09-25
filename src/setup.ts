import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parse } from "dotenv";
import { findCanaryCandidates, type CanaryCandidate } from "./setupCanary.js";
import { CanaryMode } from "./services/canaryMode.js";
import { repository, slashCommands } from "./paths.js";

function setEnv(raw: string, name: string, value: string): string {
  const line = `${name}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  return pattern.test(raw)
    ? raw.replace(pattern, line)
    : `${raw.trimEnd()}\n${line}\n`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: npm run setup -- --project /path/to/your/project\n",
    );
    return;
  }
  // Echo goes through this stream so the API key can be typed unseen.
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const cli = createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  });
  const askSecret = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await cli.question("");
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  };
  try {
    const index = process.argv.indexOf("--project");
    const supplied = index >= 0 ? process.argv[index + 1] : undefined;
    const projectAnswer =
      supplied ??
      (await cli.question(`Claude project directory [${process.cwd()}]: `));
    const project = resolve(projectAnswer.trim() || process.cwd());
    const envPath = join(repository, ".env");
    let raw = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const existing = parse(raw);
    if (
      !existing.TYPESAFE_API_KEY ||
      existing.TYPESAFE_API_KEY === "tsf_replace_with_your_key"
    ) {
      const key = (
        process.env.TYPESAFE_API_KEY ||
        (await askSecret("TypeSafe API key (hidden while you type): "))
      ).trim();
      if (!key || /[\r\n]/.test(key))
        throw new Error("A TypeSafe API key is required.");
      raw = setEnv(raw, "TYPESAFE_API_KEY", key);
    }

    const paths = [
      join(project, "CLAUDE.md"),
      join(project, "AGENTS.md"),
      join(homedir(), ".claude", "CLAUDE.md"),
      join(homedir(), ".codex", "AGENTS.md"),
    ];
    const candidates: CanaryCandidate[] = paths.flatMap((path) => {
      if (!existsSync(path)) return [];
      return findCanaryCandidates(readFileSync(path, "utf8"), path);
    });
    let prefix = "";
    if (candidates.length > 0) {
      for (const [candidateIndex, candidate] of candidates.entries()) {
        process.stdout.write(
          `${candidateIndex + 1}. ${candidate.file}: ${JSON.stringify(candidate.prefix)}\n`,
        );
      }
      const selection =
        candidates.length === 1
          ? await cli.question("Is this your canary? [y/N]: ")
          : await cli.question(
              "Is one of these your canary? Enter its number, or press Enter to skip: ",
            );
      const choice =
        candidates.length === 1 && /^y(?:es)?$/i.test(selection.trim())
          ? 1
          : Number(selection.trim());
      if (
        Number.isInteger(choice) &&
        choice >= 1 &&
        choice <= candidates.length
      ) {
        prefix = candidates[choice - 1]?.prefix ?? "";
      }
    } else {
      process.stdout.write(
        "No response canary found. Canary checks will stay off.\n",
      );
    }
    raw = setEnv(raw, "JEV_CANARY_PREFIX", prefix);
    raw = setEnv(raw, "JEV_CANARY_ACTION", "notice");
    raw = setEnv(raw, "JEV_PRUNE_ENABLED", "true");
    raw = setEnv(raw, "JEV_PRUNE_NOTIFY", "true");
    writeFileSync(envPath, raw, { mode: 0o600 });
    chmodSync(envPath, 0o600);
    const statePath =
      parse(raw).JEV_PRUNE_STATE_PATH ||
      join(homedir(), ".claude", "jev-prune-state.json");
    new CanaryMode(`${statePath}.canary-mode.json`).setAutoPrune(false);

    const commandDirectory = join(homedir(), ".claude", "commands");
    mkdirSync(commandDirectory, { recursive: true, mode: 0o700 });
    for (const command of slashCommands) {
      copyFileSync(
        join(repository, "commands", command),
        join(commandDirectory, command),
      );
    }
    process.stdout.write("Setup saved.\n");
  } finally {
    cli.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Setup failed"}\n`,
  );
  process.exitCode = 1;
});

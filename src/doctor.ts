import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, loadConfig, parsePort, type Config } from "./config.js";
import { envPath, loadInstallEnv, repository } from "./checkout.js";
import {
  claudeSettingsPath,
  commandsDirectory,
  logPath,
  slashCommands,
} from "./installation.js";
import { ProxyClient } from "./proxyClient.js";

interface Check {
  ok: boolean | "warn";
  label: string;
  fix?: string;
}

function claudeSettingsEnv(): Record<string, unknown> {
  try {
    const settings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    return settings.env ?? {};
  } catch {
    return {};
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  loadInstallEnv();
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    ok: major >= 20,
    label: `Node.js ${process.versions.node}`,
    fix: "Install Node.js 20 or newer.",
  });

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  checks.push(
    claude.status === 0
      ? { ok: true, label: `Claude Code ${claude.stdout.trim()}` }
      : {
          ok: false,
          label: "Claude Code CLI not found",
          fix: "Install Claude Code and check that `claude` runs in your terminal.",
        },
  );

  let config: Config | undefined;
  try {
    config = loadConfig(process.env);
    checks.push({ ok: true, label: "Settings in .env are valid" });
  } catch (error) {
    checks.push({
      ok: false,
      label: error instanceof Error ? error.message : "Settings are invalid",
      fix: existsSync(envPath)
        ? "Fix the value in .env, or run jev-prune --setup."
        : "Run jev-prune to finish setup.",
    });
  }

  if (config?.pruningEnabled && config.jevApiKey) {
    checks.push(
      (await reachable(config.jevBaseUrl))
        ? { ok: true, label: `TypeSafe reachable at ${config.jevBaseUrl}` }
        : {
            ok: false,
            label: `Cannot reach TypeSafe at ${config.jevBaseUrl}`,
            fix: "Check your network. Requests still go through, unpruned.",
          },
    );
  } else if (config && !config.pruningEnabled) {
    checks.push({
      ok: "warn",
      label: "Pruning is off (JEV_PRUNE_ENABLED=false)",
    });
  }

  let port = DEFAULT_PORT;
  try {
    port = parsePort(process.env);
  } catch {
    // The settings check above already reports a bad PORT.
  }
  try {
    const health = await new ProxyClient(port).probe();
    checks.push({
      ok: true,
      label: health
        ? `Proxy running on port ${port}`
        : `Port ${port} is free; the proxy starts with jev-prune`,
    });
  } catch (error) {
    checks.push({
      ok: false,
      label: error instanceof Error ? error.message : `Port ${port} is busy`,
      fix: "Set a different PORT in .env.",
    });
  }

  const stale = slashCommands.filter((name) => {
    const installed = join(commandsDirectory, name);
    return (
      !existsSync(installed) ||
      readFileSync(installed, "utf8") !==
        readFileSync(join(repository, "commands", name), "utf8")
    );
  });
  checks.push(
    stale.length === 0
      ? { ok: true, label: "Slash commands installed" }
      : {
          ok: "warn",
          label: `Slash commands missing or outdated: ${stale.join(", ")}`,
          fix: "Run jev-prune --setup.",
        },
  );

  const settingsEnv = claudeSettingsEnv();
  if (typeof settingsEnv.ANTHROPIC_BASE_URL === "string") {
    checks.push({
      ok: false,
      label: `~/.claude/settings.json sets ANTHROPIC_BASE_URL to ${settingsEnv.ANTHROPIC_BASE_URL}, which bypasses the proxy`,
      fix: "Remove it from settings.json and set ANTHROPIC_UPSTREAM_URL in .env instead.",
    });
  }
  for (const name of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    if (process.env[name] || settingsEnv[name]) {
      checks.push({
        ok: false,
        label: `${name} is set; Claude Code then skips the proxy`,
        fix: "Jev Prune only works with the Anthropic API.",
      });
    }
  }

  for (const check of checks) {
    const mark =
      check.ok === true ? "ok  " : check.ok === "warn" ? "warn" : "FAIL";
    process.stdout.write(`${mark}  ${check.label}\n`);
    if (check.ok !== true && check.fix)
      process.stdout.write(`      ${check.fix}\n`);
  }
  process.stdout.write(`Log: ${logPath}\n`);
  if (checks.some((check) => check.ok === false)) process.exitCode = 1;
}

void main();

export interface Config {
  port: number;
  pruningEnabled: boolean;
  pruneThreshold: number;
  triggerTokens: number;
  targetTokens: number;
  notify: boolean;
  keepRecent: number;
  excludeTools: ReadonlySet<string>;
  debug: boolean;
  jevApiKey?: string;
  jevBaseUrl: string;
  jevModel: string;
  jevTimeoutMs: number;
  anthropicUpstreamUrl: string;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function parseUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const pruningEnabled = parseBoolean(
    env.JEV_PRUNE_ENABLED ?? "true",
    "JEV_PRUNE_ENABLED",
  );
  const pruneThreshold = parseInteger(
    env.JEV_PRUNE_THRESHOLD ?? "120000",
    "JEV_PRUNE_THRESHOLD",
    0,
  );
  const triggerTokens = parseInteger(
    env.JEV_PRUNE_TRIGGER_TOKENS ?? "140000",
    "JEV_PRUNE_TRIGGER_TOKENS",
    0,
  );
  if (triggerTokens < pruneThreshold) {
    throw new Error(
      "JEV_PRUNE_TRIGGER_TOKENS must be greater than or equal to JEV_PRUNE_THRESHOLD",
    );
  }
  const targetTokens = parseInteger(
    env.JEV_PRUNE_TARGET_TOKENS ?? "80000",
    "JEV_PRUNE_TARGET_TOKENS",
    0,
  );
  if (targetTokens > pruneThreshold) {
    throw new Error(
      "JEV_PRUNE_TARGET_TOKENS must be less than or equal to JEV_PRUNE_THRESHOLD",
    );
  }
  if (pruningEnabled && !env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY is required when pruning is enabled");
  }

  return {
    port: parseInteger(env.PORT ?? "5590", "PORT", 1, 65_535),
    pruningEnabled,
    pruneThreshold,
    triggerTokens,
    targetTokens,
    notify: parseBoolean(env.JEV_PRUNE_NOTIFY ?? "true", "JEV_PRUNE_NOTIFY"),
    keepRecent: parseInteger(
      env.JEV_PRUNE_KEEP_RECENT ?? "5",
      "JEV_PRUNE_KEEP_RECENT",
      0,
    ),
    excludeTools: new Set(
      (env.JEV_PRUNE_EXCLUDE_TOOLS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    debug: parseBoolean(env.JEV_PRUNE_DEBUG ?? "false", "JEV_PRUNE_DEBUG"),
    ...(env.TYPESAFE_API_KEY ? { jevApiKey: env.TYPESAFE_API_KEY } : {}),
    jevBaseUrl: parseUrl(
      env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
      "TYPESAFE_BASE_URL",
    ),
    jevModel: env.JEV_MODEL ?? "jev-latest",
    jevTimeoutMs: parseInteger(
      env.JEV_TIMEOUT_MS ?? "2000",
      "JEV_TIMEOUT_MS",
      1,
    ),
    anthropicUpstreamUrl: parseUrl(
      env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com",
      "ANTHROPIC_UPSTREAM_URL",
    ),
  };
}

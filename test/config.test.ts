import { loadConfig, withoutCredentials } from "../src/config.js";

describe("loadConfig", () => {
  test("loads documented defaults", () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "secret" });

    expect(config.port).toBe(5590);
    expect(config.pruneThreshold).toBe(120_000);
    expect(config.triggerTokens).toBe(140_000);
    expect(config.targetTokens).toBe(80_000);
    expect(config.rescoreTokens).toBe(20_000);
    expect(config.resumeNoticeTokens).toBe(60_000);
    expect(config.supersede).toBe(true);
    expect(config.trim).toBe(true);
    expect([...config.trimTools]).toEqual(["Bash"]);
    expect(config.trimMinTokens).toBe(10_000);
    expect(config.trimKeepTokens).toBe(2_000);
    expect(config.statePath).toMatch(/\.claude\/jev-prune-state\.json$/);
    expect(
      loadConfig({ TYPESAFE_API_KEY: "secret", JEV_PRUNE_STATE_PATH: "" }).statePath,
    ).toBe(config.statePath);
    expect(config.notify).toBe(true);
    expect(config.skillShadow).toBe(false);
    expect(config.keepRecent).toBe(5);
    expect(config.jevModel).toBe("jev-latest");
    expect(config.jevBaseUrl).toBe("https://api.typesafe.ai");
    expect(config.anthropicUpstreamUrl).toBe("https://api.anthropic.com");
  });

  test("treats the example placeholder key as no key", () => {
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: "tsf_replace_with_your_key" }),
    ).toThrow("TYPESAFE_API_KEY is required");
    expect(
      loadConfig({
        TYPESAFE_API_KEY: "tsf_replace_with_your_key",
        JEV_PRUNE_ENABLED: "false",
      }).jevApiKey,
    ).toBeUndefined();
  });

  test("hides credentials in a URL shown to the user", () => {
    expect(withoutCredentials("https://user:secret@gateway.example/v1")).toBe(
      "https://gateway.example/v1",
    );
  });

  test("rejects a trigger below the normal threshold", () => {
    expect(() =>
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        JEV_PRUNE_THRESHOLD: "100000",
        JEV_PRUNE_TRIGGER_TOKENS: "90000",
      }),
    ).toThrow(
      "JEV_PRUNE_TRIGGER_TOKENS must be greater than or equal to JEV_PRUNE_THRESHOLD",
    );
  });

  test("rejects a target above the normal threshold", () => {
    expect(() =>
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        JEV_PRUNE_THRESHOLD: "100000",
        JEV_PRUNE_TARGET_TOKENS: "110000",
      }),
    ).toThrow(
      "JEV_PRUNE_TARGET_TOKENS must be less than or equal to JEV_PRUNE_THRESHOLD",
    );
  });

  test("never allows Read to be trimmed and validates trim sizes", () => {
    const config = loadConfig({
      TYPESAFE_API_KEY: "secret",
      JEV_PRUNE_TRIM_TOOLS: "Bash, Read,Grep",
    });

    expect([...config.trimTools]).toEqual(["Bash", "Grep"]);
    expect(() =>
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        JEV_PRUNE_TRIM_MIN_TOKENS: "3000",
        JEV_PRUNE_TRIM_KEEP_TOKENS: "2000",
      }),
    ).toThrow(
      "JEV_PRUNE_TRIM_KEEP_TOKENS must be less than half of JEV_PRUNE_TRIM_MIN_TOKENS",
    );
  });

  test("allows a missing Jev key only when pruning is disabled", () => {
    expect(loadConfig({ JEV_PRUNE_ENABLED: "false" }).pruningEnabled).toBe(
      false,
    );
    expect(() => loadConfig({ JEV_PRUNE_ENABLED: "true" })).toThrow(
      "TYPESAFE_API_KEY is required when pruning is enabled",
    );
  });

  test.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["JEV_PRUNE_KEEP_RECENT", "-1"],
    ["JEV_TIMEOUT_MS", "1.5"],
  ])("rejects invalid integer %s=%s", (name, value) => {
    expect(() =>
      loadConfig({ TYPESAFE_API_KEY: "secret", [name]: value }),
    ).toThrow(`${name} must be an integer`);
  });

  test("rejects invalid boolean values", () => {
    expect(() =>
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        JEV_PRUNE_DEBUG: "yes",
      }),
    ).toThrow("JEV_PRUNE_DEBUG must be true or false");
  });

  test("enables opt-in skill observation", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "secret", JEV_PRUNE_SKILL_SHADOW: "true" }).skillShadow).toBe(true);
    expect(() => loadConfig({ JEV_PRUNE_ENABLED: "false", JEV_PRUNE_SKILL_SHADOW: "true" })).toThrow("TYPESAFE_API_KEY is required when skill shadow mode is enabled");
  });

  test("normalizes comma-separated excluded tools", () => {
    const config = loadConfig({
      TYPESAFE_API_KEY: "secret",
      JEV_PRUNE_EXCLUDE_TOOLS: " test, grep ,,",
    });

    expect([...config.excludeTools]).toEqual(["test", "grep"]);
  });

  test("rejects non-http upstream URLs", () => {
    expect(() =>
      loadConfig({
        TYPESAFE_API_KEY: "secret",
        ANTHROPIC_UPSTREAM_URL: "file:///tmp/upstream",
      }),
    ).toThrow("ANTHROPIC_UPSTREAM_URL must use http or https");
  });
});

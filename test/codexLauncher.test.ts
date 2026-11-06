import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { launchCodex } from "../src/codexLauncher.js";
import { tempDir } from "./tempDir.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    }),
  );
});
async function setup(wait = false) {
  const home = tempDir("jev-codex-launch-");
  const receipt = join(home, "receipt.json");
  writeFileSync(
    join(home, "codex"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = args.find(a => a.startsWith('model_providers.jev_prune.base_url='));
const url = value ? JSON.parse(value.slice(value.indexOf('=')+1)) : '';
(async()=>{
 const response = await fetch(url+'/responses', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'});
 fs.writeFileSync(process.env.RECEIPT, JSON.stringify({args,url,status:response.status,body:await response.text(),cwd:process.cwd(),pid:process.pid}));
 ${wait ? "setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));" : "process.exit(7);"}
})().catch(e=>{console.error(e.message);process.exit(9)});
`,
    { mode: 0o755 },
  );
  const upstream = createServer((_req, res) => res.end("upstream OK"));
  servers.push(upstream);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const env = {
    ...process.env,
    PATH: home + ":" + process.env.PATH,
    CODEX_HOME: home,
    RECEIPT: receipt,
    TYPESAFE_API_KEY: "",
    JEV_PRUNE_ENABLED: "false",
    JEV_CODEX_UPSTREAM_URL: `http://127.0.0.1:${address.port}/v1`,
    JEV_CODEX_STATE_PATH: join(home, "state.json"),
  };
  return { home, receipt, env };
}

it("routes invocation-only provider overrides and propagates child exit status", async () => {
  const { receipt, env, home } = await setup();
  const code = await launchCodex(
    ["exec", "--model", "test-model", "hello"],
    env,
  );
  expect(code).toBe(7);
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  expect(observed.status).toBe(200);
  expect(observed.body).toBe("upstream OK");
  expect(observed.args).toContain('model_provider="jev_prune"');
  expect(observed.args).toContain(
    "model_providers.jev_prune.requires_openai_auth=true",
  );
  expect(observed.args).toContain(
    "model_providers.jev_prune.supports_websockets=false",
  );
  expect(observed.args).toContain("hello");
  await expect(fetch(observed.url + "/responses")).rejects.toThrow();
  expect(existsSync(join(home, "config.toml"))).toBe(false);
  expect(existsSync(join(home, "auth.json"))).toBe(false);
});

it.each([
  ["-c", 'model_provider="other"'],
  ["--config=model_provider=x"],
  ["--profile", "other"],
  ["--oss"],
  ["--local-provider", "ollama"],
])("rejects provider-bypassing arguments: %j", async (...args) => {
  const { env, receipt } = await setup();
  await expect(launchCodex(args, env)).rejects.toThrow(/routing/i);
  expect(existsSync(receipt)).toBe(false);
});

it("reports a missing CLI and releases the proxy", async () => {
  const { env } = await setup();
  await expect(
    launchCodex([], { ...env, PATH: "/nonexistent" }),
  ).rejects.toThrow(/Codex CLI/);
});

it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
  "cleans up the child and proxy on %s",
  async (signal) => {
    const { env, receipt } = await setup(true);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/codexLaunch.ts", "exec", "hello"],
      { env, stdio: "pipe" },
    );
    const exit = once(child, "exit");
    try {
      for (let attempt = 0; !existsSync(receipt) && attempt < 100; attempt++)
        await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(receipt)).toBe(true);
      const observed = JSON.parse(readFileSync(receipt, "utf8"));
      child.kill(signal);
      expect((await exit)[0]).toBe(
        signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143,
      );
      expect(() => process.kill(observed.pid, 0)).toThrow();
      await expect(fetch(observed.url + "/responses")).rejects.toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
  10000,
);

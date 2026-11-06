// Optional real-CLI fixture. Run after npm run build, with external egress blocked.
// All responses, credentials, goals, and tool output here are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = await mkdtemp(join(tmpdir(), "jev-codex-cli-"));
const requests = [];
let scoringRequests = 0;
const failScore = process.env.JEV_FIXTURE_FAIL_SCORE === "1";
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === "/typesafe/v1/systemone") {
      scoringRequests++;
      response.writeHead(failScore ? 500 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((key) => [
              key,
              { type: "noul", noul: 0.1 },
            ]),
          ),
        }),
      );
      return;
    }
    assert.equal(request.url, "/v1/responses");
    requests.push(body);
    const number = requests.length;
    const item =
      number === 1
        ? {
            type: "custom_tool_call",
            id: "call_fixture",
            call_id: "call_fixture",
            namespace: "functions",
            name: "exec",
            input: 'text("OLD_CONTEXT_".repeat(300));',
          }
        : {
            type: "message",
            id: `msg_${number}`,
            role: "assistant",
            content: [
              { type: "output_text", text: "LOCAL_OK", annotations: [] },
            ],
          };
    const id = `resp_${number}`;
    const events = [
      {
        type: "response.created",
        response: { id, status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id,
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: home,
    CODEX_API_KEY: "offline-only",
    OPENAI_API_KEY: "offline-only",
    TYPESAFE_API_KEY: "offline-typesafe",
    TYPESAFE_BASE_URL: `${upstream}/typesafe`,
    JEV_CODEX_UPSTREAM_URL: `${upstream}/v1`,
    JEV_CODEX_STATE_PATH: join(home, "state.json"),
    JEV_PRUNE_ENABLED: "true",
    JEV_PRUNE_THRESHOLD: "0",
    JEV_PRUNE_TARGET_TOKENS: "0",
    JEV_PRUNE_KEEP_RECENT: "0",
  };
  const launcher = fileURLToPath(
    new URL("../../dist/codexLaunch.js", import.meta.url),
  );
  async function run(args) {
    const child = spawn(process.execPath, [launcher, ...args], {
      env,
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [],
      errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
    const forced = setTimeout(() => child.kill("SIGKILL"), 36000);
    try {
      const [code] = await once(child, "exit");
      const stdout = Buffer.concat(output).toString(),
        stderr = Buffer.concat(errors).toString();
      assert.equal(code, 0, stderr);
      return {
        stdout,
        stderr,
        events: stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      };
    } finally {
      clearTimeout(timeout);
      clearTimeout(forced);
    }
  }
  const common = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--json",
    "--model",
    "gpt-6.1-sol",
  ];
  const first = await run([
    ...common,
    "-s",
    "read-only",
    "Perform the synthetic tool check.",
  ]);
  const thread = first.events.find(
    (event) => event.type === "thread.started",
  )?.thread_id;
  assert.ok(thread);
  assert.equal(requests.length, 2);
  const outputOf = (body) =>
    body.input.find((item) => item.type === "custom_tool_call_output")?.output;
  const original = outputOf(requests[1]);
  assert.ok(
    JSON.stringify(original).includes("OLD_CONTEXT_"),
    "The real tool must have executed",
  );
  const second = await run([
    ...common,
    "resume",
    thread,
    "New unrelated task; reply LOCAL_OK.",
  ]);
  assert.ok(second.stdout.includes("LOCAL_OK"));
  assert.equal(scoringRequests, 1);
  const replaced = outputOf(requests[2]);
  if (failScore) {
    assert.deepEqual(replaced, original);
    assert.ok(second.stderr.includes("scoring failed"));
  } else {
    assert.ok(JSON.stringify(replaced).includes("[jev-prune]"));
    assert.ok(!JSON.stringify(replaced).includes("OLD_CONTEXT_"));
    await run([...common, "resume", thread, "Another unrelated task."]);
    assert.deepEqual(outputOf(requests[3]), replaced);
    assert.equal(
      scoringRequests,
      1,
      "Saved drops must survive launcher restart",
    );
  }
  console.log(
    `PASS: real CLI tool execution, resume, ${failScore ? "scorer-failure pass-through" : "pruning and restart replay"}.`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}

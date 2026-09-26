import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createResponseTextTap } from "../src/utils/responseTextTap.js";

async function run(
  chunks: string[],
  contentType: string,
): Promise<{ output: string; finals: string[] }> {
  const finals: string[] = [];
  const output: Buffer[] = [];
  const sink = new (await import("node:stream")).Writable({
    write(chunk: Buffer, _encoding, callback) {
      output.push(chunk);
      callback();
    },
  });
  await pipeline(
    Readable.from(chunks),
    createResponseTextTap(contentType, (reply) => finals.push(reply)),
    sink,
  );
  return { output: Buffer.concat(output).toString("utf8"), finals };
}

test("streams bytes unchanged and captures a finished assistant text response", async () => {
  const chunks = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  expect(await run(chunks, "text/event-stream")).toEqual({
    output: chunks.join(""),
    finals: ["Done"],
  });
});

test("does not score a streamed tool-use response as a finished task", async () => {
  const chunks = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Working"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ];
  expect((await run(chunks, "text/event-stream")).finals).toEqual([]);
});

test("does not report an incomplete stream", async () => {
  const chunks = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Working"}}\n\n',
  ];
  expect((await run(chunks, "text/event-stream")).finals).toEqual([]);
});

test("captures a complete JSON message", async () => {
  const response = JSON.stringify({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Done" }],
  });
  expect((await run([response], "application/json")).finals).toEqual(["Done"]);
});

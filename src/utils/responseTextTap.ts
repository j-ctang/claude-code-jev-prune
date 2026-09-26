import { Transform, type TransformCallback } from "node:stream";

const MAX_BYTES = 64 * 1024;

/** Passes response bytes through and reports only a finished assistant reply. */
export function createResponseTextTap(
  contentType: string,
  onFinal: (reply: string) => void,
): Transform {
  const stream = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffered = "";
  let reply = "";
  let stopped = false;
  let endTurn = false;
  let overflow = false;

  const consume = (): void => {
    let boundary: number;
    while ((boundary = buffered.indexOf("\n\n")) >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data) as {
          type?: unknown;
          delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
        };
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          reply += event.delta.text;
        } else if (event.type === "message_delta") {
          endTurn = event.delta?.stop_reason === "end_turn";
        } else if (event.type === "message_stop") {
          stopped = true;
        }
      } catch {
        // Unknown frames cannot justify a completion judgment.
        overflow = true;
      }
      if (reply.length > MAX_BYTES) overflow = true;
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!overflow) {
        buffered += decoder
          .decode(chunk, { stream: true })
          .replace(/\r\n/g, "\n");
        if (buffered.length > MAX_BYTES) overflow = true;
        else if (stream) consume();
      }
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      if (!overflow) {
        if (stream) {
          consume();
          if (stopped && endTurn && reply.trim()) onFinal(reply);
        } else {
          try {
            const value = JSON.parse(buffered) as {
              stop_reason?: unknown;
              content?: Array<{ type?: unknown; text?: unknown }>;
            };
            if (value.stop_reason === "end_turn") {
              const text = value.content
                ?.filter(
                  (block) =>
                    block.type === "text" && typeof block.text === "string",
                )
                .map((block) => block.text)
                .join("\n");
              if (text?.trim()) onFinal(text);
            }
          } catch {
            // Non-JSON response cannot justify completion.
          }
        }
      }
      callback();
    },
  });
}

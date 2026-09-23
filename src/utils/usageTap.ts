import { Transform, type TransformCallback } from "node:stream";

export interface AnthropicUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalInputTokens: number;
}

const MAX_BUFFERED_BYTES = 1024 * 1024;

function numberField(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readUsage(value: unknown): AnthropicUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const fields = usage as Record<string, unknown>;
  const inputTokens = numberField(fields, "input_tokens");
  const cacheReadInputTokens = numberField(fields, "cache_read_input_tokens");
  const cacheCreationInputTokens = numberField(
    fields,
    "cache_creation_input_tokens",
  );
  return {
    inputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalInputTokens:
      inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
  };
}

function usageFromEventStream(text: string): AnthropicUsage | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || !line.includes("message_start")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim()) as {
        type?: unknown;
        message?: unknown;
      };
      if (event.type === "message_start") return readUsage(event.message);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Passes the upstream body through unchanged and reports the input-side usage
 * from either a JSON message or the `message_start` event of a stream.
 */
export function createUsageTap(
  contentType: string,
  onUsage: (usage: AnthropicUsage) => void,
): Transform {
  const isEventStream = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffered = "";
  let done = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      if (!done) {
        buffered += decoder.decode(chunk, { stream: true });
        if (isEventStream) {
          const usage = usageFromEventStream(buffered);
          if (usage) {
            done = true;
            onUsage(usage);
          }
        }
        if (buffered.length > MAX_BUFFERED_BYTES) {
          done = true;
          buffered = "";
        }
      }
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      if (!done && !isEventStream) {
        try {
          const usage = readUsage(JSON.parse(buffered) as unknown);
          if (usage) onUsage(usage);
        } catch {
          // Non-JSON bodies carry no usage.
        }
      }
      callback();
    },
  });
}

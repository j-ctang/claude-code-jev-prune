import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import type { ShadowEvent } from "./skillShadowLog.js";

const MAX_LINE = 64 * 1024;
const READ_SIZE = 64 * 1024;

interface Identity {
  dev: number;
  ino: number;
}

export function createSkillShadowLogFollower(path: string): { poll(): ShadowEvent[] } {
  let identity: Identity | undefined;
  let offset = 0;
  let decoder = new TextDecoder();
  let pending = "";
  let discard = false;

  try {
    const initial = statSync(path);
    identity = { dev: initial.dev, ino: initial.ino };
    offset = initial.size;
  } catch {
    // A missing log starts at byte zero when created.
  }

  const reset = (): void => {
    offset = 0;
    decoder = new TextDecoder();
    pending = "";
    discard = false;
  };

  const consume = (text: string, events: ShadowEvent[]): void => {
    const parts = text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (!discard) {
        pending += part;
        if (pending.length > MAX_LINE) {
          pending = "";
          discard = true;
        }
      }
      if (index === parts.length - 1) break;
      if (!discard) {
        try {
          const value: unknown = JSON.parse(pending);
          if (value && typeof value === "object") events.push(value as ShadowEvent);
        } catch {
          // Malformed lines cannot produce notices.
        }
      }
      pending = "";
      discard = false;
    }
  };

  return {
    poll(): ShadowEvent[] {
      const events: ShadowEvent[] = [];
      let descriptor: number;
      try {
        descriptor = openSync(path, "r");
      } catch {
        identity = undefined;
        reset();
        return events;
      }
      try {
        const current = fstatSync(descriptor);
        if (
          !identity ||
          identity.dev !== current.dev ||
          identity.ino !== current.ino ||
          current.size < offset
        ) reset();
        identity = { dev: current.dev, ino: current.ino };
        const buffer = Buffer.allocUnsafe(READ_SIZE);
        while (offset < current.size) {
          const count = readSync(descriptor, buffer, 0, Math.min(READ_SIZE, current.size - offset), offset);
          if (count <= 0) break;
          offset += count;
          consume(decoder.decode(buffer.subarray(0, count), { stream: true }), events);
        }
      } catch {
        identity = undefined;
        reset();
      } finally {
        closeSync(descriptor);
      }
      return events;
    },
  };
}

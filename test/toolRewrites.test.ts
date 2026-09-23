import { findSuperseded, trimOutput } from "../src/services/toolRewrites.js";
import type { ToolCandidate } from "../src/types.js";

function call(
  toolUseId: string,
  toolName: string,
  input: unknown,
  result: unknown = toolName === "Read" ? "1\tcontent" : "output",
): ToolCandidate {
  return {
    toolUseId,
    toolName,
    input,
    result,
    assistantMessageIndex: 0,
    assistantBlockIndex: 0,
    resultMessageIndex: 0,
    resultBlockIndex: 0,
  };
}

describe("findSuperseded", () => {
  test("stubs an older read when the same file is read again in full", () => {
    const stubs = findSuperseded([
      call("a", "Read", { file_path: "src/auth.ts", offset: 10, limit: 20 }),
      call("b", "Read", { file_path: "src/auth.ts" }),
    ]);

    expect([...stubs]).toEqual([
      ["a", "[jev-prune] Output removed: superseded by a later Read of src/auth.ts."],
    ]);
  });

  test("applies the same-range, Write, Bash, Grep and Glob rules", () => {
    const stubs = findSuperseded([
      call("range-1", "Read", { file_path: "a.ts", offset: 1, limit: 5 }),
      call("range-2", "Read", { file_path: "a.ts", offset: 1, limit: 5 }),
      call("write-read", "Read", { file_path: "b.ts" }),
      call("write", "Write", { file_path: "b.ts", content: "new" }),
      call("bash-1", "Bash", { command: "npm test", description: "first" }),
      call("bash-2", "Bash", { command: "npm test", description: "second" }),
      call("grep-1", "Grep", { pattern: "x", path: "src" }),
      call("grep-2", "Grep", { path: "src", pattern: "x" }),
      call("glob-1", "Glob", { pattern: "*.ts" }),
      call("glob-2", "Glob", { pattern: "*.ts" }),
    ]);

    expect([...stubs.keys()].sort()).toEqual(
      ["bash-1", "glob-1", "grep-1", "range-1", "write-read"].sort(),
    );
    expect(stubs.get("bash-1")).toMatch(/same command/);
    expect(stubs.get("write-read")).toMatch(/later Write of b\.ts/);
  });

  test("keeps reads that nothing later fully replaces", () => {
    const stubs = findSuperseded([
      call("whole", "Read", { file_path: "a.ts" }),
      call("partial", "Read", { file_path: "a.ts", offset: 50, limit: 10 }),
      call("edited", "Read", { file_path: "b.ts" }),
      call("edit", "Edit", { file_path: "b.ts", old_string: "x", new_string: "y" }),
      call("other-path", "Read", { file_path: "./a.ts" }),
      call("bash", "Bash", { command: "npm test -- auth" }),
      call("bash-different", "Bash", { command: "npm test" }),
      call("grep", "Grep", { pattern: "x" }),
      call("grep-different", "Grep", { pattern: "y" }),
    ]);

    expect([...stubs.keys()]).toEqual([]);
  });

  test("keeps the earlier read when the later Read has no file content", () => {
    const stubs = findSuperseded([
      call("original", "Read", { file_path: "a.ts" }),
      call(
        "unchanged",
        "Read",
        { file_path: "a.ts" },
        "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.",
      ),
      call("missing", "Read", { file_path: "a.ts" }, "File does not exist."),
    ]);

    expect([...stubs.keys()]).toEqual([]);
  });

  test("never stubs the newest call in a chain", () => {
    const stubs = findSuperseded([
      call("one", "Bash", { command: "ls" }),
      call("two", "Bash", { command: "ls" }),
      call("three", "Bash", { command: "ls" }),
    ]);

    expect([...stubs.keys()]).toEqual(["one", "two"]);
  });
});

describe("trimOutput", () => {
  const log = Array.from({ length: 1_000 }, (_, index) => `line ${index} ${"x".repeat(30)}`).join("\n");

  test("keeps whole lines at the start and end with a marker between", () => {
    const result = trimOutput(log, 100);

    expect(result).toBeDefined();
    const text = result?.content as string;
    expect(text.startsWith("line 0 ")).toBe(true);
    expect(text.endsWith(`line 999 ${"x".repeat(30)}`)).toBe(true);
    expect(text).toMatch(/\[jev-prune\] Trimmed [\d,]+ lines \(~\d+K tokens\) from the middle/);
    expect(result?.removedLines).toBeGreaterThan(900);
    expect(text.length).toBeLessThan(1_200);
    for (const line of text.split("\n")) {
      expect(line === "" || line.startsWith("line ") || line.startsWith("[jev-prune]")).toBe(true);
    }
  });

  test("leaves a single very long line intact rather than splitting it", () => {
    const result = trimOutput("y".repeat(10_000), 100);

    expect(result).toBeUndefined();
  });

  test("keeps block fields for text-block output and skips other outputs", () => {
    const blocks = [{ type: "text", text: log, citations: "keep-me" }];

    const result = trimOutput(blocks, 100);

    expect(result?.content).toEqual([
      expect.objectContaining({ type: "text", citations: "keep-me" }),
    ]);
    expect(trimOutput([{ type: "image", source: {} }], 100)).toBeUndefined();
    expect(trimOutput("short", 100)).toBeUndefined();
  });
});

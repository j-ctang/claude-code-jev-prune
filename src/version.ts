import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function readPackageVersion(): string {
  const entryPoint = process.argv[1];
  const candidates = new Set<string>([
    ...(process.env.npm_package_json ? [process.env.npm_package_json] : []),
    ...(entryPoint
      ? [resolve(dirname(entryPoint), "..", "package.json")]
      : []),
    resolve(process.cwd(), "package.json"),
  ]);

  for (const candidate of candidates) {
    try {
      const metadata = JSON.parse(readFileSync(candidate, "utf8")) as {
        version?: unknown;
      };
      if (typeof metadata.version === "string") return metadata.version;
    } catch {
      continue;
    }
  }
  // An unknown version must not stop the proxy from starting.
  return "unknown";
}

export const VERSION = readPackageVersion();

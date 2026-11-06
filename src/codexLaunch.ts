import "dotenv/config";
import { launchCodex } from "./codexLauncher.js";

void launchCodex(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Codex launch failed"}\n`,
    );
    process.exitCode = 1;
  },
);

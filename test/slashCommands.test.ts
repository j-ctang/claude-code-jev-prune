import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slashCommands } from "../src/installation.js";

// The proxy acts only on a command the user typed. If Claude ran one itself,
// nothing would happen and the command text would make Claude report that the
// proxy is not running.
test.each(slashCommands)("%s can only be run by the user", (command) => {
  const text = readFileSync(join(process.cwd(), "commands", command), "utf8");
  const frontmatter = text.split("---")[1] ?? "";
  expect(frontmatter).toMatch(/^disable-model-invocation: true$/m);
});

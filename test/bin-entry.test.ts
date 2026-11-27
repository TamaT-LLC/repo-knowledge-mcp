import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repositoryRoot } from "./support/quality-gate-fixtures.js";

// compileWhenHot only takes effect in a process that enables it, and the CLI
// entry is the one place that should. Nothing else in the suite notices if the
// call goes missing, so this pins it.
describe("CLI entry", () => {
  it("enables compileWhenHot before running the CLI", async () => {
    const source = await readFile(
      join(repositoryRoot, "src", "bin.ts"),
      "utf8",
    );
    // Anchored to the start of a line, so a commented-out call does not count.
    const enable = /^enableCompileWhenHot\(/mu.exec(source)?.index ?? -1;
    const run =
      /^process\.exitCode = await runDefaultRepoKnowledgeCli\(/mu.exec(
        source,
      )?.index;
    expect(enable).toBeGreaterThan(-1);
    expect(run).toBeDefined();
    expect(enable).toBeLessThan(run ?? -1);
  });
});

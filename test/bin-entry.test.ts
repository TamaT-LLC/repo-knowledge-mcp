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
    // A call at the start of a line, so a commented-out one does not count,
    // and before the CLI runs. Arguments and line breaks may change.
    expect(source).toMatch(
      /^enableCompileWhenHot\([\s\S]*runDefaultRepoKnowledgeCli\(/mu,
    );
  });
});

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
    // Anchored to line starts, so a commented-out call does not count, and
    // in this order, so the CLI runs with compileWhenHot already on.
    expect(source).toMatch(
      /^enableCompileWhenHot\(\);$[\s\S]*^process\.exitCode = await runDefaultRepoKnowledgeCli\(/mu,
    );
  });
});

/* global URL */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  coverageFileThresholds,
  coverageThresholds,
} from "../coverage.config.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureConfig = fileURLToPath(
  new URL("../test/fixtures/coverage-gate/vitest.config.mjs", import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);

test("coverage gate rejects a fixture below every global threshold", async () => {
  const result = await run(process.execPath, [
    vitestBin,
    "run",
    "--config",
    fixtureConfig,
    "--coverage",
  ]);
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.code, 0, diagnostics);
  for (const [metric, threshold] of Object.entries(coverageThresholds)) {
    assert.match(
      diagnostics,
      new RegExp(
        `Coverage for ${metric} \\([^)]*%\\) does not meet global threshold \\(${String(threshold)}%\\)`,
        "u",
      ),
    );
  }
});

test("every file-specific coverage threshold points to an existing source file", async () => {
  for (const path of Object.keys(coverageFileThresholds)) {
    assert.equal((await stat(join(repositoryRoot, path))).isFile(), true, path);
  }
});

test("file-specific coverage rejects a local regression even when global coverage passes", async () => {
  const directory = await mkdtemp(join(repositoryRoot, ".coverage-gate-"));
  try {
    const coverageConfigUrl = pathToFileURL(
      join(repositoryRoot, "coverage.config.mjs"),
    ).href;
    const configPath = join(directory, "vitest.config.mjs");
    await writeFile(
      configPath,
      `
      import { defineConfig } from "vitest/config";
      import { coverageConfig, coverageThresholds, coverageFileThresholds } from ${JSON.stringify(coverageConfigUrl)};
      export default defineConfig({
        root: ${JSON.stringify(directory)},
        test: {
          include: ["test-fixture.ts"],
          coverage: {
            ...coverageConfig,
            exclude: [],
            include: ["source.ts", "covered.ts"],
            reporter: ["text-summary"],
            thresholds: {
              ...coverageThresholds,
              "source.ts": coverageFileThresholds["src/cli-args.ts"],
            },
          },
        },
      });
    `,
    );
    await writeFile(
      join(directory, "source.ts"),
      await readFile(
        join(repositoryRoot, "test/fixtures/coverage-gate/source.ts"),
        "utf8",
      ),
    );
    // Enough independently covered functions and branches to keep every global
    // metric above its floor while source.ts still loses half of its coverage.
    await writeFile(
      join(directory, "covered.ts"),
      Array.from(
        { length: 20 },
        (_, index) =>
          `export function covered${index}(value: boolean) { return value ? 1 : 0; }`,
      ).join("\n"),
    );
    await writeFile(
      join(directory, "test-fixture.ts"),
      `
      import { expect, test } from "vitest";
      import { classify } from "./source.js";
      import * as covered from "./covered.js";
      test("covers the rest of the application", () => {
        expect(classify(true)).toBe("covered");
        for (const run of Object.values(covered)) {
          expect(run(true)).toBe(1);
          expect(run(false)).toBe(0);
        }
      });
    `,
    );
    const result = await run(process.execPath, [
      vitestBin,
      "run",
      "--config",
      configPath,
      "--coverage",
    ]);
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0, diagnostics);
    assert.doesNotMatch(diagnostics, /does not meet global threshold/u);
    for (const [metric, threshold] of Object.entries(
      coverageFileThresholds["src/cli-args.ts"],
    )) {
      assert.match(
        diagnostics,
        new RegExp(
          `Coverage for ${metric} \\([^)]*%\\) does not meet "source.ts" threshold \\(${String(threshold)}%\\)`,
          "u",
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal, stderr, stdout });
    });
  });
}

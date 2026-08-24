/* global URL */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { coverageThresholds } from "../coverage.config.mjs";

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

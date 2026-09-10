import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runGoldenCli } from "../src/golden-command.js";
import { createCommandTestRunner } from "./support/command-runner.js";
import {
  buildDegradedQualityGateScenario,
  loadQualityGateFixtures,
  repositoryRoot,
} from "./support/quality-gate-fixtures.js";

const CLI = join(repositoryRoot, "dist/golden-cli.js");
const fixtures = join(repositoryRoot, "test/fixtures/golden");

describe.each(["in-process", "subprocess"] as const)(
  "golden CLI (%s)",
  (mode) => {
    const execute = createCommandTestRunner(
      mode,
      new Map([[CLI, runGoldenCli]]),
    );
    const run = (argv: readonly string[]) =>
      execute([CLI, ...argv], {
        cwd: repositoryRoot,
        reject: false,
      });
    let directory: string;
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "rkm-golden-cli-"));
    });
    afterAll(async () => {
      await rm(directory, { force: true, recursive: true });
    });

    it.each([
      [],
      [join(fixtures, "m2-outcome-ranking-golden.json")],
      [join(fixtures, "m2-provider-baseline.json")],
    ])("evaluates the fixture with arguments %j", async (...argv) => {
      const result = await run(argv);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(expect.any(Object));
    });

    it.each([
      [["--thresholds"], "--thresholds requires a value"],
      [
        [
          join(fixtures, "m1-golden.json"),
          "--thresholds",
          join(fixtures, "m2-quality-thresholds.json"),
        ],
        "--thresholds requires a provider_golden_baseline artifact",
      ],
      [[join(fixtures, "absent.json")], "ENOENT"],
    ])("reports evaluation errors for %j", async (argv, message) => {
      const result = await run(argv as string[]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`GOLDEN_EVALUATION_FAILED:`);
      expect(result.stderr).toContain(message);
    });

    it("returns a failing exit and report for a metric regression", async () => {
      const scenario = await buildDegradedQualityGateScenario(
        await loadQualityGateFixtures(),
      );
      const artifact = join(directory, "artifact.json");
      const thresholds = join(directory, "thresholds.json");
      await writeFile(artifact, JSON.stringify(scenario.artifact));
      await writeFile(thresholds, JSON.stringify(scenario.thresholds));
      const result = await run([artifact, "--thresholds", thresholds]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).quality_gate.ok).toBe(false);
      expect(result.stderr).toBe("");
    });
  },
);

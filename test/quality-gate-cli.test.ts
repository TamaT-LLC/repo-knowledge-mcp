import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { QualityGateRunReport } from "../src/experimental.js";
import {
  buildDegradedQualityGateScenario,
  loadQualityGateFixtures,
  repositoryRoot,
} from "./support/quality-gate-fixtures.js";

const CLI = join(repositoryRoot, "dist", "quality-gate-cli.js");

async function runCli(
  argv: readonly string[],
): Promise<{ exitCode: number | undefined; report: QualityGateRunReport }> {
  const result = await execa(process.execPath, [CLI, ...argv], {
    cwd: repositoryRoot,
    reject: false,
  });
  return {
    exitCode: result.exitCode,
    report: JSON.parse(result.stdout) as QualityGateRunReport,
  };
}

describe("quality gate CLI", () => {
  let workingDirectory: string;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "rkm-quality-gate-"));
  });

  afterAll(async () => {
    await rm(workingDirectory, { force: true, recursive: true });
  });

  it("passes the committed fixtures offline with exit code 0", async () => {
    const first = await execa(process.execPath, [CLI], {
      cwd: repositoryRoot,
      reject: false,
    });
    const second = await execa(process.execPath, [CLI], {
      cwd: repositoryRoot,
      reject: false,
    });

    expect(first.exitCode).toBe(0);
    // Same inputs, same bytes: the report is deterministic across runs and
    // across Node 22/24 (both run this test in CI).
    expect(second.stdout).toBe(first.stdout);
    const report = JSON.parse(first.stdout) as QualityGateRunReport;
    expect(report.ok).toBe(true);
    expect(report.status).toBe("pass");
    expect(report.failures).toEqual([]);
  });

  it("fails with exit code 2 when the recorded predictions drift from the artifact", async () => {
    const fixtures = await loadQualityGateFixtures();
    const tampered = structuredClone(fixtures.recordedPredictions) as {
      responses: Record<string, { output: { candidates: { rule: string }[] } }>;
    };
    tampered.responses["m2-t01"]!.output.candidates[0]!.rule =
      "Tampered rule text that was never reviewed.";
    const tamperedPath = join(workingDirectory, "tampered-recorded.json");
    await writeFile(tamperedPath, JSON.stringify(tampered), "utf8");

    const { exitCode, report } = await runCli(["--recorded", tamperedPath]);

    expect(exitCode).toBe(2);
    expect(report.status).toBe("integrity_failure");
    expect(report.failures.map((failure) => failure.code)).toEqual([
      "FIXTURE_DRIFT",
    ]);
  });

  it("fails with exit code 1 when a metric drops below its reviewed minimum", async () => {
    const fixtures = await loadQualityGateFixtures();
    const scenario = await buildDegradedQualityGateScenario(fixtures);
    const artifactPath = join(workingDirectory, "degraded-artifact.json");
    const recordedPath = join(workingDirectory, "degraded-recorded.json");
    const thresholdsPath = join(workingDirectory, "degraded-thresholds.json");
    await writeFile(artifactPath, JSON.stringify(scenario.artifact), "utf8");
    await writeFile(
      recordedPath,
      JSON.stringify(scenario.recordedPredictions),
      "utf8",
    );
    await writeFile(
      thresholdsPath,
      JSON.stringify(scenario.thresholds),
      "utf8",
    );

    const { exitCode, report } = await runCli([
      "--artifact",
      artifactPath,
      "--recorded",
      recordedPath,
      "--thresholds",
      thresholdsPath,
    ]);

    expect(exitCode).toBe(1);
    expect(report.status).toBe("metric_failure");
    expect(
      report.failures.every(
        (failure) => failure.code === "METRIC_BELOW_MINIMUM",
      ),
    ).toBe(true);
    expect(report.failures.map((failure) => failure.metric)).toContain(
      "extraction_recall",
    );
  });

  it("reports an unreadable input machine-readably with exit code 2", async () => {
    const { exitCode, report } = await runCli([
      "--thresholds",
      join(workingDirectory, "does-not-exist.json"),
    ]);

    expect(exitCode).toBe(2);
    expect(report.status).toBe("integrity_failure");
    expect(report.failures.map((failure) => failure.code)).toEqual([
      "INPUT_UNREADABLE",
    ]);
  });

  it("rejects unknown arguments with usage help", async () => {
    const result = await execa(process.execPath, [CLI, "--bogus"], {
      cwd: repositoryRoot,
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown argument --bogus");
    expect(result.stderr).toContain("Usage:");
  });
});

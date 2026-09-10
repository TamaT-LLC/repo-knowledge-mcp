import { createCommandTestRunner } from "./support/command-runner.js";
import { runGoldenCli } from "../src/golden-command.js";
import { runGoldenBaselineCli } from "../src/golden-baseline-command.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(repositoryRoot, "dist", "golden-baseline-cli.js");
const GOLDEN_CLI = join(repositoryRoot, "dist", "golden-cli.js");
const CORPUS = join(
  repositoryRoot,
  "test",
  "fixtures",
  "golden",
  "m2-anonymized-corpus.json",
);
const RECORDED = join(
  repositoryRoot,
  "test",
  "fixtures",
  "golden",
  "m2-recorded-predictions.json",
);
const ARTIFACT = join(
  repositoryRoot,
  "test",
  "fixtures",
  "golden",
  "m2-provider-baseline.json",
);
const THRESHOLDS = join(
  repositoryRoot,
  "test",
  "fixtures",
  "golden",
  "m2-quality-thresholds.json",
);

describe.each(["in-process", "subprocess"] as const)(
  "golden baseline CLI (%s)",
  (mode) => {
    const executeCli = createCommandTestRunner(
      mode,
      new Map([
        [CLI, runGoldenBaselineCli],
        [GOLDEN_CLI, runGoldenCli],
      ]),
    );

    let workingDirectory: string;

    beforeAll(async () => {
      workingDirectory = await mkdtemp(join(tmpdir(), "rkm-baseline-cli-"));
    });

    afterAll(async () => {
      await rm(workingDirectory, { force: true, recursive: true });
    });

    it.each([
      [[], "--corpus is required"],
      [["--corpus"], "--corpus requires a value"],
      [["--corpus", CORPUS], "exactly one of --live or --replay is required"],
      [["--corpus", CORPUS, "--live"], "--model is required with --live"],
      [
        ["--corpus", CORPUS, "--live", "--replay", RECORDED],
        "exactly one of --live or --replay is required",
      ],
      [["--bogus"], "unknown argument --bogus"],
    ])("reports usage errors for %j", async (argv, message) => {
      const result = await executeCli([CLI, ...(argv as string[])], {
        cwd: repositoryRoot,
        reject: false,
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
    });

    it("writes a replay to stdout with explicit prompt and trust inputs", async () => {
      const trust = join(workingDirectory, "trust.json");
      await writeFile(trust, "{}");
      const result = await executeCli(
        [
          CLI,
          "--corpus",
          CORPUS,
          "--replay",
          RECORDED,
          "--prompt",
          join(repositoryRoot, "prompts/distill.md"),
          "--trust",
          trust,
        ],
        { cwd: repositoryRoot, reject: false },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        JSON.parse(await readFile(ARTIFACT, "utf8")),
      );
      expect(result.stderr).toBe("");
    });

    it("reproduces the committed baseline artifact from recorded predictions", async () => {
      const firstPath = join(workingDirectory, "replayed-baseline-1.json");
      const secondPath = join(workingDirectory, "replayed-baseline-2.json");

      const first = await executeCli(
        [CLI, "--corpus", CORPUS, "--replay", RECORDED, "--out", firstPath],
        { cwd: repositoryRoot, reject: false },
      );
      const second = await executeCli(
        [CLI, "--corpus", CORPUS, "--replay", RECORDED, "--out", secondPath],
        { cwd: repositoryRoot, reject: false },
      );

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      const firstBytes = await readFile(firstPath, "utf8");
      expect(firstBytes).toBe(await readFile(secondPath, "utf8"));
      expect(JSON.parse(firstBytes)).toEqual(
        JSON.parse(await readFile(ARTIFACT, "utf8")),
      );
    });

    it("refuses live capture without explicit cloud transmission consent", async () => {
      const result = await executeCli(
        [CLI, "--corpus", CORPUS, "--live", "--model", "claude-example"],
        {
          cwd: repositoryRoot,
          // The CI block outranks the consent check, so the inherited CI
          // variables must be cleared for this test to be deterministic on
          // GitHub Actions and local machines alike.
          env: { CI: "", GITHUB_ACTIONS: "" },
          reject: false,
        },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("BASELINE_CLOUD_CONSENT_REQUIRED");
    });

    it.each([
      { name: "CI", overrides: { CI: "true", GITHUB_ACTIONS: "" } },
      {
        name: "GITHUB_ACTIONS",
        overrides: { CI: "", GITHUB_ACTIONS: "true" },
      },
    ])(
      "blocks live capture when $name is set even with consent",
      async ({ overrides }) => {
        const result = await executeCli(
          [
            CLI,
            "--corpus",
            CORPUS,
            "--live",
            "--model",
            "claude-example",
            "--consent-cloud-transmission",
          ],
          { cwd: repositoryRoot, env: overrides, reject: false },
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("BASELINE_LIVE_CAPTURE_BLOCKED_IN_CI");
      },
    );

    it("rejects recorded predictions from a different corpus", async () => {
      const recorded = JSON.parse(await readFile(RECORDED, "utf8")) as {
        corpus_id: string;
      };
      recorded.corpus_id = "some-other-corpus";
      const mismatchedPath = join(workingDirectory, "mismatched-recorded.json");
      await writeFile(mismatchedPath, JSON.stringify(recorded), "utf8");

      const result = await executeCli(
        [CLI, "--corpus", CORPUS, "--replay", mismatchedPath],
        { cwd: repositoryRoot, reject: false },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("BASELINE_CORPUS_MISMATCH");
    });

    it("rejects thresholds reviewed against a different measurement", async () => {
      const thresholds = JSON.parse(await readFile(THRESHOLDS, "utf8")) as {
        baseline: { measured_at: string };
      };
      thresholds.baseline.measured_at = "2026-08-08T12:00:00.000Z";
      const staleThresholdsPath = join(
        workingDirectory,
        "stale-thresholds.json",
      );
      await writeFile(staleThresholdsPath, JSON.stringify(thresholds), "utf8");

      const result = await executeCli(
        [GOLDEN_CLI, ARTIFACT, "--thresholds", staleThresholdsPath],
        { cwd: repositoryRoot, reject: false },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("QUALITY_GATE_BASELINE_MISMATCH");
      expect(result.stderr).toContain("measured_at");
    });

    it("rejects an artifact whose predictions were swapped after review", async () => {
      const artifact = JSON.parse(await readFile(ARTIFACT, "utf8")) as {
        fixture: { cases: { prediction: { is_knowledge: boolean } }[] };
      };
      artifact.fixture.cases[0]!.prediction.is_knowledge =
        !artifact.fixture.cases[0]!.prediction.is_knowledge;
      const tamperedArtifactPath = join(
        workingDirectory,
        "tampered-artifact.json",
      );
      await writeFile(tamperedArtifactPath, JSON.stringify(artifact), "utf8");

      const result = await executeCli(
        [GOLDEN_CLI, tamperedArtifactPath, "--thresholds", THRESHOLDS],
        { cwd: repositoryRoot, reject: false },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("QUALITY_GATE_BASELINE_MISMATCH");
      expect(result.stderr).toContain("artifact_digest");
    });

    it("evaluates the committed artifact against the reviewed thresholds", async () => {
      const result = await executeCli(
        [GOLDEN_CLI, ARTIFACT, "--thresholds", THRESHOLDS],
        { cwd: repositoryRoot, reject: false },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        quality_gate: { ok: boolean; thresholds_version: string };
        report: { counts: { cases: number } };
      };
      expect(parsed.quality_gate.ok).toBe(true);
      expect(parsed.quality_gate.thresholds_version).toBe("m2-thresholds-v1");
      expect(parsed.report.counts.cases).toBeGreaterThanOrEqual(50);
    });
  },
);

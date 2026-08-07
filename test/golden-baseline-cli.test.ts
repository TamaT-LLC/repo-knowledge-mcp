import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
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

describe("golden baseline CLI", () => {
  let workingDirectory: string;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "rkm-baseline-cli-"));
  });

  afterAll(async () => {
    await rm(workingDirectory, { force: true, recursive: true });
  });

  it("reproduces the committed baseline artifact from recorded predictions", async () => {
    const firstPath = join(workingDirectory, "replayed-baseline-1.json");
    const secondPath = join(workingDirectory, "replayed-baseline-2.json");

    const first = await execa(
      process.execPath,
      [CLI, "--corpus", CORPUS, "--replay", RECORDED, "--out", firstPath],
      { cwd: repositoryRoot, reject: false },
    );
    const second = await execa(
      process.execPath,
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
    const result = await execa(
      process.execPath,
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
      const result = await execa(
        process.execPath,
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

    const result = await execa(
      process.execPath,
      [CLI, "--corpus", CORPUS, "--replay", mismatchedPath],
      { cwd: repositoryRoot, reject: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("BASELINE_CORPUS_MISMATCH");
  });

  it("evaluates the committed artifact against the reviewed thresholds", async () => {
    const result = await execa(
      process.execPath,
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
});

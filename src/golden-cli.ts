import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  computeBaselineIdentityDigest,
  evaluateProviderBaselineArtifact,
  isProviderGoldenBaselineArtifact,
} from "./golden-baseline.js";
import { evaluateGoldenFixture } from "./golden-evaluator.js";
import { evaluateOutcomeRankingFixture } from "./outcome-ranking-golden.js";
import {
  QualityGateThresholdsSchema,
  assertQualityGateBaselineBinding,
  evaluateQualityGate,
} from "./quality-gate.js";

const arguments_ = parseArguments(process.argv.slice(2));

try {
  const input = JSON.parse(
    await readFile(arguments_.fixturePath, "utf8"),
  ) as unknown;
  if (isProviderGoldenBaselineArtifact(input)) {
    const { artifact, report } = evaluateProviderBaselineArtifact(input);
    if (arguments_.thresholdsPath === undefined) {
      // The baseline block is printed verbatim so a thresholds review can
      // copy the exact measurement identity it binds to.
      const baseline = {
        artifact_digest: computeBaselineIdentityDigest(artifact),
        artifact_kind: artifact.artifact_kind,
        corpus_digest: artifact.corpus_digest,
        corpus_id: artifact.corpus_id,
        measured_at: artifact.measured_at,
      };
      process.stdout.write(
        `${JSON.stringify({ baseline, report }, null, 2)}\n`,
      );
    } else {
      const thresholds = QualityGateThresholdsSchema.parse(
        JSON.parse(await readFile(arguments_.thresholdsPath, "utf8")),
      );
      assertQualityGateBaselineBinding(artifact, thresholds);
      const gate = evaluateQualityGate(report, thresholds);
      process.stdout.write(
        `${JSON.stringify({ quality_gate: gate, report }, null, 2)}\n`,
      );
      if (!gate.ok) process.exitCode = 1;
    }
  } else {
    if (arguments_.thresholdsPath !== undefined) {
      throw new TypeError(
        "--thresholds requires a provider_golden_baseline artifact",
      );
    }
    const report = isOutcomeRankingFixture(input)
      ? evaluateOutcomeRankingFixture(input)
      : evaluateGoldenFixture(input);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GOLDEN_EVALUATION_FAILED: ${message}\n`);
  process.exitCode = 2;
}

function parseArguments(argv: readonly string[]): {
  fixturePath: string;
  thresholdsPath?: string;
} {
  const positional: string[] = [];
  let thresholdsPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--thresholds") {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write(
          "GOLDEN_EVALUATION_FAILED: --thresholds requires a value\n",
        );
        process.exit(2);
      }
      thresholdsPath = resolve(value);
      index += 1;
    } else {
      positional.push(argv[index]!);
    }
  }
  return {
    fixturePath: resolve(
      positional[0] ?? "test/fixtures/golden/m1-golden.json",
    ),
    ...(thresholdsPath === undefined ? {} : { thresholdsPath }),
  };
}

function isOutcomeRankingFixture(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { fixture_kind?: unknown }).fixture_kind === "outcome_ranking"
  );
}

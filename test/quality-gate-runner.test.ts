import { beforeAll, describe, expect, it } from "vitest";

import {
  QUALITY_GATE_EXIT_INTEGRITY_FAILURE,
  QUALITY_GATE_EXIT_METRIC_FAILURE,
  QUALITY_GATE_EXIT_PASS,
  QUALITY_GATE_REPORT_KIND,
  TrustConfigSchema,
  buildUnreadableInputOutcome,
  runQualityGate,
} from "../src/experimental.js";
import {
  buildDegradedQualityGateScenario,
  loadQualityGateFixtures,
  type QualityGateFixtureSet,
} from "./support/quality-gate-fixtures.js";

describe("offline quality gate runner", () => {
  let fixtures: QualityGateFixtureSet;

  beforeAll(async () => {
    fixtures = await loadQualityGateFixtures();
  });

  it("passes the committed fixtures with exit code 0", async () => {
    const outcome = await runQualityGate(fixtures);

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_PASS);
    expect(outcome.report.ok).toBe(true);
    expect(outcome.report.status).toBe("pass");
    expect(outcome.report.report_kind).toBe(QUALITY_GATE_REPORT_KIND);
    expect(outcome.report.failures).toEqual([]);
    expect(outcome.report.gate?.ok).toBe(true);
    expect(outcome.report.thresholds_version).toBe("m2-thresholds-v1");
  });

  it("produces the same report from the same inputs on every run", async () => {
    const first = await runQualityGate(fixtures);
    const second = await runQualityGate(fixtures);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("runs the gate with a trust policy whose autoActivateTrustedHuman default is false", async () => {
    // The committed baseline binds to the default trust policy digest, so a
    // change to the default (for example flipping autoActivateTrustedHuman to
    // true) would surface as fixture drift instead of passing silently.
    expect(fixtures.trust.autoActivateTrustedHuman).toBe(false);
    expect(TrustConfigSchema.parse({}).autoActivateTrustedHuman).toBe(false);

    const outcome = await runQualityGate(fixtures);

    expect(outcome.report.ok).toBe(true);
  });

  it("rejects tampered recorded predictions as fixture drift", async () => {
    const tampered = structuredClone(fixtures.recordedPredictions) as {
      responses: Record<string, { output: { candidates: { rule: string }[] } }>;
    };
    tampered.responses["m2-t01"]!.output.candidates[0]!.rule =
      "Tampered rule text that was never reviewed.";

    const outcome = await runQualityGate({
      ...fixtures,
      recordedPredictions: tampered,
    });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.status).toBe("integrity_failure");
    expect(outcome.report.failures).toHaveLength(1);
    expect(outcome.report.failures[0]).toMatchObject({
      code: "FIXTURE_DRIFT",
    });
    expect(outcome.report.failures[0]!.expected_digest).not.toBe(
      outcome.report.failures[0]!.replayed_digest,
    );
  });

  it("rejects recorded predictions captured for a different corpus", async () => {
    const foreign = structuredClone(fixtures.recordedPredictions) as {
      corpus_id: string;
    };
    foreign.corpus_id = "some-other-corpus";

    const outcome = await runQualityGate({
      ...fixtures,
      recordedPredictions: foreign,
    });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.failures).toHaveLength(1);
    expect(outcome.report.failures[0]).toMatchObject({ code: "REPLAY_FAILED" });
    expect(outcome.report.failures[0]!.detail).toContain(
      "BASELINE_CORPUS_MISMATCH",
    );
  });

  it("rejects thresholds reviewed against a different measurement", async () => {
    const rebound = structuredClone(fixtures.thresholds) as {
      baseline: { measured_at: string };
    };
    rebound.baseline.measured_at = "2026-08-08T12:00:00.000Z";

    const outcome = await runQualityGate({
      ...fixtures,
      thresholds: rebound,
    });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.failures).toHaveLength(1);
    expect(outcome.report.failures[0]).toMatchObject({
      code: "BASELINE_MISMATCH",
      mismatches: ["measured_at"],
    });
  });

  it("rejects an invalid thresholds document machine-readably", async () => {
    const outcome = await runQualityGate({ ...fixtures, thresholds: {} });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.failures.map((failure) => failure.code)).toContain(
      "THRESHOLDS_INVALID",
    );
    expect(outcome.report.gate).toBeNull();
  });

  it("rejects an invalid baseline artifact machine-readably", async () => {
    const outcome = await runQualityGate({ ...fixtures, artifact: {} });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.failures.map((failure) => failure.code)).toContain(
      "ARTIFACT_INVALID",
    );
  });

  it("fails with exit code 1 when a metric drops below its reviewed minimum", async () => {
    const scenario = await buildDegradedQualityGateScenario(fixtures);

    const outcome = await runQualityGate({
      artifact: scenario.artifact,
      corpus: fixtures.corpus,
      prompt: fixtures.prompt,
      recordedPredictions: scenario.recordedPredictions,
      thresholds: scenario.thresholds,
      trust: fixtures.trust,
    });

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_METRIC_FAILURE);
    expect(outcome.report.status).toBe("metric_failure");
    expect(outcome.report.ok).toBe(false);
    expect(
      outcome.report.failures.every(
        (failure) => failure.code === "METRIC_BELOW_MINIMUM",
      ),
    ).toBe(true);
    const recallFailure = outcome.report.failures.find(
      (failure) => failure.metric === "extraction_recall",
    );
    expect(recallFailure).toBeDefined();
    expect(recallFailure!.value).toBeLessThan(recallFailure!.minimum!);
  });

  it("wraps unreadable inputs into a machine-readable integrity failure", () => {
    const outcome = buildUnreadableInputOutcome("ENOENT: no such file");

    expect(outcome.exitCode).toBe(QUALITY_GATE_EXIT_INTEGRITY_FAILURE);
    expect(outcome.report.failures).toEqual([
      { code: "INPUT_UNREADABLE", detail: "ENOENT: no such file" },
    ]);
    expect(outcome.report.status).toBe("integrity_failure");
  });
});

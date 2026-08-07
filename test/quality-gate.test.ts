import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  QUALITY_GATE_METRICS,
  QualityGateBindingError,
  QualityGateThresholdsSchema,
  assertQualityGateBaselineBinding,
  computeBaselineIdentityDigest,
  evaluateProviderBaselineArtifact,
  evaluateQualityGate,
  type QualityGateThresholds,
} from "../src/index.js";

const THRESHOLDS_URL = new URL(
  "./fixtures/golden/m2-quality-thresholds.json",
  import.meta.url,
);
const ARTIFACT_URL = new URL(
  "./fixtures/golden/m2-provider-baseline.json",
  import.meta.url,
);

async function loadThresholds(): Promise<QualityGateThresholds> {
  return QualityGateThresholdsSchema.parse(
    JSON.parse(await readFile(THRESHOLDS_URL, "utf8")),
  );
}

describe("M2 quality gate thresholds", () => {
  it("defines a reviewed threshold for every §18.1 metric", async () => {
    const thresholds = await loadThresholds();

    expect(Object.keys(thresholds.metrics).sort()).toEqual([
      ...QUALITY_GATE_METRICS,
    ]);
    expect(thresholds.thresholds_version).toBe("m2-thresholds-v1");
    expect(thresholds.source).toBe("fixture_replay");
    expect(thresholds.reviewed.by.length).toBeGreaterThan(0);
    for (const entry of Object.values(thresholds.metrics)) {
      expect(entry.minimum).toBeGreaterThan(0);
      expect(entry.minimum).toBeLessThanOrEqual(entry.measured);
      expect(entry.rationale.length).toBeGreaterThan(0);
    }
  });

  it("binds the thresholds to the committed baseline artifact", async () => {
    const thresholds = await loadThresholds();
    const { artifact, report } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );

    expect(thresholds.baseline).toEqual({
      artifact_digest: computeBaselineIdentityDigest(artifact),
      artifact_kind: artifact.artifact_kind,
      corpus_digest: artifact.corpus_digest,
      corpus_id: artifact.corpus_id,
      measured_at: artifact.measured_at,
    });
    expect(() =>
      assertQualityGateBaselineBinding(artifact, thresholds),
    ).not.toThrow();
    for (const metric of QUALITY_GATE_METRICS) {
      expect(thresholds.metrics[metric].measured).toBe(
        report.metrics[metric].value,
      );
    }
  });

  it("rejects a same-corpus artifact measured at a different time", async () => {
    const thresholds = await loadThresholds();
    const { artifact } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );
    const remeasured = {
      ...artifact,
      measured_at: "2026-08-08T12:00:00.000Z",
    };

    expect(() =>
      assertQualityGateBaselineBinding(remeasured, thresholds),
    ).toThrow(QualityGateBindingError);
    expect(() =>
      assertQualityGateBaselineBinding(remeasured, thresholds),
    ).toThrow(/measured_at/u);
  });

  it("rejects an artifact whose recorded predictions were edited after review", async () => {
    const thresholds = await loadThresholds();
    const { artifact } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );
    const flippedCase = {
      ...artifact.fixture.cases[0]!,
      prediction: {
        ...artifact.fixture.cases[0]!.prediction,
        severity: "consider",
      },
    };
    const tampered = {
      ...artifact,
      fixture: {
        ...artifact.fixture,
        cases: [flippedCase, ...artifact.fixture.cases.slice(1)],
      },
    };

    expect(() =>
      assertQualityGateBaselineBinding(tampered, thresholds),
    ).toThrow(QualityGateBindingError);
    expect(() =>
      assertQualityGateBaselineBinding(tampered, thresholds),
    ).toThrow(/artifact_digest/u);
  });

  it("rejects a same-corpus artifact from a different provenance generation", async () => {
    const thresholds = await loadThresholds();
    const { artifact } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );
    const otherModel = {
      ...artifact,
      provenance: { ...artifact.provenance, model: "some-other-model" },
    };
    const otherMode = {
      ...artifact,
      transmission: { cloud_consent: true, mode: "live" as const },
    };

    for (const tampered of [otherModel, otherMode]) {
      expect(() =>
        assertQualityGateBaselineBinding(tampered, thresholds),
      ).toThrow(/artifact_digest/u);
    }
  });

  it("passes the committed baseline and reports per-metric results", async () => {
    const thresholds = await loadThresholds();
    const { report } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );

    const gate = evaluateQualityGate(report, thresholds);

    expect(gate.ok).toBe(true);
    expect(gate.thresholds_version).toBe("m2-thresholds-v1");
    expect(gate.results).toHaveLength(QUALITY_GATE_METRICS.length);
    expect(gate.results.every((result) => result.pass)).toBe(true);
  });

  it("fails the gate when any metric drops below its minimum", async () => {
    const thresholds = await loadThresholds();
    const { report } = evaluateProviderBaselineArtifact(
      JSON.parse(await readFile(ARTIFACT_URL, "utf8")),
    );
    const degraded = {
      ...report,
      metrics: {
        ...report.metrics,
        extraction_recall: { denominator: 42, numerator: 20, value: 0.47619 },
      },
    };

    const gate = evaluateQualityGate(degraded, thresholds);

    expect(gate.ok).toBe(false);
    expect(
      gate.results.find((result) => result.metric === "extraction_recall"),
    ).toMatchObject({ pass: false });
    expect(
      gate.results.filter((result) => !result.pass).map((r) => r.metric),
    ).toEqual(["extraction_recall"]);
  });

  it("rejects a minimum above the measured value it derives from", async () => {
    const thresholds = JSON.parse(await readFile(THRESHOLDS_URL, "utf8")) as {
      metrics: Record<string, { measured: number; minimum: number }>;
    };
    thresholds.metrics.search_mrr!.minimum =
      thresholds.metrics.search_mrr!.measured + 0.01;

    expect(() => QualityGateThresholdsSchema.parse(thresholds)).toThrowError(
      /minimum must not exceed the measured value/u,
    );
  });
});

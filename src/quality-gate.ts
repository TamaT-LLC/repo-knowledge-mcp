import { z } from "zod";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
} from "./domain-schemas.js";
import {
  computeBaselineIdentityDigest,
  type ProviderGoldenBaselineArtifact,
} from "./golden-baseline.js";
import type { GoldenEvaluationReport } from "./golden-evaluator.js";

/** Every §18.1 metric that the M2 quality gate thresholds must cover. */
export const QUALITY_GATE_METRICS = [
  "category_macro_f1",
  "extraction_precision",
  "extraction_recall",
  "merge_pairwise_precision",
  "merge_pairwise_recall",
  "scope_expected_file_match_rate",
  "scope_valid_glob_rate",
  "search_mrr",
  "search_ndcg",
  "severity_weighted_accuracy",
] as const;

export type QualityGateMetricName = (typeof QUALITY_GATE_METRICS)[number];

const MetricThresholdSchema = z
  .object({
    margin: z.number().min(0).max(1),
    measured: z.number().min(0).max(1),
    minimum: z.number().min(0).max(1),
    rationale: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimum > value.measured) {
      context.addIssue({
        code: "custom",
        message: "minimum must not exceed the measured value it derives from",
        path: ["minimum"],
      });
    }
  });

const metricThresholdEntries = Object.fromEntries(
  QUALITY_GATE_METRICS.map((name) => [name, MetricThresholdSchema]),
) as Record<QualityGateMetricName, typeof MetricThresholdSchema>;

export const QualityGateThresholdsSchema = z
  .object({
    baseline: z
      .object({
        artifact_digest: Sha256DigestSchema,
        artifact_kind: NonEmptyStringSchema,
        corpus_digest: Sha256DigestSchema,
        corpus_id: NonEmptyStringSchema,
        measured_at: IsoDateTimeSchema,
      })
      .strict(),
    metrics: z.object(metricThresholdEntries).strict(),
    reviewed: z
      .object({
        at: IsoDateTimeSchema,
        by: NonEmptyStringSchema,
      })
      .strict(),
    schema_version: z.literal(1),
    source: z.enum(["fixture_replay", "live_measurement"]),
    thresholds_version: NonEmptyStringSchema,
    update_procedure: NonEmptyStringSchema,
  })
  .strict();

export type QualityGateThresholds = z.infer<typeof QualityGateThresholdsSchema>;

export interface QualityGateMetricResult {
  readonly metric: QualityGateMetricName;
  readonly minimum: number;
  readonly pass: boolean;
  readonly value: number;
}

export interface QualityGateReport {
  readonly ok: boolean;
  readonly results: readonly QualityGateMetricResult[];
  readonly source: QualityGateThresholds["source"];
  readonly thresholds_version: string;
}

export class QualityGateBindingError extends Error {
  readonly code = "QUALITY_GATE_BASELINE_MISMATCH";

  constructor(message: string) {
    super(`QUALITY_GATE_BASELINE_MISMATCH: ${message}`);
    this.name = "QualityGateBindingError";
  }
}

/**
 * Verifies that thresholds were reviewed against exactly this measurement.
 * The artifact digest covers measured_at, transmission mode, and every
 * provenance generation, so a same-corpus artifact measured at another time
 * or with another model / prompt / schema / policy is rejected fail-closed.
 */
export function assertQualityGateBaselineBinding(
  artifact: ProviderGoldenBaselineArtifact,
  thresholds: QualityGateThresholds,
): void {
  const parsed = QualityGateThresholdsSchema.parse(thresholds);
  const mismatches: string[] = [];
  if (parsed.baseline.artifact_kind !== artifact.artifact_kind) {
    mismatches.push("artifact_kind");
  }
  if (parsed.baseline.corpus_id !== artifact.corpus_id) {
    mismatches.push("corpus_id");
  }
  if (parsed.baseline.corpus_digest !== artifact.corpus_digest) {
    mismatches.push("corpus_digest");
  }
  if (parsed.baseline.measured_at !== artifact.measured_at) {
    mismatches.push("measured_at");
  }
  if (
    parsed.baseline.artifact_digest !== computeBaselineIdentityDigest(artifact)
  ) {
    mismatches.push("artifact_digest");
  }
  if (mismatches.length > 0) {
    throw new QualityGateBindingError(
      `thresholds were reviewed against a different baseline measurement (${mismatches.join(
        ", ",
      )})`,
    );
  }
}

/**
 * Compares a recomputed golden report against reviewed per-metric minimums.
 * The comparison is pure, so the same recorded predictions always produce the
 * same gate verdict.
 */
export function evaluateQualityGate(
  report: GoldenEvaluationReport,
  thresholds: QualityGateThresholds,
): QualityGateReport {
  const parsed = QualityGateThresholdsSchema.parse(thresholds);
  const results = QUALITY_GATE_METRICS.map(
    (metric): QualityGateMetricResult => {
      const minimum = parsed.metrics[metric].minimum;
      const value = report.metrics[metric].value;
      return { metric, minimum, pass: value >= minimum, value };
    },
  );
  return {
    ok: results.every((result) => result.pass),
    results,
    source: parsed.source,
    thresholds_version: parsed.thresholds_version,
  };
}

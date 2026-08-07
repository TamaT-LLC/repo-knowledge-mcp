import { z } from "zod";

import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
} from "./domain-schemas.js";
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

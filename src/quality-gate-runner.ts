import type { DistillationPromptTemplate } from "./distillation-prompt.js";
import type { TrustConfig } from "./domain-schemas.js";
import {
  captureProviderGoldenBaseline,
  computeBaselineIdentityDigest,
  createRecordedPredictionProvider,
  evaluateProviderBaselineArtifact,
  type ProviderGoldenBaselineArtifact,
} from "./golden-baseline.js";
import type { GoldenEvaluationReport } from "./golden-evaluator.js";
import {
  QualityGateBindingError,
  QualityGateMetricMissingError,
  QualityGateThresholdsSchema,
  assertQualityGateBaselineBinding,
  evaluateQualityGate,
  type QualityGateMetricName,
  type QualityGateReport,
  type QualityGateThresholds,
} from "./quality-gate.js";

export const QUALITY_GATE_REPORT_KIND = "m2_quality_gate_report";

/** Gate verdict exit codes shared by the runner and the CLI. */
export const QUALITY_GATE_EXIT_PASS = 0;
export const QUALITY_GATE_EXIT_METRIC_FAILURE = 1;
export const QUALITY_GATE_EXIT_INTEGRITY_FAILURE = 2;

export type QualityGateRunFailureCode =
  | "ARTIFACT_INVALID"
  | "BASELINE_MISMATCH"
  | "FIXTURE_DRIFT"
  | "INPUT_UNREADABLE"
  | "METRIC_BELOW_MINIMUM"
  | "METRIC_MISSING"
  | "REPLAY_FAILED"
  | "THRESHOLDS_INVALID";

export type QualityGateRunStatus =
  | "integrity_failure"
  | "metric_failure"
  | "pass";

export interface QualityGateRunFailure {
  readonly code: QualityGateRunFailureCode;
  readonly detail: string;
  readonly expected_digest?: string;
  readonly metric?: QualityGateMetricName;
  readonly minimum?: number;
  readonly mismatches?: readonly string[];
  readonly replayed_digest?: string;
  readonly value?: number;
}

/**
 * Machine-readable verdict of one offline quality gate run. The report is a
 * pure function of the five inputs, so Node 22 and Node 24 produce identical
 * bytes and identical exit codes from the same fixtures.
 */
export interface QualityGateRunReport {
  readonly failures: readonly QualityGateRunFailure[];
  readonly gate: QualityGateReport | null;
  readonly metrics_report: GoldenEvaluationReport | null;
  readonly ok: boolean;
  readonly report_kind: typeof QUALITY_GATE_REPORT_KIND;
  readonly schema_version: 1;
  readonly status: QualityGateRunStatus;
  readonly thresholds_version: string | null;
}

export interface QualityGateRunOutcome {
  readonly exitCode: number;
  readonly report: QualityGateRunReport;
}

export interface RunQualityGateRequest {
  /** Committed baseline artifact the thresholds were reviewed against. */
  readonly artifact: unknown;
  /** Anonymized corpus used to replay the recorded predictions. */
  readonly corpus: unknown;
  readonly prompt: DistillationPromptTemplate;
  /** Recorded provider predictions; the run never touches the network. */
  readonly recordedPredictions: unknown;
  readonly thresholds: unknown;
  readonly trust: TrustConfig;
}

/**
 * Runs the complete offline M2 quality gate:
 *
 * 1. validates the thresholds document and the committed baseline artifact,
 * 2. rejects thresholds that were reviewed against a different measurement
 *    (corpus, measured_at, or any prompt/schema/policy generation),
 * 3. replays the recorded predictions through the current code and rejects
 *    fixture drift — a committed artifact that the corpus + recorded
 *    predictions + current prompt/schema/policy generations no longer
 *    reproduce byte-for-byte,
 * 4. recomputes every metric and compares it against the reviewed minimums,
 *    failing on any missing metric or any value below its floor.
 *
 * Every failure mode is returned as a machine-readable report entry together
 * with a non-zero exit code instead of an unstructured crash.
 */
export async function runQualityGate(
  request: RunQualityGateRequest,
): Promise<QualityGateRunOutcome> {
  const failures: QualityGateRunFailure[] = [];

  const thresholds = parseThresholds(request.thresholds, failures);
  const evaluation = parseArtifact(request.artifact, failures);
  if (thresholds !== null && evaluation !== null) {
    checkBaselineBinding(evaluation.artifact, thresholds, failures);
  }
  if (evaluation !== null) {
    await checkFixtureDrift(request, evaluation.artifact, failures);
  }

  if (failures.length > 0) {
    return buildOutcome(failures, null, evaluation?.report ?? null, thresholds);
  }

  const gate = compareMetrics(evaluation!.report, thresholds!, failures);
  return buildOutcome(failures, gate, evaluation!.report, thresholds);
}

/** Wraps an unreadable input (missing file, broken JSON) fail-closed. */
export function buildUnreadableInputOutcome(
  detail: string,
): QualityGateRunOutcome {
  return buildOutcome([{ code: "INPUT_UNREADABLE", detail }], null, null, null);
}

function parseThresholds(
  input: unknown,
  failures: QualityGateRunFailure[],
): QualityGateThresholds | null {
  const parsed = QualityGateThresholdsSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  failures.push({
    code: "THRESHOLDS_INVALID",
    detail: `thresholds document failed schema validation: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ")}`,
  });
  return null;
}

interface ParsedArtifact {
  readonly artifact: ProviderGoldenBaselineArtifact;
  readonly report: GoldenEvaluationReport;
}

function parseArtifact(
  input: unknown,
  failures: QualityGateRunFailure[],
): ParsedArtifact | null {
  try {
    return evaluateProviderBaselineArtifact(input);
  } catch (error) {
    failures.push({
      code: "ARTIFACT_INVALID",
      detail: `baseline artifact is not evaluable: ${errorMessage(error)}`,
    });
    return null;
  }
}

function checkBaselineBinding(
  artifact: ProviderGoldenBaselineArtifact,
  thresholds: QualityGateThresholds,
  failures: QualityGateRunFailure[],
): void {
  try {
    assertQualityGateBaselineBinding(artifact, thresholds);
  } catch (error) {
    if (!(error instanceof QualityGateBindingError)) throw error;
    failures.push({
      code: "BASELINE_MISMATCH",
      detail: error.message,
      mismatches: error.mismatches,
    });
  }
}

async function checkFixtureDrift(
  request: RunQualityGateRequest,
  artifact: ProviderGoldenBaselineArtifact,
  failures: QualityGateRunFailure[],
): Promise<void> {
  let replayed: ProviderGoldenBaselineArtifact;
  try {
    const provider = createRecordedPredictionProvider(
      request.recordedPredictions,
    );
    const corpusId = (request.corpus as { corpus_id?: unknown }).corpus_id;
    if (provider.recorded.corpus_id !== corpusId) {
      failures.push({
        code: "REPLAY_FAILED",
        detail:
          "BASELINE_CORPUS_MISMATCH: recorded predictions were captured for a different corpus",
      });
      return;
    }
    replayed = await captureProviderGoldenBaseline({
      corpus: request.corpus,
      measuredAt: provider.recorded.recorded_at,
      predictionProvider: provider,
      prompt: request.prompt,
      transmission: { cloudConsent: false, mode: "replay" },
      trust: request.trust,
    });
  } catch (error) {
    failures.push({
      code: "REPLAY_FAILED",
      detail: `recorded predictions could not be replayed: ${errorMessage(error)}`,
    });
    return;
  }
  const expectedDigest = computeBaselineIdentityDigest(artifact);
  const replayedDigest = computeBaselineIdentityDigest(replayed);
  if (expectedDigest === replayedDigest) return;
  failures.push({
    code: "FIXTURE_DRIFT",
    detail:
      "replaying the recorded predictions with the current prompt/schema/policy generations does not reproduce the committed baseline artifact",
    expected_digest: expectedDigest,
    replayed_digest: replayedDigest,
  });
}

function compareMetrics(
  report: GoldenEvaluationReport,
  thresholds: QualityGateThresholds,
  failures: QualityGateRunFailure[],
): QualityGateReport | null {
  let gate: QualityGateReport;
  try {
    gate = evaluateQualityGate(report, thresholds);
  } catch (error) {
    if (!(error instanceof QualityGateMetricMissingError)) throw error;
    for (const metric of error.metrics) {
      failures.push({
        code: "METRIC_MISSING",
        detail: `the recomputed metric report lacks a finite value for ${metric}`,
        metric,
      });
    }
    return null;
  }
  for (const result of gate.results) {
    if (result.pass) continue;
    failures.push({
      code: "METRIC_BELOW_MINIMUM",
      detail: `${result.metric} dropped below its reviewed minimum`,
      metric: result.metric,
      minimum: result.minimum,
      value: result.value,
    });
  }
  return gate;
}

function buildOutcome(
  failures: readonly QualityGateRunFailure[],
  gate: QualityGateReport | null,
  metricsReport: GoldenEvaluationReport | null,
  thresholds: QualityGateThresholds | null,
): QualityGateRunOutcome {
  const status = deriveStatus(failures);
  return {
    exitCode:
      status === "pass"
        ? QUALITY_GATE_EXIT_PASS
        : status === "metric_failure"
          ? QUALITY_GATE_EXIT_METRIC_FAILURE
          : QUALITY_GATE_EXIT_INTEGRITY_FAILURE,
    report: {
      failures,
      gate,
      metrics_report: metricsReport,
      ok: status === "pass",
      report_kind: QUALITY_GATE_REPORT_KIND,
      schema_version: 1,
      status,
      thresholds_version: thresholds?.thresholds_version ?? null,
    },
  };
}

function deriveStatus(
  failures: readonly QualityGateRunFailure[],
): QualityGateRunStatus {
  if (failures.length === 0) return "pass";
  const onlyMetricFloors = failures.every(
    (failure) => failure.code === "METRIC_BELOW_MINIMUM",
  );
  return onlyMetricFloors ? "metric_failure" : "integrity_failure";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { z } from "zod";

import { IsoDateTimeSchema } from "./domain-schemas.js";
import { QUALITY_GATE_REPORT_KIND } from "./quality-gate-runner.js";

export const PILOT_DAILY_RECORD_KIND = "m2_pilot_daily_record";
export const PILOT_SUMMARY_REPORT_KIND = "m2_pilot_summary_report";
export const PILOT_RECORD_SCHEMA_VERSION = 1;
export const DEFAULT_PILOT_DURATION_DAYS = 14;

const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day in `YYYY-MM-DD`, validated as a real date. */
export const UtcDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be a UTC day formatted as YYYY-MM-DD")
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, "YYYY-MM-DD".length) === value
      );
    },
    { message: "must be a valid UTC calendar day" },
  );

/**
 * One cron run summary line as emitted by `repo-knowledge sync` on stdout.
 * Only the fields the pilot aggregates are validated; the schema tolerates
 * additive summary fields so a newer CLI does not break older pilot tooling.
 */
export const PilotSyncSummaryLineSchema = z.object({
  discovered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failures: z.array(
    z.object({
      message: z.string(),
      pr_number: z.number().int().positive(),
    }),
  ),
  ingested: z.number().int().nonnegative(),
  jobs_created: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

/**
 * Failure marker the cron wrapper appends to the sync log when a run exits
 * without printing its summary JSON (for example on `LOCK_TIMEOUT` or a gh
 * failure before any output). Without the marker such aborted runs would be
 * invisible to `runs_total` / `runs_failed`, and the pilot's rollback
 * condition "every run failed on two consecutive UTC days" could never
 * trigger. The marker counts as one failed run; it carries no per-PR data.
 */
export const PilotCronRunFailureLineSchema = z.object({
  cron_run_failed: z.literal(true),
  exit_code: z.number().int(),
});

/** The subset of the `stats` CLI output the pilot records every day. */
export const PilotStatsSnapshotSchema = z.object({
  canonical_digest: z.string().min(1),
  knowledge: z.object({ total: z.number().int().nonnegative() }),
  operations: z.object({
    failed_jobs: z.number().int().nonnegative(),
    last_sync_checkpoint_at: z.string().min(1).nullable(),
    pending_jobs: z.number().int().nonnegative(),
  }),
  outcomes: z.object({ total: z.number().int().nonnegative() }),
  stats_schema_version: z.literal(1),
});

/** The subset of the quality gate report the pilot records every day. */
export const PilotQualityGateReportSchema = z.object({
  report_kind: z.literal(QUALITY_GATE_REPORT_KIND),
  schema_version: z.literal(1),
  status: z.enum(["integrity_failure", "metric_failure", "pass"]),
});

export type PilotSyncSummaryLine = z.infer<typeof PilotSyncSummaryLineSchema>;

/**
 * A line claiming to be a cron failure marker is validated as one instead
 * of falling through to the summary schema, so a malformed marker is
 * reported as a marker problem rather than a misleading summary error.
 */
function isCronRunFailureCandidate(line: unknown): boolean {
  return (
    typeof line === "object" &&
    line !== null &&
    !Array.isArray(line) &&
    "cron_run_failed" in line
  );
}

export const PilotGateStatusSchema = z.enum([
  "integrity_failure",
  "metric_failure",
  "not_run",
  "pass",
]);

export type PilotGateStatus = z.infer<typeof PilotGateStatusSchema>;

const PilotSyncActivitySchema = z
  .object({
    discovered: z.number().int().nonnegative(),
    failed_pull_requests: z.array(z.number().int().positive()),
    ingested: z.number().int().nonnegative(),
    jobs_created: z.number().int().nonnegative(),
    retry_attempts: z.number().int().nonnegative(),
    runs_failed: z.number().int().nonnegative(),
    runs_total: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.runs_failed <= value.runs_total, {
    message: "runs_failed must not exceed runs_total",
  });

const PilotBacklogSchema = z
  .object({
    failed_jobs: z.number().int().nonnegative(),
    last_sync_checkpoint_at: z.string().min(1).nullable(),
    pending_jobs: z.number().int().nonnegative(),
  })
  .strict();

const PilotQualitySchema = z
  .object({
    canonical_digest: z.string().min(1),
    gate_status: PilotGateStatusSchema,
    knowledge_total: z.number().int().nonnegative(),
    outcomes_total: z.number().int().nonnegative(),
  })
  .strict();

const dailyRecordBaseShape = {
  date: UtcDaySchema,
  pilot_id: z.string().min(1),
  record_kind: z.literal(PILOT_DAILY_RECORD_KIND),
  recorded_at: IsoDateTimeSchema,
  schema_version: z.literal(PILOT_RECORD_SCHEMA_VERSION),
} as const;

export const ObservedPilotDailyRecordSchema = z
  .object({
    ...dailyRecordBaseShape,
    backlog: PilotBacklogSchema,
    notes: z.string().min(1).optional(),
    quality: PilotQualitySchema,
    status: z.literal("observed"),
    sync: PilotSyncActivitySchema,
  })
  .strict();

/** A day without machine observation must carry an explicit reason. */
export const MissingPilotDailyRecordSchema = z
  .object({
    ...dailyRecordBaseShape,
    notes: z.string().min(1).optional(),
    reason: z.string().min(1),
    status: z.literal("missing"),
  })
  .strict();

export const PilotDailyRecordSchema = z.discriminatedUnion("status", [
  ObservedPilotDailyRecordSchema,
  MissingPilotDailyRecordSchema,
]);

export type ObservedPilotDailyRecord = z.infer<
  typeof ObservedPilotDailyRecordSchema
>;
export type MissingPilotDailyRecord = z.infer<
  typeof MissingPilotDailyRecordSchema
>;
export type PilotDailyRecord = z.infer<typeof PilotDailyRecordSchema>;

export type PilotRecordErrorCode =
  | "PILOT_DATE_OUT_OF_WINDOW"
  | "PILOT_DUPLICATE_DATE"
  | "PILOT_ID_MISMATCH"
  | "PILOT_LOG_EMPTY"
  | "PILOT_QUALITY_GATE_INVALID"
  | "PILOT_RECORD_INVALID"
  | "PILOT_STATS_INVALID"
  | "PILOT_SYNC_LOG_INVALID";

export class PilotRecordError extends Error {
  constructor(
    readonly code: PilotRecordErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PilotRecordError";
  }
}

export interface BuildObservedDailyRecordRequest {
  readonly date: string;
  readonly notes?: string;
  readonly pilotId: string;
  /** Quality gate report for the day; omit when the gate was not run. */
  readonly qualityGateReport?: unknown;
  readonly recordedAt: string;
  readonly stats: unknown;
  /** Parsed JSONL lines of the day's sync cron log (may be empty). */
  readonly syncSummaries: readonly unknown[];
}

/**
 * Builds one observed daily record by aggregating the day's sync cron log,
 * the `stats` snapshot, and the optional quality gate report. Duplicate
 * ingest work surfaces as `unchanged` (idempotent re-ingests), and retries
 * surface as repeated failures of the same PR across runs. A sync log line
 * may be either a summary or a cron failure marker (see
 * `PilotCronRunFailureLineSchema`); markers count as failed runs, and any
 * other line stays a fail-closed validation error.
 */
export function buildObservedDailyRecord(
  request: BuildObservedDailyRecordRequest,
): ObservedPilotDailyRecord {
  const summaries: PilotSyncSummaryLine[] = [];
  let abortedRuns = 0;
  for (const [index, line] of request.syncSummaries.entries()) {
    if (isCronRunFailureCandidate(line)) {
      const marker = PilotCronRunFailureLineSchema.safeParse(line);
      if (!marker.success) {
        throw new PilotRecordError(
          "PILOT_SYNC_LOG_INVALID",
          `cron failure marker line ${String(index + 1)} failed validation: ${formatZodError(marker.error)}`,
        );
      }
      abortedRuns += 1;
      continue;
    }
    const parsed = PilotSyncSummaryLineSchema.safeParse(line);
    if (!parsed.success) {
      throw new PilotRecordError(
        "PILOT_SYNC_LOG_INVALID",
        `sync summary line ${String(index + 1)} failed validation: ${formatZodError(parsed.error)}`,
      );
    }
    summaries.push(parsed.data);
  }
  const stats = PilotStatsSnapshotSchema.safeParse(request.stats);
  if (!stats.success) {
    throw new PilotRecordError(
      "PILOT_STATS_INVALID",
      `stats snapshot failed validation: ${formatZodError(stats.error)}`,
    );
  }
  const gateStatus = parseGateStatus(request.qualityGateReport);

  const failureOccurrences = summaries.flatMap((summary) =>
    summary.failures.map((failure) => failure.pr_number),
  );
  const failedPullRequests = [...new Set(failureOccurrences)].sort(
    (left, right) => left - right,
  );
  const record: ObservedPilotDailyRecord = {
    backlog: {
      failed_jobs: stats.data.operations.failed_jobs,
      last_sync_checkpoint_at: stats.data.operations.last_sync_checkpoint_at,
      pending_jobs: stats.data.operations.pending_jobs,
    },
    date: request.date,
    ...(request.notes === undefined ? {} : { notes: request.notes }),
    pilot_id: request.pilotId,
    quality: {
      canonical_digest: stats.data.canonical_digest,
      gate_status: gateStatus,
      knowledge_total: stats.data.knowledge.total,
      outcomes_total: stats.data.outcomes.total,
    },
    record_kind: PILOT_DAILY_RECORD_KIND,
    recorded_at: request.recordedAt,
    schema_version: PILOT_RECORD_SCHEMA_VERSION,
    status: "observed",
    sync: {
      discovered: sumOf(summaries, (summary) => summary.discovered),
      failed_pull_requests: failedPullRequests,
      ingested: sumOf(summaries, (summary) => summary.ingested),
      jobs_created: sumOf(summaries, (summary) => summary.jobs_created),
      retry_attempts: failureOccurrences.length - failedPullRequests.length,
      runs_failed:
        summaries.filter((summary) => summary.failed > 0).length + abortedRuns,
      runs_total: summaries.length + abortedRuns,
      unchanged: sumOf(summaries, (summary) => summary.unchanged),
    },
  };
  return parseRecordOrThrow(record);
}

export interface BuildMissingDailyRecordRequest {
  readonly date: string;
  readonly notes?: string;
  readonly pilotId: string;
  readonly reason: string;
  readonly recordedAt: string;
}

/** Builds one explicit gap record; the reason field is mandatory. */
export function buildMissingDailyRecord(
  request: BuildMissingDailyRecordRequest,
): MissingPilotDailyRecord {
  const record: MissingPilotDailyRecord = {
    date: request.date,
    ...(request.notes === undefined ? {} : { notes: request.notes }),
    pilot_id: request.pilotId,
    reason: request.reason,
    record_kind: PILOT_DAILY_RECORD_KIND,
    recorded_at: request.recordedAt,
    schema_version: PILOT_RECORD_SCHEMA_VERSION,
    status: "missing",
  };
  const parsed = MissingPilotDailyRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PilotRecordError(
      "PILOT_RECORD_INVALID",
      formatZodError(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Parses an append-only pilot log (JSONL text) into validated records.
 * The whole log must belong to one pilot and one record per day; both
 * violations are rejected fail-closed so a corrupted log never aggregates.
 */
export function parsePilotLog(text: string): readonly PilotDailyRecord[] {
  const records: PilotDailyRecord[] = [];
  const seenDates = new Set<string>();
  const lines = text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0);
  for (const { line, lineNumber } of lines) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PilotRecordError(
        "PILOT_RECORD_INVALID",
        `line ${String(lineNumber)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = PilotDailyRecordSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new PilotRecordError(
        "PILOT_RECORD_INVALID",
        `line ${String(lineNumber)} failed validation: ${formatZodError(parsed.error)}`,
      );
    }
    const record = parsed.data;
    const firstPilotId = records[0]?.pilot_id;
    if (firstPilotId !== undefined && record.pilot_id !== firstPilotId) {
      throw new PilotRecordError(
        "PILOT_ID_MISMATCH",
        `line ${String(lineNumber)} belongs to pilot ${record.pilot_id} but the log started with ${firstPilotId}`,
      );
    }
    if (seenDates.has(record.date)) {
      throw new PilotRecordError(
        "PILOT_DUPLICATE_DATE",
        `line ${String(lineNumber)} repeats date ${record.date}; one record per day`,
      );
    }
    seenDates.add(record.date);
    records.push(record);
  }
  return records;
}

function parseRecordOrThrow(record: unknown): ObservedPilotDailyRecord {
  const parsed = ObservedPilotDailyRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new PilotRecordError(
      "PILOT_RECORD_INVALID",
      formatZodError(parsed.error),
    );
  }
  return parsed.data;
}

function parseGateStatus(report: unknown): PilotGateStatus {
  if (report === undefined) return "not_run";
  const parsed = PilotQualityGateReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new PilotRecordError(
      "PILOT_QUALITY_GATE_INVALID",
      `quality gate report failed validation: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data.status;
}

function sumOf<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/** Lists the `durationDays` UTC days of the pilot window from `startDate`. */
export function listPilotWindowDates(
  startDate: string,
  durationDays: number,
): readonly string[] {
  const start = UtcDaySchema.parse(startDate);
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: durationDays }, (_, index) =>
    new Date(startMs + index * MS_PER_UTC_DAY)
      .toISOString()
      .slice(0, "YYYY-MM-DD".length),
  );
}

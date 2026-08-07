import {
  DEFAULT_PILOT_DURATION_DAYS,
  PILOT_SUMMARY_REPORT_KIND,
  PilotRecordError,
  listPilotWindowDates,
  type ObservedPilotDailyRecord,
  type PilotDailyRecord,
  type PilotGateStatus,
} from "./pilot-daily-record.js";

export interface PilotSummaryWindow {
  readonly duration_days: number;
  readonly end_date: string;
  readonly start_date: string;
}

export interface PilotSummaryCoverage {
  /** True when every expected day has an observed or missing record. */
  readonly complete: boolean;
  readonly days_expected: number;
  readonly days_missing: number;
  readonly days_observed: number;
  /** Expected days that have neither an observed nor a missing record. */
  readonly unrecorded_dates: readonly string[];
}

export interface PilotSummarySync {
  readonly discovered: number;
  readonly failed_pull_requests: readonly number[];
  readonly ingested: number;
  readonly jobs_created: number;
  readonly retry_attempts: number;
  /** `(runs_total - runs_failed) / runs_total`, or null without any run. */
  readonly run_success_rate: number | null;
  readonly runs_failed: number;
  readonly runs_total: number;
  readonly unchanged: number;
}

export interface PilotSummaryBacklog {
  readonly final_failed_jobs: number | null;
  readonly final_pending_jobs: number | null;
  readonly max_failed_jobs: number | null;
  readonly max_pending_jobs: number | null;
}

export interface PilotSummaryQuality {
  readonly days_by_gate_status: Readonly<Record<PilotGateStatus, number>>;
  readonly final_canonical_digest: string | null;
  readonly final_knowledge_total: number | null;
  readonly final_outcomes_total: number | null;
}

export interface PilotSummaryMissingDay {
  readonly date: string;
  readonly reason: string;
}

export interface PilotSummaryReport {
  readonly backlog: PilotSummaryBacklog;
  readonly coverage: PilotSummaryCoverage;
  readonly missing_days: readonly PilotSummaryMissingDay[];
  readonly pilot_id: string;
  readonly quality: PilotSummaryQuality;
  readonly report_kind: typeof PILOT_SUMMARY_REPORT_KIND;
  readonly schema_version: 1;
  readonly sync: PilotSummarySync;
  readonly window: PilotSummaryWindow;
}

export interface SummarizePilotLogRequest {
  readonly durationDays?: number;
  readonly records: readonly PilotDailyRecord[];
  readonly startDate: string;
}

/**
 * Aggregates a validated pilot log into the machine-readable summary the
 * final M2 report quotes. The summary is a pure function of the records and
 * the declared window, so re-running it never changes the verdict.
 */
export function summarizePilotLog(
  request: SummarizePilotLogRequest,
): PilotSummaryReport {
  const durationDays = request.durationDays ?? DEFAULT_PILOT_DURATION_DAYS;
  const expectedDates = listPilotWindowDates(request.startDate, durationDays);
  const records = sortByDate(request.records);
  if (records.length === 0) {
    throw new PilotRecordError(
      "PILOT_LOG_EMPTY",
      "the pilot log has no records to summarize",
    );
  }
  const expected = new Set(expectedDates);
  for (const record of records) {
    if (!expected.has(record.date)) {
      throw new PilotRecordError(
        "PILOT_DATE_OUT_OF_WINDOW",
        `record date ${record.date} is outside the declared pilot window ${expectedDates[0]!}..${expectedDates.at(-1)!}`,
      );
    }
  }
  const observed = records.filter(
    (record): record is ObservedPilotDailyRecord =>
      record.status === "observed",
  );
  const missingDays = records
    .filter((record) => record.status === "missing")
    .map((record) => ({ date: record.date, reason: record.reason }));
  const recordedDates = new Set(records.map((record) => record.date));
  const unrecordedDates = expectedDates.filter(
    (date) => !recordedDates.has(date),
  );
  const lastObserved = observed.at(-1) ?? null;
  return {
    backlog: {
      final_failed_jobs: lastObserved?.backlog.failed_jobs ?? null,
      final_pending_jobs: lastObserved?.backlog.pending_jobs ?? null,
      max_failed_jobs: maxOf(observed, (record) => record.backlog.failed_jobs),
      max_pending_jobs: maxOf(
        observed,
        (record) => record.backlog.pending_jobs,
      ),
    },
    coverage: {
      complete: unrecordedDates.length === 0,
      days_expected: expectedDates.length,
      days_missing: missingDays.length,
      days_observed: observed.length,
      unrecorded_dates: unrecordedDates,
    },
    missing_days: missingDays,
    pilot_id: records[0]!.pilot_id,
    quality: {
      days_by_gate_status: countByGateStatus(observed),
      final_canonical_digest: lastObserved?.quality.canonical_digest ?? null,
      final_knowledge_total: lastObserved?.quality.knowledge_total ?? null,
      final_outcomes_total: lastObserved?.quality.outcomes_total ?? null,
    },
    report_kind: PILOT_SUMMARY_REPORT_KIND,
    schema_version: 1,
    sync: summarizeSync(observed),
    window: {
      duration_days: durationDays,
      end_date: expectedDates.at(-1)!,
      start_date: expectedDates[0]!,
    },
  };
}

function summarizeSync(
  observed: readonly ObservedPilotDailyRecord[],
): PilotSummarySync {
  const runsTotal = sumOf(observed, (record) => record.sync.runs_total);
  const runsFailed = sumOf(observed, (record) => record.sync.runs_failed);
  const failedPullRequests = [
    ...new Set(observed.flatMap((record) => record.sync.failed_pull_requests)),
  ].sort((left, right) => left - right);
  return {
    discovered: sumOf(observed, (record) => record.sync.discovered),
    failed_pull_requests: failedPullRequests,
    ingested: sumOf(observed, (record) => record.sync.ingested),
    jobs_created: sumOf(observed, (record) => record.sync.jobs_created),
    retry_attempts: sumOf(observed, (record) => record.sync.retry_attempts),
    run_success_rate:
      runsTotal === 0 ? null : (runsTotal - runsFailed) / runsTotal,
    runs_failed: runsFailed,
    runs_total: runsTotal,
    unchanged: sumOf(observed, (record) => record.sync.unchanged),
  };
}

function countByGateStatus(
  observed: readonly ObservedPilotDailyRecord[],
): Readonly<Record<PilotGateStatus, number>> {
  const counts: Record<PilotGateStatus, number> = {
    integrity_failure: 0,
    metric_failure: 0,
    not_run: 0,
    pass: 0,
  };
  for (const record of observed) {
    counts[record.quality.gate_status] += 1;
  }
  return counts;
}

function sortByDate(
  records: readonly PilotDailyRecord[],
): readonly PilotDailyRecord[] {
  return [...records].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
}

function sumOf<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function maxOf<T>(
  items: readonly T[],
  select: (item: T) => number,
): number | null {
  if (items.length === 0) return null;
  return items.reduce(
    (maximum, item) => Math.max(maximum, select(item)),
    Number.NEGATIVE_INFINITY,
  );
}

import { describe, expect, it } from "vitest";

import {
  PilotRecordError,
  buildMissingDailyRecord,
  buildObservedDailyRecord,
  listPilotWindowDates,
  parsePilotLog,
  summarizePilotLog,
  type PilotDailyRecord,
} from "../src/index.js";

const PILOT_ID = "m2-cron-pilot-test";
const RECORDED_AT = "2026-08-02T00:05:00.000Z";

function syncSummaryLine(
  overrides: Partial<{
    discovered: number;
    failed: number;
    failures: { message: string; pr_number: number }[];
    ingested: number;
    jobs_created: number;
    unchanged: number;
  }> = {},
): unknown {
  return {
    discovered: 0,
    failed: 0,
    failures: [],
    ingested: 0,
    jobs_created: 0,
    next_cursor: null,
    unchanged: 0,
    ...overrides,
  };
}

function statsSnapshot(
  overrides: Partial<{
    canonical_digest: string;
    failed_jobs: number;
    knowledge_total: number;
    outcomes_total: number;
    pending_jobs: number;
  }> = {},
): unknown {
  return {
    buckets: null,
    canonical_digest: overrides.canonical_digest ?? "sha256:aa11",
    knowledge: { total: overrides.knowledge_total ?? 5 },
    operations: {
      failed_jobs: overrides.failed_jobs ?? 0,
      last_sync_checkpoint_at: "2026-08-01T23:45:00Z",
      pending_jobs: overrides.pending_jobs ?? 2,
    },
    outcomes: { total: overrides.outcomes_total ?? 3 },
    stats_schema_version: 1,
  };
}

const PASSING_GATE_REPORT = {
  ok: true,
  report_kind: "m2_quality_gate_report",
  schema_version: 1,
  status: "pass",
};

function observedRecord(
  date: string,
  overrides: {
    gateStatus?: "pass" | "not_run";
    failures?: number[];
    pendingJobs?: number;
  } = {},
): PilotDailyRecord {
  return buildObservedDailyRecord({
    date,
    pilotId: PILOT_ID,
    ...(overrides.gateStatus === "not_run"
      ? {}
      : { qualityGateReport: PASSING_GATE_REPORT }),
    recordedAt: RECORDED_AT,
    stats: statsSnapshot(
      overrides.pendingJobs === undefined
        ? {}
        : { pending_jobs: overrides.pendingJobs },
    ),
    syncSummaries: [
      syncSummaryLine({ discovered: 1, ingested: 1 }),
      ...(overrides.failures ?? []).map((prNumber) =>
        syncSummaryLine({
          discovered: 1,
          failed: 1,
          failures: [{ message: "boom", pr_number: prNumber }],
        }),
      ),
    ],
  });
}

describe("buildObservedDailyRecord", () => {
  it("aggregates runs, duplicates, failures, and retries from the day's sync log", () => {
    const record = buildObservedDailyRecord({
      date: "2026-08-01",
      pilotId: PILOT_ID,
      qualityGateReport: PASSING_GATE_REPORT,
      recordedAt: RECORDED_AT,
      stats: statsSnapshot({ pending_jobs: 4 }),
      syncSummaries: [
        syncSummaryLine({
          discovered: 3,
          ingested: 2,
          jobs_created: 2,
          unchanged: 1,
        }),
        syncSummaryLine({
          discovered: 2,
          failed: 1,
          failures: [{ message: "rate limited", pr_number: 321 }],
          ingested: 1,
        }),
        syncSummaryLine({
          discovered: 1,
          failed: 1,
          failures: [{ message: "rate limited", pr_number: 321 }],
        }),
        syncSummaryLine({ discovered: 1, unchanged: 1 }),
      ],
    });

    expect(record.status).toBe("observed");
    expect(record.sync).toEqual({
      discovered: 7,
      failed_pull_requests: [321],
      ingested: 3,
      jobs_created: 2,
      // The same PR failing in two runs is one failed PR plus one retry.
      retry_attempts: 1,
      runs_failed: 2,
      runs_total: 4,
      unchanged: 2,
    });
    expect(record.backlog).toEqual({
      failed_jobs: 0,
      last_sync_checkpoint_at: "2026-08-01T23:45:00Z",
      pending_jobs: 4,
    });
    expect(record.quality).toEqual({
      canonical_digest: "sha256:aa11",
      gate_status: "pass",
      knowledge_total: 5,
      outcomes_total: 3,
    });
  });

  it("records gate_status not_run when no quality gate report is provided", () => {
    const record = buildObservedDailyRecord({
      date: "2026-08-01",
      pilotId: PILOT_ID,
      recordedAt: RECORDED_AT,
      stats: statsSnapshot(),
      syncSummaries: [],
    });

    expect(record.quality.gate_status).toBe("not_run");
    expect(record.sync.runs_total).toBe(0);
  });

  it("rejects an invalid sync summary line fail-closed", () => {
    expect(() =>
      buildObservedDailyRecord({
        date: "2026-08-01",
        pilotId: PILOT_ID,
        recordedAt: RECORDED_AT,
        stats: statsSnapshot(),
        syncSummaries: [{ discovered: "many" }],
      }),
    ).toThrowError(/PILOT_SYNC_LOG_INVALID/u);
  });

  it("rejects an invalid stats snapshot and an invalid gate report", () => {
    expect(() =>
      buildObservedDailyRecord({
        date: "2026-08-01",
        pilotId: PILOT_ID,
        recordedAt: RECORDED_AT,
        stats: { canonical_digest: "" },
        syncSummaries: [],
      }),
    ).toThrowError(/PILOT_STATS_INVALID/u);
    expect(() =>
      buildObservedDailyRecord({
        date: "2026-08-01",
        pilotId: PILOT_ID,
        qualityGateReport: { status: "unheard-of" },
        recordedAt: RECORDED_AT,
        stats: statsSnapshot(),
        syncSummaries: [],
      }),
    ).toThrowError(/PILOT_QUALITY_GATE_INVALID/u);
  });

  it("rejects a calendar-invalid date", () => {
    expect(() =>
      buildObservedDailyRecord({
        date: "2026-02-30",
        pilotId: PILOT_ID,
        recordedAt: RECORDED_AT,
        stats: statsSnapshot(),
        syncSummaries: [],
      }),
    ).toThrowError(/PILOT_RECORD_INVALID/u);
  });
});

describe("buildMissingDailyRecord", () => {
  it("requires an explicit non-empty reason", () => {
    expect(() =>
      buildMissingDailyRecord({
        date: "2026-08-03",
        pilotId: PILOT_ID,
        reason: "",
        recordedAt: RECORDED_AT,
      }),
    ).toThrowError(/PILOT_RECORD_INVALID/u);

    const record = buildMissingDailyRecord({
      date: "2026-08-03",
      pilotId: PILOT_ID,
      reason: "operator was offline; recorded retroactively",
      recordedAt: RECORDED_AT,
    });
    expect(record.status).toBe("missing");
    expect(record.reason).toContain("offline");
  });
});

describe("parsePilotLog", () => {
  it("round-trips records through JSONL", () => {
    const records = [
      observedRecord("2026-08-01"),
      observedRecord("2026-08-02"),
    ];
    const text = records.map((record) => JSON.stringify(record)).join("\n");

    expect(parsePilotLog(`${text}\n`)).toEqual(records);
  });

  it("rejects duplicate dates, mixed pilots, and broken lines", () => {
    const record = observedRecord("2026-08-01");
    const duplicate = `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`;
    expect(() => parsePilotLog(duplicate)).toThrowError(
      /PILOT_DUPLICATE_DATE/u,
    );

    const foreign = {
      ...observedRecord("2026-08-02"),
      pilot_id: "another-pilot",
    };
    const mixed = `${JSON.stringify(record)}\n${JSON.stringify(foreign)}\n`;
    expect(() => parsePilotLog(mixed)).toThrowError(/PILOT_ID_MISMATCH/u);

    expect(() => parsePilotLog("not json\n")).toThrowError(
      /PILOT_RECORD_INVALID/u,
    );
  });
});

describe("summarizePilotLog", () => {
  it("aggregates coverage, success rate, backlog, and gate statuses", () => {
    const records: PilotDailyRecord[] = [
      observedRecord("2026-08-01", { failures: [11] }),
      observedRecord("2026-08-02", { gateStatus: "not_run" }),
      buildMissingDailyRecord({
        date: "2026-08-03",
        pilotId: PILOT_ID,
        reason: "power outage",
        recordedAt: RECORDED_AT,
      }),
    ];

    const summary = summarizePilotLog({
      durationDays: 5,
      records,
      startDate: "2026-08-01",
    });

    expect(summary.pilot_id).toBe(PILOT_ID);
    expect(summary.window).toEqual({
      duration_days: 5,
      end_date: "2026-08-05",
      start_date: "2026-08-01",
    });
    expect(summary.coverage).toEqual({
      complete: false,
      days_expected: 5,
      days_missing: 1,
      days_observed: 2,
      unrecorded_dates: ["2026-08-04", "2026-08-05"],
    });
    expect(summary.missing_days).toEqual([
      { date: "2026-08-03", reason: "power outage" },
    ]);
    // Day one has 2 runs (1 failed), day two has 1 run: 2 of 3 succeeded.
    expect(summary.sync.runs_total).toBe(3);
    expect(summary.sync.runs_failed).toBe(1);
    expect(summary.sync.run_success_rate).toBeCloseTo(2 / 3, 10);
    expect(summary.sync.failed_pull_requests).toEqual([11]);
    expect(summary.quality.days_by_gate_status).toEqual({
      integrity_failure: 0,
      metric_failure: 0,
      not_run: 1,
      pass: 1,
    });
    expect(summary.backlog.final_pending_jobs).toBe(2);
    expect(summary.quality.final_canonical_digest).toBe("sha256:aa11");
  });

  it("reports complete coverage when every day is observed or excused", () => {
    const summary = summarizePilotLog({
      durationDays: 2,
      records: [
        observedRecord("2026-08-01"),
        buildMissingDailyRecord({
          date: "2026-08-02",
          pilotId: PILOT_ID,
          reason: "maintenance window",
          recordedAt: RECORDED_AT,
        }),
      ],
      startDate: "2026-08-01",
    });

    expect(summary.coverage.complete).toBe(true);
    expect(summary.coverage.unrecorded_dates).toEqual([]);
  });

  it("exposes the day-by-day backlog and detects a monotonically increasing backlog", () => {
    const summary = summarizePilotLog({
      durationDays: 3,
      records: [
        observedRecord("2026-08-01", { pendingJobs: 1 }),
        observedRecord("2026-08-02", { pendingJobs: 3 }),
        observedRecord("2026-08-03", { pendingJobs: 3 }),
      ],
      startDate: "2026-08-01",
    });

    expect(summary.backlog.pending_jobs_by_day).toEqual([
      { date: "2026-08-01", pending_jobs: 1 },
      { date: "2026-08-02", pending_jobs: 3 },
      { date: "2026-08-03", pending_jobs: 3 },
    ]);
    expect(summary.backlog.backlog_series_gaps).toEqual([]);
    // Never decreases and strictly grows overall: the no-go signal.
    expect(summary.backlog.pending_jobs_monotonically_increasing).toBe(true);
  });

  it("returns an indeterminate backlog verdict when the observed series is interrupted", () => {
    // Day 2 is excused with a reason, day 4 is simply unrecorded; both
    // interrupt the series between the first and last observed day.
    const summary = summarizePilotLog({
      durationDays: 5,
      records: [
        observedRecord("2026-08-01", { pendingJobs: 1 }),
        buildMissingDailyRecord({
          date: "2026-08-02",
          pilotId: PILOT_ID,
          reason: "operator offline",
          recordedAt: RECORDED_AT,
        }),
        observedRecord("2026-08-03", { pendingJobs: 2 }),
        observedRecord("2026-08-05", { pendingJobs: 4 }),
      ],
      startDate: "2026-08-01",
    });

    expect(summary.backlog.backlog_series_gaps).toEqual([
      "2026-08-02",
      "2026-08-04",
    ]);
    // The backlog may have moved during the gaps, so the verdict is
    // indeterminate rather than a boolean the go decision could trust.
    expect(summary.backlog.pending_jobs_monotonically_increasing).toBeNull();
  });

  it("voids the backlog verdict when the window's leading edge is not observed", () => {
    // Day 1 is excused with a reason: the series starts unobserved, so the
    // backlog may already have moved before the first sample.
    const summary = summarizePilotLog({
      durationDays: 3,
      records: [
        buildMissingDailyRecord({
          date: "2026-08-01",
          pilotId: PILOT_ID,
          reason: "cron not yet installed",
          recordedAt: RECORDED_AT,
        }),
        observedRecord("2026-08-02", { pendingJobs: 1 }),
        observedRecord("2026-08-03", { pendingJobs: 2 }),
      ],
      startDate: "2026-08-01",
    });

    expect(summary.backlog.backlog_series_gaps).toEqual(["2026-08-01"]);
    expect(summary.backlog.pending_jobs_monotonically_increasing).toBeNull();
  });

  it("voids the backlog verdict when the window's trailing edge is not observed", () => {
    // The unrecorded day 3 ends the window unobserved: the final backlog
    // state is unknown, so no boolean verdict is possible.
    const summary = summarizePilotLog({
      durationDays: 3,
      records: [
        observedRecord("2026-08-01", { pendingJobs: 1 }),
        observedRecord("2026-08-02", { pendingJobs: 2 }),
      ],
      startDate: "2026-08-01",
    });

    expect(summary.backlog.backlog_series_gaps).toEqual(["2026-08-03"]);
    expect(summary.backlog.pending_jobs_monotonically_increasing).toBeNull();
  });

  it("does not flag a backlog that dips, stays flat, or has a single sample", () => {
    const dipping = summarizePilotLog({
      durationDays: 3,
      records: [
        observedRecord("2026-08-01", { pendingJobs: 1 }),
        observedRecord("2026-08-02", { pendingJobs: 5 }),
        observedRecord("2026-08-03", { pendingJobs: 2 }),
      ],
      startDate: "2026-08-01",
    });
    expect(dipping.backlog.pending_jobs_monotonically_increasing).toBe(false);

    const flat = summarizePilotLog({
      durationDays: 2,
      records: [
        observedRecord("2026-08-01", { pendingJobs: 4 }),
        observedRecord("2026-08-02", { pendingJobs: 4 }),
      ],
      startDate: "2026-08-01",
    });
    expect(flat.backlog.pending_jobs_monotonically_increasing).toBe(false);

    const single = summarizePilotLog({
      durationDays: 1,
      records: [observedRecord("2026-08-01", { pendingJobs: 9 })],
      startDate: "2026-08-01",
    });
    expect(single.backlog.pending_jobs_monotonically_increasing).toBe(false);
    expect(single.backlog.pending_jobs_by_day).toEqual([
      { date: "2026-08-01", pending_jobs: 9 },
    ]);
  });

  it("rejects records outside the declared window and empty logs", () => {
    expect(() =>
      summarizePilotLog({
        durationDays: 2,
        records: [observedRecord("2026-08-09")],
        startDate: "2026-08-01",
      }),
    ).toThrowError(/PILOT_DATE_OUT_OF_WINDOW/u);
    expect(() =>
      summarizePilotLog({
        durationDays: 2,
        records: [],
        startDate: "2026-08-01",
      }),
    ).toThrowError(PilotRecordError);
  });
});

describe("listPilotWindowDates", () => {
  it("spans month boundaries in UTC", () => {
    expect(listPilotWindowDates("2026-08-30", 4)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

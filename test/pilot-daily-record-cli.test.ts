import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PilotDailyRecord, PilotSummaryReport } from "../src/index.js";
import { repositoryRoot } from "./support/quality-gate-fixtures.js";

const CLI = join(repositoryRoot, "dist", "pilot-daily-record-cli.js");
const PILOT_ID = "m2-cron-pilot-cli-test";

async function runCli(argv: readonly string[]): Promise<{
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
}> {
  const result = await execa(process.execPath, [CLI, ...argv], {
    cwd: repositoryRoot,
    reject: false,
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

describe("pilot daily record CLI", () => {
  let workingDirectory: string;
  let logPath: string;
  let statsPath: string;
  let gatePath: string;
  let syncLogPath: string;

  beforeAll(async () => {
    workingDirectory = await mkdtemp(join(tmpdir(), "rkm-pilot-cli-"));
    logPath = join(workingDirectory, "pilot-log.jsonl");
    statsPath = join(workingDirectory, "stats.json");
    gatePath = join(workingDirectory, "quality-gate.json");
    syncLogPath = join(workingDirectory, "sync-2026-08-01.jsonl");
    await writeFile(
      statsPath,
      JSON.stringify({
        canonical_digest: "sha256:cli",
        knowledge: { total: 7 },
        operations: {
          failed_jobs: 1,
          last_sync_checkpoint_at: "2026-08-01T23:45:00Z",
          pending_jobs: 3,
        },
        outcomes: { total: 4 },
        stats_schema_version: 1,
      }),
      "utf8",
    );
    await writeFile(
      gatePath,
      JSON.stringify({
        report_kind: "m2_quality_gate_report",
        schema_version: 1,
        status: "pass",
      }),
      "utf8",
    );
    const syncLines = [
      {
        discovered: 2,
        failed: 0,
        failures: [],
        ingested: 2,
        jobs_created: 1,
        next_cursor: null,
        unchanged: 0,
      },
      {
        discovered: 1,
        failed: 1,
        failures: [{ message: "rate limited", pr_number: 42 }],
        ingested: 0,
        jobs_created: 0,
        next_cursor: null,
        unchanged: 0,
      },
    ];
    await writeFile(
      syncLogPath,
      `${syncLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(workingDirectory, { force: true, recursive: true });
  });

  it("appends an observed record aggregated from sync log, stats, and gate report", async () => {
    const { exitCode, stdout } = await runCli([
      "record",
      "--log",
      logPath,
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-01",
      "--sync-log",
      syncLogPath,
      "--stats",
      statsPath,
      "--quality-gate",
      gatePath,
      "--recorded-at",
      "2026-08-02T00:05:00.000Z",
    ]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as PilotDailyRecord;
    expect(record.status).toBe("observed");
    if (record.status !== "observed") return;
    expect(record.sync.runs_total).toBe(2);
    expect(record.sync.runs_failed).toBe(1);
    expect(record.sync.failed_pull_requests).toEqual([42]);
    expect(record.quality.gate_status).toBe("pass");
    expect(record.backlog.pending_jobs).toBe(3);

    const persisted = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!)).toEqual(record);
  });

  it("rejects a second record for the same date with exit code 1", async () => {
    const { exitCode, stderr } = await runCli([
      "record",
      "--log",
      logPath,
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-01",
      "--missing",
      "--reason",
      "duplicate attempt",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("PILOT_DUPLICATE_DATE");
  });

  it("appends a missing-day record with an explicit reason", async () => {
    const { exitCode, stdout } = await runCli([
      "record",
      "--log",
      logPath,
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-02",
      "--missing",
      "--reason",
      "operator offline",
      "--recorded-at",
      "2026-08-03T00:05:00.000Z",
    ]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(stdout) as PilotDailyRecord;
    expect(record.status).toBe("missing");
  });

  it("summarizes the log and enforces coverage with --require-complete", async () => {
    const complete = await runCli([
      "summarize",
      "--log",
      logPath,
      "--start",
      "2026-08-01",
      "--days",
      "2",
      "--require-complete",
    ]);
    expect(complete.exitCode).toBe(0);
    const summary = JSON.parse(complete.stdout) as PilotSummaryReport;
    expect(summary.coverage.complete).toBe(true);
    expect(summary.sync.run_success_rate).toBe(0.5);
    expect(summary.missing_days).toEqual([
      { date: "2026-08-02", reason: "operator offline" },
    ]);

    const incomplete = await runCli([
      "summarize",
      "--log",
      logPath,
      "--start",
      "2026-08-01",
      "--days",
      "14",
      "--require-complete",
    ]);
    expect(incomplete.exitCode).toBe(1);
    expect(incomplete.stderr).toContain("PILOT_COVERAGE_INCOMPLETE");
    const incompleteSummary = JSON.parse(
      incomplete.stdout,
    ) as PilotSummaryReport;
    expect(incompleteSummary.coverage.unrecorded_dates).toHaveLength(12);
  });

  it("serializes concurrent record runs on one log via the lock file", async () => {
    const contendedLogPath = join(workingDirectory, "contended-log.jsonl");
    const recordArgv = (reason: string): readonly string[] => [
      "record",
      "--log",
      contendedLogPath,
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-05",
      "--missing",
      "--reason",
      reason,
      "--recorded-at",
      "2026-08-06T00:05:00.000Z",
    ];

    const [first, second] = await Promise.all([
      runCli(recordArgv("writer a")),
      runCli(recordArgv("writer b")),
    ]);

    // The lock turns the race into a deterministic outcome: exactly one
    // append wins and the loser fails the duplicate-date check.
    const exitCodes = [first.exitCode, second.exitCode].sort();
    expect(exitCodes).toEqual([0, 1]);
    const loser = first.exitCode === 0 ? second : first;
    expect(loser.stderr).toContain("PILOT_DUPLICATE_DATE");
    const persisted = (await readFile(contendedLogPath, "utf8"))
      .trim()
      .split("\n");
    expect(persisted).toHaveLength(1);
  });

  it("reports an unreadable input with exit code 1", async () => {
    const { exitCode } = await runCli([
      "record",
      "--log",
      join(workingDirectory, "other-log.jsonl"),
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-01",
      "--sync-log",
      join(workingDirectory, "does-not-exist.jsonl"),
      "--stats",
      statsPath,
    ]);

    expect(exitCode).toBe(1);
  });

  it("rejects usage errors with exit code 2", async () => {
    const unknownCommand = await runCli(["frobnicate"]);
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("unknown command frobnicate");
    expect(unknownCommand.stderr).toContain("Usage:");

    const missingReason = await runCli([
      "record",
      "--log",
      logPath,
      "--pilot",
      PILOT_ID,
      "--date",
      "2026-08-03",
      "--missing",
    ]);
    expect(missingReason.exitCode).toBe(2);
    expect(missingReason.stderr).toContain("--reason is required");

    const badDays = await runCli([
      "summarize",
      "--log",
      logPath,
      "--start",
      "2026-08-01",
      "--days",
      "zero",
    ]);
    expect(badDays.exitCode).toBe(2);
    expect(badDays.stderr).toContain("--days must be a positive integer");
  });
});

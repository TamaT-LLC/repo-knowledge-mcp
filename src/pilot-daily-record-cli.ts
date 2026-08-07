import { appendFile, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  DEFAULT_PILOT_DURATION_DAYS,
  PilotRecordError,
  buildMissingDailyRecord,
  buildObservedDailyRecord,
  parsePilotLog,
  type PilotDailyRecord,
} from "./pilot-daily-record.js";
import { summarizePilotLog } from "./pilot-summary.js";
import { withPosixFileLock } from "./posix-file-lock.js";

const USAGE = [
  "Usage:",
  "  pilot-daily-record-cli record --log <pilot-log.jsonl> --pilot <id> --date <YYYY-MM-DD>",
  "                               --sync-log <sync-YYYY-MM-DD.jsonl> --stats <stats.json>",
  "                               [--quality-gate <report.json>] [--notes <text>]",
  "                               [--recorded-at <iso>]",
  "  pilot-daily-record-cli record --log <pilot-log.jsonl> --pilot <id> --date <YYYY-MM-DD>",
  "                               --missing --reason <text> [--notes <text>] [--recorded-at <iso>]",
  "  pilot-daily-record-cli summarize --log <pilot-log.jsonl> --start <YYYY-MM-DD>",
  "                               [--days <n>] [--require-complete]",
  "",
  "record appends one validated daily record for the M2 cron pilot to the",
  "append-only JSONL log. Inputs are the day's sync cron log, the stats CLI",
  "output, and (optionally) the quality gate report; a day without machine",
  "observation must be recorded with --missing and an explicit --reason.",
  "summarize validates the whole log and writes the aggregated pilot summary",
  "to stdout. Neither command touches the network.",
  "",
  "Exit codes:",
  "  0  record appended / summary produced (and coverage complete when",
  "     --require-complete is set)",
  "  1  validation or aggregation failure (duplicate date, invalid input,",
  "     incomplete coverage with --require-complete)",
  "  2  usage error",
].join("\n");

const USAGE_EXIT_CODE = 2;
const FAILURE_EXIT_CODE = 1;
/** Same bound the sync CLI uses for its repository lock. */
const RECORD_LOCK_TIMEOUT_MS = 5000;
/**
 * Bound on symlink hops while canonicalizing a not-yet-existing log path.
 * Mirrors the ELOOP-style limits kernels apply, and turns a symlink cycle
 * into a fail-closed error instead of an infinite loop.
 */
const MAX_SYMLINK_RESOLUTION_DEPTH = 40;

interface RecordArguments {
  readonly command: "record";
  readonly date: string;
  readonly logPath: string;
  readonly missing: boolean;
  readonly notes?: string;
  readonly pilotId: string;
  readonly qualityGatePath?: string;
  readonly reason?: string;
  readonly recordedAt?: string;
  readonly statsPath?: string;
  readonly syncLogPath?: string;
}

interface SummarizeArguments {
  readonly command: "summarize";
  readonly days: number;
  readonly logPath: string;
  readonly requireComplete: boolean;
  readonly startDate: string;
}

type ParsedArguments = RecordArguments | SummarizeArguments;

class UsageError extends Error {}

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "record") {
    await runRecord(parsed);
  } else {
    await runSummarize(parsed);
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = USAGE_EXIT_CODE;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

async function runRecord(parsed: RecordArguments): Promise<void> {
  const recordedAt = parsed.recordedAt ?? new Date().toISOString();
  const record = parsed.missing
    ? buildMissingDailyRecord({
        date: parsed.date,
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        pilotId: parsed.pilotId,
        reason: parsed.reason!,
        recordedAt,
      })
    : buildObservedDailyRecord({
        date: parsed.date,
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
        pilotId: parsed.pilotId,
        ...(parsed.qualityGatePath === undefined
          ? {}
          : { qualityGateReport: await readJson(parsed.qualityGatePath) }),
        recordedAt,
        stats: await readJson(parsed.statsPath!),
        syncSummaries: await readSyncLog(parsed.syncLogPath!),
      });
  const logPath = await canonicalLogPath(parsed.logPath);
  // Read-check-append is one critical section: without the lock, two
  // concurrent record runs could both pass the duplicate/pilot check and
  // append conflicting records that later break every summarize.
  await withPosixFileLock(
    `${logPath}.lock`,
    RECORD_LOCK_TIMEOUT_MS,
    async () => {
      const existing = await readPilotLog(logPath);
      assertAppendable(existing, record);
      await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
    },
  );
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Canonicalizes the log path (resolving symlinks) before deriving the lock
 * path, so two runs addressing the same log through different spellings —
 * a symlink versus its target, a dangling symlink to a log that does not
 * exist yet, a symlinked parent directory — converge on one canonical path
 * and therefore contend on one lock instead of silently bypassing each
 * other while appendFile writes through to the same target.
 */
async function canonicalLogPath(path: string): Promise<string> {
  return canonicalizeMaybeMissingPath(resolve(path), 0);
}

async function canonicalizeMaybeMissingPath(
  resolved: string,
  depth: number,
): Promise<string> {
  try {
    return await realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (depth >= MAX_SYMLINK_RESOLUTION_DEPTH) {
    throw new Error(
      `PILOT_LOG_PATH_UNRESOLVABLE: too many levels of symbolic links while canonicalizing ${resolved}`,
    );
  }
  // The final component does not exist (or is a dangling symlink): the
  // parent must exist, so canonicalize it, then resolve the component.
  const candidate = join(await realpath(dirname(resolved)), basename(resolved));
  let linkTarget: string;
  try {
    linkTarget = await readlink(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: a plain missing file — the canonical parent + name is final.
    // EINVAL: the component exists and is not a symlink (raced into
    // existence after the realpath above); the joined path is canonical.
    if (code === "ENOENT" || code === "EINVAL") return candidate;
    throw error;
  }
  // A relative symlink target is resolved against the symlink's directory.
  return canonicalizeMaybeMissingPath(
    resolve(dirname(candidate), linkTarget),
    depth + 1,
  );
}

async function runSummarize(parsed: SummarizeArguments): Promise<void> {
  const records = parsePilotLog(
    await readFile(resolve(parsed.logPath), "utf8"),
  );
  const summary = summarizePilotLog({
    durationDays: parsed.days,
    records,
    startDate: parsed.startDate,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (parsed.requireComplete && !summary.coverage.complete) {
    process.stderr.write(
      `PILOT_COVERAGE_INCOMPLETE: ${String(summary.coverage.unrecorded_dates.length)} expected day(s) have no record\n`,
    );
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

function assertAppendable(
  existing: readonly PilotDailyRecord[],
  record: PilotDailyRecord,
): void {
  const firstPilotId = existing[0]?.pilot_id;
  if (firstPilotId !== undefined && firstPilotId !== record.pilot_id) {
    throw new PilotRecordError(
      "PILOT_ID_MISMATCH",
      `the log belongs to pilot ${firstPilotId} but the record targets ${record.pilot_id}`,
    );
  }
  if (existing.some((entry) => entry.date === record.date)) {
    throw new PilotRecordError(
      "PILOT_DUPLICATE_DATE",
      `the log already has a record for ${record.date}; one record per day`,
    );
  }
}

async function readPilotLog(
  path: string,
): Promise<readonly PilotDailyRecord[]> {
  let text: string;
  try {
    text = await readFile(resolve(path), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parsePilotLog(text);
}

async function readSyncLog(path: string): Promise<readonly unknown[]> {
  const text = await readFile(resolve(path), "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new PilotRecordError(
          "PILOT_SYNC_LOG_INVALID",
          `sync log line ${String(index + 1)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (command === "record") return parseRecordArguments(argv.slice(1));
  if (command === "summarize") return parseSummarizeArguments(argv.slice(1));
  throw new UsageError(
    command === undefined
      ? "a command (record or summarize) is required"
      : `unknown command ${command}`,
  );
}

function parseRecordArguments(argv: readonly string[]): RecordArguments {
  let date: string | undefined;
  let logPath: string | undefined;
  let missing = false;
  let notes: string | undefined;
  let pilotId: string | undefined;
  let qualityGatePath: string | undefined;
  let reason: string | undefined;
  let recordedAt: string | undefined;
  let statsPath: string | undefined;
  let syncLogPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--date":
        date = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--log":
        logPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--missing":
        missing = true;
        break;
      case "--notes":
        notes = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--pilot":
        pilotId = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--quality-gate":
        qualityGatePath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--reason":
        reason = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--recorded-at":
        recordedAt = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--stats":
        statsPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--sync-log":
        syncLogPath = requireValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new UsageError(`unknown argument ${argument}`);
    }
  }
  if (logPath === undefined) throw new UsageError("--log is required");
  if (pilotId === undefined) throw new UsageError("--pilot is required");
  if (date === undefined) throw new UsageError("--date is required");
  if (missing) {
    if (reason === undefined) {
      throw new UsageError("--reason is required with --missing");
    }
    if (statsPath !== undefined || syncLogPath !== undefined) {
      throw new UsageError(
        "--missing cannot be combined with --sync-log or --stats",
      );
    }
  } else {
    if (syncLogPath === undefined) {
      throw new UsageError("--sync-log is required (or use --missing)");
    }
    if (statsPath === undefined) {
      throw new UsageError("--stats is required (or use --missing)");
    }
  }
  return {
    command: "record",
    date,
    logPath,
    missing,
    ...(notes === undefined ? {} : { notes }),
    pilotId,
    ...(qualityGatePath === undefined ? {} : { qualityGatePath }),
    ...(reason === undefined ? {} : { reason }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(statsPath === undefined ? {} : { statsPath }),
    ...(syncLogPath === undefined ? {} : { syncLogPath }),
  };
}

function parseSummarizeArguments(argv: readonly string[]): SummarizeArguments {
  let days = DEFAULT_PILOT_DURATION_DAYS;
  let logPath: string | undefined;
  let requireComplete = false;
  let startDate: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case "--days": {
        const value = requireValue(argv, index, argument);
        days = Number.parseInt(value, 10);
        if (!Number.isInteger(days) || days < 1 || String(days) !== value) {
          throw new UsageError(
            `--days must be a positive integer, got ${value}`,
          );
        }
        index += 1;
        break;
      }
      case "--log":
        logPath = requireValue(argv, index, argument);
        index += 1;
        break;
      case "--require-complete":
        requireComplete = true;
        break;
      case "--start":
        startDate = requireValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new UsageError(`unknown argument ${argument}`);
    }
  }
  if (logPath === undefined) throw new UsageError("--log is required");
  if (startDate === undefined) throw new UsageError("--start is required");
  return { command: "summarize", days, logPath, requireComplete, startDate };
}

function requireValue(
  argv: readonly string[],
  index: number,
  argument: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${argument} requires a value`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

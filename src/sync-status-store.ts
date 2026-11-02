import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson } from "./canonical.js";
import { IsoDateTimeSchema, RepositoryIdSchema } from "./domain-schemas.js";
import { fsyncDirectory, writeDurable } from "./durable-fs.js";
import { SYNC_CHECKPOINT_DIRECTORY } from "./sync-checkpoint-store.js";

export const SYNC_STATUS_SCHEMA_VERSION = 1;
export const SYNC_STATUS_FILE_NAME = "status.json";

/**
 * Outcome of one completed sync run:
 * - `succeeded`: the run finished and no pull request failed. `has_more` may
 *   still be true (bounded run, deferred PRs); the backlog converges over the
 *   following scheduled runs, so the run itself counts as a success.
 * - `partial_failure`: the run finished but stopped at a failed pull request.
 * - `failed`: the run aborted with an error after taking the sync lock.
 */
export const SyncRunOutcomeSchema = z.enum([
  "succeeded",
  "partial_failure",
  "failed",
]);

export type SyncRunOutcome = z.infer<typeof SyncRunOutcomeSchema>;

/**
 * Durable per-repository record of the latest sync run, kept next to the
 * checkpoint. The checkpoint only moves when a pull request is ingested, so
 * it cannot answer "did the scheduled sync run, and did it succeed?" on a
 * quiet repository; this record can.
 */
export const SyncStatusSchema = z
  .object({
    consecutive_failures: z.number().int().nonnegative(),
    last_attempt_finished_at: IsoDateTimeSchema,
    last_attempt_started_at: IsoDateTimeSchema,
    last_error_code: z.string().min(1).nullable(),
    last_has_more: z.boolean().nullable(),
    last_outcome: SyncRunOutcomeSchema,
    last_success_at: IsoDateTimeSchema.nullable(),
    repo_id: RepositoryIdSchema,
    schema_version: z.literal(SYNC_STATUS_SCHEMA_VERSION),
  })
  .strict();

export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export type SyncStatusErrorCode =
  | "SYNC_STATUS_INVALID"
  | "SYNC_STATUS_VERSION_UNSUPPORTED";

export class SyncStatusError extends Error {
  constructor(
    readonly code: SyncStatusErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SyncStatusError";
  }
}

export interface SyncRunRecord {
  readonly error_code: string | null;
  readonly finished_at: string;
  readonly has_more: boolean | null;
  readonly outcome: SyncRunOutcome;
  readonly repo_id: string;
  readonly started_at: string;
}

/**
 * Persists `sync/status.json` via atomic replace. Writers hold the repository
 * sync lock, so read-modify-write of the record never races another run.
 */
export class SyncStatusStore {
  readonly statusPath: string;

  private readonly directoryPath: string;

  constructor(repositoryRoot: string) {
    this.directoryPath = join(
      resolve(repositoryRoot),
      SYNC_CHECKPOINT_DIRECTORY,
    );
    this.statusPath = join(this.directoryPath, SYNC_STATUS_FILE_NAME);
  }

  async read(): Promise<SyncStatus | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.statusPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch (error) {
      throw new SyncStatusError(
        "SYNC_STATUS_INVALID",
        `${this.statusPath} is not valid UTF-8 JSON`,
        { cause: error },
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "schema_version" in value &&
      value.schema_version !== SYNC_STATUS_SCHEMA_VERSION
    ) {
      throw new SyncStatusError(
        "SYNC_STATUS_VERSION_UNSUPPORTED",
        `sync status schema_version must be ${String(SYNC_STATUS_SCHEMA_VERSION)}`,
      );
    }
    const parsed = SyncStatusSchema.safeParse(value);
    if (!parsed.success) {
      throw new SyncStatusError("SYNC_STATUS_INVALID", parsed.error.message, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  /**
   * Folds one finished run into the record. A previous record that cannot be
   * read (corrupt, foreign repository) is replaced rather than blocking the
   * run's own outcome from being recorded.
   */
  async recordRun(run: SyncRunRecord): Promise<SyncStatus> {
    let previous: SyncStatus | null;
    try {
      previous = await this.read();
    } catch (error) {
      if (!(error instanceof SyncStatusError)) throw error;
      previous = null;
    }
    if (previous !== null && previous.repo_id !== run.repo_id) {
      previous = null;
    }
    const succeeded = run.outcome === "succeeded";
    return this.write({
      consecutive_failures: succeeded
        ? 0
        : (previous?.consecutive_failures ?? 0) + 1,
      last_attempt_finished_at: run.finished_at,
      last_attempt_started_at: run.started_at,
      last_error_code: run.error_code,
      last_has_more: run.has_more,
      last_outcome: run.outcome,
      last_success_at: succeeded
        ? run.finished_at
        : (previous?.last_success_at ?? null),
      repo_id: run.repo_id,
      schema_version: SYNC_STATUS_SCHEMA_VERSION,
    });
  }

  private async write(status: SyncStatus): Promise<SyncStatus> {
    const parsed = SyncStatusSchema.parse(status);
    await mkdir(this.directoryPath, { mode: 0o700, recursive: true });
    const bytes = Buffer.from(`${canonicalizeJson(parsed)}\n`, "utf8");
    const temporaryPath = `${this.statusPath}.tmp`;
    await unlinkIfPresent(temporaryPath);
    await writeDurable(temporaryPath, bytes, "wx");
    await rename(temporaryPath, this.statusPath);
    await fsyncDirectory(this.directoryPath);
    return parsed;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

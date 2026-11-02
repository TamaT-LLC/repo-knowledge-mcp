import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { RepositoryNameSchema } from "./domain-schemas.js";
import type {
  IngestPullRequestResult,
  IngestRepositoryResolver,
} from "./github-ingest-service.js";
import type {
  EnumerateUpdatedPullRequestsRequest,
  EnumerateUpdatedPullRequestsResult,
  UpdatedPullRequestRef,
} from "./github-pull-request-enumerator.js";
import { FileLockTimeoutError, withPosixFileLock } from "./posix-file-lock.js";
import type { RepositoryResolution } from "./repository-resolver.js";
import {
  SYNC_CHECKPOINT_SCHEMA_VERSION,
  SyncCheckpointStore,
  type SyncCheckpoint,
} from "./sync-checkpoint-store.js";
import {
  compareSyncOrder,
  nextSyncCursor,
  parseIsoTimestampMs,
  resolveSyncBoundary,
  type SyncCursor,
  type SyncOrderKey,
} from "./sync-cursor.js";
import { SyncStatusStore } from "./sync-status-store.js";

export const SYNC_LOCK_FILE_NAME = ".sync.lock";
export const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 5_000;
export const MAX_SYNC_PULL_REQUESTS_PER_RUN = 10_000;

export interface SyncPullRequestEnumerator {
  enumerateUpdatedPullRequests(
    request: EnumerateUpdatedPullRequestsRequest,
  ): Promise<EnumerateUpdatedPullRequestsResult>;
}

export interface SyncPullRequestIngester {
  /** The repository name the ingester is bound to (diagnostics only). */
  readonly repo: string;

  ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult>;

  /**
   * Resolves the ingester's own binding — through the ingester's own
   * resolver — to a stable repo_id, without performing any mutation. Sync
   * compares this against its resolved target before the first ingest, so an
   * alias and the canonical name of the same repository both pass while a
   * divergent resolver behind an identical name still fails closed.
   */
  resolveBoundRepoId(): Promise<string>;
}

export interface SyncRepoRequest {
  /**
   * Upper bound on PRs processed by this run. The oldest PRs are processed
   * first and the rest stay after the checkpoint for the next run, so large
   * backlogs converge over repeated bounded runs. Unbounded when omitted.
   */
  readonly maxPullRequests?: number;
  readonly since?: string;
}

export interface SyncPullRequestFailure {
  readonly message: string;
  readonly pr_number: number;
}

export interface SyncRepoSummary {
  /** PRs updated too recently for this run; the next run picks them up. */
  readonly deferred: number;
  readonly discovered: number;
  readonly failed: number;
  readonly failures: readonly SyncPullRequestFailure[];
  /** True when known work remains after next_cursor for a later run. */
  readonly has_more: boolean;
  readonly ingested: number;
  readonly jobs_created: number;
  readonly next_cursor: SyncCursor | null;
  readonly unchanged: number;
}

export interface SyncRepoServiceOptions {
  readonly checkpointStoreFactory?: (
    repositoryRoot: string,
  ) => SyncCheckpointStore;
  readonly enumerator: SyncPullRequestEnumerator;
  readonly ingester: SyncPullRequestIngester;
  readonly now?: () => Date;
  readonly repo: string;
  readonly repositoryResolver: IngestRepositoryResolver;
  readonly syncLockTimeoutMs?: number;
  readonly syncStatusStoreFactory?: (repositoryRoot: string) => SyncStatusStore;
}

export type SyncRepoErrorCode =
  | "SYNC_ALREADY_RUNNING"
  | "SYNC_CHECKPOINT_REPOSITORY_MISMATCH"
  | "SYNC_MAX_PULL_REQUESTS_INVALID"
  | "SYNC_REPOSITORY_MISMATCH"
  | "SYNC_SINCE_BEYOND_CHECKPOINT";

export class SyncRepoError extends Error {
  constructor(
    readonly code: SyncRepoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SyncRepoError";
  }
}

/**
 * Incremental sync orchestration: enumerates updated PRs after the durable
 * checkpoint and replays them through the existing ingest pipeline in
 * deterministic (updatedAt, PR number) ascending order.
 *
 * Concurrency and crash-safety contract:
 * - A whole run (enumeration network I/O included) holds the repository
 *   sync lock, so syncs of the same repository never run concurrently, from
 *   the CLI, a scheduler, or MCP `sync_repo`. A run that cannot take the lock
 *   within `syncLockTimeoutMs` fails fast with `SYNC_ALREADY_RUNNING` without
 *   touching any state; a lock left by a crashed process is reclaimed once
 *   its owner PID is gone. The canonical writer lock is never held here, and
 *   therefore never held across network I/O.
 * - Every run that took the lock records its outcome in `sync/status.json`
 *   (see `SyncStatusStore`), so the last successful sync time is observable
 *   even when no pull request changed.
 * - The checkpoint advances atomically to each successfully ingested PR, so
 *   a crash after any ingest resumes at (not past) the next unprocessed PR.
 * - A run may stop early at `maxPullRequests`; the unprocessed tail stays
 *   strictly after the checkpoint (ties on updatedAt are ordered by PR
 *   number), so repeated bounded runs converge without gaps or duplicates.
 * - Advancement is deterministic on failure: processing stops at the first
 *   failed PR and the checkpoint stays at the last contiguous success, so no
 *   PR behind a failure is ever skipped. Re-ingesting already-synced PRs on
 *   retry is an idempotent no-op in the ingest pipeline.
 * - `--since` may only replay history strictly older than the stored
 *   checkpoint boundary; a narrower window is rejected fail-closed because
 *   advancing the checkpoint past never-synced PRs would exclude them from
 *   every future incremental run.
 */
export class SyncRepoService {
  private readonly checkpointStoreFactory: (
    repositoryRoot: string,
  ) => SyncCheckpointStore;
  private readonly enumerator: SyncPullRequestEnumerator;
  private readonly ingester: SyncPullRequestIngester;
  private readonly now: () => Date;
  private readonly repo: string;
  private readonly repositoryResolver: IngestRepositoryResolver;
  private readonly syncLockTimeoutMs: number;
  private readonly syncStatusStoreFactory: (
    repositoryRoot: string,
  ) => SyncStatusStore;

  constructor(options: SyncRepoServiceOptions) {
    this.checkpointStoreFactory =
      options.checkpointStoreFactory ??
      ((repositoryRoot) => new SyncCheckpointStore(repositoryRoot));
    this.enumerator = options.enumerator;
    this.ingester = options.ingester;
    this.now = options.now ?? (() => new Date());
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repositoryResolver = options.repositoryResolver;
    this.syncLockTimeoutMs =
      options.syncLockTimeoutMs ?? DEFAULT_SYNC_LOCK_TIMEOUT_MS;
    this.syncStatusStoreFactory =
      options.syncStatusStoreFactory ??
      ((repositoryRoot) => new SyncStatusStore(repositoryRoot));
  }

  async sync(request: SyncRepoRequest = {}): Promise<SyncRepoSummary> {
    assertMaxPullRequests(request.maxPullRequests);
    const repository = await this.repositoryResolver.resolve({
      repo: this.repo,
    });
    await this.assertIngesterBinding(repository);
    await mkdir(repository.absolutePath, { mode: 0o700, recursive: true });
    const lockPath = join(repository.absolutePath, SYNC_LOCK_FILE_NAME);
    try {
      return await withPosixFileLock(lockPath, this.syncLockTimeoutMs, () =>
        this.syncRecorded(repository, request),
      );
    } catch (error) {
      // Only contention on this run's own sync lock is "already running"; a
      // lock timeout raised inside the run (e.g. the canonical writer lock)
      // stays a genuine failure.
      if (
        error instanceof FileLockTimeoutError &&
        error.lockPath === lockPath
      ) {
        throw new SyncRepoError(
          "SYNC_ALREADY_RUNNING",
          `another sync of ${repository.currentName} holds ${lockPath}; this run was skipped without changes`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Runs one serialized sync and records its outcome while still holding the
   * sync lock. A failure to record a failed run never masks the run's own
   * error.
   */
  private async syncRecorded(
    repository: RepositoryResolution,
    request: SyncRepoRequest,
  ): Promise<SyncRepoSummary> {
    const statusStore = this.syncStatusStoreFactory(repository.absolutePath);
    const startedAt = this.now().toISOString();
    let summary: SyncRepoSummary;
    try {
      summary = await this.syncSerialized(repository, request);
    } catch (error) {
      try {
        await statusStore.recordRun({
          error_code: syncErrorCode(error),
          finished_at: this.now().toISOString(),
          has_more: null,
          outcome: "failed",
          repo_id: repository.repoId,
          started_at: startedAt,
        });
      } catch {
        // The original sync error is the actionable diagnostic.
      }
      throw error;
    }
    await statusStore.recordRun({
      error_code: summary.failed === 0 ? null : "SYNC_PARTIAL_FAILURE",
      finished_at: this.now().toISOString(),
      has_more: summary.has_more,
      outcome: summary.failed === 0 ? "succeeded" : "partial_failure",
      repo_id: repository.repoId,
      started_at: startedAt,
    });
    return summary;
  }

  /**
   * Fails closed before any mutation when the injected ingester is bound to
   * a different repository. The comparison always uses stable repo_ids that
   * each side resolved through its own resolver: matching raw names are no
   * proof of the same repository, and differing names may be aliases of one,
   * so no name-based shortcut is taken.
   */
  private async assertIngesterBinding(
    repository: RepositoryResolution,
  ): Promise<void> {
    const ingesterRepoId = await this.ingester.resolveBoundRepoId();
    if (ingesterRepoId !== repository.repoId) {
      throw new SyncRepoError(
        "SYNC_REPOSITORY_MISMATCH",
        `ingester is bound to ${this.ingester.repo} (${ingesterRepoId}), not ${this.repo} (${repository.repoId})`,
      );
    }
  }

  private async syncSerialized(
    repository: RepositoryResolution,
    request: SyncRepoRequest,
  ): Promise<SyncRepoSummary> {
    const checkpointStore = this.checkpointStoreFactory(
      repository.absolutePath,
    );
    const checkpoint = await checkpointStore.read();
    if (
      checkpoint !== null &&
      checkpoint.cursor.repo_id !== repository.repoId
    ) {
      throw new SyncRepoError(
        "SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
        `stored checkpoint belongs to ${checkpoint.cursor.repo_id}, not ${repository.repoId}`,
      );
    }
    assertSinceWithinCheckpoint(request, checkpoint);
    // An explicit --since replays history at or before the stored checkpoint;
    // replaying already-synced PRs is safe because ingest is idempotent.
    const enumeration = await this.enumerator.enumerateUpdatedPullRequests({
      repo: repository.currentName,
      ...(request.since !== undefined
        ? { since: request.since }
        : checkpoint === null
          ? {}
          : { cursor: checkpoint.cursor }),
    });
    if (enumeration.repository.id !== repository.repoId) {
      throw new SyncRepoError(
        "SYNC_REPOSITORY_MISMATCH",
        `enumerated repository ${enumeration.repository.id} does not match resolved ${repository.repoId}`,
      );
    }

    let current = checkpoint;
    let ingested = 0;
    let jobsCreated = 0;
    let unchanged = 0;
    const failures: SyncPullRequestFailure[] = [];
    const batch = enumeration.pullRequests.slice(
      0,
      request.maxPullRequests ?? enumeration.pullRequests.length,
    );
    for (const pullRequest of batch) {
      let result: IngestPullRequestResult;
      try {
        result = await this.ingester.ingestPullRequest({
          pr_number: pullRequest.number,
        });
      } catch (error) {
        // Deterministic advancement rule: stop at the first failure so the
        // checkpoint can never move past an unprocessed PR.
        failures.push({
          message: errorMessage(error),
          pr_number: pullRequest.number,
        });
        break;
      }
      // Defense in depth behind the pre-sync binding check: an ingester with
      // a diverging resolver still stops the run before the checkpoint
      // advances.
      if (result.repo_id !== repository.repoId) {
        throw new SyncRepoError(
          "SYNC_REPOSITORY_MISMATCH",
          `pull request ${String(pullRequest.number)} was ingested into ${result.repo_id}, not ${repository.repoId}`,
        );
      }
      jobsCreated += result.jobs_created;
      if (isUnchangedIngest(result)) {
        unchanged += 1;
      } else {
        ingested += 1;
      }
      current = await this.advanceCheckpoint(
        checkpointStore,
        current,
        repository.repoId,
        pullRequest,
      );
    }

    return {
      deferred: enumeration.deferred,
      discovered: enumeration.pullRequests.length,
      failed: failures.length,
      failures,
      has_more:
        ingested + unchanged < enumeration.pullRequests.length ||
        enumeration.deferred > 0,
      ingested,
      jobs_created: jobsCreated,
      next_cursor: current?.cursor ?? null,
      unchanged,
    };
  }

  /**
   * Commits the successful boundary after each ingested PR. The checkpoint is
   * monotonic: a --since replay over already-synced PRs never regresses the
   * durable resume point.
   */
  private async advanceCheckpoint(
    checkpointStore: SyncCheckpointStore,
    current: SyncCheckpoint | null,
    repoId: string,
    pullRequest: UpdatedPullRequestRef,
  ): Promise<SyncCheckpoint> {
    const cursor = nextSyncCursor(repoId, pullRequest);
    if (
      current !== null &&
      compareSyncOrder(
        cursorOrderKey(current.cursor),
        cursorOrderKey(cursor),
      ) >= 0
    ) {
      return current;
    }
    return checkpointStore.write({
      cursor,
      schema_version: SYNC_CHECKPOINT_SCHEMA_VERSION,
      updated_at: this.now().toISOString(),
    });
  }
}

/**
 * `--since` may only replay history that is strictly older than the stored
 * checkpoint boundary. A boundary at or beyond the checkpoint timestamp
 * would enumerate past PRs that were never synced (or past same-timestamp
 * PRs above the cursor's PR number), and a later monotonic checkpoint
 * advance would then exclude them from every future incremental run — so
 * this fails closed instead. Without a stored checkpoint, `--since` is the
 * operator-declared initial boundary and is accepted as-is (§16).
 */
function assertSinceWithinCheckpoint(
  request: SyncRepoRequest,
  checkpoint: SyncCheckpoint | null,
): void {
  if (request.since === undefined || checkpoint === null) return;
  const boundary = resolveSyncBoundary({ since: request.since });
  if (boundary.kind !== "since") return;
  const checkpointMs = parseIsoTimestampMs(checkpoint.cursor.last_updated_at);
  if (boundary.sinceMs >= checkpointMs) {
    throw new SyncRepoError(
      "SYNC_SINCE_BEYOND_CHECKPOINT",
      `--since ${request.since} is not strictly older than the stored checkpoint boundary (${checkpoint.cursor.last_updated_at}, #${String(checkpoint.cursor.last_pr_number)}); PRs between them would be skipped permanently. Run without --since to resume from the checkpoint.`,
    );
  }
}

function assertMaxPullRequests(value: number | undefined): void {
  if (value === undefined) return;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SYNC_PULL_REQUESTS_PER_RUN
  ) {
    throw new SyncRepoError(
      "SYNC_MAX_PULL_REQUESTS_INVALID",
      `maxPullRequests must be between 1 and ${String(MAX_SYNC_PULL_REQUESTS_PER_RUN)}`,
    );
  }
}

function cursorOrderKey(cursor: SyncCursor): SyncOrderKey {
  return {
    number: cursor.last_pr_number,
    updatedAtMs: parseIsoTimestampMs(cursor.last_updated_at),
  };
}

function isUnchangedIngest(result: IngestPullRequestResult): boolean {
  return (
    result.new_threads === 0 &&
    result.changed_threads === 0 &&
    result.jobs_created === 0
  );
}

function syncErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
    ? error.code
    : "SYNC_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

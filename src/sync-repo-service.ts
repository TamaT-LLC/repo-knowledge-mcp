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
import { withPosixFileLock } from "./posix-file-lock.js";
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

export const SYNC_LOCK_FILE_NAME = ".sync.lock";
export const DEFAULT_SYNC_LOCK_TIMEOUT_MS = 5_000;

export interface SyncPullRequestEnumerator {
  enumerateUpdatedPullRequests(
    request: EnumerateUpdatedPullRequestsRequest,
  ): Promise<EnumerateUpdatedPullRequestsResult>;
}

export interface SyncPullRequestIngester {
  /**
   * The repository name the ingester is bound to. Before any mutation it is
   * resolved to its stable repo_id and compared with the sync target, so an
   * alias and the canonical name of the same repository both pass.
   */
  readonly repo: string;

  ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult>;
}

export interface SyncRepoRequest {
  readonly since?: string;
}

export interface SyncPullRequestFailure {
  readonly message: string;
  readonly pr_number: number;
}

export interface SyncRepoSummary {
  readonly discovered: number;
  readonly failed: number;
  readonly failures: readonly SyncPullRequestFailure[];
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
}

export type SyncRepoErrorCode =
  | "SYNC_CHECKPOINT_REPOSITORY_MISMATCH"
  | "SYNC_REPOSITORY_MISMATCH"
  | "SYNC_SINCE_BEYOND_CHECKPOINT";

export class SyncRepoError extends Error {
  constructor(
    readonly code: SyncRepoErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SyncRepoError";
  }
}

/**
 * Incremental sync orchestration: enumerates updated PRs after the durable
 * checkpoint and replays them through the existing ingest pipeline in
 * deterministic (updatedAt, PR number) ascending order.
 *
 * Concurrency and crash-safety contract:
 * - A whole run holds the repository sync lock, so competing syncs of the
 *   same repository serialize; the canonical writer lock is never held here,
 *   and therefore never held across network I/O.
 * - The checkpoint advances atomically to each successfully ingested PR, so
 *   a crash after any ingest resumes at (not past) the next unprocessed PR.
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
  }

  async sync(request: SyncRepoRequest = {}): Promise<SyncRepoSummary> {
    const repository = await this.repositoryResolver.resolve({
      repo: this.repo,
    });
    await this.assertIngesterBinding(repository);
    await mkdir(repository.absolutePath, { mode: 0o700, recursive: true });
    return withPosixFileLock(
      join(repository.absolutePath, SYNC_LOCK_FILE_NAME),
      this.syncLockTimeoutMs,
      async () => this.syncSerialized(repository, request),
    );
  }

  /**
   * Fails closed before any mutation when the injected ingester is bound to
   * a different repository. Bindings are compared by the resolver's stable
   * repo_id, never by raw name, so an alias and the canonical name of the
   * same repository are both accepted.
   */
  private async assertIngesterBinding(
    repository: RepositoryResolution,
  ): Promise<void> {
    if (this.ingester.repo === this.repo) return;
    const ingesterRepository = await this.repositoryResolver.resolve({
      repo: this.ingester.repo,
    });
    if (ingesterRepository.repoId !== repository.repoId) {
      throw new SyncRepoError(
        "SYNC_REPOSITORY_MISMATCH",
        `ingester is bound to ${this.ingester.repo} (${ingesterRepository.repoId}), not ${this.repo} (${repository.repoId})`,
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
    for (const pullRequest of enumeration.pullRequests) {
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
      discovered: enumeration.pullRequests.length,
      failed: failures.length,
      failures,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

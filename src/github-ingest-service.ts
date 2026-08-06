import { compareCodeUnits, sha256Jcs } from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  CanonicalTransactionStore,
  type CanonicalAppendRecordRequest,
} from "./canonical-transaction-store.js";
import {
  ObservationIdSchema,
  PullRequestSnapshotSchema,
  ThreadRemovedObservationSchema,
  type CommentObservation,
  type PullRequestObservation,
  type PullRequestSnapshot,
  type ThreadObservation,
  type ThreadRemovedObservation,
  type TrustConfig,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_CREATED,
  createDistillationJobEventRecord,
  jobUniqueKey,
  type DistillationJobEvent,
} from "./distill-job-state.js";
import { DISTILL_JOB_EVENT_PATH } from "./distill-job-coordinator.js";
import {
  type CompleteGitHubPullRequestSnapshot,
  type FetchGitHubPullRequestRequest,
  reviewSummaryThreadId,
} from "./github-pull-request-client.js";
import {
  normalizeGitHubPullRequestSnapshot,
  type NormalizedGitHubPullRequestSnapshot,
  type UnknownBotWarning,
} from "./github-snapshot-normalizer.js";
import { createDomainId } from "./ids.js";
import type {
  RepositoryResolution,
  RepositoryResolutionInput,
} from "./repository-resolver.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

export const RAW_PULL_REQUEST_PATH = "raw/pull_requests.jsonl";
export const RAW_THREAD_OBSERVATION_PATH = "raw/thread_observations.jsonl";
export const RAW_COMMENT_PATH = "raw/comments.jsonl";
export const RAW_PULL_REQUEST_SNAPSHOT_PATH =
  "raw/pull_request_snapshots.jsonl";
export const PULL_REQUEST_SNAPSHOT_RECORD_TYPE = "PullRequestSnapshot";
export const THREAD_REMOVED_RECORD_TYPE = "ThreadRemoved";

export interface IngestPullRequestRequest {
  readonly pr_number: number;
  readonly repo?: string;
  readonly workspace_path?: string;
}

export interface IngestPullRequestSummary {
  readonly changed_threads: number;
  readonly distilled: number;
  readonly jobs_created: number;
  readonly new_threads: number;
  readonly pending: number;
  readonly unchanged: number;
}

export interface IngestPullRequestResult extends IngestPullRequestSummary {
  readonly repo_id: string;
  readonly snapshot_id: string;
  readonly warnings: readonly UnknownBotWarning[];
}

export interface CompleteSnapshotFetcher {
  fetchCompleteSnapshot(
    request: FetchGitHubPullRequestRequest,
  ): Promise<CompleteGitHubPullRequestSnapshot>;
}

export interface IngestRepositoryResolver {
  resolve(input?: RepositoryResolutionInput): Promise<RepositoryResolution>;
}

export interface GitHubIngestServiceOptions {
  readonly nextEventId?: () => string;
  readonly nextJobId?: () => string;
  readonly nextObservationId?: () => string;
  readonly nextTransactionId?: () => string;
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly repositoryContext: unknown;
  readonly repositoryResolver: IngestRepositoryResolver;
  readonly snapshotClient: CompleteSnapshotFetcher;
  readonly storeFactory?: (repositoryRoot: string) => CanonicalTransactionStore;
  readonly trust: TrustConfig;
}

export type GitHubIngestErrorCode =
  "REPOSITORY_SNAPSHOT_MISMATCH" | "STALE_SNAPSHOT";

export class GitHubIngestError extends Error {
  constructor(
    readonly code: GitHubIngestErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GitHubIngestError";
  }
}

interface IngestPlan {
  readonly changedThreads: number;
  readonly jobEvents: readonly CanonicalJsonlRecord[];
  readonly newThreads: number;
  readonly previousSnapshot: PullRequestSnapshot | null;
  readonly removedThreads: readonly string[];
  readonly rawChanged: boolean;
  readonly unchanged: number;
}

/**
 * Fetches and normalizes a complete PR outside the writer lock, then commits
 * every raw observation, snapshot, removal, and new job in one transaction.
 */
export class GitHubIngestService {
  private readonly nextEventId: () => string;
  private readonly nextJobId: () => string;
  private readonly nextObservationId: () => string;
  private readonly nextTransactionId: () => string;
  private readonly options: GitHubIngestServiceOptions;
  private readonly storeFactory: (
    repositoryRoot: string,
  ) => CanonicalTransactionStore;

  constructor(options: GitHubIngestServiceOptions) {
    this.options = options;
    this.nextEventId = options.nextEventId ?? (() => createDomainId("event"));
    this.nextJobId = options.nextJobId ?? (() => createDomainId("job"));
    this.nextObservationId =
      options.nextObservationId ?? (() => createDomainId("observation"));
    this.nextTransactionId =
      options.nextTransactionId ?? (() => createDomainId("transaction"));
    this.storeFactory =
      options.storeFactory ??
      ((repositoryRoot) => new CanonicalTransactionStore(repositoryRoot));
  }

  async ingest(
    request: IngestPullRequestRequest,
  ): Promise<IngestPullRequestResult> {
    if (!Number.isSafeInteger(request.pr_number) || request.pr_number < 1) {
      throw new TypeError("pr_number must be a positive safe integer");
    }
    const repository = await this.options.repositoryResolver.resolve({
      ...(request.repo === undefined ? {} : { repo: request.repo }),
      ...(request.workspace_path === undefined
        ? {}
        : { workspacePath: request.workspace_path }),
    });
    const complete = await this.options.snapshotClient.fetchCompleteSnapshot({
      prNumber: request.pr_number,
      repo: repository.currentName,
    });
    assertResolvedSnapshot(repository, complete, request.pr_number);

    const transactionId = this.nextTransactionId();
    const observationIds = uniqueObservationIdAllocator(this.nextObservationId);
    const normalized = normalizeGitHubPullRequestSnapshot(
      {
        outputSchemaDigest: this.options.outputSchemaDigest,
        promptDigest: this.options.promptDigest,
        repositoryContext: this.options.repositoryContext,
        snapshot: complete,
        transactionId,
        trust: this.options.trust,
      },
      { nextObservationId: observationIds.next },
    );
    const store = this.storeFactory(repository.absolutePath);

    return store.runLockedMutation((snapshot) => {
      const plan = this.planIngest(snapshot, normalized, transactionId);
      const summary: IngestPullRequestSummary = {
        changed_threads: plan.changedThreads,
        distilled: 0,
        jobs_created: plan.jobEvents.length,
        new_threads: plan.newThreads,
        pending: plan.jobEvents.length,
        unchanged: plan.unchanged,
      };
      if (!plan.rawChanged && plan.jobEvents.length === 0) {
        return {
          transaction: null,
          value: {
            ...summary,
            repo_id: repository.repoId,
            snapshot_id:
              plan.previousSnapshot?.snapshot_id ??
              normalized.snapshot.snapshot_id,
            warnings: normalized.warnings,
          },
        };
      }

      const removedRecords = plan.removedThreads.map((threadId) =>
        threadRemovedRecord(
          normalized.snapshot,
          plan.previousSnapshot!,
          threadId,
          observationIds.next(),
          transactionId,
        ),
      );
      const appendRecords = ingestAppendRecords(
        normalized,
        removedRecords,
        plan.jobEvents,
        transactionId,
      );
      return {
        transaction: {
          appendRecords,
          createdAt: normalized.snapshot.observed_at,
          fileWrites: [],
          transactionId,
        },
        value: {
          ...summary,
          repo_id: repository.repoId,
          snapshot_id: normalized.snapshot.snapshot_id,
          warnings: normalized.warnings,
        },
      };
    });
  }

  private planIngest(
    snapshot: CanonicalProjectionSnapshot,
    normalized: NormalizedGitHubPullRequestSnapshot,
    transactionId: string,
  ): IngestPlan {
    const previousSnapshot = latestSnapshot(
      snapshot,
      normalized.snapshot.repo_id,
      normalized.snapshot.pr_number,
    );
    const rawChanged =
      previousSnapshot === null ||
      currentSemanticDigest(normalized) !==
        previousSemanticDigest(snapshot, previousSnapshot);
    const previousThreadIds = new Set(
      previousSnapshot === null
        ? []
        : completeSnapshotThreadIds(previousSnapshot),
    );
    const previousThreads = new Map(
      snapshot.domain.threads
        .filter((thread) => thread.repo_id === normalized.snapshot.repo_id)
        .map((thread) => [thread.thread_id, thread]),
    );
    let changedThreads = 0;
    let newThreads = 0;
    let unchanged = 0;
    for (const thread of normalized.threads) {
      const previous = previousThreads.get(thread.threadId);
      if (
        previousSnapshot === null ||
        !previousThreadIds.has(thread.threadId) ||
        previous === undefined
      ) {
        newThreads += 1;
      } else if (
        previous.content_fingerprint !== thread.contentFingerprint ||
        previous.state_fingerprint !== thread.stateFingerprint
      ) {
        changedThreads += 1;
      } else {
        unchanged += 1;
      }
    }

    const currentThreadIds = new Set(
      normalized.threads.map((thread) => thread.threadId),
    );
    const removedThreads = [...previousThreadIds]
      .filter((threadId) => !currentThreadIds.has(threadId))
      .sort(compareCodeUnits);
    const existingJobKeys = new Set(
      snapshot.domain.distillJobs.map((job) => jobUniqueKey(job)),
    );
    const jobEvents: CanonicalJsonlRecord[] = [];
    for (const thread of normalized.threads) {
      if (thread.disposition !== "distill") continue;
      const uniqueKey = jobUniqueKey({
        distillation_key: thread.distillationKey,
        repo_id: normalized.snapshot.repo_id,
        thread_id: thread.threadId,
      });
      if (existingJobKeys.has(uniqueKey)) continue;
      const event: DistillationJobEvent = {
        payload: {
          distillation_key: thread.distillationKey,
          job_id: this.nextJobId(),
          repo_id: normalized.snapshot.repo_id,
          thread_id: thread.threadId,
        },
        type: DISTILLATION_JOB_CREATED,
      };
      jobEvents.push(
        createDistillationJobEventRecord({
          eventId: this.nextEventId(),
          payload: event.payload,
          recordedAt: normalized.snapshot.observed_at,
          transactionId,
          type: event.type,
        }),
      );
      existingJobKeys.add(uniqueKey);
    }
    if (
      previousSnapshot !== null &&
      Date.parse(normalized.snapshot.observed_at) <
        Date.parse(previousSnapshot.observed_at) &&
      (rawChanged || jobEvents.length > 0)
    ) {
      throw new GitHubIngestError(
        "STALE_SNAPSHOT",
        `snapshot ${normalized.snapshot.snapshot_id} predates ${previousSnapshot.snapshot_id}`,
      );
    }

    return {
      changedThreads,
      jobEvents,
      newThreads,
      previousSnapshot,
      removedThreads,
      rawChanged,
      unchanged,
    };
  }
}

function ingestAppendRecords(
  normalized: NormalizedGitHubPullRequestSnapshot,
  removedRecords: readonly CanonicalJsonlRecord<ThreadRemovedObservation>[],
  jobEvents: readonly CanonicalJsonlRecord[],
  transactionId: string,
): CanonicalAppendRecordRequest[] {
  const snapshotRecord: CanonicalJsonlRecord<PullRequestSnapshot> = {
    payload: PullRequestSnapshotSchema.parse(normalized.snapshot),
    record_id: normalized.snapshot.snapshot_id,
    record_type: PULL_REQUEST_SNAPSHOT_RECORD_TYPE,
    recorded_at: normalized.snapshot.observed_at,
    schema_version: 1,
    transaction_id: transactionId,
  };
  return [
    ...normalized.records.pullRequests.map((record) => ({
      record,
      targetPath: RAW_PULL_REQUEST_PATH,
    })),
    { record: snapshotRecord, targetPath: RAW_PULL_REQUEST_SNAPSHOT_PATH },
    ...normalized.records.threadObservations.map((record) => ({
      record,
      targetPath: RAW_THREAD_OBSERVATION_PATH,
    })),
    ...removedRecords.map((record) => ({
      record,
      targetPath: RAW_THREAD_OBSERVATION_PATH,
    })),
    ...normalized.records.comments.map((record) => ({
      record,
      targetPath: RAW_COMMENT_PATH,
    })),
    ...jobEvents.map((record) => ({
      record,
      targetPath: DISTILL_JOB_EVENT_PATH,
    })),
  ];
}

function threadRemovedRecord(
  current: PullRequestSnapshot,
  previous: PullRequestSnapshot,
  threadId: string,
  observationId: string,
  transactionId: string,
): CanonicalJsonlRecord<ThreadRemovedObservation> {
  const payload = ThreadRemovedObservationSchema.parse({
    observation_id: observationId,
    observation_type: "thread_removed",
    observed_at: current.observed_at,
    pr_number: current.pr_number,
    previous_snapshot_id: previous.snapshot_id,
    repo_id: current.repo_id,
    snapshot_id: current.snapshot_id,
    thread_id: threadId,
  });
  return {
    payload,
    record_id: payload.observation_id,
    record_type: THREAD_REMOVED_RECORD_TYPE,
    recorded_at: payload.observed_at,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

function latestSnapshot(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  prNumber: number,
): PullRequestSnapshot | null {
  const latestPullRequest = snapshot.domain.pullRequests.find(
    (candidate) =>
      candidate.repo_id === repoId && candidate.pr_number === prNumber,
  );
  if (latestPullRequest !== undefined) {
    const linkedSnapshot = snapshot.domain.pullRequestSnapshots.find(
      (candidate) =>
        candidate.snapshot_id === latestPullRequest.snapshot_id &&
        candidate.repo_id === repoId &&
        candidate.pr_number === prNumber,
    );
    if (linkedSnapshot !== undefined) return linkedSnapshot;
  }
  return (
    snapshot.domain.pullRequestSnapshots
      .filter(
        (candidate) =>
          candidate.repo_id === repoId && candidate.pr_number === prNumber,
      )
      .sort((first, second) => {
        const timeOrder =
          Date.parse(second.observed_at) - Date.parse(first.observed_at);
        return timeOrder === 0
          ? compareCodeUnits(second.snapshot_id, first.snapshot_id)
          : timeOrder;
      })[0] ?? null
  );
}

function completeSnapshotThreadIds(snapshot: PullRequestSnapshot): string[] {
  return [
    ...snapshot.thread_ids,
    ...snapshot.review_summary_ids.map(reviewSummaryThreadId),
  ].sort(compareCodeUnits);
}

function currentSemanticDigest(
  normalized: NormalizedGitHubPullRequestSnapshot,
): string {
  return sha256Jcs({
    comments: [...normalized.records.comments]
      .sort((first, second) =>
        compareCodeUnits(first.payload.comment_id, second.payload.comment_id),
      )
      .map((record) => stableComment(record.payload)),
    pull_request: stablePullRequest(
      normalized.records.pullRequests[0]!.payload,
    ),
    snapshot: stableSnapshot(normalized.snapshot),
    threads: [...normalized.records.threadObservations]
      .sort((first, second) =>
        compareCodeUnits(first.payload.thread_id, second.payload.thread_id),
      )
      .map((record) => stableThread(record.payload)),
  });
}

function previousSemanticDigest(
  snapshot: CanonicalProjectionSnapshot,
  previousSnapshot: PullRequestSnapshot,
): string | null {
  const pullRequest = snapshot.domain.pullRequests.find(
    (candidate) =>
      candidate.repo_id === previousSnapshot.repo_id &&
      candidate.pr_number === previousSnapshot.pr_number,
  );
  if (pullRequest === undefined) return null;
  const threadsById = new Map(
    snapshot.domain.threads
      .filter((thread) => thread.repo_id === previousSnapshot.repo_id)
      .map((thread) => [thread.thread_id, thread]),
  );
  const commentsById = new Map(
    snapshot.domain.comments.map((comment) => [comment.comment_id, comment]),
  );
  const threads: ThreadObservation[] = [];
  const comments = new Map<string, CommentObservation>();
  for (const threadId of completeSnapshotThreadIds(previousSnapshot)) {
    const thread = threadsById.get(threadId);
    if (thread === undefined) return null;
    threads.push(thread);
    for (const commentId of thread.comment_ids) {
      const comment = commentsById.get(commentId);
      if (comment === undefined) return null;
      comments.set(commentId, comment);
    }
  }
  return sha256Jcs({
    comments: [...comments.values()]
      .sort((first, second) =>
        compareCodeUnits(first.comment_id, second.comment_id),
      )
      .map(stableComment),
    pull_request: stablePullRequest(pullRequest),
    snapshot: stableSnapshot(previousSnapshot),
    threads: threads
      .sort((first, second) =>
        compareCodeUnits(first.thread_id, second.thread_id),
      )
      .map(stableThread),
  });
}

function stablePullRequest(value: PullRequestObservation): unknown {
  return {
    base_ref_oid: value.base_ref_oid,
    head_ref_oid: value.head_ref_oid,
    merged_at: value.merged_at,
    name_with_owner: value.name_with_owner,
    observation_type: value.observation_type,
    pr_number: value.pr_number,
    pull_request_id: value.pull_request_id,
    repo_id: value.repo_id,
    title: value.title,
  };
}

function stableThread(value: ThreadObservation): unknown {
  return {
    comment_ids: value.comment_ids,
    content_fingerprint: value.content_fingerprint,
    is_outdated: value.is_outdated,
    is_resolved: value.is_resolved,
    observation_type: value.observation_type,
    ...(value.path === undefined ? {} : { path: value.path }),
    pr_number: value.pr_number,
    repo_id: value.repo_id,
    state_fingerprint: value.state_fingerprint,
    thread_id: value.thread_id,
  };
}

function stableComment(value: CommentObservation): unknown {
  return {
    actor: value.actor,
    body: value.body,
    comment_id: value.comment_id,
    created_at: value.created_at,
    ...(value.diff_hunk === undefined ? {} : { diff_hunk: value.diff_hunk }),
    observation_type: value.observation_type,
    thread_id: value.thread_id,
    updated_at: value.updated_at,
    url: value.url,
  };
}

function stableSnapshot(value: PullRequestSnapshot): unknown {
  return {
    complete: value.complete,
    pr_number: value.pr_number,
    repo_id: value.repo_id,
    review_summary_ids: value.review_summary_ids,
    thread_ids: value.thread_ids,
  };
}

function uniqueObservationIdAllocator(generate: () => string): {
  readonly next: () => string;
} {
  const seen = new Set<string>();
  return {
    next: () => {
      const id = ObservationIdSchema.parse(generate());
      if (seen.has(id)) {
        throw new TypeError(
          `observation ID generator returned duplicate ${id}`,
        );
      }
      seen.add(id);
      return id;
    },
  };
}

function assertResolvedSnapshot(
  repository: RepositoryResolution,
  snapshot: CompleteGitHubPullRequestSnapshot,
  requestedPrNumber: number,
): void {
  if (
    snapshot.repository.id !== repository.repoId ||
    snapshot.repository.nameWithOwner !== repository.currentName ||
    snapshot.pullRequest.number !== requestedPrNumber ||
    snapshot.snapshot.pr_number !== requestedPrNumber
  ) {
    throw new GitHubIngestError(
      "REPOSITORY_SNAPSHOT_MISMATCH",
      "resolved repository identity does not match the complete snapshot",
    );
  }
}

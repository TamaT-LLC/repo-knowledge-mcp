import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  DistillJobCoordinator,
  GitHubIngestService,
  RAW_COMMENT_PATH,
  RAW_PULL_REQUEST_PATH,
  RAW_PULL_REQUEST_SNAPSHOT_PATH,
  RAW_THREAD_OBSERVATION_PATH,
  THREAD_REMOVED_RECORD_TYPE,
  computeOutputSchemaDigest,
  computePromptDigest,
  type CompleteGitHubPullRequestSnapshot,
  type CompleteSnapshotFetcher,
  type GitHubReviewActor,
  type GitHubReviewComment,
  type GitHubReviewThread,
  type IngestRepositoryResolver,
  type RepositoryResolution,
  type TrustConfig,
} from "../src/index.js";

const REPO_ID = "R_repo_node";
const REPOSITORY = "owner/repository";
const SNAPSHOT_IDS = [
  "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "snap_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "snap_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "snap_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "snap_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
] as const;
const TIMES = [
  "2026-08-06T00:00:00.000Z",
  "2026-08-06T00:01:00.000Z",
  "2026-08-06T00:02:00.000Z",
  "2026-08-06T00:03:00.000Z",
  "2026-08-06T00:04:00.000Z",
] as const;
const TRUST: TrustConfig = {
  aiReviewers: {},
  autoActivateTrustedHuman: false,
  externalContributors: "raw-only",
  sourceAliases: {},
  trustedActorIds: ["U_trusted"],
  trustedLogins: [],
};

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("GitHubIngestService", () => {
  it("commits raw observations, the complete snapshot, and jobs atomically", async () => {
    const repository = await createRepository();
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
    ]);
    const service = ingestService(repository, fetcher);

    const result = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(result).toMatchObject({
      changed_threads: 0,
      distilled: 0,
      jobs_created: 1,
      new_threads: 1,
      pending: 1,
      repo_id: REPO_ID,
      snapshot_id: SNAPSHOT_IDS[0],
      unchanged: 0,
      warnings: [],
    });
    expect(fetcher.requests).toEqual([{ prNumber: 7, repo: REPOSITORY }]);
    expect(snapshot.records.map((entry) => entry.targetPath)).toEqual([
      "events/distillation.jsonl",
      RAW_COMMENT_PATH,
      RAW_PULL_REQUEST_SNAPSHOT_PATH,
      RAW_PULL_REQUEST_PATH,
      RAW_THREAD_OBSERVATION_PATH,
    ]);
    expect(
      new Set(snapshot.records.map((entry) => entry.record.transaction_id))
        .size,
    ).toBe(1);
    expect(snapshot.domain).toMatchObject({
      comments: [expect.objectContaining({ comment_id: "comment-1" })],
      distillJobs: [expect.objectContaining({ state: "pending" })],
      evidence: [],
      pullRequestSnapshots: [
        expect.objectContaining({ snapshot_id: SNAPSHOT_IDS[0] }),
      ],
      pullRequests: [expect.objectContaining({ pr_number: 7 })],
      threads: [expect.objectContaining({ thread_id: "thread-1" })],
    });
  });

  it("turns an identical complete snapshot into an atomic no-op", async () => {
    const repository = await createRepository();
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
      completeSnapshot({
        observedAt: TIMES[1],
        snapshotId: SNAPSHOT_IDS[1],
      }),
    ]);
    const service = ingestService(repository, fetcher);
    await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const before = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    const repeated = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const after = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(repeated).toMatchObject({
      changed_threads: 0,
      jobs_created: 0,
      new_threads: 0,
      pending: 0,
      snapshot_id: SNAPSHOT_IDS[0],
      unchanged: 1,
    });
    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    expect(after.records).toHaveLength(5);
    expect(after.domain.pullRequestSnapshots).toHaveLength(1);
    expect(after.domain.distillJobs).toHaveLength(1);
    expect(after.domain.evidence).toHaveLength(0);
  });

  it("creates a new job when distillation context changes without raw changes", async () => {
    const repository = await createRepository();
    await ingestService(
      repository,
      new QueueSnapshotFetcher([
        completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
      ]),
    ).ingest({ pr_number: 7, repo: REPOSITORY });
    const changedContext = ingestService(
      repository,
      new QueueSnapshotFetcher([
        completeSnapshot({
          observedAt: TIMES[1],
          snapshotId: SNAPSHOT_IDS[1],
        }),
      ]),
      { prompt: "distill-v2\n" },
    );

    const result = await changedContext.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(result).toMatchObject({
      changed_threads: 0,
      jobs_created: 1,
      new_threads: 0,
      pending: 1,
      unchanged: 1,
    });
    expect(snapshot.domain.pullRequestSnapshots).toHaveLength(2);
    expect(snapshot.domain.distillJobs).toHaveLength(2);
    expect(snapshot.domain.distillJobs).toEqual([
      expect.objectContaining({
        skip_reason: "superseded_context",
        state: "skipped",
      }),
      expect.objectContaining({ state: "pending" }),
    ]);
  });

  it("retires a legacy stale job even when the current-key job already exists", async () => {
    const repository = await createRepository();
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
      completeSnapshot({
        observedAt: TIMES[1],
        snapshotId: SNAPSHOT_IDS[1],
      }),
    ]);
    const service = ingestService(repository, fetcher);
    await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const store = new CanonicalTransactionStore(repository);
    await new DistillJobCoordinator(store).createJob({
      distillation_key: `sha256:${"f".repeat(64)}`,
      repo_id: REPO_ID,
      thread_id: "thread-1",
    });

    const result = await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const snapshot = await store.readSnapshot();

    expect(result).toMatchObject({ jobs_created: 0, pending: 0 });
    expect(snapshot.domain.distillJobs).toHaveLength(2);
    expect(
      snapshot.domain.distillJobs.find(
        (job) => job.distillation_key === `sha256:${"f".repeat(64)}`,
      ),
    ).toMatchObject({
      skip_reason: "superseded_context",
      state: "skipped",
    });
    expect(
      snapshot.domain.distillJobs.filter((job) => job.state === "pending"),
    ).toHaveLength(1);
  });

  it("supersedes an active old-context lease and fences its delayed worker", async () => {
    const repository = await createRepository();
    await ingestService(
      repository,
      new QueueSnapshotFetcher([
        completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
      ]),
    ).ingest({ pr_number: 7, repo: REPOSITORY });
    const store = new CanonicalTransactionStore(repository);
    const coordinator = new DistillJobCoordinator(store);
    const lease = await coordinator.acquireLease({ repo_id: REPO_ID });
    expect(lease).not.toBeNull();

    await ingestService(
      repository,
      new QueueSnapshotFetcher([
        completeSnapshot({
          observedAt: TIMES[1],
          snapshotId: SNAPSHOT_IDS[1],
        }),
      ]),
      { prompt: "distill-v2\n" },
    ).ingest({ pr_number: 7, repo: REPOSITORY });

    await expect(coordinator.succeed(lease!)).rejects.toMatchObject({
      code: "STALE_LEASE",
    });
    const snapshot = await store.readSnapshot();
    expect(
      snapshot.domain.distillJobs.find((job) => job.job_id === lease!.job_id),
    ).toMatchObject({
      skip_reason: "superseded_context",
      state: "skipped",
    });
    expect(
      snapshot.domain.distillJobs.filter((job) => job.state === "pending"),
    ).toHaveLength(1);
  });

  it("rejects an older complete snapshot instead of regressing projection state", async () => {
    const repository = await createRepository();
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({
        observedAt: TIMES[1],
        snapshotId: SNAPSHOT_IDS[1],
      }),
      completeSnapshot({
        observedAt: TIMES[0],
        snapshotId: SNAPSHOT_IDS[0],
        threads: [
          reviewThread("thread-1", [
            reviewComment("comment-1", "Stale content"),
          ]),
        ],
      }),
    ]);
    const service = ingestService(repository, fetcher);
    await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const before = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    await expect(
      service.ingest({ pr_number: 7, repo: REPOSITORY }),
    ).rejects.toMatchObject({ code: "STALE_SNAPSHOT" });
    const after = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    expect(after.canonicalDigest).toBe(before.canonicalDigest);
  });

  it("creates jobs for content edits and replies but not state-only changes", async () => {
    const repository = await createRepository();
    const original = reviewThread("thread-1", [
      reviewComment("comment-1", "Use the repository helper"),
    ]);
    const edited = reviewThread("thread-1", [
      reviewComment("comment-1", "Use the canonical repository helper", {
        updatedAt: TIMES[1],
      }),
    ]);
    const replied = reviewThread("thread-1", [
      ...edited.comments,
      reviewComment("comment-2", "Also preserve the current etag", {
        createdAt: TIMES[2],
        updatedAt: TIMES[2],
      }),
    ]);
    const stateOnly = { ...replied, isResolved: true };
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({ snapshotId: SNAPSHOT_IDS[0], threads: [original] }),
      completeSnapshot({
        observedAt: TIMES[1],
        snapshotId: SNAPSHOT_IDS[1],
        threads: [edited],
      }),
      completeSnapshot({
        observedAt: TIMES[2],
        snapshotId: SNAPSHOT_IDS[2],
        threads: [replied],
      }),
      completeSnapshot({
        observedAt: TIMES[3],
        snapshotId: SNAPSHOT_IDS[3],
        threads: [stateOnly],
      }),
    ]);
    const service = ingestService(repository, fetcher);

    await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const editResult = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const replyResult = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const stateResult = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(editResult).toMatchObject({
      changed_threads: 1,
      jobs_created: 1,
      pending: 1,
    });
    expect(replyResult).toMatchObject({
      changed_threads: 1,
      jobs_created: 1,
      pending: 1,
    });
    expect(stateResult).toMatchObject({
      changed_threads: 1,
      jobs_created: 0,
      pending: 0,
    });
    expect(snapshot.domain.distillJobs).toHaveLength(3);
    expect(
      snapshot.domain.distillJobs.filter(
        (job) =>
          job.state === "skipped" && job.skip_reason === "superseded_context",
      ),
    ).toHaveLength(2);
    expect(
      snapshot.domain.distillJobs.filter((job) => job.state === "pending"),
    ).toHaveLength(1);
    expect(snapshot.domain.threads[0]).toMatchObject({
      is_resolved: true,
      thread_id: "thread-1",
    });
  });

  it("records removals only after another complete snapshot", async () => {
    const repository = await createRepository();
    const first = completeSnapshot({
      snapshotId: SNAPSHOT_IDS[0],
      threads: [
        reviewThread("thread-1", [reviewComment("comment-1", "Keep this")]),
        reviewThread("thread-2", [
          reviewComment("comment-2", "This will be deleted"),
        ]),
      ],
    });
    const afterRemoval = completeSnapshot({
      observedAt: TIMES[2],
      snapshotId: SNAPSHOT_IDS[2],
      threads: [
        reviewThread("thread-1", [reviewComment("comment-1", "Keep this")]),
      ],
    });
    const partialFailure = new Error("GRAPHQL_PARTIAL_RESPONSE");
    const fetcher = new QueueSnapshotFetcher([
      first,
      partialFailure,
      afterRemoval,
    ]);
    const service = ingestService(repository, fetcher);
    await service.ingest({ pr_number: 7, repo: REPOSITORY });
    const beforeFailure = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    await expect(
      service.ingest({ pr_number: 7, repo: REPOSITORY }),
    ).rejects.toBe(partialFailure);
    const afterFailure = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    expect(afterFailure.canonicalDigest).toBe(beforeFailure.canonicalDigest);
    expect(afterFailure.domain.threadRemovals).toEqual([]);

    const removalResult = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const afterComplete = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    expect(removalResult).toMatchObject({
      jobs_created: 0,
      new_threads: 0,
      unchanged: 1,
    });
    expect(afterComplete.domain.threadRemovals).toEqual([
      expect.objectContaining({
        previous_snapshot_id: SNAPSHOT_IDS[0],
        snapshot_id: SNAPSHOT_IDS[2],
        thread_id: "thread-2",
      }),
    ]);
    expect(
      afterComplete.domain.distillJobs.find(
        (job) => job.thread_id === "thread-2",
      ),
    ).toMatchObject({
      skip_reason: "source_removed",
      state: "skipped",
    });
    expect(
      afterComplete.records.filter(
        (entry) => entry.record.record_type === THREAD_REMOVED_RECORD_TYPE,
      ),
    ).toHaveLength(1);
  });

  it("stores unknown bot observations as raw-only without creating jobs", async () => {
    const repository = await createRepository();
    const bot = actor("Bot", "B_unknown", "unconfigured-bot");
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({
        snapshotId: SNAPSHOT_IDS[0],
        threads: [
          reviewThread("thread-bot", [
            reviewComment("comment-bot", "Potential issue", { author: bot }),
          ]),
        ],
      }),
    ]);
    const service = ingestService(repository, fetcher);

    const result = await service.ingest({
      pr_number: 7,
      repo: REPOSITORY,
    });
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(result).toMatchObject({ jobs_created: 0, pending: 0 });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_BOT_RAW_ONLY",
        threadIds: ["thread-bot"],
      }),
    ]);
    expect(snapshot.domain.comments).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          actor_kind: "bot",
          trust: "unknown",
        }),
      }),
    ]);
    expect(snapshot.domain.distillJobs).toEqual([]);
  });

  it("serializes concurrent identical ingests without duplicate raw identities or jobs", async () => {
    const repository = await createRepository();
    const fetcher = new QueueSnapshotFetcher([
      completeSnapshot({ snapshotId: SNAPSHOT_IDS[0] }),
      completeSnapshot({
        observedAt: TIMES[1],
        snapshotId: SNAPSHOT_IDS[1],
      }),
    ]);
    const service = ingestService(repository, fetcher);

    const results = await Promise.all([
      service.ingest({ pr_number: 7, repo: REPOSITORY }),
      service.ingest({ pr_number: 7, repo: REPOSITORY }),
    ]);
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(results.map((result) => result.jobs_created).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.new_threads).sort()).toEqual([0, 1]);
    expect(snapshot.records).toHaveLength(5);
    expect(snapshot.domain.comments).toHaveLength(1);
    expect(snapshot.domain.pullRequestSnapshots).toHaveLength(1);
    expect(snapshot.domain.distillJobs).toHaveLength(1);
  });
});

class QueueSnapshotFetcher implements CompleteSnapshotFetcher {
  readonly requests: Array<{
    readonly prNumber: number;
    readonly repo: string;
  }> = [];

  constructor(
    private readonly values: Array<CompleteGitHubPullRequestSnapshot | Error>,
  ) {}

  async fetchCompleteSnapshot(request: {
    readonly prNumber: number;
    readonly repo: string;
  }): Promise<CompleteGitHubPullRequestSnapshot> {
    this.requests.push(request);
    const value = this.values.shift();
    if (value === undefined) throw new Error("snapshot fixture exhausted");
    if (value instanceof Error) throw value;
    return value;
  }
}

class FixedRepositoryResolver implements IngestRepositoryResolver {
  constructor(private readonly repositoryRoot: string) {}

  async resolve(): Promise<RepositoryResolution> {
    return {
      absolutePath: this.repositoryRoot,
      aliases: [],
      currentName: REPOSITORY,
      path: "repos/R_repo_node",
      repoId: REPO_ID,
      source: "tool-repo",
    };
  }
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-ingest-"));
  temporaryRepositories.push(repository);
  return repository;
}

function ingestService(
  repository: string,
  snapshotClient: CompleteSnapshotFetcher,
  options: { readonly prompt?: string } = {},
): GitHubIngestService {
  return new GitHubIngestService({
    outputSchemaDigest: computeOutputSchemaDigest({ type: "object" }),
    promptDigest: computePromptDigest(options.prompt ?? "distill-v1\n"),
    repositoryContext: { language: "TypeScript" },
    repositoryResolver: new FixedRepositoryResolver(repository),
    snapshotClient,
    trust: TRUST,
  });
}

interface CompleteSnapshotOptions {
  readonly observedAt?: string;
  readonly snapshotId: string;
  readonly threads?: readonly GitHubReviewThread[];
}

function completeSnapshot(
  options: CompleteSnapshotOptions,
): CompleteGitHubPullRequestSnapshot {
  const observedAt = options.observedAt ?? TIMES[0];
  const threads = options.threads ?? [
    reviewThread("thread-1", [
      reviewComment("comment-1", "Use the repository helper"),
    ]),
  ];
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: "PR_pull_node",
      mergedAt: null,
      number: 7,
      title: "Ingest fixture",
    },
    repository: { id: REPO_ID, nameWithOwner: REPOSITORY },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: observedAt,
      pr_number: 7,
      repo_id: REPO_ID,
      review_summary_ids: [],
      snapshot_id: options.snapshotId,
      thread_ids: threads.map((thread) => thread.id).sort(),
    },
    threads,
  };
}

function reviewThread(
  id: string,
  comments: readonly GitHubReviewComment[],
): GitHubReviewThread {
  return {
    comments,
    id,
    isOutdated: false,
    isResolved: false,
    path: `src/${id}.ts`,
  };
}

function reviewComment(
  id: string,
  body: string,
  overrides: Partial<GitHubReviewComment> = {},
): GitHubReviewComment {
  return {
    author: actor("User", "U_trusted", "alice"),
    authorAssociation: "MEMBER",
    body,
    createdAt: "2026-08-05T23:59:00.000Z",
    diffHunk: "@@ -1 +1 @@",
    id,
    updatedAt: "2026-08-05T23:59:30.000Z",
    url: `https://github.com/owner/repository/pull/7#${id}`,
    ...overrides,
  };
}

function actor(
  type: GitHubReviewActor["__typename"],
  id: string,
  login: string,
): GitHubReviewActor {
  return { __typename: type, id, login };
}

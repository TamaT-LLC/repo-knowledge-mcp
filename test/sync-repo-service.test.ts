import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  GitHubIngestService,
  IngestPrMutationService,
  RepoKnowledgeConfigSchema,
  SYNC_CHECKPOINT_SCHEMA_VERSION,
  SYNC_CURSOR_VERSION,
  SyncCheckpointStore,
  SyncRepoService,
  compareSyncOrder,
  computeOutputSchemaDigest,
  computePromptDigest,
  isAfterSyncBoundary,
  nextSyncCursor,
  parseIsoTimestampMs,
  resolveSyncBoundary,
  type CompleteGitHubPullRequestSnapshot,
  type CompleteSnapshotFetcher,
  type EnumerateUpdatedPullRequestsRequest,
  type EnumerateUpdatedPullRequestsResult,
  type GitHubReviewActor,
  type GitHubReviewComment,
  type GitHubReviewThread,
  type IngestPullRequestResult,
  type IngestRepositoryResolver,
  type RepositoryResolution,
  type RepositoryResolutionInput,
  type SyncCursor,
  type SyncPullRequestEnumerator,
  type SyncPullRequestIngester,
  type SyncRepoServiceOptions,
  type TrustConfig,
  type UpdatedPullRequestRef,
} from "../src/experimental.js";

const REPO_ID = "R_repo_node";
const REPOSITORY = "owner/repository";
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");
const ONE_MINUTE_MS = 60_000;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TRUST: TrustConfig = {
  aiReviewers: {},
  autoActivateTrustedHuman: false,
  externalContributors: "raw-only",
  sourceAliases: {},
  trustedActorIds: ["U_trusted"],
  trustedLogins: [],
};
const PULL_REQUESTS = [pullRequestRef(1), pullRequestRef(2), pullRequestRef(3)];

let snapshotSequence = 0;
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SyncRepoService", () => {
  it("syncs discovered PRs through ingest and persists a versioned checkpoint", async () => {
    const repository = await createRepository();
    const service = syncService(repository);

    const summary = await service.sync();
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    const checkpoint = await new SyncCheckpointStore(repository).read();

    expect(summary).toEqual({
      discovered: 3,
      failed: 0,
      failures: [],
      ingested: 3,
      jobs_created: 3,
      next_cursor: cursorAt(3),
      unchanged: 0,
    });
    // Provider stays disabled by default: raw observations are canonical and
    // every discovered thread becomes a pending job, nothing is distilled.
    expect(snapshot.domain.comments).toHaveLength(3);
    expect(snapshot.domain.pullRequestSnapshots).toHaveLength(3);
    expect(snapshot.domain.distillJobs.map((job) => job.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(snapshot.domain.evidence).toHaveLength(0);
    expect(checkpoint).toEqual({
      cursor: cursorAt(3),
      schema_version: SYNC_CHECKPOINT_SCHEMA_VERSION,
      updated_at: expect.stringContaining("T"),
    });
  });

  it("does not grow canonical state when re-run from the same boundary", async () => {
    const repository = await createRepository();
    const service = syncService(repository);
    await service.sync();
    const before = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    const resumed = await service.sync();
    const replayed = await service.sync({
      since: new Date(BASE_MS - ONE_MINUTE_MS).toISOString(),
    });
    const after = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(resumed).toMatchObject({
      discovered: 0,
      failed: 0,
      ingested: 0,
      jobs_created: 0,
      next_cursor: cursorAt(3),
      unchanged: 0,
    });
    // A --since replay revisits every PR but ingest is idempotent and the
    // durable checkpoint never regresses.
    expect(replayed).toMatchObject({
      discovered: 3,
      failed: 0,
      ingested: 0,
      jobs_created: 0,
      next_cursor: cursorAt(3),
      unchanged: 3,
    });
    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    expect(after.domain.evidence).toHaveLength(0);
    expect(after.domain.distillJobs).toHaveLength(3);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toMatchObject({ cursor: cursorAt(3) });
  });

  it("does not skip PRs when a crash lands between ingest and checkpoint advancement", async () => {
    const repository = await createRepository();
    const crashing = new CrashAfterIngestIngester(buildIngester(repository), 2);
    const firstRun = syncService(repository, { ingester: crashing });

    const crashed = await firstRun.sync();
    const checkpointAfterCrash = await new SyncCheckpointStore(
      repository,
    ).read();

    // PR 2 reached canonical storage, but the run reports it as failed and
    // the checkpoint still names PR 1 as the boundary.
    expect(crashed).toMatchObject({
      discovered: 3,
      failed: 1,
      failures: [expect.objectContaining({ pr_number: 2 })],
      ingested: 1,
      next_cursor: cursorAt(1),
    });
    expect(checkpointAfterCrash).toMatchObject({ cursor: cursorAt(1) });

    const resumed = await syncService(repository).sync();
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(resumed).toEqual({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 1,
      jobs_created: 1,
      next_cursor: cursorAt(3),
      unchanged: 1,
    });
    expect(snapshot.domain.distillJobs).toHaveLength(3);
    expect(snapshot.domain.comments).toHaveLength(3);
  });

  it("stops at the first failed PR with a deterministic checkpoint", async () => {
    const repository = await createRepository();
    const flaky = new FlakyIngester(buildIngester(repository), new Set([2]));
    const service = syncService(repository, { ingester: flaky });

    const failedRun = await service.sync();

    expect(failedRun).toEqual({
      discovered: 3,
      failed: 1,
      failures: [{ message: "ingest fixture failure", pr_number: 2 }],
      ingested: 1,
      jobs_created: 1,
      next_cursor: cursorAt(1),
      unchanged: 0,
    });
    // PR 3 is never attempted once PR 2 fails.
    expect(flaky.calls).toEqual([1, 2]);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toMatchObject({ cursor: cursorAt(1) });

    const healed = await syncService(repository).sync();

    expect(healed).toEqual({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 2,
      jobs_created: 2,
      next_cursor: cursorAt(3),
      unchanged: 0,
    });
  });

  it("serializes concurrent syncs of the same repository", async () => {
    const repository = await createRepository();
    const guarded = new GuardedIngester(buildIngester(repository));
    const service = syncService(repository, {
      ingester: guarded,
      syncLockTimeoutMs: 30_000,
    });

    const results = await Promise.all([service.sync(), service.sync()]);
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(guarded.maxActive).toBe(1);
    expect(results.map((result) => result.failed)).toEqual([0, 0]);
    expect(
      results.map((result) => result.discovered).sort((a, b) => a - b),
    ).toEqual([0, 3]);
    expect(snapshot.domain.distillJobs).toHaveLength(3);
    expect(snapshot.domain.comments).toHaveLength(3);
    expect(snapshot.domain.pullRequestSnapshots).toHaveLength(3);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toMatchObject({ cursor: cursorAt(3) });
  });

  it("rejects --since at or beyond the stored checkpoint boundary", async () => {
    const repository = await createRepository();
    const service = syncService(repository);
    // Leave the checkpoint mid-history at PR 1 so PRs 2 and 3 are unsynced.
    await syncService(repository, {
      ingester: new FlakyIngester(buildIngester(repository), new Set([2])),
    }).sync();
    const before = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    // A --since equal to or newer than the checkpoint boundary would let the
    // checkpoint advance past never-synced PRs, so both fail closed.
    await expect(service.sync({ since: isoAt(1) })).rejects.toMatchObject({
      code: "SYNC_SINCE_BEYOND_CHECKPOINT",
    });
    await expect(service.sync({ since: isoAt(2) })).rejects.toMatchObject({
      code: "SYNC_SINCE_BEYOND_CHECKPOINT",
    });
    const after = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toMatchObject({ cursor: cursorAt(1) });

    // Resuming without --since still reaches PRs 2 and 3 afterwards.
    await expect(service.sync()).resolves.toMatchObject({
      discovered: 2,
      failed: 0,
      next_cursor: cursorAt(3),
    });
  });

  it("accepts an ingester bound to an alias of the same repository", async () => {
    const repository = await createRepository();
    const canonical = resolutionOf(repository, REPO_ID, REPOSITORY);
    // The ingester's own resolver maps the historical alias to the same
    // stable repo_id the service resolves for the canonical name.
    const aliasResolver = new MappedRepositoryResolver(
      new Map([
        ["owner/old-name", { ...canonical, aliases: ["owner/old-name"] }],
      ]),
    );
    const service = syncService(repository, {
      ingester: buildIngester(repository, "owner/old-name", aliasResolver),
    });

    await expect(service.sync()).resolves.toMatchObject({
      discovered: 3,
      failed: 0,
      ingested: 3,
      jobs_created: 3,
      next_cursor: cursorAt(3),
    });
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toMatchObject({ cursor: cursorAt(3) });
  });

  it("rejects an ingester bound to a truly different repository before any mutation", async () => {
    const repository = await createRepository();
    const foreignResolver = new MappedRepositoryResolver(
      new Map([
        [
          "other/repository",
          resolutionOf(repository, "R_other_node", "other/repository"),
        ],
      ]),
    );
    const recorder = new FlakyIngester(
      buildIngester(repository, "other/repository", foreignResolver),
      new Set(),
    );
    const service = syncService(repository, { ingester: recorder });

    await expect(service.sync()).rejects.toMatchObject({
      code: "SYNC_REPOSITORY_MISMATCH",
    });
    // The run fails closed before a single ingest is attempted.
    expect(recorder.calls).toEqual([]);
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    expect(snapshot.records).toHaveLength(0);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toBeNull();
  });

  it("rejects a same-named ingester whose own resolver targets a different repository", async () => {
    const repository = await createRepository();
    // Identical repo strings, but the ingester's resolver binds the name to
    // another stable repo_id — the repo_id comparison must not be skipped.
    const divergentResolver = new MappedRepositoryResolver(
      new Map([
        [REPOSITORY, resolutionOf(repository, "R_other_node", REPOSITORY)],
      ]),
    );
    const recorder = new FlakyIngester(
      buildIngester(repository, REPOSITORY, divergentResolver),
      new Set(),
    );
    const service = syncService(repository, { ingester: recorder });

    await expect(service.sync()).rejects.toMatchObject({
      code: "SYNC_REPOSITORY_MISMATCH",
    });
    // No mutation is committed even though the raw names match.
    expect(recorder.calls).toEqual([]);
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    expect(snapshot.records).toHaveLength(0);
    await expect(
      new SyncCheckpointStore(repository).read(),
    ).resolves.toBeNull();
  });

  it("rejects a stored checkpoint that belongs to a different repository", async () => {
    const repository = await createRepository();
    await new SyncCheckpointStore(repository).write({
      cursor: {
        last_pr_number: 1,
        last_updated_at: isoAt(1),
        repo_id: "R_other_repository",
        version: SYNC_CURSOR_VERSION,
      },
      schema_version: SYNC_CHECKPOINT_SCHEMA_VERSION,
      updated_at: isoAt(1),
    });

    await expect(syncService(repository).sync()).rejects.toMatchObject({
      code: "SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
    });
  });
});

/** Replays the deterministic boundary rules over a fixed PR listing. */
class FixtureEnumerator implements SyncPullRequestEnumerator {
  constructor(
    private readonly pullRequests: readonly UpdatedPullRequestRef[],
  ) {}

  async enumerateUpdatedPullRequests(
    request: EnumerateUpdatedPullRequestsRequest,
  ): Promise<EnumerateUpdatedPullRequestsResult> {
    const boundary = resolveSyncBoundary({
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.since === undefined ? {} : { since: request.since }),
    });
    const included = this.pullRequests
      .filter((pullRequest) =>
        isAfterSyncBoundary(
          boundary,
          parseIsoTimestampMs(pullRequest.updatedAt),
          pullRequest.number,
        ),
      )
      .sort((first, second) =>
        compareSyncOrder(
          {
            number: first.number,
            updatedAtMs: parseIsoTimestampMs(first.updatedAt),
          },
          {
            number: second.number,
            updatedAtMs: parseIsoTimestampMs(second.updatedAt),
          },
        ),
      );
    const last = included.at(-1);
    return {
      nextCursor:
        last !== undefined
          ? nextSyncCursor(REPO_ID, last)
          : boundary.kind === "cursor"
            ? boundary.cursor
            : null,
      pullRequests: included,
      repository: { id: REPO_ID, nameWithOwner: REPOSITORY },
    };
  }
}

/** Serves a deterministic complete snapshot for any requested PR number. */
class FixturePullRequestFetcher implements CompleteSnapshotFetcher {
  async fetchCompleteSnapshot(request: {
    readonly prNumber: number;
    readonly repo: string;
  }): Promise<CompleteGitHubPullRequestSnapshot> {
    return completeSnapshot(request.prNumber);
  }
}

/** Resolves configured names (canonical or alias) to stable resolutions. */
class MappedRepositoryResolver implements IngestRepositoryResolver {
  constructor(
    private readonly resolutions: ReadonlyMap<string, RepositoryResolution>,
  ) {}

  async resolve(
    input?: RepositoryResolutionInput,
  ): Promise<RepositoryResolution> {
    const resolution =
      input?.repo === undefined ? undefined : this.resolutions.get(input.repo);
    if (resolution === undefined) {
      throw new Error(`unknown repository ${input?.repo ?? "<none>"}`);
    }
    return resolution;
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

/** Ingests normally, then simulates a crash before the checkpoint advances. */
class CrashAfterIngestIngester implements SyncPullRequestIngester {
  constructor(
    private readonly inner: SyncPullRequestIngester,
    private readonly crashOnPrNumber: number,
  ) {}

  get repo(): string {
    return this.inner.repo;
  }

  async resolveBoundRepoId(): Promise<string> {
    return this.inner.resolveBoundRepoId();
  }

  async ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult> {
    const result = await this.inner.ingestPullRequest(request);
    if (request.pr_number === this.crashOnPrNumber) {
      throw new Error("simulated crash after ingest");
    }
    return result;
  }
}

class FlakyIngester implements SyncPullRequestIngester {
  readonly calls: number[] = [];

  constructor(
    private readonly inner: SyncPullRequestIngester,
    private readonly failOnPrNumbers: ReadonlySet<number>,
  ) {}

  get repo(): string {
    return this.inner.repo;
  }

  async resolveBoundRepoId(): Promise<string> {
    return this.inner.resolveBoundRepoId();
  }

  async ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult> {
    this.calls.push(request.pr_number);
    if (this.failOnPrNumbers.has(request.pr_number)) {
      throw new Error("ingest fixture failure");
    }
    return this.inner.ingestPullRequest(request);
  }
}

/** Records the peak number of in-flight ingests to prove serialization. */
class GuardedIngester implements SyncPullRequestIngester {
  maxActive = 0;

  private active = 0;

  constructor(private readonly inner: SyncPullRequestIngester) {}

  get repo(): string {
    return this.inner.repo;
  }

  async resolveBoundRepoId(): Promise<string> {
    return this.inner.resolveBoundRepoId();
  }

  async ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.inner.ingestPullRequest(request);
    } finally {
      this.active -= 1;
    }
  }
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-sync-repo-"));
  temporaryRepositories.push(repository);
  return repository;
}

function resolutionOf(
  repositoryRoot: string,
  repoId: string,
  currentName: string,
): RepositoryResolution {
  return {
    absolutePath: repositoryRoot,
    aliases: [],
    currentName,
    path: `repos/${repoId}`,
    repoId,
    source: "tool-repo",
  };
}

function syncService(
  repository: string,
  overrides: Partial<SyncRepoServiceOptions> = {},
): SyncRepoService {
  return new SyncRepoService({
    enumerator: new FixtureEnumerator(PULL_REQUESTS),
    ingester: buildIngester(repository),
    repo: REPOSITORY,
    repositoryResolver: new FixedRepositoryResolver(repository),
    ...overrides,
  });
}

function buildIngester(
  repository: string,
  repo = REPOSITORY,
  resolver: IngestRepositoryResolver = new FixedRepositoryResolver(repository),
): IngestPrMutationService {
  return new IngestPrMutationService({
    config: RepoKnowledgeConfigSchema.parse({}),
    ingester: new GitHubIngestService({
      outputSchemaDigest: computeOutputSchemaDigest({ type: "object" }),
      promptDigest: computePromptDigest("distill-v1\n"),
      repositoryContext: { language: "TypeScript" },
      repositoryResolver: resolver,
      snapshotClient: new FixturePullRequestFetcher(),
      trust: TRUST,
    }),
    repo,
  });
}

function pullRequestRef(prNumber: number): UpdatedPullRequestRef {
  return {
    id: `PR_node_${String(prNumber)}`,
    number: prNumber,
    updatedAt: isoAt(prNumber),
  };
}

function isoAt(prNumber: number): string {
  return new Date(BASE_MS + prNumber * ONE_MINUTE_MS).toISOString();
}

function cursorAt(prNumber: number): SyncCursor {
  return {
    last_pr_number: prNumber,
    last_updated_at: isoAt(prNumber),
    repo_id: REPO_ID,
    version: SYNC_CURSOR_VERSION,
  };
}

function completeSnapshot(prNumber: number): CompleteGitHubPullRequestSnapshot {
  const threads = [
    reviewThread(`thread-${String(prNumber)}`, [
      reviewComment(
        `comment-${String(prNumber)}`,
        `Guard the input on PR ${String(prNumber)}`,
      ),
    ]),
  ];
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: `PR_node_${String(prNumber)}`,
      mergedAt: null,
      number: prNumber,
      title: `Sync fixture ${String(prNumber)}`,
    },
    repository: { id: REPO_ID, nameWithOwner: REPOSITORY },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: isoAt(prNumber),
      pr_number: prNumber,
      repo_id: REPO_ID,
      review_summary_ids: [],
      snapshot_id: nextSnapshotId(),
      thread_ids: threads.map((thread) => thread.id).sort(),
    },
    threads,
  };
}

function nextSnapshotId(): string {
  const index = snapshotSequence;
  snapshotSequence += 1;
  const high = ULID_ALPHABET[Math.floor(index / ULID_ALPHABET.length)];
  const low = ULID_ALPHABET[index % ULID_ALPHABET.length];
  if (high === undefined || low === undefined) {
    throw new Error("snapshot fixture sequence exhausted");
  }
  // 24 fixed ULID characters + 2 sequence characters = a unique 26-char ULID.
  return `snap_01ARZ3NDEKTSV4RRFFQ69G5F${high}${low}`;
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

function reviewComment(id: string, body: string): GitHubReviewComment {
  return {
    author: actor("User", "U_trusted", "alice"),
    authorAssociation: "MEMBER",
    body,
    createdAt: "2026-07-31T23:59:00.000Z",
    diffHunk: "@@ -1 +1 @@",
    id,
    updatedAt: "2026-07-31T23:59:30.000Z",
    url: `https://github.com/owner/repository/pull/1#${id}`,
  };
}

function actor(
  type: GitHubReviewActor["__typename"],
  id: string,
  login: string,
): GitHubReviewActor {
  return { __typename: type, id, login };
}

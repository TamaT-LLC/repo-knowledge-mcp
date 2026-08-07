import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalCliRepositoryService,
  CanonicalTransactionStore,
  DistillJobCoordinator,
  GitHubIngestService,
  ModelPlaneKnowledgeService,
  RepoKnowledgeConfigSchema,
  computeOutputSchemaDigest,
  computePromptDigest,
  type CompleteGitHubPullRequestSnapshot,
  type CompleteSnapshotFetcher,
  type GitHubReviewActor,
  type GitHubReviewComment,
  type IngestRepositoryResolver,
  type ProviderPostIngestRunner,
  type RepositoryResolution,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OUTPUT_DIGEST = computeOutputSchemaDigest({ type: "object" });
const PROMPT_DIGEST = computePromptDigest("distill-v1\n");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe("CanonicalCliRepositoryService", () => {
  it("reindexes only SQLite and lists canonical statuses", async () => {
    const fixture = await createKnowledgeFixture();
    const knowledgePath = join(
      fixture.root,
      "knowledge",
      `${fixture.knowledgeId}.md`,
    );
    const before = await readFile(knowledgePath);

    const result = await fixture.service.reindex();

    expect(result).toMatchObject({
      evidence: 0,
      jobs: 0,
      knowledge: 1,
      repo: REPOSITORY,
      submissions: 0,
    });
    expect(await readFile(knowledgePath)).toEqual(before);
    expect(
      await fixture.service.listKnowledge({ status: "proposed" }),
    ).toMatchObject({
      knowledge: [
        expect.objectContaining({
          id: fixture.knowledgeId,
          status: "proposed",
        }),
      ],
      repo: REPOSITORY,
    });
    await expect(
      readFile(join(fixture.root, "index.sqlite")),
    ).resolves.not.toHaveLength(0);
  });

  it("writes derived metadata through one canonical transaction and then no-ops", async () => {
    const fixture = await createKnowledgeFixture();

    const first = await fixture.service.reconcileDerivedMetadata();

    expect(first).toMatchObject({
      repo: REPOSITORY,
      transaction_id: expect.stringMatching(/^txn_/u),
      unchanged: 0,
      written: 1,
    });
    const document = await fixture.store.readKnowledge(
      `knowledge/${fixture.knowledgeId}.md`,
    );
    expect(document.frontmatter).toMatchObject({
      applied_count: 0,
      evidence_count: 0,
      representative_evidence: [],
      revision: 2,
      sources: [],
      violation_count: 0,
    });

    await expect(fixture.service.reconcileDerivedMetadata()).resolves.toEqual({
      repo: REPOSITORY,
      transaction_id: null,
      unchanged: 1,
      written: 0,
    });
  });

  it("reclassifies a configured bot and creates a job without refetching GitHub", async () => {
    const root = await createRoot();
    const fetcher = new OneSnapshotFetcher(botSnapshot());
    const ingester = new GitHubIngestService({
      outputSchemaDigest: OUTPUT_DIGEST,
      promptDigest: PROMPT_DIGEST,
      repositoryContext: {},
      repositoryResolver: new FixedResolver(root),
      snapshotClient: fetcher,
      trust: RepoKnowledgeConfigSchema.parse({}).trust,
    });
    await expect(
      ingester.ingest({ pr_number: 7, repo: REPOSITORY }),
    ).resolves.toMatchObject({ jobs_created: 0, pending: 0 });
    const store = new CanonicalTransactionStore(root);
    const service = maintenance(store, {
      trust: {
        aiReviewers: { "greptile-apps[bot]": "greptile" },
      },
    });

    const result = await service.redistill({
      author: "greptile-apps[bot]",
      selector: "author",
    });

    expect(result).toEqual({
      created_jobs: 1,
      reclassified_comments: 1,
      reset_jobs: 0,
      selected_threads: 1,
      unchanged: 0,
    });
    expect(fetcher.calls).toBe(1);
    const snapshot = await store.readSnapshot();
    expect(snapshot.domain.comments).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({
          login: "greptile-apps[bot]",
          provider: "greptile",
          trust: "trusted",
        }),
      }),
    ]);
    expect(snapshot.domain.distillJobs).toEqual([
      expect.objectContaining({ state: "pending", thread_id: "thread-1" }),
    ]);
  });

  it("resets a failed provider job selected by --failed", async () => {
    const root = await createRoot();
    const config = RepoKnowledgeConfigSchema.parse({
      trust: {
        aiReviewers: { "greptile-apps[bot]": "greptile" },
      },
    });
    const ingester = new GitHubIngestService({
      outputSchemaDigest: OUTPUT_DIGEST,
      promptDigest: PROMPT_DIGEST,
      repositoryContext: {},
      repositoryResolver: new FixedResolver(root),
      snapshotClient: new OneSnapshotFetcher(botSnapshot()),
      trust: config.trust,
    });
    await ingester.ingest({ pr_number: 7, repo: REPOSITORY });
    const store = new CanonicalTransactionStore(root);
    const initial = await store.readSnapshot();
    const job = initial.domain.distillJobs[0]!;
    const coordinator = new DistillJobCoordinator(store, {
      nextLeaseToken: () => "provider-lease",
    });
    const lease = await coordinator.acquireLease({
      job_id: job.job_id,
      repo_id: REPOSITORY_ID,
    });
    expect(lease).not.toBeNull();
    await coordinator.fail({
      ...lease!,
      failure_kind: "system",
      last_error: "provider unavailable",
    });

    const result = await maintenance(store, config).redistill({
      selector: "failed",
    });

    expect(result).toMatchObject({
      created_jobs: 0,
      reset_jobs: 1,
      selected_threads: 1,
    });
    expect((await store.readSnapshot()).domain.distillJobs[0]).toMatchObject({
      job_id: job.job_id,
      last_error: null,
      state: "pending",
      validation_failures: 0,
    });
    const reacquired = await coordinator.acquireLease({
      job_id: job.job_id,
      repo_id: REPOSITORY_ID,
    });
    expect(reacquired).toMatchObject({
      job: { state: "processing" },
      lease_generation: 2,
    });
  });

  it("leaves jobs pending and never invokes a provider when transmission is disabled", async () => {
    const root = await createRoot();
    const config = RepoKnowledgeConfigSchema.parse({
      trust: {
        aiReviewers: { "greptile-apps[bot]": "greptile" },
      },
    });
    await new GitHubIngestService({
      outputSchemaDigest: OUTPUT_DIGEST,
      promptDigest: PROMPT_DIGEST,
      repositoryContext: {},
      repositoryResolver: new FixedResolver(root),
      snapshotClient: new OneSnapshotFetcher(botSnapshot()),
      trust: config.trust,
    }).ingest({ pr_number: 7, repo: REPOSITORY });
    const providerRunner: ProviderPostIngestRunner = {
      run: vi.fn(async () => ({ distilled: 0, pending: 0 })),
    };
    const service = maintenance(
      new CanonicalTransactionStore(root),
      config,
      providerRunner,
    );

    await expect(service.distill()).resolves.toMatchObject({
      distilled: 0,
      pending: 1,
      reason: expect.stringContaining("disabled"),
    });
    expect(providerRunner.run).not.toHaveBeenCalled();
  });
});

async function createKnowledgeFixture() {
  const root = await createRoot();
  const store = new CanonicalTransactionStore(root);
  const model = new ModelPlaneKnowledgeService({
    repo: REPOSITORY,
    repoId: REPOSITORY_ID,
    repository: store,
  });
  const added = await model.addKnowledge({
    category: "architecture",
    detail: "Canonical CLI fixture detail",
    rule: "Canonical CLI fixture rule",
    scope: ["src/**"],
    severity: "must",
  });
  return {
    knowledgeId: added.id,
    root,
    service: maintenance(store),
    store,
  };
}

function maintenance(
  store: CanonicalTransactionStore,
  configInput: unknown = {},
  providerRunner?: ProviderPostIngestRunner,
): CanonicalCliRepositoryService {
  const config = RepoKnowledgeConfigSchema.parse(configInput);
  return new CanonicalCliRepositoryService({
    config,
    outputSchemaDigest: OUTPUT_DIGEST,
    promptDigest: PROMPT_DIGEST,
    promptVersion: "distill-v1",
    ...(providerRunner === undefined ? {} : { providerRunner }),
    repo: REPOSITORY,
    repoId: REPOSITORY_ID,
    repository: store,
    repositoryContext: {},
  });
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rkm-cli-maintenance-"));
  roots.push(root);
  return root;
}

class FixedResolver implements IngestRepositoryResolver {
  constructor(private readonly root: string) {}

  async resolve(): Promise<RepositoryResolution> {
    return {
      absolutePath: this.root,
      aliases: [],
      currentName: REPOSITORY,
      path: "repos/R_repository",
      repoId: REPOSITORY_ID,
      source: "tool-repo",
    };
  }
}

class OneSnapshotFetcher implements CompleteSnapshotFetcher {
  calls = 0;

  constructor(private readonly snapshot: CompleteGitHubPullRequestSnapshot) {}

  async fetchCompleteSnapshot(): Promise<CompleteGitHubPullRequestSnapshot> {
    this.calls += 1;
    return this.snapshot;
  }
}

function botSnapshot(): CompleteGitHubPullRequestSnapshot {
  const comment: GitHubReviewComment = {
    author: actor("Bot", "B_greptile", "greptile-apps[bot]"),
    authorAssociation: "NONE",
    body: "Use the canonical repository helper.",
    createdAt: "2026-08-06T00:00:00.000Z",
    diffHunk: "@@ -1 +1 @@",
    id: "comment-1",
    updatedAt: "2026-08-06T00:00:01.000Z",
    url: "https://github.com/owner/repository/pull/7#discussion_r1",
  };
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: "PR_node",
      mergedAt: null,
      number: 7,
      title: "CLI fixture",
    },
    repository: { id: REPOSITORY_ID, nameWithOwner: REPOSITORY },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: "2026-08-06T00:01:00.000Z",
      pr_number: 7,
      repo_id: REPOSITORY_ID,
      review_summary_ids: [],
      snapshot_id: SNAPSHOT_ID,
      thread_ids: ["thread-1"],
    },
    threads: [
      {
        comments: [comment],
        id: "thread-1",
        isOutdated: false,
        isResolved: false,
        path: "src/helper.ts",
      },
    ],
  };
}

function actor(
  type: GitHubReviewActor["__typename"],
  id: string,
  login: string,
): GitHubReviewActor {
  return { __typename: type, id, login };
}

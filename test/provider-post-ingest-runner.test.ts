import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalCliRepositoryService,
  CanonicalFinalizeService,
  CanonicalProviderPostIngestRunner,
  CanonicalTransactionStore,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DistillJobCoordinator,
  GitHubIngestService,
  HostAssistedDistillationError,
  ProviderDistillationPipeline,
  ProviderDistillationService,
  ProviderPostIngestError,
  RepoKnowledgeConfigSchema,
  type CanonicalProjectionSnapshot,
  parseDistillationPrompt,
  type CompleteGitHubPullRequestSnapshot,
  type LlmProviderAdapter,
  type RepositoryResolution,
} from "../src/experimental.js";

const REPOSITORY_ID = "R_repository";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OBSOLETE_JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-06T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("CanonicalProviderPostIngestRunner", () => {
  it("runs current pending jobs and reports their final states", async () => {
    const initial = snapshot([
      job(JOB_ID, "pending"),
      job(OBSOLETE_JOB_ID, "pending"),
    ]);
    const current = snapshot([
      job(JOB_ID, "skipped"),
      job(OBSOLETE_JOB_ID, "pending"),
    ]);
    const readSnapshot = vi
      .fn<() => Promise<CanonicalProjectionSnapshot>>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(current);
    const pipelineRun = vi.fn<ProviderDistillationPipeline["run"]>(
      async () => ({
        result: {
          manual_review: null,
          reassociated_evidence_ids: [],
          stable_response: {
            skip_reason: "typo",
            staled_knowledge_ids: [],
            state: "skipped",
            withdrawn_evidence_ids: [],
          },
        },
        state: "skipped",
      }),
    );
    const runner = new CanonicalProviderPostIngestRunner({
      config: RepoKnowledgeConfigSchema.parse({}),
      pipeline: { run: pipelineRun },
      promptDigest: HASH,
      repoId: REPOSITORY_ID,
      repository: { readSnapshot },
      repositoryContext: { language: "TypeScript" },
      sourceResolver: (...args) => {
        const distillJob = args[1];
        if (distillJob.job_id === OBSOLETE_JOB_ID) {
          throw new HostAssistedDistillationError(
            "DISTILLATION_CONTEXT_CHANGED",
            "obsolete job",
          );
        }
        return {
          contentFingerprint: HASH,
          distillationKey: HASH,
          normalizedActors: [
            {
              actor_id: "U_1",
              actor_kind: "user",
              authorAssociation: "MEMBER",
              login: "reviewer",
              provider: "human",
              trust: "trusted",
            },
          ],
          normalizedComments: [
            {
              body: "Use the server factory",
              createdAt: NOW,
              id: "C_1",
              updatedAt: NOW,
            },
          ],
          path: "src/server.ts",
          snapshotId: SNAPSHOT_ID,
        };
      },
    });

    const result = await runner.run({
      ingest: ingestResult(),
      pr_number: 42,
    });

    expect(result).toEqual({ distilled: 1, pending: 0 });
    expect(pipelineRun).toHaveBeenCalledOnce();
    expect(pipelineRun).toHaveBeenCalledWith({
      job_id: JOB_ID,
      repositoryContext: { language: "TypeScript" },
      thread: expect.objectContaining({
        contentFingerprint: HASH,
        distillationInputDigest: expect.stringMatching(/^sha256:/u),
        distillationKey: HASH,
        threadId: "thread-1",
      }),
    });
  });

  it("counts resumable non-pending states without stealing their leases", async () => {
    const current = snapshot([job(JOB_ID, "awaiting_finalize", true)]);
    const pipelineRun = vi.fn<ProviderDistillationPipeline["run"]>();
    const runner = new CanonicalProviderPostIngestRunner({
      config: RepoKnowledgeConfigSchema.parse({}),
      pipeline: { run: pipelineRun },
      promptDigest: HASH,
      repoId: REPOSITORY_ID,
      repository: { readSnapshot: vi.fn(async () => current) },
      repositoryContext: {},
      sourceResolver: () => ({
        contentFingerprint: HASH,
        distillationKey: HASH,
        normalizedActors: [],
        normalizedComments: [],
        path: null,
        snapshotId: SNAPSHOT_ID,
      }),
    });

    await expect(
      runner.run({ ingest: ingestResult(), pr_number: 42 }),
    ).resolves.toEqual({ distilled: 0, pending: 1 });
    expect(pipelineRun).not.toHaveBeenCalled();
  });

  it("recovers interrupted processing only after lease expiry, once in a new generation", async () => {
    const fixture = await recoveryFixture();
    const interrupted = await fixture.coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPOSITORY_ID,
    });
    expect(interrupted).not.toBeNull();
    const before = (await fixture.store.readSnapshot()).domain.distillJobs[0];
    fixture.setTime(Date.parse(interrupted!.expires_at) - 1);

    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 0,
      pending: 1,
    });
    expect(fixture.completeStructured).not.toHaveBeenCalled();
    expect((await fixture.store.readSnapshot()).domain.distillJobs[0]).toEqual(
      before,
    );

    fixture.setTime(Date.parse(interrupted!.expires_at));
    const recovered = await Promise.all([
      fixture.cli.distill(),
      fixture.cli.distill(),
    ]);
    expect(recovered.map((result) => result.distilled).sort()).toEqual([0, 1]);
    expect(recovered).toContainEqual({ distilled: 1, pending: 0 });
    expect(fixture.completeStructured).toHaveBeenCalledOnce();
    expect(
      (await fixture.store.readSnapshot()).domain.distillJobs[0],
    ).toMatchObject({
      attempts: 2,
      job_id: fixture.jobId,
      lease_generation: interrupted!.lease_generation + 1,
      state: "skipped",
    });
    await expect(
      fixture.coordinator.markAwaitingFinalize(interrupted!),
    ).rejects.toMatchObject({
      code: "STALE_LEASE",
    });
    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 0,
      pending: 0,
    });
    expect(fixture.completeStructured).toHaveBeenCalledOnce();
  });

  it("keeps a recovered provider failure terminal until an explicit failed-job reset", async () => {
    const fixture = await recoveryFixture();
    const interrupted = await fixture.coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPOSITORY_ID,
    });
    fixture.setTime(Date.parse(interrupted!.expires_at));
    fixture.completeStructured.mockRejectedValueOnce(
      new Error("synthetic provider failure"),
    );

    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 0,
      pending: 1,
    });
    const failed = (await fixture.store.readSnapshot()).domain.distillJobs[0]!;
    expect(failed).toMatchObject({
      attempts: 2,
      last_error: "provider request failed (UNEXPECTED_PROVIDER_ERROR)",
      lease_generation: 2,
      state: "failed",
    });
    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 0,
      pending: 1,
    });
    expect(fixture.completeStructured).toHaveBeenCalledOnce();
    expect((await fixture.store.readSnapshot()).domain.distillJobs[0]).toEqual(
      failed,
    );

    await expect(
      fixture.cli.redistill({ selector: "failed" }),
    ).resolves.toMatchObject({
      created_jobs: 0,
      reset_jobs: 1,
      selected_threads: 1,
    });
    expect(
      (await fixture.store.readSnapshot()).domain.distillJobs[0],
    ).toMatchObject({
      attempts: 2,
      job_id: fixture.jobId,
      last_error: null,
      lease_generation: 2,
      state: "pending",
      validation_failures: 0,
    });
    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 1,
      pending: 0,
    });
    expect(fixture.completeStructured).toHaveBeenCalledTimes(2);
    expect(
      (await fixture.store.readSnapshot()).domain.distillJobs[0],
    ).toMatchObject({
      attempts: 3,
      lease_generation: 3,
      state: "skipped",
    });
  });

  it("does not re-extract awaiting-finalize work even after its lease expires", async () => {
    const fixture = await recoveryFixture();
    const lease = await fixture.coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPOSITORY_ID,
    });
    await fixture.coordinator.markAwaitingFinalize(lease!);
    const before = (await fixture.store.readSnapshot()).domain.distillJobs[0];
    fixture.setTime(Date.parse(lease!.expires_at));

    await expect(fixture.cli.distill()).resolves.toEqual({
      distilled: 0,
      pending: 1,
    });
    expect(fixture.completeStructured).not.toHaveBeenCalled();
    expect((await fixture.store.readSnapshot()).domain.distillJobs[0]).toEqual(
      before,
    );
  });

  it("does not re-extract when a processing snapshot becomes expired awaiting-finalize before admission", async () => {
    const fixture = await recoveryFixture();
    const lease = await fixture.coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPOSITORY_ID,
    });
    const readSnapshot = fixture.store.readSnapshot.bind(fixture.store);
    let awaiting: CanonicalProjectionSnapshot | undefined;
    vi.spyOn(fixture.store, "readSnapshot").mockImplementationOnce(async () => {
      const stale = await readSnapshot();
      expect(stale.domain.distillJobs[0]?.state).toBe("processing");
      await fixture.coordinator.markAwaitingFinalize(lease!);
      fixture.setTime(Date.parse(lease!.expires_at));
      awaiting = await readSnapshot();
      return stale;
    });

    await expect(
      fixture.runner.run({ ingest: ingestResult(), pr_number: 42 }),
    ).resolves.toEqual({ distilled: 0, pending: 1 });
    expect(fixture.completeStructured).not.toHaveBeenCalled();
    expect((await readSnapshot()).domain.distillJobs).toEqual(
      awaiting!.domain.distillJobs,
    );
  });

  it("rejects results for a different repository before provider work", async () => {
    const readSnapshot = vi.fn(async () => snapshot([]));
    const runner = new CanonicalProviderPostIngestRunner({
      config: RepoKnowledgeConfigSchema.parse({}),
      pipeline: { run: vi.fn() },
      promptDigest: HASH,
      repoId: REPOSITORY_ID,
      repository: { readSnapshot },
      repositoryContext: {},
    });

    await expect(
      runner.run({
        ingest: { ...ingestResult(), repo_id: "R_other" },
        pr_number: 42,
      }),
    ).rejects.toMatchObject({
      code: "INGEST_REPOSITORY_MISMATCH",
    } satisfies Partial<ProviderPostIngestError>);
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});

function snapshot(
  jobs: readonly ReturnType<typeof job>[],
): CanonicalProjectionSnapshot {
  return {
    domain: {
      distillJobs: jobs,
      pullRequestSnapshots: [
        {
          complete: true,
          observed_at: NOW,
          pr_number: 42,
          repo_id: REPOSITORY_ID,
          review_summary_ids: [],
          snapshot_id: SNAPSHOT_ID,
          thread_ids: ["thread-1"],
        },
      ],
    },
  } as unknown as CanonicalProjectionSnapshot;
}

function job(
  jobId: string,
  state: "awaiting_finalize" | "pending" | "skipped",
  leased = false,
) {
  return {
    attempts: leased ? 1 : 0,
    distillation_key: HASH,
    job_id: jobId,
    ...(leased
      ? {
          lease_expires_at: "2026-08-06T00:05:00.000Z",
          lease_token_hash: HASH,
        }
      : {}),
    lease_generation: leased ? 1 : 0,
    repo_id: REPOSITORY_ID,
    state,
    thread_id: "thread-1",
    updated_at: NOW,
    validation_failures: 0,
  } as const;
}

function ingestResult() {
  return {
    changed_threads: 0,
    distilled: 0,
    jobs_created: 1,
    new_threads: 1,
    pending: 1,
    repo_id: REPOSITORY_ID,
    snapshot_id: SNAPSHOT_ID,
    unchanged: 0,
    warnings: [],
  };
}

/** Builds a temporary canonical repository with a fake provider and controlled clock. */
async function recoveryFixture() {
  const root = await mkdtemp(join(tmpdir(), "rkm-provider-recovery-"));
  roots.push(root);
  let timestamp = Date.parse(NOW);
  /** Returns the fixture's controlled current time. */
  function now(): Date {
    return new Date(timestamp);
  }
  /** Sets the fixture clock to the supplied epoch-millisecond timestamp. */
  function setTime(value: number): void {
    timestamp = value;
  }
  const config = RepoKnowledgeConfigSchema.parse({
    llm: {
      allowCloudTransmission: true,
      mode: "anthropic",
      model: "fake-model",
    },
  });
  const prompt = parseDistillationPrompt(`---
prompt_version: recovery-test-v1
---
Return structured output for synthetic reviews.
`);
  const resolution: RepositoryResolution = {
    absolutePath: root,
    aliases: [],
    currentName: "owner/repository",
    path: "repos/R_repository",
    repoId: REPOSITORY_ID,
    source: "tool-repo",
  };
  const ingester = new GitHubIngestService({
    outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    promptDigest: prompt.promptDigest,
    repositoryContext: {},
    repositoryResolver: {
      /** Resolves only the isolated synthetic repository used by this fixture. */
      async resolve() {
        return resolution;
      },
    },
    snapshotClient: {
      /** Supplies synthetic review data without contacting GitHub. */
      async fetchCompleteSnapshot() {
        return recoverySnapshot();
      },
    },
    trust: config.trust,
  });
  await ingester.ingest({ pr_number: 42, repo: resolution.currentName });
  const store = new CanonicalTransactionStore(root);
  const coordinator = new DistillJobCoordinator(store, { now });
  const completeStructured = vi.fn<LlmProviderAdapter["completeStructured"]>(
    async () => ({
      model: "fake-model",
      outputText: JSON.stringify({ candidates: [], skip_reason: "typo" }),
      provider: "anthropic",
    }),
  );
  const extractor = new ProviderDistillationService({
    adapter: { completeStructured, provider: "anthropic" },
    config,
    coordinatorOptions: { now },
    /** Discards expected fake-provider diagnostics without writing test noise. */
    diagnosticSink() {},
    prompt,
    repository: resolution,
  });
  const runner = new CanonicalProviderPostIngestRunner({
    config,
    pipeline: new ProviderDistillationPipeline({
      classifier: { classify: vi.fn() },
      extractor,
      finalizer: new CanonicalFinalizeService({
        now,
        repoId: REPOSITORY_ID,
        repository: store,
      }),
      now,
      search: { search: vi.fn() },
    }),
    promptDigest: prompt.promptDigest,
    repoId: REPOSITORY_ID,
    repository: store,
    repositoryContext: {},
  });
  const cli = new CanonicalCliRepositoryService({
    config,
    now,
    outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    promptDigest: prompt.promptDigest,
    promptVersion: prompt.promptVersion,
    providerRunner: runner,
    repo: resolution.currentName,
    repoId: REPOSITORY_ID,
    repository: store,
    repositoryContext: {},
  });
  return {
    cli,
    completeStructured,
    coordinator,
    jobId: (await store.readSnapshot()).domain.distillJobs[0]!.job_id,
    runner,
    setTime,
    store,
  };
}

/** Supplies a complete synthetic review snapshot without GitHub or credential access. */
function recoverySnapshot(): CompleteGitHubPullRequestSnapshot {
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: "PR_synthetic",
      mergedAt: null,
      number: 42,
      title: "Synthetic recovery fixture",
    },
    repository: { id: REPOSITORY_ID, nameWithOwner: "owner/repository" },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: NOW,
      pr_number: 42,
      repo_id: REPOSITORY_ID,
      review_summary_ids: [],
      snapshot_id: SNAPSHOT_ID,
      thread_ids: ["thread-1"],
    },
    threads: [
      {
        comments: [
          {
            author: {
              __typename: "User",
              id: "U_synthetic",
              login: "reviewer",
            },
            authorAssociation: "MEMBER",
            body: "Correct this synthetic typo.",
            diffHunk: "@@ -1 +1 @@",
            createdAt: NOW,
            id: "comment-synthetic",
            updatedAt: NOW,
            url: "https://github.com/owner/repository/pull/42#discussion_r1",
          },
        ],
        id: "thread-1",
        isOutdated: false,
        isResolved: false,
        path: "src/helper.ts",
      },
    ],
  };
}

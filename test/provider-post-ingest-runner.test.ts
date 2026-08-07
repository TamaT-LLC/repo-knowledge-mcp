import { describe, expect, it, vi } from "vitest";

import {
  CanonicalProviderPostIngestRunner,
  HostAssistedDistillationError,
  ProviderPostIngestError,
  RepoKnowledgeConfigSchema,
  type CanonicalProjectionSnapshot,
  type ProviderDistillationPipeline,
} from "../src/index.js";

const REPOSITORY_ID = "R_repository";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OBSOLETE_JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const HASH = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-06T00:00:00.000Z";

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

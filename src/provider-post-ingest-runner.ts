import { canonicalizeJson, compareCodeUnits } from "./canonical.js";
import { computeTrustPolicyDigest } from "./config.js";
import {
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type DistillJob,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import { DISTILLATION_OUTPUT_SCHEMA_DIGEST } from "./distillation-prompt.js";
import { computeDistillationInputDigest } from "./github-snapshot-normalizer.js";
import {
  resolveHostAssistedDistillationSource,
  type CurrentHostAssistedDistillationSource,
  type ResolveHostAssistedDistillationSourceInput,
} from "./host-assisted-distillation-service.js";
import type {
  ProviderPostIngestRequest,
  ProviderPostIngestResult,
  ProviderPostIngestRunner,
} from "./ingest-pr-mutation-service.js";
import type { ProviderDistillationPipeline } from "./provider-distillation-pipeline.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

export interface ProviderPostIngestRepository {
  readSnapshot(): Promise<CanonicalProjectionSnapshot>;
}

export interface CanonicalProviderPostIngestRunnerOptions {
  readonly config: RepoKnowledgeConfig;
  readonly pipeline: Pick<ProviderDistillationPipeline, "run">;
  readonly promptDigest: string;
  readonly repoId: string;
  readonly repository: ProviderPostIngestRepository;
  readonly repositoryContext: unknown;
  /** Test seam; production callers use canonical source reconstruction. */
  readonly sourceResolver?: typeof resolveHostAssistedDistillationSource;
}

export type ProviderPostIngestErrorCode =
  | "INGEST_REPOSITORY_MISMATCH"
  | "INGEST_SNAPSHOT_UNAVAILABLE";

export class ProviderPostIngestError extends Error {
  constructor(
    readonly code: ProviderPostIngestErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProviderPostIngestError";
  }
}

/** Drains current pending jobs for the ingested snapshot through the provider pipeline. */
export class CanonicalProviderPostIngestRunner
  implements ProviderPostIngestRunner
{
  private readonly pipeline: Pick<ProviderDistillationPipeline, "run">;
  private readonly repository: ProviderPostIngestRepository;
  private readonly repositoryContext: unknown;
  private readonly repoId: string;
  private readonly sourceInput: ResolveHostAssistedDistillationSourceInput;
  private readonly sourceResolver: typeof resolveHostAssistedDistillationSource;

  constructor(options: CanonicalProviderPostIngestRunnerOptions) {
    const config = RepoKnowledgeConfigSchema.parse(options.config);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.pipeline = options.pipeline;
    this.repository = options.repository;
    this.repositoryContext = JSON.parse(
      canonicalizeJson(options.repositoryContext),
    ) as unknown;
    this.sourceResolver =
      options.sourceResolver ?? resolveHostAssistedDistillationSource;
    this.sourceInput = {
      outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      promptDigest: Sha256DigestSchema.parse(options.promptDigest),
      repoId: this.repoId,
      repositoryContext: this.repositoryContext,
      trustPolicyDigest: computeTrustPolicyDigest(config.trust),
    };
  }

  async run(
    request: ProviderPostIngestRequest,
  ): Promise<ProviderPostIngestResult> {
    if (request.ingest.repo_id !== this.repoId) {
      throw new ProviderPostIngestError(
        "INGEST_REPOSITORY_MISMATCH",
        "the ingest result belongs to a different repository",
      );
    }
    const initial = await this.repository.readSnapshot();
    const sourceSnapshot = initial.domain.pullRequestSnapshots.find(
      (snapshot) =>
        snapshot.repo_id === this.repoId &&
        snapshot.snapshot_id === request.ingest.snapshot_id &&
        snapshot.pr_number === request.pr_number,
    );
    if (sourceSnapshot === undefined) {
      throw new ProviderPostIngestError(
        "INGEST_SNAPSHOT_UNAVAILABLE",
        `snapshot ${request.ingest.snapshot_id} is not canonical for pull request ${request.pr_number}`,
      );
    }
    const threadIds = new Set([
      ...sourceSnapshot.thread_ids,
      ...sourceSnapshot.review_summary_ids,
    ]);
    const relevant: Array<{
      readonly job: DistillJob;
      readonly source: CurrentHostAssistedDistillationSource;
    }> = [];
    for (const job of initial.domain.distillJobs
      .filter(
        (candidate) =>
          candidate.repo_id === this.repoId &&
          threadIds.has(candidate.thread_id) &&
          candidate.state !== "done" &&
          candidate.state !== "skipped",
      )
      .sort((left, right) => compareCodeUnits(left.job_id, right.job_id))) {
      try {
        relevant.push({
          job,
          source: this.sourceResolver(initial, job, this.sourceInput),
        });
      } catch (error) {
        if (isObsoleteContext(error)) continue;
        throw error;
      }
    }

    let distilled = 0;
    for (const { job, source } of relevant) {
      if (job.state !== "pending") continue;
      const result = await this.pipeline.run({
        job_id: job.job_id,
        repositoryContext: this.repositoryContext,
        thread: {
          contentFingerprint: source.contentFingerprint,
          distillationInputDigest: computeDistillationInputDigest({
            normalizedActors: source.normalizedActors,
            normalizedComments: source.normalizedComments,
            path: source.path,
            repositoryContext: this.repositoryContext,
            threadId: job.thread_id,
          }),
          distillationKey: source.distillationKey,
          normalizedActors: source.normalizedActors,
          normalizedComments: source.normalizedComments,
          path: source.path,
          threadId: job.thread_id,
        },
      });
      if (result.state === "finalized" || result.state === "skipped") {
        distilled += 1;
      }
    }

    const relevantIds = new Set(relevant.map(({ job }) => job.job_id));
    const current = await this.repository.readSnapshot();
    const pending = current.domain.distillJobs.filter(
      (job) =>
        relevantIds.has(job.job_id) &&
        job.state !== "done" &&
        job.state !== "skipped",
    ).length;
    return { distilled, pending };
  }
}

function isObsoleteContext(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "DISTILLATION_CONTEXT_CHANGED"
  );
}

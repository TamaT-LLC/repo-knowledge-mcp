import {
  RepoKnowledgeConfigSchema,
  RepositoryNameSchema,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import type {
  GitHubIngestService,
  IngestPullRequestResult,
} from "./github-ingest-service.js";
import { evaluateProviderTransmission } from "./provider-transmission.js";

export interface ProviderPostIngestRequest {
  readonly ingest: IngestPullRequestResult;
  readonly pr_number: number;
}

export interface ProviderPostIngestResult {
  readonly distilled: number;
  readonly pending: number;
}

export interface ProviderPostIngestRunner {
  run(request: ProviderPostIngestRequest): Promise<ProviderPostIngestResult>;
}

export interface IngestPrMutationServiceOptions {
  readonly config: RepoKnowledgeConfig;
  readonly ingester: Pick<GitHubIngestService, "ingest" | "resolveRepoId">;
  readonly providerRunner?: ProviderPostIngestRunner;
  readonly repo: string;
}

export type IngestPrMutationErrorCode =
  | "PROVIDER_PIPELINE_MISSING"
  | "PROVIDER_SUMMARY_INVALID";

export class IngestPrMutationError extends Error {
  constructor(
    readonly code: IngestPrMutationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "IngestPrMutationError";
  }
}

/** Ingests first, then runs provider work only behind its explicit policy opt-in. */
export class IngestPrMutationService {
  /** The repository this mutation service is bound to. */
  readonly repo: string;

  private readonly config: RepoKnowledgeConfig;
  private readonly ingester: Pick<
    GitHubIngestService,
    "ingest" | "resolveRepoId"
  >;
  private readonly providerRunner: ProviderPostIngestRunner | undefined;

  constructor(options: IngestPrMutationServiceOptions) {
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.ingester = options.ingester;
    this.providerRunner = options.providerRunner;
    this.repo = RepositoryNameSchema.parse(options.repo);
  }

  /**
   * Resolves this service's bound repository to its stable repo_id through
   * the ingest pipeline's own resolver, without performing any mutation.
   */
  async resolveBoundRepoId(): Promise<string> {
    return this.ingester.resolveRepoId(this.repo);
  }

  async ingestPullRequest(request: {
    readonly pr_number: number;
  }): Promise<IngestPullRequestResult> {
    const ingest = await this.ingester.ingest({
      pr_number: request.pr_number,
      repo: this.repo,
    });
    const transmission = evaluateProviderTransmission(this.config, this.repo);
    if (!transmission.allowed) return ingest;
    if (this.providerRunner === undefined) {
      throw new IngestPrMutationError(
        "PROVIDER_PIPELINE_MISSING",
        `provider mode ${transmission.mode} is enabled but no post-ingest runner is configured`,
      );
    }

    const provider = await this.providerRunner.run({
      ingest,
      pr_number: request.pr_number,
    });
    if (
      !Number.isSafeInteger(provider.distilled) ||
      provider.distilled < 0 ||
      !Number.isSafeInteger(provider.pending) ||
      provider.pending < 0
    ) {
      throw new IngestPrMutationError(
        "PROVIDER_SUMMARY_INVALID",
        "post-ingest provider summary must contain non-negative safe integer counts",
      );
    }
    return {
      ...ingest,
      distilled: provider.distilled,
      pending: provider.pending,
    };
  }
}

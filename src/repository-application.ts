import { canonicalizeJson } from "./canonical.js";
import { AnthropicProviderAdapter } from "./anthropic-provider.js";
import { CanonicalFinalizeService } from "./canonical-finalize-service.js";
import type { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import {
  CanonicalCliRepositoryService,
  type CliRepositoryOperationsFactory,
  type CliRepositoryOperationsFactoryContext,
} from "./cli-maintenance-service.js";
import type { CliRepositoryOperations } from "./cli.js";
import {
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  type DistillationPromptTemplate,
} from "./distillation-prompt.js";
import {
  RepoKnowledgeConfigSchema,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import {
  GitHubIngestService,
  type CompleteSnapshotFetcher,
} from "./github-ingest-service.js";
import { GitHubPullRequestSnapshotClient } from "./github-pull-request-client.js";
import { GitHubPullRequestEnumerator } from "./github-pull-request-enumerator.js";
import type { GhRunnerLike } from "./gh-runner.js";
import { HostAssistedDistillationService } from "./host-assisted-distillation-service.js";
import { IngestPrMutationService } from "./ingest-pr-mutation-service.js";
import type { LlmProviderAdapter } from "./llm-provider.js";
import { OpenAiProviderAdapter } from "./openai-provider.js";
import {
  type RepositoryMutationPipelineFactory,
  type RepositoryMutationPipelineFactoryContext,
  type RepositoryMutationPipelineOperations,
} from "./mcp-mutation-tools.js";
import { MergeCandidateSearchService } from "./merge-candidate-service.js";
import { ProviderMergeRelationClassifier } from "./merge-classifier.js";
import { ProviderDistillationPipeline } from "./provider-distillation-pipeline.js";
import { ProviderDistillationService } from "./provider-distillation-service.js";
import { CanonicalProviderPostIngestRunner } from "./provider-post-ingest-runner.js";
import type { RepositoryResolution } from "./repository-resolver.js";
import { RuntimeFinalizeContextStore } from "./runtime-finalize-context-store.js";
import { StatsReadService } from "./stats-read-service.js";
import { SubmitDistillationService } from "./submit-distillation-service.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { TrustedHumanAutoActivationPolicy } from "./trusted-human-auto-activation-policy.js";
import {
  SyncRepoService,
  type SyncPullRequestEnumerator,
} from "./sync-repo-service.js";
import { XaiProviderAdapter } from "./xai-provider.js";

export interface RepositoryApplicationOperations
  extends RepositoryMutationPipelineOperations,
    CliRepositoryOperations {}

export interface RepositoryApplicationFactoryOptions {
  readonly adapter?: LlmProviderAdapter;
  readonly config: RepoKnowledgeConfig;
  readonly enumerator?: SyncPullRequestEnumerator;
  readonly ghRunner?: GhRunnerLike;
  readonly prompt: DistillationPromptTemplate;
  readonly repositoryContext?: unknown;
  readonly snapshotClient?: CompleteSnapshotFetcher;
}

export type RepositoryApplicationErrorCode = "REPOSITORY_IDENTITY_CHANGED";

export class RepositoryApplicationError extends Error {
  constructor(
    readonly code: RepositoryApplicationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RepositoryApplicationError";
  }
}

interface CachedApplication {
  readonly absolutePath: string;
  readonly currentName: string;
  readonly operations: Promise<RepositoryApplicationOperations>;
}

/** Builds and shares one repo-bound application graph across MCP and CLI. */
export class DefaultRepositoryApplicationFactory
  implements RepositoryMutationPipelineFactory, CliRepositoryOperationsFactory
{
  private readonly adapter: LlmProviderAdapter;
  private readonly applications = new Map<string, CachedApplication>();
  private readonly config: RepoKnowledgeConfig;
  private readonly enumerator: SyncPullRequestEnumerator;
  private readonly prompt: DistillationPromptTemplate;
  private readonly repositoryContext: unknown;
  private readonly snapshotClient: CompleteSnapshotFetcher;

  constructor(options: RepositoryApplicationFactoryOptions) {
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.prompt = options.prompt;
    this.repositoryContext = JSON.parse(
      canonicalizeJson(options.repositoryContext ?? {}),
    ) as unknown;
    this.adapter =
      options.adapter ?? createConfiguredProviderAdapter(this.config);
    this.snapshotClient =
      options.snapshotClient ??
      new GitHubPullRequestSnapshotClient({
        ...(options.ghRunner === undefined
          ? {}
          : { ghRunner: options.ghRunner }),
      });
    this.enumerator =
      options.enumerator ??
      new GitHubPullRequestEnumerator({
        ...(options.ghRunner === undefined
          ? {}
          : { ghRunner: options.ghRunner }),
      });
  }

  async create(
    context:
      | RepositoryMutationPipelineFactoryContext
      | CliRepositoryOperationsFactoryContext,
  ): Promise<RepositoryApplicationOperations> {
    const repository = context.repository;
    const cached = this.applications.get(repository.repoId);
    if (cached !== undefined) {
      if (
        cached.absolutePath !== repository.absolutePath ||
        cached.currentName !== repository.currentName
      ) {
        throw new RepositoryApplicationError(
          "REPOSITORY_IDENTITY_CHANGED",
          `repository ${repository.repoId} changed identity during this process; restart before continuing`,
        );
      }
      return cached.operations;
    }

    const operations = this.createOperations(
      repository,
      context.repositoryStore,
    );
    this.applications.set(repository.repoId, {
      absolutePath: repository.absolutePath,
      currentName: repository.currentName,
      operations,
    });
    try {
      return await operations;
    } catch (error) {
      this.applications.delete(repository.repoId);
      throw error;
    }
  }

  private async createOperations(
    repository: RepositoryResolution,
    repositoryStore: CanonicalTransactionStore,
  ): Promise<RepositoryApplicationOperations> {
    const fixedRepositoryResolver = {
      async resolve() {
        return repository;
      },
    };
    const ingester = new GitHubIngestService({
      outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      promptDigest: this.prompt.promptDigest,
      repositoryContext: this.repositoryContext,
      repositoryResolver: fixedRepositoryResolver,
      snapshotClient: this.snapshotClient,
      storeFactory: () => repositoryStore,
      trust: this.config.trust,
    });
    const search = new MergeCandidateSearchService({
      repoId: repository.repoId,
      repository: repositoryStore,
    });
    const extractor = new ProviderDistillationService({
      adapter: this.adapter,
      config: this.config,
      prompt: this.prompt,
      repository,
    });
    const classifier = new ProviderMergeRelationClassifier({
      adapter: this.adapter,
      config: this.config,
      repository,
    });
    const autoActivationPolicy = new TrustedHumanAutoActivationPolicy({
      config: this.config,
    });
    const providerFinalizer = new CanonicalFinalizeService({
      autoActivationPolicy,
      repoId: repository.repoId,
      repository: repositoryStore,
    });
    const providerPipeline = new ProviderDistillationPipeline({
      classifier,
      extractor,
      finalizer: providerFinalizer,
      search,
    });
    const providerRunner = new CanonicalProviderPostIngestRunner({
      config: this.config,
      pipeline: providerPipeline,
      promptDigest: this.prompt.promptDigest,
      repoId: repository.repoId,
      repository: repositoryStore,
      repositoryContext: this.repositoryContext,
    });
    const ingest = new IngestPrMutationService({
      config: this.config,
      ingester,
      providerRunner,
      repo: repository.currentName,
    });
    // MCP sync_repo and CLI sync share this one checkpoint-resumed service,
    // so both surfaces produce the identical summary contract.
    const sync = new SyncRepoService({
      enumerator: this.enumerator,
      ingester: ingest,
      repo: repository.currentName,
      repositoryResolver: fixedRepositoryResolver,
    });
    const finalizeContexts = new RuntimeFinalizeContextStore();
    const host = new HostAssistedDistillationService({
      config: this.config,
      finalizeContexts,
      mergeCandidateSearch: search,
      promptDigest: this.prompt.promptDigest,
      repository,
      repositoryContext: this.repositoryContext,
    });
    const submit = new SubmitDistillationService({
      distillationContext: {
        config: this.config,
        outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
        outputSchemaVersion: DISTILLATION_OUTPUT_SCHEMA_VERSION,
        promptDigest: this.prompt.promptDigest,
        promptVersion: this.prompt.promptVersion,
        repositoryContext: this.repositoryContext,
      },
      finalizeContexts,
      repoId: repository.repoId,
      repository: repositoryStore,
    });
    // CLI stats reads through the same canonical projection and checkpoint
    // inputs as the MCP stats tool, so both surfaces return the identical
    // versioned aggregation for one canonical state.
    const statsReads = new StatsReadService({
      repo: repository.currentName,
      repoId: repository.repoId,
      repository: repositoryStore,
      syncCheckpoints: new SyncCheckpointStore(repository.absolutePath),
    });
    const cli = new CanonicalCliRepositoryService({
      config: this.config,
      outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      promptDigest: this.prompt.promptDigest,
      promptVersion: this.prompt.promptVersion,
      providerRunner,
      repo: repository.currentName,
      repoId: repository.repoId,
      repository: repositoryStore,
      repositoryContext: this.repositoryContext,
    });
    return combineOperations(cli, statsReads, {
      ingestPullRequest: (request) => ingest.ingestPullRequest(request),
      prepareDistillation: (request) => host.prepare(request),
      submitExtract: (request) => submit.submitExtract(request),
      submitFinalize: (request) => submit.submitFinalize(request),
      syncRepo: (request) => sync.sync(request),
    });
  }
}

function createConfiguredProviderAdapter(
  config: RepoKnowledgeConfig,
): LlmProviderAdapter {
  const options =
    config.llm.model === null ? {} : { defaultModel: config.llm.model };
  switch (config.llm.mode) {
    case "openai":
      return new OpenAiProviderAdapter(options);
    case "xai":
      return new XaiProviderAdapter(options);
    case "anthropic":
    case "disabled":
      return new AnthropicProviderAdapter(options);
  }
}

function combineOperations(
  cli: CanonicalCliRepositoryService,
  statsReads: StatsReadService,
  mutation: RepositoryMutationPipelineOperations,
): RepositoryApplicationOperations {
  return {
    admin: cli.admin,
    distill: () => cli.distill(),
    ingestPullRequest: (request) => mutation.ingestPullRequest(request),
    listKnowledge: (request) => cli.listKnowledge(request),
    prepareDistillation: (request) => mutation.prepareDistillation(request),
    reconcileDerivedMetadata: () => cli.reconcileDerivedMetadata(),
    redistill: (request) => cli.redistill(request),
    reindex: () => cli.reindex(),
    reviewInbox: (request) => cli.reviewInbox(request),
    stats: (request) => statsReads.getStats(request),
    submitExtract: (request) => mutation.submitExtract(request),
    submitFinalize: (request) => mutation.submitFinalize(request),
    syncRepo: (request) => mutation.syncRepo(request),
  };
}

import { type z } from "zod";

import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import type { IngestPullRequestResult } from "./github-ingest-service.js";
import type {
  PrepareDistillationRequest,
  PrepareDistillationResult,
} from "./host-assisted-distillation-service.js";
import type { SubmitFinalizedResultMcpSchema } from "./mcp-mutation-schemas.js";
import {
  ModelPlaneKnowledgeService,
  type ModelPlaneAddKnowledgeRequest,
  type ModelPlaneAddKnowledgeResult,
  type ModelPlaneUpdateKnowledgeRequest,
  type ModelPlaneUpdateKnowledgeResult,
} from "./model-plane-knowledge-service.js";
import {
  RecordOutcomeMutationService,
  type RecordOutcomeRequest,
  type RecordOutcomeResult,
} from "./record-outcome-mutation-service.js";
import {
  RepositoryResolver,
  type RepositoryResolution,
  type RepositoryResolutionInput,
  type RepositoryResolverOptions,
} from "./repository-resolver.js";
import type {
  SubmitExtractRequest,
  SubmitExtractResponse,
  SubmitFinalizeRequest,
} from "./submit-distillation-service.js";
import type { SyncRepoRequest, SyncRepoSummary } from "./sync-repo-service.js";

export interface IngestPrMutationRequest {
  readonly pr_number: number;
}

export interface KnowledgeMutationOperations {
  addKnowledge(
    request: ModelPlaneAddKnowledgeRequest,
  ): Promise<ModelPlaneAddKnowledgeResult>;
  /** Returns the final summary after any explicitly enabled provider pipeline. */
  ingestPullRequest(
    request: IngestPrMutationRequest,
  ): Promise<IngestPullRequestResult>;
  prepareDistillation(
    request?: PrepareDistillationRequest,
  ): Promise<PrepareDistillationResult>;
  /** Appends one idempotent outcome event; knowledge state is never mutated. */
  recordOutcome(request: RecordOutcomeRequest): Promise<RecordOutcomeResult>;
  submitExtract(request: SubmitExtractRequest): Promise<SubmitExtractResponse>;
  submitFinalize(
    request: SubmitFinalizeRequest,
  ): Promise<z.infer<typeof SubmitFinalizedResultMcpSchema>>;
  /** Incremental checkpoint-resumed sync through the same ingest pipeline. */
  syncRepo(request?: SyncRepoRequest): Promise<SyncRepoSummary>;
  updateKnowledge(
    request: ModelPlaneUpdateKnowledgeRequest,
  ): Promise<ModelPlaneUpdateKnowledgeResult>;
}

export interface KnowledgeMutationServiceResolutionInput
  extends RepositoryResolutionInput {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export interface KnowledgeMutationServiceResolver {
  resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<KnowledgeMutationOperations>;
}

export type RepositoryMutationPipelineOperations = Omit<
  KnowledgeMutationOperations,
  "addKnowledge" | "recordOutcome" | "updateKnowledge"
>;

export interface RepositoryMutationPipelineFactoryContext {
  readonly repository: RepositoryResolution;
  readonly repositoryStore: CanonicalTransactionStore;
}

export interface RepositoryMutationPipelineFactory {
  create(
    context: RepositoryMutationPipelineFactoryContext,
  ):
    | Promise<RepositoryMutationPipelineOperations>
    | RepositoryMutationPipelineOperations;
}

export type CanonicalKnowledgeMutationServiceResolverOptions = Omit<
  RepositoryResolverOptions,
  "startupRepo" | "startupWorkspace"
> & {
  readonly pipelineFactory: RepositoryMutationPipelineFactory;
};

/** Resolves and caches repo-bound mutation services, preserving finalize handles. */
export class CanonicalKnowledgeMutationServiceResolver
  implements KnowledgeMutationServiceResolver
{
  private readonly operations = new Map<
    string,
    Promise<KnowledgeMutationOperations>
  >();
  private readonly pipelineFactory: RepositoryMutationPipelineFactory;
  private readonly resolverOptions: Omit<
    RepositoryResolverOptions,
    "startupRepo" | "startupWorkspace"
  >;

  constructor(options: CanonicalKnowledgeMutationServiceResolverOptions) {
    const { pipelineFactory, ...resolverOptions } = options;
    this.pipelineFactory = pipelineFactory;
    this.resolverOptions = resolverOptions;
  }

  async resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<KnowledgeMutationOperations> {
    const resolver = new RepositoryResolver({
      ...this.resolverOptions,
      ...(input.startupRepo === undefined
        ? {}
        : { startupRepo: input.startupRepo }),
      ...(input.startupWorkspace === undefined
        ? {}
        : { startupWorkspace: input.startupWorkspace }),
    });
    const repository = await resolver.resolve({
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
    });
    const cached = this.operations.get(repository.repoId);
    if (cached !== undefined) return cached;

    const created = this.createOperations(repository);
    this.operations.set(repository.repoId, created);
    try {
      return await created;
    } catch (error) {
      this.operations.delete(repository.repoId);
      throw error;
    }
  }

  private async createOperations(
    repository: RepositoryResolution,
  ): Promise<KnowledgeMutationOperations> {
    const repositoryStore = new CanonicalTransactionStore(
      repository.absolutePath,
    );
    const pipeline = await this.pipelineFactory.create({
      repository,
      repositoryStore,
    });
    const knowledge = new ModelPlaneKnowledgeService({
      repo: repository.currentName,
      repoId: repository.repoId,
      repository: repositoryStore,
    });
    const outcomes = new RecordOutcomeMutationService({
      repo: repository.currentName,
      repoId: repository.repoId,
      repository: repositoryStore,
    });
    return {
      addKnowledge: (request) => knowledge.addKnowledge(request),
      ingestPullRequest: (request) => pipeline.ingestPullRequest(request),
      prepareDistillation: (request) => pipeline.prepareDistillation(request),
      recordOutcome: (request) => outcomes.recordOutcome(request),
      submitExtract: (request) => pipeline.submitExtract(request),
      submitFinalize: (request) => pipeline.submitFinalize(request),
      syncRepo: (request) => pipeline.syncRepo(request),
      updateKnowledge: (request) => knowledge.updateKnowledge(request),
    };
  }
}

interface MutationServiceResolutionOptions {
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export async function resolveMutationService(
  options: MutationServiceResolutionOptions,
  input: {
    readonly repo?: string | undefined;
    readonly workspace_path?: string | undefined;
  },
): Promise<KnowledgeMutationOperations> {
  return options.mutationServiceResolver.resolve({
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.workspace_path === undefined
      ? {}
      : { workspacePath: input.workspace_path }),
    ...(options.startupRepo === undefined
      ? {}
      : { startupRepo: options.startupRepo }),
    ...(options.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: options.startupWorkspace }),
  });
}

import { openStore, type GlobalStore } from "./global-store.js";
import {
  GLOBAL_STORE_ID,
  type AlwaysReturnResult,
} from "./global-always-return.js";
import { type z } from "zod";

import type { CanonicalTransactionStore } from "./canonical-transaction-store.js";
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
  RecordOutcomeError,
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
  setGlobalAlwaysReturn?(
    selection: KnowledgeMutationServiceResolutionInput,
    id: string,
    enabled: boolean,
  ): Promise<AlwaysReturnResult>;
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
  readonly globalStore?: GlobalStore;
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

  private readonly globalStore: GlobalStore | undefined;
  constructor(options: CanonicalKnowledgeMutationServiceResolverOptions) {
    this.globalStore = options.globalStore;
    const { pipelineFactory, ...resolverOptions } = options;
    this.pipelineFactory = pipelineFactory;
    this.resolverOptions = resolverOptions;
  }

  private resolveRepository(input: KnowledgeMutationServiceResolutionInput) {
    return new RepositoryResolver({
      ...this.resolverOptions,
      ...input,
    }).resolve(input);
  }

  async setGlobalAlwaysReturn(
    input: KnowledgeMutationServiceResolutionInput,
    id: string,
    enabled: boolean,
  ) {
    if (!this.globalStore) throw new Error("Global store unavailable");
    const repository = await this.resolveRepository(input);
    return this.globalStore.setAlwaysReturn(id, enabled, {
      actor: "mcp",
      caller_repo_id: repository.repoId,
    });
  }

  async resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<KnowledgeMutationOperations> {
    const repository = await this.resolveRepository(input);
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
    const repositoryStore = openStore({ kind: "repository", ...repository });
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
      recordOutcome: async (request) => {
        try {
          return await outcomes.recordOutcome(request);
        } catch (error) {
          if (
            !(
              error instanceof RecordOutcomeError &&
              error.code === "KNOWLEDGE_NOT_FOUND" &&
              this.globalStore &&
              // A broken global store keeps the original NOT_FOUND.
              (await this.globalStore.exists().catch(() => false))
            )
          )
            throw error;
          return new RecordOutcomeMutationService({
            repo: repository.currentName,
            repoId: GLOBAL_STORE_ID,
            callerRepoId: repository.repoId,
            repository: this.globalStore.store,
          }).recordOutcome(request);
        }
      },
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

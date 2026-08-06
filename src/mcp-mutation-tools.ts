import {
  type CallToolResult,
  type McpServer,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  CanonicalStoreError,
  CanonicalTransactionStore,
  KnowledgeConflictError,
} from "./canonical-transaction-store.js";
import { CanonicalFinalizeError } from "./canonical-finalize-service.js";
import {
  ActorKindSchema,
  CandidateIdSchema,
  DistillJobStateSchema,
  EvidenceIdSchema,
  GitHubNodeIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  MergeRelationSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  ScopePatternSchema,
  SeveritySchema,
  Sha256DigestSchema,
  SkipReasonSchema,
  SnapshotIdSchema,
  SourceProviderSchema,
  TrustLevelSchema,
} from "./domain-schemas.js";
import { DistillJobCoordinatorError } from "./distill-job-coordinator.js";
import type { IngestPullRequestResult } from "./github-ingest-service.js";
import { IngestPrMutationError } from "./ingest-pr-mutation-service.js";
import { ProviderPostIngestError } from "./provider-post-ingest-runner.js";
import {
  HostAssistedDistillationError,
  MAX_PREPARE_DISTILLATION_LIMIT,
  type PrepareDistillationRequest,
  type PrepareDistillationResult,
} from "./host-assisted-distillation-service.js";
import { MergeClassifierError } from "./merge-classifier.js";
import {
  ModelPlaneKnowledgeError,
  ModelPlaneKnowledgeService,
  type ModelPlaneAddKnowledgeRequest,
  type ModelPlaneAddKnowledgeResult,
  type ModelPlaneUpdateKnowledgeRequest,
  type ModelPlaneUpdateKnowledgeResult,
} from "./model-plane-knowledge-service.js";
import { RequestIntegrityError } from "./request-integrity.js";
import {
  RepositoryResolutionError,
  RepositoryResolver,
  type RepositoryResolution,
  type RepositoryResolutionInput,
  type RepositoryResolverOptions,
} from "./repository-resolver.js";
import { RuntimeFinalizeContextStoreError } from "./runtime-finalize-context-store.js";
import {
  SubmitDistillationError,
  type SubmitExtractRequest,
  type SubmitExtractResponse,
  type SubmitFinalizeRequest,
} from "./submit-distillation-service.js";

const RawSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 hex digest");
const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const RepositorySelectionShape = {
  repo: RepositoryNameSchema.optional(),
  workspace_path: NonEmptyStringSchema.optional(),
};

const DistilledCandidateMcpSchema = z
  .object({
    category: KnowledgeCategorySchema,
    confidence: z.number().min(0).max(1),
    detail: NonEmptyStringSchema,
    evidence_comment_ids: z.array(GitHubNodeIdSchema).min(1),
    rule: NonEmptyStringSchema,
    scope: z.array(ScopePatternSchema),
    severity: SeveritySchema,
  })
  .strict();

const ExtractCandidateMcpSchema = z
  .object({
    candidate: DistilledCandidateMcpSchema,
    candidate_id: CandidateIdSchema,
  })
  .strict();

const PossibleKnowledgeMatchMcpSchema = z
  .object({
    category: KnowledgeCategorySchema,
    detail: z.string(),
    etag: RawSha256Schema,
    knowledge_id: KnowledgeIdSchema,
    revision: PositiveSafeIntegerSchema,
    rule: z.string(),
    scope: z.array(z.string()),
    severity: SeveritySchema,
    status: z.enum(["active", "proposed", "stale"]),
  })
  .strict();

const PossibleMatchSetMcpSchema = z
  .object({
    candidate_id: CandidateIdSchema,
    possible_matches: z.array(PossibleKnowledgeMatchMcpSchema),
  })
  .strict();

const RuntimeFinalizeHandleMcpSchema = z
  .object({
    expires_at: IsoDateTimeSchema,
    finalize_token: NonEmptyStringSchema,
    lease_generation: PositiveSafeIntegerSchema,
  })
  .strict();

const MutationToolErrorPayloadSchema = z
  .object({
    code: NonEmptyStringSchema,
    details: z.looseObject({}).optional(),
    message: NonEmptyStringSchema,
    next_action: NonEmptyStringSchema.optional(),
    retryable: z.boolean(),
  })
  .strict();

export const MutationToolSummarySchema = z
  .object({
    counts: z.record(
      NonEmptyStringSchema,
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ),
    next_action: NonEmptyStringSchema.nullable(),
    retryable: z.boolean(),
  })
  .strict();

function mutationOutputSchema<T extends z.ZodType>(resultSchema: T) {
  return z
    .object({
      error: MutationToolErrorPayloadSchema.optional(),
      ok: z.boolean(),
      result: resultSchema.optional(),
      summary: MutationToolSummarySchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.ok &&
        (value.result === undefined || value.error !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "successful mutation output requires only result",
        });
      }
      if (
        !value.ok &&
        (value.error === undefined || value.result !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "failed mutation output requires only error",
        });
      }
    });
}

export const IngestPrInputSchema = z
  .object({
    ...RepositorySelectionShape,
    pr_number: PositiveSafeIntegerSchema,
  })
  .strict();

const UnknownBotWarningMcpSchema = z
  .object({
    actorId: NonEmptyStringSchema.nullable(),
    code: z.literal("UNKNOWN_BOT_RAW_ONLY"),
    commentIds: z.array(GitHubNodeIdSchema),
    configPath: z.literal("trust.aiReviewers"),
    login: NonEmptyStringSchema.nullable(),
    threadIds: z.array(NonEmptyStringSchema),
  })
  .strict();

export const IngestPrResultSchema = z
  .object({
    changed_threads: z.number().int().nonnegative(),
    distilled: z.number().int().nonnegative(),
    jobs_created: z.number().int().nonnegative(),
    new_threads: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    repo_id: RepositoryIdSchema,
    snapshot_id: SnapshotIdSchema,
    unchanged: z.number().int().nonnegative(),
    warnings: z.array(UnknownBotWarningMcpSchema),
  })
  .strict();

export const IngestPrOutputSchema = mutationOutputSchema(IngestPrResultSchema);

export const PrepareDistillationInputSchema = z
  .object({
    ...RepositorySelectionShape,
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_PREPARE_DISTILLATION_LIMIT)
      .optional(),
  })
  .strict();

const PreparedJobMetadataMcpSchema = z
  .object({
    available_at: IsoDateTimeSchema.optional(),
    job_id: JobIdSchema,
    lease_generation: z.number().int().nonnegative(),
    state: DistillJobStateSchema,
    thread_id: NonEmptyStringSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

const PreparedActorMcpSchema = z
  .object({
    actor_id: NonEmptyStringSchema.nullable(),
    actor_kind: ActorKindSchema,
    author_association: NonEmptyStringSchema.nullable(),
    login: NonEmptyStringSchema.nullable(),
    provider: SourceProviderSchema,
    trust: TrustLevelSchema,
  })
  .strict();

const PreparedCommentMcpSchema = z
  .object({
    actor: PreparedActorMcpSchema,
    body: z.string(),
    created_at: IsoDateTimeSchema,
    diff_hunk: z.string().optional(),
    id: GitHubNodeIdSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

const PreparedExtractJobMcpSchema = z
  .object({
    comments: z.array(PreparedCommentMcpSchema).min(1),
    expires_at: IsoDateTimeSchema,
    job_id: JobIdSchema,
    lease_generation: PositiveSafeIntegerSchema,
    lease_token: NonEmptyStringSchema,
    output_schema: z.looseObject({}),
    path: z.string().optional(),
    phase: z.literal("extract"),
    review_content_characters: z.number().int().nonnegative(),
    thread_fingerprint: Sha256DigestSchema,
  })
  .strict();

const PreparedFinalizeJobMcpSchema = z
  .object({
    candidate_set_sha256: RawSha256Schema,
    candidates: z.array(ExtractCandidateMcpSchema).min(1),
    expires_at: IsoDateTimeSchema,
    finalize_handle: RuntimeFinalizeHandleMcpSchema,
    job_id: JobIdSchema,
    lease_generation: PositiveSafeIntegerSchema,
    lease_token: NonEmptyStringSchema,
    match_set_digest: RawSha256Schema,
    phase: z.literal("finalize"),
    possible_matches: z.array(PossibleMatchSetMcpSchema),
    thread_fingerprint: Sha256DigestSchema,
  })
  .strict();

const PrepareBlockedJobMcpSchema = z
  .object({
    job: PreparedJobMetadataMcpSchema,
    max_characters_per_job: PositiveSafeIntegerSchema.optional(),
    reason: z.enum([
      "distillation_context_changed",
      "extract_receipt_unavailable",
      "lease_expired_during_prepare",
      "max_characters_exceeded",
      "source_unavailable",
    ]),
    review_content_characters: z.number().int().nonnegative().optional(),
  })
  .strict();

const PrepareDisabledResultMcpSchema = z
  .object({
    instructions: z.array(NonEmptyStringSchema),
    jobs: z.array(PreparedJobMetadataMcpSchema),
    missing_settings: z.array(
      z.enum([
        "hostAssistedDistillation.allowReviewContentTransmission",
        "hostAssistedDistillation.enabled",
      ]),
    ),
    required_settings: z
      .object({
        "hostAssistedDistillation.allowReviewContentTransmission":
          z.literal(true),
        "hostAssistedDistillation.enabled": z.literal(true),
      })
      .strict(),
    state: z.literal("disabled"),
  })
  .strict();

const PrepareReadyResultMcpSchema = z
  .object({
    blocked_jobs: z.array(PrepareBlockedJobMcpSchema),
    jobs: z.array(
      z.discriminatedUnion("phase", [
        PreparedExtractJobMcpSchema,
        PreparedFinalizeJobMcpSchema,
      ]),
    ),
    state: z.literal("prepared"),
  })
  .strict();

export const PrepareDistillationResultSchema = z.discriminatedUnion("state", [
  PrepareDisabledResultMcpSchema,
  PrepareReadyResultMcpSchema,
]);

export const PrepareDistillationOutputSchema = mutationOutputSchema(
  PrepareDistillationResultSchema,
);

const SubmitExtractInputSchema = z
  .object({
    ...RepositorySelectionShape,
    candidates: z.array(DistilledCandidateMcpSchema),
    job_id: JobIdSchema,
    lease_generation: PositiveSafeIntegerSchema,
    lease_token: NonEmptyStringSchema,
    phase: z.literal("extract"),
    request_schema_version: z.literal(1),
    skip_reason: SkipReasonSchema.nullable(),
    submission_id: NonEmptyStringSchema,
    thread_fingerprint: Sha256DigestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.candidates.length === 0 && value.skip_reason === null) {
      context.addIssue({
        code: "custom",
        message: "zero candidates require skip_reason",
        path: ["skip_reason"],
      });
    }
    if (value.candidates.length > 0 && value.skip_reason !== null) {
      context.addIssue({
        code: "custom",
        message: "candidate output must not include skip_reason",
        path: ["skip_reason"],
      });
    }
  });

const MergeDecisionMcpSchema = z
  .object({
    candidate_id: CandidateIdSchema,
    relation: MergeRelationSchema,
    target_id: KnowledgeIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.relation === "different" && value.target_id !== undefined) {
      context.addIssue({
        code: "custom",
        message: "different decisions must not include target_id",
        path: ["target_id"],
      });
    }
    if (value.relation !== "different" && value.target_id === undefined) {
      context.addIssue({
        code: "custom",
        message: `${value.relation} decisions require target_id`,
        path: ["target_id"],
      });
    }
  });

const SubmitFinalizeInputSchema = z
  .object({
    ...RepositorySelectionShape,
    candidate_set_sha256: RawSha256Schema,
    decisions: z.array(MergeDecisionMcpSchema).min(1),
    finalize_token: NonEmptyStringSchema,
    job_id: JobIdSchema,
    lease_generation: PositiveSafeIntegerSchema,
    lease_token: NonEmptyStringSchema,
    phase: z.literal("finalize"),
    request_schema_version: z.literal(1),
    submission_id: NonEmptyStringSchema,
  })
  .strict();

export const SubmitDistillationInputSchema = z.discriminatedUnion("phase", [
  SubmitExtractInputSchema,
  SubmitFinalizeInputSchema,
]);

const SubmitSkippedResultMcpSchema = z
  .object({
    skip_reason: SkipReasonSchema,
    staled_knowledge_ids: z.array(KnowledgeIdSchema),
    state: z.literal("skipped"),
    withdrawn_evidence_ids: z.array(EvidenceIdSchema),
  })
  .strict();

const SubmitMergeResultMcpSchema = z
  .object({
    candidate_set_sha256: RawSha256Schema,
    candidates: z.array(ExtractCandidateMcpSchema).min(1),
    finalize_handle: RuntimeFinalizeHandleMcpSchema,
    match_set_digest: RawSha256Schema,
    possible_matches: z.array(PossibleMatchSetMcpSchema),
    state: z.literal("merge_decision_required"),
  })
  .strict();

const SubmitFinalizedResultMcpSchema = z
  .object({
    accepted: z.boolean(),
    created_proposed: z.array(KnowledgeIdSchema),
    merged_evidence: z.array(EvidenceIdSchema),
    rejected_reason: NonEmptyStringSchema.optional(),
    revision_proposals: z.array(NonEmptyStringSchema),
  })
  .strict();

export const SubmitDistillationResultSchema = z.union([
  SubmitSkippedResultMcpSchema,
  SubmitMergeResultMcpSchema,
  SubmitFinalizedResultMcpSchema,
]);

export const SubmitDistillationOutputSchema = mutationOutputSchema(
  SubmitDistillationResultSchema,
);

export const AddKnowledgeInputSchema = z
  .object({
    ...RepositorySelectionShape,
    category: KnowledgeCategorySchema,
    detail: NonEmptyStringSchema,
    related_ids: z.array(KnowledgeIdSchema).optional(),
    rule: NonEmptyStringSchema,
    scope: z.array(ScopePatternSchema),
    severity: SeveritySchema,
  })
  .strict();

export const AddKnowledgeResultSchema = z
  .object({
    etag: RawSha256Schema,
    id: KnowledgeIdSchema,
    origin: z.literal("manual"),
    repo: RepositoryNameSchema,
    revision: PositiveSafeIntegerSchema,
    status: z.literal("proposed"),
  })
  .strict();

export const AddKnowledgeOutputSchema = mutationOutputSchema(
  AddKnowledgeResultSchema,
);

const ModelPlanePatchMcpSchema = z
  .object({
    category: KnowledgeCategorySchema.optional(),
    detail: NonEmptyStringSchema.optional(),
    rule: NonEmptyStringSchema.optional(),
    scope: z.array(ScopePatternSchema).optional(),
    severity: SeveritySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "patch must not be empty",
  });

export const UpdateKnowledgeInputSchema = z
  .object({
    ...RepositorySelectionShape,
    expected_etag: RawSha256Schema,
    expected_revision: PositiveSafeIntegerSchema,
    id: KnowledgeIdSchema,
    patch: ModelPlanePatchMcpSchema,
  })
  .strict();

export const UpdateKnowledgeResultSchema = z
  .object({
    current_etag: RawSha256Schema,
    current_revision: PositiveSafeIntegerSchema,
    knowledge_id: KnowledgeIdSchema,
    proposal_id: NonEmptyStringSchema,
    repo: RepositoryNameSchema,
    status: z.literal("pending"),
  })
  .strict();

export const UpdateKnowledgeOutputSchema = mutationOutputSchema(
  UpdateKnowledgeResultSchema,
);

export const MUTATION_TOOL_ANNOTATIONS = Object.freeze({
  add_knowledge: Object.freeze({
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  }),
  ingest_pr: Object.freeze({
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  }),
  prepare_distillation: Object.freeze({
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  }),
  submit_distillation: Object.freeze({
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  }),
  update_knowledge: Object.freeze({
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  }),
}) satisfies Readonly<Record<string, ToolAnnotations>>;

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
  submitExtract(request: SubmitExtractRequest): Promise<SubmitExtractResponse>;
  submitFinalize(
    request: SubmitFinalizeRequest,
  ): Promise<z.infer<typeof SubmitFinalizedResultMcpSchema>>;
  updateKnowledge(
    request: ModelPlaneUpdateKnowledgeRequest,
  ): Promise<ModelPlaneUpdateKnowledgeResult>;
}

export interface KnowledgeMutationServiceResolutionInput extends RepositoryResolutionInput {
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
  "addKnowledge" | "updateKnowledge"
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
export class CanonicalKnowledgeMutationServiceResolver implements KnowledgeMutationServiceResolver {
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
    return {
      addKnowledge: (request) => knowledge.addKnowledge(request),
      ingestPullRequest: (request) => pipeline.ingestPullRequest(request),
      prepareDistillation: (request) => pipeline.prepareDistillation(request),
      submitExtract: (request) => pipeline.submitExtract(request),
      submitFinalize: (request) => pipeline.submitFinalize(request),
      updateKnowledge: (request) => knowledge.updateKnowledge(request),
    };
  }
}

export interface RegisterMutationToolsOptions {
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

/** Registers model-plane tools; all authorization remains in application services. */
export function registerMutationTools(
  server: McpServer,
  options: RegisterMutationToolsOptions,
): void {
  server.registerTool(
    "ingest_pr",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.ingest_pr,
      description:
        "Ingest a complete GitHub pull-request review snapshot and run only explicitly enabled provider distillation.",
      inputSchema: IngestPrInputSchema,
      outputSchema: IngestPrOutputSchema,
      title: "Ingest pull request",
    },
    async (input) => {
      return executeMutation(
        IngestPrResultSchema,
        async () =>
          (await resolveMutationService(options, input)).ingestPullRequest({
            pr_number: input.pr_number,
          }),
        summarizeIngest,
      );
    },
  );

  server.registerTool(
    "prepare_distillation",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.prepare_distillation,
      description:
        "Lease host-assisted distillation work. Review content is returned only after both host-assisted opt-ins are enabled.",
      inputSchema: PrepareDistillationInputSchema,
      outputSchema: PrepareDistillationOutputSchema,
      title: "Prepare host-assisted distillation",
    },
    async (input) => {
      return executeMutation(
        PrepareDistillationResultSchema,
        async () =>
          (await resolveMutationService(options, input)).prepareDistillation({
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        summarizePrepare,
      );
    },
  );

  server.registerTool(
    "submit_distillation",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.submit_distillation,
      description:
        "Submit idempotent extract or finalize results for a leased host-assisted job.",
      inputSchema: SubmitDistillationInputSchema,
      outputSchema: SubmitDistillationOutputSchema,
      title: "Submit host-assisted distillation",
    },
    async (input) => {
      return executeMutation(
        SubmitDistillationResultSchema,
        async () => {
          const service = await resolveMutationService(options, input);
          return input.phase === "extract"
            ? service.submitExtract(input)
            : service.submitFinalize(input);
        },
        summarizeSubmit,
      );
    },
  );

  server.registerTool(
    "add_knowledge",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.add_knowledge,
      description:
        "Create manual repository knowledge in proposed state. This tool cannot activate knowledge.",
      inputSchema: AddKnowledgeInputSchema,
      outputSchema: AddKnowledgeOutputSchema,
      title: "Propose repository knowledge",
    },
    async (input) => {
      return executeMutation(
        AddKnowledgeResultSchema,
        async () =>
          (await resolveMutationService(options, input)).addKnowledge({
            category: input.category,
            detail: input.detail,
            ...(input.related_ids === undefined
              ? {}
              : { related_ids: input.related_ids }),
            rule: input.rule,
            scope: input.scope,
            severity: input.severity,
          }),
        summarizeAdd,
      );
    },
  );

  server.registerTool(
    "update_knowledge",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.update_knowledge,
      description:
        "Create a pending edit proposal using revision and exact-byte ETag CAS. This tool never edits or approves canonical knowledge directly.",
      inputSchema: UpdateKnowledgeInputSchema,
      outputSchema: UpdateKnowledgeOutputSchema,
      title: "Propose a knowledge edit",
    },
    async (input) => {
      return executeMutation(
        UpdateKnowledgeResultSchema,
        async () =>
          (await resolveMutationService(options, input)).updateKnowledge({
            expected_etag: input.expected_etag,
            expected_revision: input.expected_revision,
            id: input.id,
            patch: input.patch,
          }),
        summarizeUpdate,
      );
    },
  );
}

async function resolveMutationService(
  options: RegisterMutationToolsOptions,
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

async function executeMutation<T extends z.ZodType>(
  schema: T,
  operation: () => Promise<unknown>,
  summarize: (result: z.output<T>) => MutationToolPresentation,
): Promise<CallToolResult> {
  try {
    const result = schema.parse(await operation());
    const presentation = summarize(result);
    const summary = MutationToolSummarySchema.parse(presentation.summary);
    return {
      content: [
        {
          type: "text",
          text: renderMutationContent(presentation.body, summary),
        },
      ],
      structuredContent: { ok: true, result, summary },
    };
  } catch (error) {
    const mapped = mapMutationError(error);
    const summary = MutationToolSummarySchema.parse({
      counts: { failed_operations: 1 },
      next_action: mapped.next_action ?? null,
      retryable: mapped.retryable,
    });
    return {
      content: [
        {
          type: "text",
          text: renderMutationContent(
            `### ${mapped.code}\n\n${mapped.message}`,
            summary,
          ),
        },
      ],
      isError: true,
      structuredContent: { error: mapped, ok: false, summary },
    };
  }
}

interface MutationToolPresentation {
  readonly body: string;
  readonly summary: z.input<typeof MutationToolSummarySchema>;
}

export interface MutationToolErrorPayload {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly message: string;
  readonly next_action?: string;
  readonly retryable: boolean;
}

export function mapMutationError(error: unknown): MutationToolErrorPayload {
  if (error instanceof KnowledgeConflictError) {
    return {
      code: "KNOWLEDGE_CONFLICT",
      details: {
        current: {
          body: error.current.body,
          etag: error.current.etag,
          frontmatter: error.current.frontmatter,
          path: error.current.path,
          revision: error.current.revision,
        },
        current_etag: error.current.etag,
        current_revision: error.current.revision,
      },
      message: error.message,
      next_action:
        "Call get_knowledge, review the current generation, then submit a new proposal with both current CAS values.",
      retryable: true,
    };
  }

  if (error instanceof RepositoryResolutionError) {
    const details = {
      ...(error.candidates.length === 0
        ? {}
        : { candidates: error.candidates }),
      ...(error.diagnostics.length === 0
        ? {}
        : { diagnostics: error.diagnostics }),
      ...(error.guidance.length === 0 ? {} : { guidance: error.guidance }),
    };
    return {
      code: error.code,
      ...(Object.keys(details).length === 0 ? {} : { details }),
      message: error.message,
      next_action:
        error.guidance.length > 0
          ? error.guidance.join(" ")
          : "Pass an unambiguous repo or an allowed workspace_path and retry.",
      retryable: false,
    };
  }

  if (error instanceof SubmitDistillationError) {
    if (error.code === "MERGE_CANDIDATES_CHANGED") {
      return {
        code: error.code,
        ...(error.retry === undefined
          ? {}
          : { details: { retry: error.retry } }),
        message: error.message,
        next_action:
          "Reclassify the returned current matches and retry finalize with the fresh handle.",
        retryable: true,
      };
    }
    if (
      error.code === "UNKNOWN_FINALIZE_TOKEN" ||
      error.code === "RESUME_REQUIRED"
    ) {
      return {
        code: error.code,
        message: error.message,
        next_action:
          "Call prepare_distillation again to acquire a fresh lease and finalize handle.",
        retryable: true,
      };
    }
    if (
      error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_CHANGED"
    ) {
      return {
        code: error.code,
        message: error.message,
        next_action:
          "Re-ingest the pull request if needed, then call prepare_distillation again.",
        retryable: true,
      };
    }
    return knownError(error, false);
  }

  if (error instanceof DistillJobCoordinatorError) {
    const retryable =
      error.code === "STALE_LEASE" || error.code === "INVALID_LEASE_TOKEN";
    return {
      ...knownError(error, retryable),
      ...(retryable
        ? {
            next_action:
              "Call prepare_distillation again to acquire the current fenced lease.",
          }
        : {}),
    };
  }

  if (
    error instanceof HostAssistedDistillationError ||
    error instanceof CanonicalFinalizeError
  ) {
    if (
      error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_UNAVAILABLE"
    ) {
      return {
        ...knownError(error, true),
        next_action:
          "Re-ingest the pull request if needed, then call prepare_distillation again.",
      };
    }
    if (error.code === "LEASE_EXPIRED_DURING_PREPARE") {
      return {
        ...knownError(error, true),
        next_action:
          "Call prepare_distillation again to acquire a fresh fenced lease.",
      };
    }
    if (
      error instanceof CanonicalFinalizeError &&
      error.code === "MERGE_CANDIDATES_CHANGED"
    ) {
      return {
        ...knownError(error, true),
        ...(error.currentSearch === undefined
          ? {}
          : { details: { current_search: error.currentSearch } }),
        next_action:
          "Reclassify the current matches, then retry finalize with a fresh handle.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof RequestIntegrityError) {
    if (error.code === "IDEMPOTENCY_KEY_REUSED") {
      return {
        ...knownError(error, false),
        next_action:
          "Keep the original request for this submission_id, or use a new submission_id for a different logical submission.",
      };
    }
    return {
      ...knownError(error, true),
      next_action:
        "Call prepare_distillation again and retry with the newly bound lease and handle.",
    };
  }

  if (error instanceof RuntimeFinalizeContextStoreError) {
    if (error.code === "FINALIZE_CONTEXT_EXPIRED") {
      return {
        ...knownError(error, true),
        next_action:
          "Call prepare_distillation again to acquire a fresh finalize handle.",
      };
    }
    return knownError(error, false);
  }

  if (error instanceof CanonicalStoreError) {
    const retryable = error.code === "CONFLICT";
    return {
      ...knownError(error, retryable),
      ...(error.transactionId === undefined
        ? {}
        : { details: { transaction_id: error.transactionId } }),
      ...(retryable
        ? {
            next_action:
              "Read the current canonical state, then retry from the new generation.",
          }
        : {}),
    };
  }

  if (
    error instanceof MergeClassifierError ||
    error instanceof IngestPrMutationError ||
    error instanceof ProviderPostIngestError ||
    error instanceof ModelPlaneKnowledgeError
  ) {
    return knownError(error, false);
  }

  if (isCodedError(error)) return knownError(error, false);

  return {
    code: "MUTATION_FAILED",
    message: error instanceof Error ? error.message : "Mutation failed",
    retryable: false,
  };
}

function knownError(
  error: Error & { readonly code: string },
  retryable: boolean,
): MutationToolErrorPayload {
  return { code: error.code, message: error.message, retryable };
}

function isCodedError(
  error: unknown,
): error is Error & { readonly code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  );
}

function summarizeIngest(
  result: z.infer<typeof IngestPrResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Pull request ingested\n\nCreated **${result.jobs_created}** job(s); **${result.distilled}** distilled and **${result.pending}** pending.`,
    summary: {
      counts: {
        changed_threads: result.changed_threads,
        distilled: result.distilled,
        jobs_created: result.jobs_created,
        new_threads: result.new_threads,
        pending: result.pending,
        unchanged: result.unchanged,
        warnings: result.warnings.length,
      },
      next_action:
        result.pending > 0
          ? "If host-assisted distillation is explicitly enabled, call prepare_distillation; otherwise leave the jobs pending."
          : "Review any proposed knowledge through the admin CLI.",
      retryable: true,
    },
  };
}

function summarizePrepare(
  result: z.infer<typeof PrepareDistillationResultSchema>,
): MutationToolPresentation {
  if (result.state === "disabled") {
    return {
      body: `### Host-assisted distillation disabled\n\nFound **${result.jobs.length}** pending job(s). Review content was not returned because explicit opt-in is incomplete.`,
      summary: {
        counts: {
          missing_settings: result.missing_settings.length,
          pending_jobs: result.jobs.length,
          review_content_items: 0,
        },
        next_action:
          "Enable both host-assisted settings, then call prepare_distillation again.",
        retryable: true,
      },
    };
  }
  return {
    body: `### Distillation prepared\n\nLeased **${result.jobs.length}** job(s); **${result.blocked_jobs.length}** blocked.`,
    summary: {
      counts: {
        blocked_jobs: result.blocked_jobs.length,
        leased_jobs: result.jobs.length,
      },
      next_action:
        result.jobs.length > 0
          ? "Distill each leased job and call submit_distillation with phase extract."
          : "No submission is required; ingest changed review content before preparing again.",
      retryable: false,
    },
  };
}

function summarizeSubmit(
  result: z.infer<typeof SubmitDistillationResultSchema>,
): MutationToolPresentation {
  if ("state" in result && result.state === "skipped") {
    return {
      body: `### Distillation skipped\n\nRecorded skip reason \`${result.skip_reason}\`; no finalize call is required.`,
      summary: {
        counts: {
          staled_knowledge: result.staled_knowledge_ids.length,
          withdrawn_evidence: result.withdrawn_evidence_ids.length,
        },
        next_action: "No finalize call is required.",
        retryable: true,
      },
    };
  }
  if ("state" in result && result.state === "merge_decision_required") {
    return {
      body: `### Merge decisions required\n\nClassify **${result.candidates.length}** candidate(s), then submit the finalize phase.`,
      summary: {
        counts: {
          candidates: result.candidates.length,
          possible_matches: result.possible_matches.reduce(
            (count, matches) => count + matches.possible_matches.length,
            0,
          ),
        },
        next_action:
          "Classify every candidate, then call submit_distillation with phase finalize and the returned handle.",
        retryable: true,
      },
    };
  }
  return {
    body: `### Distillation finalized\n\nCreated **${result.created_proposed.length}** proposed rule(s), merged **${result.merged_evidence.length}** evidence item(s), and created **${result.revision_proposals.length}** revision proposal(s).`,
    summary: {
      counts: {
        created_proposed: result.created_proposed.length,
        merged_evidence: result.merged_evidence.length,
        revision_proposals: result.revision_proposals.length,
      },
      next_action:
        "Review proposed knowledge and revision proposals through the admin CLI.",
      retryable: true,
    },
  };
}

function summarizeAdd(
  result: z.infer<typeof AddKnowledgeResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Knowledge proposed\n\nCreated \`${result.id}\` in **proposed** state. A human must approve it in the admin CLI before it becomes active.`,
    summary: {
      counts: { created_proposed: 1 },
      next_action: "Review and approve the proposal through the admin CLI.",
      retryable: false,
    },
  };
}

function summarizeUpdate(
  result: z.infer<typeof UpdateKnowledgeResultSchema>,
): MutationToolPresentation {
  return {
    body: `### Edit proposed\n\nCreated pending revision proposal \`${result.proposal_id}\` for \`${result.knowledge_id}\`. Canonical knowledge was not modified.`,
    summary: {
      counts: { revision_proposals: 1 },
      next_action:
        "Review and approve the revision proposal through the admin CLI.",
      retryable: false,
    },
  };
}

function renderMutationContent(
  body: string,
  summary: z.output<typeof MutationToolSummarySchema>,
): string {
  const counts = Object.entries(summary.counts)
    .map(([name, value]) => `\`${name}\`: **${value}**`)
    .join(", ");
  return `${body}\n\nCounts: ${counts.length === 0 ? "none" : counts}.\n\nNext: ${summary.next_action ?? "No further action is required."}\n\nRetryable: **${summary.retryable ? "yes" : "no"}**.`;
}

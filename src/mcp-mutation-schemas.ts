import { type ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  ActorKindSchema,
  CandidateIdSchema,
  DistillJobStateSchema,
  EventIdSchema,
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
import { MAX_PREPARE_DISTILLATION_LIMIT } from "./host-assisted-distillation-service.js";
import {
  OutcomeKindSchema,
  RecordOutcomeRequestSchema,
} from "./record-outcome-mutation-service.js";
import { SensitiveContentFindingsSchema } from "./sensitive-content.js";
import { SyncCursorSchema } from "./sync-cursor.js";
import { MAX_SYNC_PULL_REQUESTS_PER_RUN } from "./sync-repo-service.js";
import { addCustomIssue } from "./zod-issues.js";
import { compileWhenHot } from "./zod-compile-when-hot.js";

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

const DistilledCandidateMcpSchema = z.strictObject({
  category: KnowledgeCategorySchema,
  confidence: z.number().min(0).max(1),
  detail: NonEmptyStringSchema,
  evidence_comment_ids: z.array(GitHubNodeIdSchema).min(1),
  rule: NonEmptyStringSchema,
  scope: z.array(ScopePatternSchema),
  severity: SeveritySchema,
});

const ExtractCandidateMcpSchema = z.strictObject({
  candidate: DistilledCandidateMcpSchema,
  candidate_id: CandidateIdSchema,
});

const PossibleKnowledgeMatchMcpSchema = z.strictObject({
  category: KnowledgeCategorySchema,
  detail: z.string(),
  etag: RawSha256Schema,
  knowledge_id: KnowledgeIdSchema,
  revision: PositiveSafeIntegerSchema,
  rule: z.string(),
  scope: z.array(z.string()),
  severity: SeveritySchema,
  status: z.enum(["active", "proposed", "stale"]),
});

const PossibleMatchSetMcpSchema = z.strictObject({
  candidate_id: CandidateIdSchema,
  possible_matches: z.array(PossibleKnowledgeMatchMcpSchema),
});

const RuntimeFinalizeHandleMcpSchema = z.strictObject({
  expires_at: IsoDateTimeSchema,
  finalize_token: NonEmptyStringSchema,
  lease_generation: PositiveSafeIntegerSchema,
});

const MutationToolErrorPayloadSchema = z.strictObject({
  code: NonEmptyStringSchema,
  details: z.looseObject({}).optional(),
  message: NonEmptyStringSchema,
  next_action: NonEmptyStringSchema.optional(),
  retryable: z.boolean(),
});

export const MutationToolSummarySchema = compileWhenHot(
  z.strictObject({
    counts: z.record(
      NonEmptyStringSchema,
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ),
    next_action: NonEmptyStringSchema.nullable(),
    retryable: z.boolean(),
  }),
);

/** A mutation tool's output schema; every one is passed to the MCP SDK. */
function mutationOutputSchema<T extends z.ZodType>(resultSchema: T) {
  const schema = z
    .strictObject({
      error: MutationToolErrorPayloadSchema.optional(),
      ok: z.boolean(),
      result: resultSchema.optional(),
      summary: MutationToolSummarySchema,
    })
    .check((context) => {
      const value = context.value;
      if (
        value.ok &&
        (value.result === undefined || value.error !== undefined)
      ) {
        addCustomIssue(context, {
          message: "successful mutation output requires only result",
        });
      }
      if (
        !value.ok &&
        (value.error === undefined || value.result !== undefined)
      ) {
        addCustomIssue(context, {
          message: "failed mutation output requires only error",
        });
      }
    });
  return compileWhenHot(schema);
}

export const IngestPrInputSchema = compileWhenHot(
  z.strictObject({
    ...RepositorySelectionShape,
    pr_number: PositiveSafeIntegerSchema,
  }),
);

const UnknownBotWarningMcpSchema = z.strictObject({
  actorId: NonEmptyStringSchema.nullable(),
  code: z.literal("UNKNOWN_BOT_RAW_ONLY"),
  commentIds: z.array(GitHubNodeIdSchema),
  configPath: z.literal("trust.aiReviewers"),
  login: NonEmptyStringSchema.nullable(),
  threadIds: z.array(NonEmptyStringSchema),
});

export const IngestPrResultSchema = compileWhenHot(
  z.strictObject({
    changed_threads: z.number().int().nonnegative(),
    distilled: z.number().int().nonnegative(),
    jobs_created: z.number().int().nonnegative(),
    new_threads: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    repo_id: RepositoryIdSchema,
    snapshot_id: SnapshotIdSchema,
    unchanged: z.number().int().nonnegative(),
    warnings: z.array(UnknownBotWarningMcpSchema),
  }),
);

export const IngestPrOutputSchema = mutationOutputSchema(IngestPrResultSchema);

export const SyncRepoInputSchema = compileWhenHot(
  z.strictObject({
    ...RepositorySelectionShape,
    max_pull_requests: z
      .number()
      .int()
      .positive()
      .max(MAX_SYNC_PULL_REQUESTS_PER_RUN)
      .optional()
      .meta({
        description:
          "Process at most this many pull requests in this run, oldest first. The checkpoint advances past each one, so call sync_repo again while has_more is true to converge on a large backlog.",
      }),
    since: IsoDateTimeSchema.optional().meta({
      description:
        "Initial ISO-8601 boundary; only pull requests updated strictly after it are synced. With a stored checkpoint it must be strictly older than the checkpoint boundary.",
    }),
  }),
);

const SyncPullRequestFailureMcpSchema = z.strictObject({
  message: z.string(),
  pr_number: PositiveSafeIntegerSchema,
});

export const SyncRepoResultSchema = compileWhenHot(
  z.strictObject({
    deferred: z.number().int().nonnegative(),
    discovered: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failures: z.array(SyncPullRequestFailureMcpSchema),
    has_more: z.boolean(),
    ingested: z.number().int().nonnegative(),
    jobs_created: z.number().int().nonnegative(),
    next_cursor: SyncCursorSchema.nullable(),
    unchanged: z.number().int().nonnegative(),
  }),
);

export const SyncRepoOutputSchema = mutationOutputSchema(SyncRepoResultSchema);

export const PrepareDistillationInputSchema = compileWhenHot(
  z.strictObject({
    ...RepositorySelectionShape,
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_PREPARE_DISTILLATION_LIMIT)
      .optional(),
  }),
);

const PreparedJobMetadataMcpSchema = z.strictObject({
  available_at: IsoDateTimeSchema.optional(),
  job_id: JobIdSchema,
  lease_generation: z.number().int().nonnegative(),
  state: DistillJobStateSchema,
  thread_id: NonEmptyStringSchema,
  updated_at: IsoDateTimeSchema,
});

const PreparedActorMcpSchema = z.strictObject({
  actor_id: NonEmptyStringSchema.nullable(),
  actor_kind: ActorKindSchema,
  author_association: NonEmptyStringSchema.nullable(),
  login: NonEmptyStringSchema.nullable(),
  provider: SourceProviderSchema,
  trust: TrustLevelSchema,
});

const PreparedCommentMcpSchema = z.strictObject({
  actor: PreparedActorMcpSchema,
  body: z.string(),
  created_at: IsoDateTimeSchema,
  diff_hunk: z.string().optional(),
  id: GitHubNodeIdSchema,
  updated_at: IsoDateTimeSchema,
});

const PreparedExtractJobMcpSchema = z.strictObject({
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
});

const PreparedFinalizeJobMcpSchema = z.strictObject({
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
});

const PrepareBlockedJobMcpSchema = z.strictObject({
  job: PreparedJobMetadataMcpSchema,
  max_characters_per_job: PositiveSafeIntegerSchema.optional(),
  reason: z.enum([
    "distillation_context_changed",
    "extract_receipt_unavailable",
    "lease_expired_during_prepare",
    "max_characters_exceeded",
    "sensitive_content_detected",
    "source_unavailable",
  ]),
  review_content_characters: z.number().int().nonnegative().optional(),
  sensitive_content_findings: SensitiveContentFindingsSchema.optional(),
});

const PrepareDisabledResultMcpSchema = z.strictObject({
  instructions: z.array(NonEmptyStringSchema),
  jobs: z.array(PreparedJobMetadataMcpSchema),
  missing_settings: z.array(
    z.enum([
      "hostAssistedDistillation.allowReviewContentTransmission",
      "hostAssistedDistillation.enabled",
    ]),
  ),
  required_settings: z.strictObject({
    "hostAssistedDistillation.allowReviewContentTransmission": z.literal(true),
    "hostAssistedDistillation.enabled": z.literal(true),
  }),
  state: z.literal("disabled"),
});

const PrepareReadyResultMcpSchema = z.strictObject({
  blocked_jobs: z.array(PrepareBlockedJobMcpSchema),
  jobs: z.array(
    z.discriminatedUnion("phase", [
      PreparedExtractJobMcpSchema,
      PreparedFinalizeJobMcpSchema,
    ]),
  ),
  state: z.literal("prepared"),
});

export const PrepareDistillationResultSchema = compileWhenHot(
  z.discriminatedUnion("state", [
    PrepareDisabledResultMcpSchema,
    PrepareReadyResultMcpSchema,
  ]),
);

export const PrepareDistillationOutputSchema = mutationOutputSchema(
  PrepareDistillationResultSchema,
);

const SubmitExtractInputSchema = z
  .strictObject({
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
  .check((context) => {
    const value = context.value;
    if (value.candidates.length === 0 && value.skip_reason === null) {
      addCustomIssue(context, {
        message: "zero candidates require skip_reason",
        path: ["skip_reason"],
      });
    }
    if (value.candidates.length > 0 && value.skip_reason !== null) {
      addCustomIssue(context, {
        message: "candidate output must not include skip_reason",
        path: ["skip_reason"],
      });
    }
  });

const MergeDecisionMcpSchema = z
  .strictObject({
    candidate_id: CandidateIdSchema,
    relation: MergeRelationSchema,
    target_id: KnowledgeIdSchema.optional(),
  })
  .check((context) => {
    const value = context.value;
    if (value.relation === "different" && value.target_id !== undefined) {
      addCustomIssue(context, {
        message: "different decisions must not include target_id",
        path: ["target_id"],
      });
    }
    if (value.relation !== "different" && value.target_id === undefined) {
      addCustomIssue(context, {
        message: `${value.relation} decisions require target_id`,
        path: ["target_id"],
      });
    }
  });

const SubmitFinalizeInputSchema = z.strictObject({
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
});

export const SubmitDistillationInputSchema = compileWhenHot(
  z.discriminatedUnion("phase", [
    SubmitExtractInputSchema,
    SubmitFinalizeInputSchema,
  ]),
);

const SubmitSkippedResultMcpSchema = z.strictObject({
  skip_reason: SkipReasonSchema,
  staled_knowledge_ids: z.array(KnowledgeIdSchema),
  state: z.literal("skipped"),
  withdrawn_evidence_ids: z.array(EvidenceIdSchema),
});

const SubmitMergeResultMcpSchema = z.strictObject({
  candidate_set_sha256: RawSha256Schema,
  candidates: z.array(ExtractCandidateMcpSchema).min(1),
  finalize_handle: RuntimeFinalizeHandleMcpSchema,
  match_set_digest: RawSha256Schema,
  possible_matches: z.array(PossibleMatchSetMcpSchema),
  state: z.literal("merge_decision_required"),
});

export const SubmitFinalizedResultMcpSchema = z.strictObject({
  accepted: z.boolean(),
  created_active: z.array(KnowledgeIdSchema),
  created_proposed: z.array(KnowledgeIdSchema),
  merged_evidence: z.array(EvidenceIdSchema),
  rejected_reason: NonEmptyStringSchema.optional(),
  revision_proposals: z.array(NonEmptyStringSchema),
});

export const SubmitDistillationResultSchema = compileWhenHot(
  z.union([
    SubmitSkippedResultMcpSchema,
    SubmitMergeResultMcpSchema,
    SubmitFinalizedResultMcpSchema,
  ]),
);

export const SubmitDistillationOutputSchema = mutationOutputSchema(
  SubmitDistillationResultSchema,
);

// Not compileWhenHot: compiling measured slower (0.7×).
export const AddKnowledgeInputSchema = z.strictObject({
  ...RepositorySelectionShape,
  category: KnowledgeCategorySchema,
  detail: NonEmptyStringSchema,
  related_ids: z.array(KnowledgeIdSchema).optional(),
  rule: NonEmptyStringSchema,
  scope: z.array(ScopePatternSchema),
  severity: SeveritySchema,
});

export const AddKnowledgeResultSchema = compileWhenHot(
  z.strictObject({
    etag: RawSha256Schema,
    id: KnowledgeIdSchema,
    origin: z.literal("manual"),
    repo: RepositoryNameSchema,
    revision: PositiveSafeIntegerSchema,
    status: z.literal("proposed"),
  }),
);

export const AddKnowledgeOutputSchema = mutationOutputSchema(
  AddKnowledgeResultSchema,
);

const ModelPlanePatchMcpSchema = z
  .strictObject({
    category: KnowledgeCategorySchema.optional(),
    detail: NonEmptyStringSchema.optional(),
    rule: NonEmptyStringSchema.optional(),
    scope: z.array(ScopePatternSchema).optional(),
    severity: SeveritySchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    error: "patch must not be empty",
  });

export const UpdateKnowledgeInputSchema = compileWhenHot(
  z.strictObject({
    ...RepositorySelectionShape,
    expected_etag: RawSha256Schema,
    expected_revision: PositiveSafeIntegerSchema,
    id: KnowledgeIdSchema,
    patch: ModelPlanePatchMcpSchema,
  }),
);

export const UpdateKnowledgeResultSchema = compileWhenHot(
  z.strictObject({
    current_etag: RawSha256Schema,
    current_revision: PositiveSafeIntegerSchema,
    knowledge_id: KnowledgeIdSchema,
    proposal_id: NonEmptyStringSchema,
    repo: RepositoryNameSchema,
    status: z.literal("pending"),
  }),
);

export const UpdateKnowledgeOutputSchema = mutationOutputSchema(
  UpdateKnowledgeResultSchema,
);

// The canonical request schema is extended, not redefined, so the MCP surface
// can never accept fields the outcome mutation service would reject.
// Not compileWhenHot: compiling measured 0.9–1.6×, not reliably faster.
export const RecordOutcomeInputSchema = RecordOutcomeRequestSchema.safeExtend(
  RepositorySelectionShape,
).check((context) => {
  const request = context.value;
  if (request.result_observed !== true) {
    addCustomIssue(context, {
      message: "record_outcome requires result_observed: true",
      path: ["result_observed"],
    });
  }
  if (request.context === undefined) {
    addCustomIssue(context, {
      message: "record_outcome requires observable task context",
      path: ["context"],
    });
  }
  if (request.note === undefined) {
    addCustomIssue(context, {
      message: "record_outcome requires a note describing the observed result",
      path: ["note"],
    });
  }
});

export const RecordOutcomeResultSchema = compileWhenHot(
  z.strictObject({
    applied_count: z.number().int().nonnegative(),
    event_id: EventIdSchema,
    knowledge_id: KnowledgeIdSchema,
    outcome: OutcomeKindSchema,
    replayed: z.boolean(),
    violation_count: z.number().int().nonnegative(),
  }),
);

export const RecordOutcomeOutputSchema = mutationOutputSchema(
  RecordOutcomeResultSchema,
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
  record_outcome: Object.freeze({
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  }),
  submit_distillation: Object.freeze({
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  }),
  sync_repo: Object.freeze({
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  }),
  update_knowledge: Object.freeze({
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  }),
}) satisfies Readonly<Record<string, ToolAnnotations>>;

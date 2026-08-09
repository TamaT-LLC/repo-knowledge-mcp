import { z } from "zod";

import { sortAndDedupeStrings } from "./canonical.js";

const NON_EMPTY_MESSAGE = "must be a non-empty string";

export const NonEmptyStringSchema = z.string().min(1, NON_EMPTY_MESSAGE);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "must use sha256:<lowercase hex>");

function prefixedUlidSchema(prefix: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u"),
      `must be a ${prefix}_ prefixed ULID`,
    );
}

function stringSetSchema<T extends z.ZodType<string>>(
  itemSchema: T,
): z.ZodPipe<z.ZodArray<T>, z.ZodTransform<z.output<T>[], z.output<T>[]>> {
  return z
    .array(itemSchema)
    .transform((values) => sortAndDedupeStrings(values) as z.output<T>[]);
}

export const KnowledgeIdSchema = prefixedUlidSchema("kn");
export const EvidenceIdSchema = prefixedUlidSchema("ev");
export const JobIdSchema = prefixedUlidSchema("job");
export const TransactionIdSchema = prefixedUlidSchema("txn");
export const EventIdSchema = prefixedUlidSchema("evt");
export const ObservationIdSchema = prefixedUlidSchema("obs");
export const SnapshotIdSchema = prefixedUlidSchema("snap");
export const ReceiptIdSchema = prefixedUlidSchema("rcpt");
export const CandidateIdSchema = prefixedUlidSchema("cand");

export const RepositoryIdSchema = NonEmptyStringSchema;
export const RepositoryNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u,
    "must use owner/name form",
  )
  .refine((value) => !value.endsWith("/.") && !value.endsWith("/.."), {
    message: "repository name must not be '.' or '..'",
  });
export const GitHubNodeIdSchema = NonEmptyStringSchema;

/** User-facing repository state returned additively by `get_rules`. */
export const RepositoryReadinessStateSchema = z.enum([
  "setup_required",
  "learning",
  "ready",
  "empty",
]);
export const RepositoryReadinessSchema = z
  .object({
    next_action: NonEmptyStringSchema,
    state: RepositoryReadinessStateSchema,
  })
  .strict();

export const ActorKindSchema = z.enum(["user", "bot", "unknown"]);
export const SourceProviderSchema = z.enum([
  "human",
  "devin",
  "greptile",
  "bugbot",
  "other",
]);
export const AiProviderSchema = z.enum([
  "devin",
  "greptile",
  "bugbot",
  "other",
]);
export const TrustLevelSchema = z.enum(["trusted", "untrusted", "unknown"]);

export const LlmConfigSchema = z
  .object({
    allowCloudTransmission: z.boolean().default(false),
    mode: z.enum(["disabled", "anthropic"]).default("disabled"),
    model: NonEmptyStringSchema.nullable().default(null),
  })
  .strict();

export const RepositoryPolicySchema = z
  .object({
    allowCloudTransmission: z.boolean().optional(),
  })
  .strict();

export const TrustConfigSchema = z
  .object({
    aiReviewers: z.record(NonEmptyStringSchema, AiProviderSchema).default({}),
    autoActivateTrustedHuman: z.boolean().default(false),
    externalContributors: z.enum(["proposed", "raw-only"]).default("raw-only"),
    sourceAliases: z
      .record(NonEmptyStringSchema, SourceProviderSchema)
      .default({}),
    trustedActorIds: stringSetSchema(NonEmptyStringSchema).default([]),
    trustedLogins: stringSetSchema(NonEmptyStringSchema).default([]),
  })
  .strict();

export const IngestConfigSchema = z
  .object({
    excludeAuthors: stringSetSchema(NonEmptyStringSchema).default([]),
    includeOutdated: z.boolean().default(true),
  })
  .strict();

export const HostAssistedDistillationConfigSchema = z
  .object({
    allowReviewContentTransmission: z.boolean().default(false),
    enabled: z.boolean().default(false),
    includeDiffHunk: z.boolean().default(false),
    maxCharactersPerJob: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .default(30_000),
  })
  .strict();

export const RepoKnowledgeConfigSchema = z
  .object({
    defaultRepo: RepositoryNameSchema.optional(),
    hostAssistedDistillation: HostAssistedDistillationConfigSchema.default({
      allowReviewContentTransmission: false,
      enabled: false,
      includeDiffHunk: false,
      maxCharactersPerJob: 30_000,
    }),
    ingest: IngestConfigSchema.default({
      excludeAuthors: [],
      includeOutdated: true,
    }),
    llm: LlmConfigSchema.default({
      allowCloudTransmission: false,
      mode: "disabled",
      model: null,
    }),
    repoPolicies: z
      .record(RepositoryNameSchema, RepositoryPolicySchema)
      .default({}),
    repos: stringSetSchema(RepositoryNameSchema).default([]),
    trust: TrustConfigSchema.default({
      aiReviewers: {},
      autoActivateTrustedHuman: false,
      externalContributors: "raw-only",
      sourceAliases: {},
      trustedActorIds: [],
      trustedLogins: [],
    }),
    workspaceMappings: z
      .record(NonEmptyStringSchema, RepositoryNameSchema)
      .default({}),
  })
  .strict();

export const ReviewerIdentitySchema = z
  .object({
    actor_id: GitHubNodeIdSchema.optional(),
    actor_kind: ActorKindSchema,
    author_association: NonEmptyStringSchema.optional(),
    login: NonEmptyStringSchema.nullable(),
    provider: SourceProviderSchema,
    trust: TrustLevelSchema,
  })
  .strict();

export const EvidenceActorSchema = z
  .object({
    actor_id: GitHubNodeIdSchema.optional(),
    actor_kind: ActorKindSchema,
    comment_id: GitHubNodeIdSchema,
    login: NonEmptyStringSchema.optional(),
    provider: SourceProviderSchema,
    trust: TrustLevelSchema,
  })
  .strict();

export const PullRequestObservationSchema = z
  .object({
    base_ref_oid: NonEmptyStringSchema,
    head_ref_oid: NonEmptyStringSchema,
    merged_at: IsoDateTimeSchema.nullable(),
    name_with_owner: RepositoryNameSchema,
    observation_id: ObservationIdSchema,
    observation_type: z.literal("pull_request"),
    observed_at: IsoDateTimeSchema,
    pr_number: z.number().int().positive(),
    pull_request_id: GitHubNodeIdSchema,
    repo_id: RepositoryIdSchema,
    snapshot_id: SnapshotIdSchema,
    title: NonEmptyStringSchema,
  })
  .strict();

export const ThreadObservationSchema = z
  .object({
    comment_ids: stringSetSchema(GitHubNodeIdSchema),
    content_fingerprint: Sha256DigestSchema,
    is_outdated: z.boolean(),
    is_resolved: z.boolean(),
    observation_id: ObservationIdSchema,
    observation_type: z.literal("thread"),
    observed_at: IsoDateTimeSchema,
    path: NonEmptyStringSchema.optional(),
    pr_number: z.number().int().positive(),
    repo_id: RepositoryIdSchema,
    snapshot_id: SnapshotIdSchema,
    state_fingerprint: Sha256DigestSchema,
    thread_id: NonEmptyStringSchema,
  })
  .strict();

export const ThreadRemovedObservationSchema = z
  .object({
    observation_id: ObservationIdSchema,
    observation_type: z.literal("thread_removed"),
    observed_at: IsoDateTimeSchema,
    pr_number: z.number().int().positive(),
    previous_snapshot_id: SnapshotIdSchema,
    repo_id: RepositoryIdSchema,
    snapshot_id: SnapshotIdSchema,
    thread_id: NonEmptyStringSchema,
  })
  .strict();

export const CommentObservationSchema = z
  .object({
    actor: ReviewerIdentitySchema,
    body: z.string(),
    comment_id: GitHubNodeIdSchema,
    created_at: IsoDateTimeSchema,
    diff_hunk: z.string().optional(),
    observation_id: ObservationIdSchema,
    observation_type: z.literal("comment"),
    observed_at: IsoDateTimeSchema,
    snapshot_id: SnapshotIdSchema,
    thread_id: NonEmptyStringSchema,
    updated_at: IsoDateTimeSchema,
    url: z.string().url(),
  })
  .strict();

export const RawObservationSchema = z.discriminatedUnion("observation_type", [
  PullRequestObservationSchema,
  ThreadObservationSchema,
  ThreadRemovedObservationSchema,
  CommentObservationSchema,
]);

export const PullRequestSnapshotSchema = z
  .object({
    complete: z.literal(true),
    observed_at: IsoDateTimeSchema,
    pr_number: z.number().int().positive(),
    repo_id: RepositoryIdSchema,
    review_summary_ids: stringSetSchema(NonEmptyStringSchema),
    snapshot_id: SnapshotIdSchema,
    thread_ids: stringSetSchema(NonEmptyStringSchema),
  })
  .strict();

export const KnowledgeCategorySchema = z.enum([
  "style",
  "naming",
  "architecture",
  "error-handling",
  "security",
  "perf",
  "test",
  "docs",
  "other",
]);
export const SeveritySchema = z.enum(["must", "should", "consider"]);
export const KnowledgeStatusSchema = z.enum([
  "proposed",
  "active",
  "stale",
  "deprecated",
  "rejected",
]);
export const SkipReasonSchema = z.enum([
  "typo",
  "praise_or_chitchat",
  "question_without_conclusion",
  "pr_specific",
  "duplicate_noise",
  "insufficient_context",
]);

/**
 * Job-only terminal reasons used when server-side ingest makes unfinished
 * work obsolete. They are intentionally separate from `SkipReasonSchema`: a
 * model may classify review content with a public skip reason, but may never
 * claim that canonical context changed or disappeared.
 */
export const DistillJobSkipReasonSchema = z.union([
  SkipReasonSchema,
  z.enum(["superseded_context", "source_removed"]),
]);

export const ScopePatternSchema = NonEmptyStringSchema.max(512).refine(
  (value) => !value.startsWith("!"),
  "negative scope patterns are not supported in M1",
);

export const GENERATED_CODE_EXAMPLE_MAX_CONTENT_CHARACTERS = 4_000;

export const CodeExampleLanguageSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9+#.-]{0,31}$/u,
    "must be a lowercase language identifier such as typescript",
  );

/**
 * A concrete example is only valid when it is grounded in the supplied review
 * thread: it must always carry `generated_example: true` and cite at least one
 * evidence comment ID, and every ID is bound to the current snapshot by the
 * extract and finalize validators.
 */
export const GeneratedCodeExampleSchema = z
  .object({
    content: NonEmptyStringSchema.max(
      GENERATED_CODE_EXAMPLE_MAX_CONTENT_CHARACTERS,
    ).refine((value) => value.trim().length > 0, {
      message: "code example content must not be blank",
    }),
    evidence_comment_ids: z
      .array(GitHubNodeIdSchema)
      .min(1)
      .transform((values) => sortAndDedupeStrings(values)),
    generated_example: z.literal(true),
    language: CodeExampleLanguageSchema,
  })
  .strict();

export const DistilledCandidateSchema = z
  .object({
    category: KnowledgeCategorySchema,
    code_example: GeneratedCodeExampleSchema.optional(),
    confidence: z.number().min(0).max(1),
    detail: NonEmptyStringSchema,
    evidence_comment_ids: z
      .array(GitHubNodeIdSchema)
      .min(1)
      .transform((values) => sortAndDedupeStrings(values)),
    rule: NonEmptyStringSchema,
    scope: stringSetSchema(ScopePatternSchema),
    severity: SeveritySchema,
  })
  .strict();

export const DistillationOutputSchema = z
  .object({
    candidates: z.array(DistilledCandidateSchema),
    skip_reason: SkipReasonSchema.nullable(),
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

export const MergeRelationSchema = z.enum(["same", "overlaps", "different"]);
export const MergeDecisionSchema = z
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

export const DistillJobStateSchema = z.enum([
  "pending",
  "processing",
  "awaiting_finalize",
  "done",
  "skipped",
  "failed",
]);

export const DistillJobSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    distillation_key: Sha256DigestSchema,
    job_id: JobIdSchema,
    last_error: NonEmptyStringSchema.nullable().optional(),
    lease_expires_at: IsoDateTimeSchema.optional(),
    lease_generation: z.number().int().nonnegative(),
    lease_token_hash: Sha256DigestSchema.optional(),
    next_retry_at: IsoDateTimeSchema.nullable().optional(),
    repo_id: RepositoryIdSchema,
    skip_reason: DistillJobSkipReasonSchema.nullable().optional(),
    state: DistillJobStateSchema,
    thread_id: NonEmptyStringSchema,
    updated_at: IsoDateTimeSchema,
    validation_failures: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((value, context) => {
    const hasCompleteLease =
      value.lease_expires_at !== undefined &&
      value.lease_token_hash !== undefined;
    const hasAnyLease =
      value.lease_expires_at !== undefined ||
      value.lease_token_hash !== undefined;
    if (
      (value.state === "processing" || value.state === "awaiting_finalize") &&
      !hasCompleteLease
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.state} jobs require an active lease`,
        path: ["lease_expires_at"],
      });
    }
    if (
      value.state !== "processing" &&
      value.state !== "awaiting_finalize" &&
      hasAnyLease
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.state} jobs must not retain a lease`,
        path: ["lease_expires_at"],
      });
    }
    if (value.state === "skipped" && value.skip_reason == null) {
      context.addIssue({
        code: "custom",
        message: "skipped jobs require skip_reason",
        path: ["skip_reason"],
      });
    }
    if (value.state !== "skipped" && value.skip_reason != null) {
      context.addIssue({
        code: "custom",
        message: `${value.state} jobs must not have skip_reason`,
        path: ["skip_reason"],
      });
    }
    if (value.state === "failed" && value.last_error == null) {
      context.addIssue({
        code: "custom",
        message: "failed jobs require last_error",
        path: ["last_error"],
      });
    }
  });

export const EvidenceStatusSchema = z.enum([
  "active",
  "superseded",
  "withdrawn",
]);

export const KnowledgeEvidenceSchema = z
  .object({
    actors: z.array(EvidenceActorSchema).min(1),
    author_association: NonEmptyStringSchema.optional(),
    comment_ids: z
      .array(GitHubNodeIdSchema)
      .min(1)
      .transform((values) => sortAndDedupeStrings(values)),
    content_fingerprint: Sha256DigestSchema,
    eligible_for_count: z.boolean(),
    evidence_id: EvidenceIdSchema,
    knowledge_id: KnowledgeIdSchema,
    observed_at: IsoDateTimeSchema,
    occurrence_key: NonEmptyStringSchema,
    originator: EvidenceActorSchema,
    path: NonEmptyStringSchema.optional(),
    pr_number: z.number().int().positive(),
    repo_id: RepositoryIdSchema,
    sources: z
      .array(SourceProviderSchema)
      .min(1)
      .transform((values) => sortAndDedupeStrings(values)),
    state_fingerprint: Sha256DigestSchema,
    status: EvidenceStatusSchema,
    superseded_by: EvidenceIdSchema.optional(),
    supersedes: EvidenceIdSchema.optional(),
    thread_id: NonEmptyStringSchema,
    url: z.string().url().optional(),
  })
  .strict();

export const KnowledgeOutcomeSchema = z
  .object({
    at: IsoDateTimeSchema,
    context: z
      .object({
        file_paths: stringSetSchema(NonEmptyStringSchema).optional(),
        pr_number: z.number().int().positive().optional(),
        task_id: NonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
    knowledge_id: KnowledgeIdSchema,
    note: NonEmptyStringSchema.optional(),
    outcome: z.enum([
      "applied",
      "violated",
      "not_applicable",
      "false_positive",
    ]),
    repo_id: RepositoryIdSchema,
  })
  .strict();

export const KnowledgeRevisionProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export const KnowledgeRevisionPatchSchema = z
  .object({
    category: KnowledgeCategorySchema.optional(),
    detail: NonEmptyStringSchema.optional(),
    rule: NonEmptyStringSchema.optional(),
    scope: stringSetSchema(ScopePatternSchema).optional(),
    severity: SeveritySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "revision proposal patch must not be empty",
  });
export const KnowledgeRevisionProposalSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    evidence_ids: stringSetSchema(EvidenceIdSchema).default([]),
    knowledge_id: KnowledgeIdSchema,
    patch: KnowledgeRevisionPatchSchema,
    proposal_id: NonEmptyStringSchema,
    repo_id: RepositoryIdSchema,
    status: KnowledgeRevisionProposalStatusSchema.default("pending"),
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const ExtractCandidateSchema = z
  .object({
    candidate: DistilledCandidateSchema,
    candidate_id: CandidateIdSchema,
  })
  .strict();

export const MergeDecisionRequiredStableResponseSchema = z
  .object({
    candidates: z.array(ExtractCandidateSchema).min(1),
    state: z.literal("merge_decision_required"),
  })
  .strict();

export const SkippedStableResponseSchema = z
  .object({
    skip_reason: SkipReasonSchema,
    staled_knowledge_ids: stringSetSchema(KnowledgeIdSchema),
    state: z.literal("skipped"),
    withdrawn_evidence_ids: stringSetSchema(EvidenceIdSchema),
  })
  .strict();

export const ExtractStableResponseSchema = z.discriminatedUnion("state", [
  MergeDecisionRequiredStableResponseSchema,
  SkippedStableResponseSchema,
]);

export const FinalizeStableResponseSchema = z
  .object({
    accepted: z.boolean(),
    created_proposed: stringSetSchema(KnowledgeIdSchema),
    merged_evidence: stringSetSchema(EvidenceIdSchema),
    rejected_reason: NonEmptyStringSchema.optional(),
    revision_proposals: stringSetSchema(NonEmptyStringSchema),
  })
  .strict();

const SubmissionReceiptBaseShape = {
  committed_at: IsoDateTimeSchema,
  job_id: JobIdSchema,
  receipt_id: ReceiptIdSchema,
  request_sha256: Sha256DigestSchema,
  submission_id: NonEmptyStringSchema,
};

export const ExtractSubmissionReceiptSchema = z
  .object({
    ...SubmissionReceiptBaseShape,
    phase: z.literal("extract"),
    stable_response: ExtractStableResponseSchema,
  })
  .strict();

export const FinalizeSubmissionReceiptSchema = z
  .object({
    ...SubmissionReceiptBaseShape,
    phase: z.literal("finalize"),
    stable_response: FinalizeStableResponseSchema,
  })
  .strict();

export const SubmissionReceiptSchema = z.discriminatedUnion("phase", [
  ExtractSubmissionReceiptSchema,
  FinalizeSubmissionReceiptSchema,
]);

export type ReviewerIdentity = z.infer<typeof ReviewerIdentitySchema>;
export type RepositoryReadiness = z.infer<typeof RepositoryReadinessSchema>;
export type RepositoryReadinessState = z.infer<
  typeof RepositoryReadinessStateSchema
>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type RepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;
export type TrustConfig = z.infer<typeof TrustConfigSchema>;
export type IngestConfig = z.infer<typeof IngestConfigSchema>;
export type HostAssistedDistillationConfig = z.infer<
  typeof HostAssistedDistillationConfigSchema
>;
export type RepoKnowledgeConfig = z.infer<typeof RepoKnowledgeConfigSchema>;
export type EvidenceActor = z.infer<typeof EvidenceActorSchema>;
export type PullRequestObservation = z.infer<
  typeof PullRequestObservationSchema
>;
export type ThreadObservation = z.infer<typeof ThreadObservationSchema>;
export type ThreadRemovedObservation = z.infer<
  typeof ThreadRemovedObservationSchema
>;
export type CommentObservation = z.infer<typeof CommentObservationSchema>;
export type RawObservation = z.infer<typeof RawObservationSchema>;
export type PullRequestSnapshot = z.infer<typeof PullRequestSnapshotSchema>;
export type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type SkipReason = z.infer<typeof SkipReasonSchema>;
export type DistillJobSkipReason = z.infer<typeof DistillJobSkipReasonSchema>;
export type GeneratedCodeExample = z.infer<typeof GeneratedCodeExampleSchema>;
export type DistilledCandidate = z.infer<typeof DistilledCandidateSchema>;
export type DistillationOutput = z.infer<typeof DistillationOutputSchema>;
export type MergeDecision = z.infer<typeof MergeDecisionSchema>;
export type DistillJob = z.infer<typeof DistillJobSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type KnowledgeEvidence = z.infer<typeof KnowledgeEvidenceSchema>;
export type KnowledgeOutcome = z.infer<typeof KnowledgeOutcomeSchema>;
export type KnowledgeRevisionPatch = z.infer<
  typeof KnowledgeRevisionPatchSchema
>;
export type KnowledgeRevisionProposal = z.infer<
  typeof KnowledgeRevisionProposalSchema
>;
export type KnowledgeRevisionProposalStatus = z.infer<
  typeof KnowledgeRevisionProposalStatusSchema
>;
export type ExtractCandidate = z.infer<typeof ExtractCandidateSchema>;
export type MergeDecisionRequiredStableResponse = z.infer<
  typeof MergeDecisionRequiredStableResponseSchema
>;
export type SkippedStableResponse = z.infer<typeof SkippedStableResponseSchema>;
export type ExtractStableResponse = z.infer<typeof ExtractStableResponseSchema>;
export type FinalizeStableResponse = z.infer<
  typeof FinalizeStableResponseSchema
>;
export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

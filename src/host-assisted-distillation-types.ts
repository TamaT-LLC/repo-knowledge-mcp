import {
  type DistillJob,
  type ExtractCandidate,
  type RepoKnowledgeConfig,
  type ReviewerIdentity,
} from "./domain-schemas.js";
import { type DistillJobCoordinatorOptions } from "./distill-job-coordinator.js";
import {
  type NormalizedDistillationActor,
  type NormalizedDistillationComment,
} from "./github-snapshot-normalizer.js";
import {
  type MergeCandidateSearchRequest,
  type MergeCandidateSearchResult,
} from "./merge-candidate-service.js";
import type {
  PossibleKnowledgeMatch,
  PossibleMatchSet,
} from "./possible-match.js";
import type { RepositoryResolution } from "./repository-resolver.js";
import {
  RuntimeFinalizeContextStore,
  type RuntimeFinalizeHandle,
} from "./runtime-finalize-context-store.js";
import { type SensitiveContentFinding } from "./sensitive-content.js";

export const DEFAULT_PREPARE_DISTILLATION_LIMIT = 1;
export const MAX_PREPARE_DISTILLATION_LIMIT = 10;
export const MAX_PREPARE_BLOCKED_JOB_METADATA = 10;

export const REQUIRED_HOST_ASSISTED_SETTINGS = Object.freeze({
  "hostAssistedDistillation.allowReviewContentTransmission": true,
  "hostAssistedDistillation.enabled": true,
});

export type HostAssistedSetting = keyof typeof REQUIRED_HOST_ASSISTED_SETTINGS;

export interface PrepareDistillationRequest {
  readonly limit?: number;
}

export interface HostAssistedDistillationJobMetadata {
  readonly available_at?: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly state: DistillJob["state"];
  readonly thread_id: string;
  readonly updated_at: string;
}

export interface HostAssistedDistillationActor {
  readonly actor_id: string | null;
  readonly actor_kind: ReviewerIdentity["actor_kind"];
  readonly author_association: string | null;
  readonly login: string | null;
  readonly provider: ReviewerIdentity["provider"];
  readonly trust: ReviewerIdentity["trust"];
}

export interface HostAssistedDistillationComment {
  readonly actor: HostAssistedDistillationActor;
  readonly body: string;
  readonly created_at: string;
  readonly diff_hunk?: string;
  readonly id: string;
  readonly updated_at: string;
}

interface PreparedJobBase {
  readonly expires_at: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token: string;
  readonly thread_fingerprint: string;
}

export interface HostAssistedExtractJob extends PreparedJobBase {
  readonly comments: readonly HostAssistedDistillationComment[];
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly path?: string;
  readonly phase: "extract";
  /** Code points in the exact canonical comments/path object returned. */
  readonly review_content_characters: number;
}

export interface HostAssistedFinalizeJob extends PreparedJobBase {
  readonly candidate_set_sha256: string;
  readonly candidates: readonly ExtractCandidate[];
  readonly finalize_handle: RuntimeFinalizeHandle;
  readonly match_set_digest: string;
  readonly phase: "finalize";
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
}

export type HostAssistedPreparedJob =
  | HostAssistedExtractJob
  | HostAssistedFinalizeJob;

export type HostAssistedBlockedJobReason =
  | "distillation_context_changed"
  | "extract_receipt_unavailable"
  | "lease_expired_during_prepare"
  | "max_characters_exceeded"
  | "sensitive_content_detected"
  | "source_unavailable";

export interface HostAssistedBlockedJob {
  readonly job: HostAssistedDistillationJobMetadata;
  readonly max_characters_per_job?: number;
  readonly reason: HostAssistedBlockedJobReason;
  readonly review_content_characters?: number;
  readonly sensitive_content_findings?: readonly SensitiveContentFinding[];
}

export interface HostAssistedDistillationDisabledResult {
  readonly instructions: readonly string[];
  readonly jobs: readonly HostAssistedDistillationJobMetadata[];
  readonly missing_settings: readonly HostAssistedSetting[];
  readonly required_settings: Readonly<Record<HostAssistedSetting, true>>;
  readonly state: "disabled";
}

export interface HostAssistedDistillationPreparedResult {
  readonly blocked_jobs: readonly HostAssistedBlockedJob[];
  readonly jobs: readonly HostAssistedPreparedJob[];
  readonly state: "prepared";
}

export type PrepareDistillationResult =
  | HostAssistedDistillationDisabledResult
  | HostAssistedDistillationPreparedResult;

export interface HostAssistedDistillationServiceOptions {
  readonly config: RepoKnowledgeConfig;
  readonly coordinatorOptions?: DistillJobCoordinatorOptions;
  readonly finalizeContexts?: RuntimeFinalizeContextStore;
  /** Test/composition seam; production callers normally use the canonical service. */
  readonly mergeCandidateSearch?: HostAssistedMergeCandidateSearch;
  readonly promptDigest: string;
  readonly repository: RepositoryResolution;
  readonly repositoryContext: unknown;
}

export interface HostAssistedMergeCandidateSearch {
  search(
    request: MergeCandidateSearchRequest,
  ): Promise<MergeCandidateSearchResult>;
}

export type HostAssistedDistillationErrorCode =
  | "DISTILLATION_CONTEXT_CHANGED"
  | "DISTILLATION_SOURCE_UNAVAILABLE"
  | "EXTRACT_RECEIPT_UNAVAILABLE"
  | "INVALID_PREPARE_LIMIT"
  | "LEASE_EXPIRED_DURING_PREPARE";

export class HostAssistedDistillationError extends Error {
  constructor(
    readonly code: HostAssistedDistillationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "HostAssistedDistillationError";
  }
}

export interface CurrentHostAssistedDistillationSource {
  readonly contentFingerprint: string;
  readonly distillationKey: string;
  readonly normalizedActors: readonly NormalizedDistillationActor[];
  readonly normalizedComments: readonly NormalizedDistillationComment[];
  readonly path: string | null;
  readonly snapshotId: string;
}

export interface ResolveHostAssistedDistillationSourceInput {
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly repoId: string;
  readonly repositoryContext: unknown;
  readonly trustPolicyDigest: string;
}

export interface PreparedReviewContent {
  readonly characters: number;
  readonly comments: readonly HostAssistedDistillationComment[];
  readonly path: string | null;
}

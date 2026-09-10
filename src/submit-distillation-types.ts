import {
  CanonicalTransactionStore,
  type CanonicalAppendRecordRequest,
  type CanonicalFileWriteRequest,
} from "./canonical-transaction-store.js";
import {
  type CommentObservation,
  type DistillJob,
  type DistilledCandidate,
  type ExtractCandidate,
  type ExtractStableResponse,
  type FinalizeStableResponse,
  type RepoKnowledgeConfig,
  type SkipReason,
  type SubmissionReceipt,
  type ThreadObservation,
} from "./domain-schemas.js";
import { CanonicalFinalizeError } from "./canonical-finalize-service.js";
import type {
  PossibleKnowledgeMatch,
  PossibleMatchSet,
} from "./possible-match.js";
import {
  type ExtractRequest,
  type FinalizeRequest,
} from "./request-integrity.js";
import {
  RuntimeFinalizeContextStore,
  type RuntimeFinalizeHandle,
} from "./runtime-finalize-context-store.js";

export const SUBMISSION_EVENT_PATH = "events/submissions.jsonl";

export interface SubmitExtractRequest extends ExtractRequest {
  readonly candidates: readonly DistilledCandidate[];
  readonly skip_reason: SkipReason | null;
}

export interface SubmitExtractMergeResponse {
  readonly candidate_set_sha256: string;
  readonly candidates: readonly ExtractCandidate[];
  readonly finalize_handle: RuntimeFinalizeHandle;
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
  readonly state: "merge_decision_required";
}

export type SubmitExtractResponse =
  | SubmitExtractMergeResponse
  | Extract<ExtractStableResponse, { readonly state: "skipped" }>;

export type SubmitFinalizeRequest = FinalizeRequest;

export interface SubmitFinalizeRetryResponse {
  readonly candidate_set_sha256: string;
  readonly finalize_handle: RuntimeFinalizeHandle;
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
  readonly state: "merge_decision_required";
}

export interface SubmitDistillationContextOptions {
  readonly config: RepoKnowledgeConfig;
  readonly model?: string;
  readonly outputSchemaDigest?: string;
  readonly outputSchemaVersion?: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly provider?: string;
  readonly repositoryContext: unknown;
}

export interface SubmitDistillationServiceOptions {
  readonly candidateLimit?: number;
  readonly evidenceEventPath?: string;
  readonly finalizeContexts?: RuntimeFinalizeContextStore;
  readonly jobEventPath?: string;
  readonly nextCandidateId?: (timestamp: number) => string;
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextReceiptId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
  readonly distillationContext?: SubmitDistillationContextOptions;
  readonly submissionEventPath?: string;
}

export type SubmitDistillationErrorCode =
  | "CURRENT_SNAPSHOT_INCOMPLETE"
  | "DISTILLATION_CONTEXT_CHANGED"
  | "DISTILLATION_SOURCE_CHANGED"
  | "EVIDENCE_COMMENTS_INVALID"
  | "EXTRACT_REQUEST_INVALID"
  | "FINALIZE_REQUEST_INVALID"
  | "JOB_ALREADY_FINALIZED"
  | "JOB_CONTEXT_MISMATCH"
  | "MERGE_CANDIDATES_CHANGED"
  | "PHASE_ALREADY_COMMITTED"
  | "RESUME_REQUIRED"
  | "UNKNOWN_FINALIZE_TOKEN";

interface SubmitDistillationErrorOptions extends ErrorOptions {
  readonly retry?: SubmitFinalizeRetryResponse;
}

export class SubmitDistillationError extends Error {
  constructor(
    readonly code: SubmitDistillationErrorCode,
    message: string,
    options?: SubmitDistillationErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SubmitDistillationError";
    this.retry = options?.retry;
  }

  readonly retry: SubmitFinalizeRetryResponse | undefined;
}

export interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

export interface ExtractContext {
  readonly comments: readonly CommentObservation[];
  readonly job: DistillJob;
  readonly operation: OperationTime;
  readonly sourceSnapshotId: string;
  readonly thread: ThreadObservation;
}

export interface ExtractCommitResult {
  readonly receipt: Extract<SubmissionReceipt, { readonly phase: "extract" }>;
  readonly stableResponse: ExtractStableResponse;
}

export interface FinalizeReceiptMiss {
  readonly extractReceipt: Extract<
    SubmissionReceipt,
    { readonly phase: "extract" }
  > & {
    readonly stable_response: Extract<
      ExtractStableResponse,
      { readonly state: "merge_decision_required" }
    >;
  };
  readonly kind: "miss";
  readonly threadId: string;
}

interface FinalizeReceiptReplay {
  readonly kind: "replay";
  readonly stableResponse: FinalizeStableResponse;
}

export type FinalizeReceiptLookup = FinalizeReceiptMiss | FinalizeReceiptReplay;

interface FinalizeMatchChanged {
  readonly contentFingerprint: string;
  readonly distillationKey: string;
  readonly expiresAt: string;
  readonly kind: "match_changed";
  readonly sourceSnapshotId: string;
  readonly search: NonNullable<CanonicalFinalizeError["currentSearch"]>;
}

interface FinalizeCommitted {
  readonly kind: "committed" | "replay";
  readonly stableResponse: FinalizeStableResponse;
}

export type FinalizeLockedResult = FinalizeCommitted | FinalizeMatchChanged;

export interface ValidatedSubmitDistillationContext {
  readonly config: RepoKnowledgeConfig;
  readonly model: string;
  readonly outputSchemaDigest: string;
  readonly outputSchemaVersion: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly provider: string;
  readonly repositoryContext: unknown;
  readonly trustPolicyDigest: string;
}

export interface SkipLifecyclePlan {
  readonly fileWrites: readonly CanonicalFileWriteRequest[];
  readonly records: readonly CanonicalAppendRecordRequest[];
  readonly staledKnowledgeIds: readonly string[];
  readonly withdrawnEvidenceIds: readonly string[];
}

import {
  CanonicalTransactionStore,
  type CanonicalAppendRecordRequest,
  type CanonicalTransactionRequest,
} from "./canonical-transaction-store.js";
import {
  type CommentObservation,
  type DistillJob,
  type ExtractCandidate,
  type FinalizeStableResponse,
  type KnowledgeEvidence,
  type MergeDecision,
  type SkipReason,
  type SkippedStableResponse,
  type ThreadObservation,
} from "./domain-schemas.js";
import { type DistillJobLeaseCredentials } from "./distill-job-coordinator.js";
import type { ManualReviewMarker } from "./evidence-policy.js";
import { type MergeCandidateSearchResult } from "./merge-candidate-service.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import type { TrustedHumanAutoActivationPolicyLike } from "./trusted-human-auto-activation-policy.js";

export const EVIDENCE_EVENT_PATH = "events/evidence.jsonl";
export const REVISION_PROPOSAL_EVENT_PATH = "events/revisions.jsonl";

export type CanonicalFinalizeErrorCode =
  | "CURRENT_SNAPSHOT_INCOMPLETE"
  | "DISTILLATION_CONTEXT_CHANGED"
  | "DISTILLATION_SOURCE_CHANGED"
  | "EVIDENCE_COMMENTS_INVALID"
  | "FINALIZE_REQUEST_INVALID"
  | "JOB_CONTEXT_MISMATCH"
  | "MERGE_CANDIDATES_CHANGED";

export class CanonicalFinalizeError extends Error {
  constructor(
    readonly code: CanonicalFinalizeErrorCode,
    message: string,
    readonly currentSearch?: MergeCandidateSearchResult,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "CanonicalFinalizeError";
  }
}

export interface CanonicalFinalizeSourceBinding {
  readonly content_fingerprint: string;
  readonly distillation_key: string;
  readonly thread_id: string;
}

export interface CanonicalFinalizeRequest
  extends CanonicalFinalizeSourceBinding {
  readonly candidates: readonly ExtractCandidate[];
  readonly decisions: readonly unknown[];
  readonly expected_match_set_digest: string;
  readonly lease: DistillJobLeaseCredentials;
  readonly provenance: DistillationProvenance;
}

export interface CanonicalSkipFinalizeRequest
  extends CanonicalFinalizeSourceBinding {
  readonly duplicate_knowledge_id?: string;
  readonly lease: DistillJobLeaseCredentials;
  readonly skip_reason: SkipReason;
}

export interface CanonicalSkipFinalizeResult {
  readonly manual_review: ManualReviewMarker | null;
  readonly reassociated_evidence_ids: readonly string[];
  readonly stable_response: SkippedStableResponse;
}

export interface CanonicalFinalizeMutationPlan {
  readonly transaction: CanonicalTransactionRequest;
  readonly value: FinalizeStableResponse;
}

export interface CanonicalFinalizeServiceOptions {
  readonly autoActivationPolicy?: TrustedHumanAutoActivationPolicyLike;
  readonly candidateLimit?: number;
  readonly evidenceEventPath?: string;
  readonly jobEventPath?: string;
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextEvidenceId?: (timestamp: number) => string;
  readonly nextKnowledgeId?: (timestamp: number) => string;
  readonly nextProposalId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly proposalEventPath?: string;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
}

export interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

export interface CurrentFinalizeContext {
  readonly comments: readonly CommentObservation[];
  readonly job: DistillJob;
  readonly operation: OperationTime;
  readonly thread: ThreadObservation;
}

interface AssignedCandidateBase {
  readonly candidate: ExtractCandidate;
  readonly decision: MergeDecision;
  readonly knowledgeId: string;
  readonly relatedIds: readonly string[];
}

interface ExistingAssignedCandidate extends AssignedCandidateBase {
  readonly createsKnowledge: false;
  readonly initialStatus: null;
}

export interface NewAssignedCandidate extends AssignedCandidateBase {
  readonly createsKnowledge: true;
  readonly initialStatus: "active" | "proposed";
}

export type AssignedCandidate =
  | ExistingAssignedCandidate
  | NewAssignedCandidate;

export const PROPOSE_ONLY_AUTO_ACTIVATION_POLICY: TrustedHumanAutoActivationPolicyLike =
  {
    evaluate: () => ({ reasons: ["eligibility_missing"], status: "proposed" }),
  };

export interface EvidenceGroup {
  readonly commentIds: readonly string[];
  readonly knowledgeId: string;
}

export interface PlannedEvidenceLifecycle {
  readonly active: readonly KnowledgeEvidence[];
  readonly records: readonly CanonicalAppendRecordRequest[];
  readonly staleKnowledgeIds: readonly string[];
  readonly withdrawnEvidenceIds: readonly string[];
}

export interface IdentifierFactory {
  nextEventId(): string;
  nextEvidenceId(): string;
  nextKnowledgeId(): string;
  nextProposalId(): string;
}

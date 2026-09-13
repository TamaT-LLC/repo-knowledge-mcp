import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import {
  type EvidenceActor,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
  type Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import { type KnowledgeDocument } from "./knowledge-document.js";

export const DEFAULT_ADMIN_POSSIBLE_MATCH_LIMIT = 8;

export type AdminPlaneErrorCode =
  | "ADMIN_PROJECTION_INVALID"
  | "INVALID_ADMIN_STATE"
  | "KNOWLEDGE_NOT_FOUND"
  | "POSSIBLE_MATCH_QUERY_INVALID"
  | "REVISION_PROPOSAL_NOT_FOUND"
  | "REVISION_PROPOSAL_CHANGED"
  | "REVISION_PROPOSAL_NOT_PENDING"
  | "TTY_REQUIRED";

export class AdminPlaneError extends Error {
  constructor(
    readonly code: AdminPlaneErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "AdminPlaneError";
  }
}

export interface AdminEvidenceReview {
  readonly actors: readonly EvidenceActor[];
  readonly comment_ids: readonly string[];
  readonly evidence_id: string;
  readonly observed_at: string;
  readonly originator: EvidenceActor;
  readonly sources: readonly string[];
  readonly status: KnowledgeEvidence["status"];
  readonly url?: string;
}

export interface AdminPossibleMatch {
  readonly etag: string;
  readonly id: string;
  readonly revision: number;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: Severity;
  readonly status: KnowledgeStatus;
}

export interface AdminKnowledgeSummary {
  readonly etag: string;
  readonly evidence_count: number;
  readonly id: string;
  readonly revision: number;
  readonly rule: string;
  readonly severity: Severity;
  readonly status: Extract<KnowledgeStatus, "proposed" | "stale">;
}

export interface AdminRevisionProposalSummary {
  readonly knowledge_id: string;
  readonly proposal_id: string;
  readonly updated_at: string;
}

export interface AdminReviewQueue {
  readonly knowledge: readonly AdminKnowledgeSummary[];
  readonly repo: string;
  readonly revision_proposals: readonly AdminRevisionProposalSummary[];
}

export interface AdminKnowledgeReview {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly etag: string;
  readonly evidence: readonly AdminEvidenceReview[];
  readonly id: string;
  readonly origin: Readonly<Record<string, unknown>> | null;
  readonly possible_matches: readonly AdminPossibleMatch[];
  readonly related_ids: readonly string[];
  readonly repo: string;
  readonly revision: number;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: Severity;
  readonly status: KnowledgeStatus;
}

export interface AdminRevisionProposalReview {
  readonly knowledge: AdminKnowledgeReview;
  readonly proposal: KnowledgeRevisionProposal;
}

/** Exact canonical knowledge generation displayed by an interactive reviewer. */
export interface AdminKnowledgeReviewBinding {
  readonly etag: string;
  readonly id: string;
  readonly revision: number;
}

/** Exact pending proposal and target generation displayed by a reviewer. */
export interface AdminRevisionProposalReviewBinding {
  readonly knowledge: AdminKnowledgeReviewBinding;
  readonly proposalEtag: string;
  readonly proposalId: string;
}

export type AdminInteractionResult<T> =
  | { readonly confirmed: false }
  | { readonly confirmed: true; readonly value: T };

export interface AdminAddActiveInput {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly related_ids?: readonly string[];
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: Severity;
}

export interface AdminPlaneServiceOptions {
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextKnowledgeId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly possibleMatchLimit?: number;
  readonly proposalEventPath?: string;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
}

export interface CurrentKnowledge {
  readonly document: KnowledgeDocument;
  readonly projected: ProjectedKnowledge;
}

export interface AdminSearchSubject {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly rule: string;
  readonly scope: readonly string[];
}

import { sortAndDedupeStrings } from "./canonical.js";

export const DEFINITIVE_NON_KNOWLEDGE_SKIP_REASONS = [
  "typo",
  "praise_or_chitchat",
  "question_without_conclusion",
  "pr_specific",
] as const;

export type DefinitiveNonKnowledgeSkipReason =
  (typeof DEFINITIVE_NON_KNOWLEDGE_SKIP_REASONS)[number];

export type SkipReason =
  DefinitiveNonKnowledgeSkipReason | "duplicate_noise" | "insufficient_context";

export type EvidenceStatus = "active" | "withdrawn";

export interface EvidenceRecord {
  readonly id: string;
  readonly knowledgeId: string;
  readonly status: EvidenceStatus;
}

export interface SkippedStableResponse {
  readonly skip_reason: SkipReason;
  readonly staled_knowledge_ids: readonly string[];
  readonly state: "skipped";
  readonly withdrawn_evidence_ids: readonly string[];
}

export interface ManualReviewMarker {
  readonly evidenceIds: readonly string[];
  readonly reason: "insufficient_context";
  readonly required: true;
}

export interface SkipPolicyInput {
  readonly duplicateKnowledgeId?: string;
  readonly evidence: readonly EvidenceRecord[];
  readonly skipReason: SkipReason;
}

export interface SkipPolicyResult {
  readonly evidence: readonly EvidenceRecord[];
  readonly manualReview: ManualReviewMarker | null;
  readonly reassociatedEvidenceIds: readonly string[];
  readonly stableResponse: SkippedStableResponse;
}

/** Returns whether a skip reason permits active evidence withdrawal. */
export function isDefinitiveNonKnowledge(
  skipReason: SkipReason,
): skipReason is DefinitiveNonKnowledgeSkipReason {
  return DEFINITIVE_NON_KNOWLEDGE_SKIP_REASONS.some(
    (reason) => reason === skipReason,
  );
}

/**
 * Applies the zero-candidate evidence policy without mutating its input.
 * Persistence code can atomically record the stable response and returned
 * evidence changes, while manual-review-only outcomes remain mutation free.
 */
export function applySkipReasonPolicy(
  input: SkipPolicyInput,
): SkipPolicyResult {
  assertUniqueEvidenceIds(input.evidence);

  if (isDefinitiveNonKnowledge(input.skipReason)) {
    return withdrawActiveEvidence(input.skipReason, input.evidence);
  }

  if (input.skipReason === "insufficient_context") {
    const evidence = cloneEvidence(input.evidence);
    return {
      evidence,
      manualReview: {
        evidenceIds: activeEvidenceIds(evidence),
        reason: "insufficient_context",
        required: true,
      },
      reassociatedEvidenceIds: [],
      stableResponse: skippedResponse("insufficient_context"),
    };
  }

  if (input.duplicateKnowledgeId === undefined) {
    return {
      evidence: cloneEvidence(input.evidence),
      manualReview: null,
      reassociatedEvidenceIds: [],
      stableResponse: skippedResponse("duplicate_noise"),
    };
  }

  if (input.duplicateKnowledgeId.length === 0) {
    throw new TypeError("duplicateKnowledgeId must not be empty");
  }

  return reassociateDuplicateEvidence(
    input.evidence,
    input.duplicateKnowledgeId,
  );
}

function withdrawActiveEvidence(
  skipReason: DefinitiveNonKnowledgeSkipReason,
  currentEvidence: readonly EvidenceRecord[],
): SkipPolicyResult {
  const withdrawnEvidenceIds: string[] = [];
  const evidence = currentEvidence.map((record) => {
    if (record.status !== "active") {
      return { ...record };
    }

    withdrawnEvidenceIds.push(record.id);
    return { ...record, status: "withdrawn" as const };
  });

  return {
    evidence,
    manualReview: null,
    reassociatedEvidenceIds: [],
    stableResponse: skippedResponse(
      skipReason,
      withdrawnEvidenceIds,
      findStaledKnowledgeIds(currentEvidence, evidence),
    ),
  };
}

function reassociateDuplicateEvidence(
  currentEvidence: readonly EvidenceRecord[],
  duplicateKnowledgeId: string,
): SkipPolicyResult {
  const reassociatedEvidenceIds: string[] = [];
  const evidence = currentEvidence.map((record) => {
    if (
      record.status !== "active" ||
      record.knowledgeId === duplicateKnowledgeId
    ) {
      return { ...record };
    }

    reassociatedEvidenceIds.push(record.id);
    return { ...record, knowledgeId: duplicateKnowledgeId };
  });

  return {
    evidence,
    manualReview: null,
    reassociatedEvidenceIds: sortAndDedupeStrings(reassociatedEvidenceIds),
    stableResponse: skippedResponse(
      "duplicate_noise",
      [],
      findStaledKnowledgeIds(currentEvidence, evidence),
    ),
  };
}

function skippedResponse(
  skipReason: SkipReason,
  withdrawnEvidenceIds: readonly string[] = [],
  staleKnowledgeIds: readonly string[] = [],
): SkippedStableResponse {
  return {
    skip_reason: skipReason,
    staled_knowledge_ids: sortAndDedupeStrings(staleKnowledgeIds),
    state: "skipped",
    withdrawn_evidence_ids: sortAndDedupeStrings(withdrawnEvidenceIds),
  };
}

function activeEvidenceIds(evidence: readonly EvidenceRecord[]): string[] {
  return sortAndDedupeStrings(
    evidence.filter(({ status }) => status === "active").map(({ id }) => id),
  );
}

function findStaledKnowledgeIds(
  before: readonly EvidenceRecord[],
  after: readonly EvidenceRecord[],
): string[] {
  const affectedKnowledgeIds = before
    .filter((record, index) => {
      const updated = after[index];
      return (
        record.status === "active" &&
        (updated?.status !== "active" ||
          updated.knowledgeId !== record.knowledgeId)
      );
    })
    .map(({ knowledgeId }) => knowledgeId);

  return sortAndDedupeStrings(affectedKnowledgeIds).filter(
    (knowledgeId) =>
      !after.some(
        (record) =>
          record.status === "active" && record.knowledgeId === knowledgeId,
      ),
  );
}

function cloneEvidence(evidence: readonly EvidenceRecord[]): EvidenceRecord[] {
  return evidence.map((record) => ({ ...record }));
}

function assertUniqueEvidenceIds(evidence: readonly EvidenceRecord[]): void {
  const ids = new Set<string>();
  for (const record of evidence) {
    if (ids.has(record.id)) {
      throw new TypeError(`Duplicate evidence id: ${record.id}`);
    }
    ids.add(record.id);
  }
}

import {
  canonicalizeJson,
  compareCodeUnits,
  sha256Jcs,
  sortAndDedupeStrings,
} from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  KnowledgeConflictError,
  type CanonicalTransactionRequest,
} from "./canonical-transaction-store.js";
import {
  KnowledgeIdSchema,
  KnowledgeRevisionPatchSchema,
  NonEmptyStringSchema,
  type KnowledgeEvidence,
  type KnowledgeRevisionPatch,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
} from "./domain-schemas.js";
import {
  KnowledgeSearchError,
  normalizeKnowledgeSearchQuery,
  type ExhaustiveKnowledgeSearchRequest,
} from "./knowledge-search.js";
import {
  applyKnowledgeDocumentPatch,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { scopesMayOverlap } from "./merge-candidate-service.js";
import type {
  CanonicalKnowledgeSearchView,
  CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";

import {
  AdminPlaneError,
  type AdminEvidenceReview,
  type AdminPossibleMatch,
  type AdminKnowledgeReview,
  type AdminRevisionProposalReview,
  type AdminKnowledgeReviewBinding,
  type AdminRevisionProposalReviewBinding,
  type AdminAddActiveInput,
  type CurrentKnowledge,
  type AdminSearchSubject,
} from "./admin-plane-types.js";

export function knowledgeReview(
  current: CurrentKnowledge,
  view: CanonicalKnowledgeSearchView,
  repo: string,
  repoId: string,
  possibleMatchLimit: number,
): AdminKnowledgeReview {
  const frontmatter = current.document.frontmatter;
  const possibleMatches = possibleMatchesForReview(
    view,
    repoId,
    current.projected.scope,
    possibleMatchLimit,
    current.projected.id,
  );
  return {
    category: current.projected.category,
    detail: current.projected.detail,
    etag: current.projected.etag,
    evidence: view.snapshot.domain.evidence
      .filter(
        (evidence) =>
          evidence.repo_id === repoId &&
          evidence.knowledge_id === current.projected.id,
      )
      .sort(compareEvidenceForReview)
      .map(adminEvidence),
    id: current.projected.id,
    origin: optionalRecord(frontmatter.origin, "origin", current.projected.id),
    possible_matches: possibleMatches,
    related_ids: relatedIds(frontmatter.related_ids, current.projected.id),
    repo,
    revision: current.projected.revision,
    rule: current.projected.rule,
    scope: current.projected.scope,
    severity: current.projected.severity,
    status: current.projected.status,
  };
}

function adminEvidence(evidence: KnowledgeEvidence): AdminEvidenceReview {
  return {
    actors: evidence.actors,
    comment_ids: evidence.comment_ids,
    evidence_id: evidence.evidence_id,
    observed_at: evidence.observed_at,
    originator: evidence.originator,
    sources: evidence.sources,
    status: evidence.status,
    ...(evidence.url === undefined ? {} : { url: evidence.url }),
  };
}

function compareEvidenceForReview(
  left: KnowledgeEvidence,
  right: KnowledgeEvidence,
): number {
  const statusOrder =
    evidenceStatusRank(left.status) - evidenceStatusRank(right.status);
  return (
    statusOrder ||
    compareCodeUnits(right.observed_at, left.observed_at) ||
    compareCodeUnits(left.evidence_id, right.evidence_id)
  );
}

function evidenceStatusRank(status: KnowledgeEvidence["status"]): number {
  switch (status) {
    case "active":
      return 0;
    case "superseded":
      return 1;
    case "withdrawn":
      return 2;
  }
}

export function findKnowledge(
  snapshot: CanonicalProjectionSnapshot,
  id: string,
  repoId: string,
): CurrentKnowledge {
  const projected = snapshot.domain.knowledge.find(
    (knowledge) => knowledge.id === id && knowledge.repoId === repoId,
  );
  if (projected === undefined) {
    throw new AdminPlaneError(
      "KNOWLEDGE_NOT_FOUND",
      `knowledge ${id} was not found in this repository`,
    );
  }
  const document = snapshot.knowledge.find(
    (candidate) =>
      candidate.path === projected.path &&
      candidate.frontmatter.id === projected.id &&
      candidate.frontmatter.repo_id === repoId,
  );
  if (document === undefined) {
    throw new AdminPlaneError(
      "ADMIN_PROJECTION_INVALID",
      `knowledge ${id} has no matching canonical document`,
    );
  }
  return { document, projected };
}

export function findProposal(
  snapshot: CanonicalProjectionSnapshot,
  proposalId: string,
  repoId: string,
): KnowledgeRevisionProposal {
  const proposal = snapshot.domain.revisionProposals.find(
    (candidate) =>
      candidate.proposal_id === proposalId && candidate.repo_id === repoId,
  );
  if (proposal === undefined) {
    throw new AdminPlaneError(
      "REVISION_PROPOSAL_NOT_FOUND",
      `revision proposal ${proposalId} was not found`,
    );
  }
  return proposal;
}

export function adminSearchRequests(
  subject: AdminSearchSubject,
  repoId: string,
): ExhaustiveKnowledgeSearchRequest[] {
  const requests: ExhaustiveKnowledgeSearchRequest[] = [];
  const normalizedQueries = new Set<string>();
  for (const value of [subject.rule, subject.detail]) {
    try {
      const query = normalizeKnowledgeSearchQuery(value).normalized;
      if (normalizedQueries.has(query)) continue;
      normalizedQueries.add(query);
      requests.push({
        category: subject.category,
        query,
        repoId,
        statuses: ["active", "proposed", "stale"],
      });
    } catch (error) {
      if (!(error instanceof KnowledgeSearchError)) throw error;
    }
  }
  return requests;
}

export function possibleMatchesForReview(
  view: CanonicalKnowledgeSearchView,
  repoId: string,
  scope: readonly string[],
  possibleMatchLimit: number,
  excludedId?: string,
): AdminPossibleMatch[] {
  const matches: AdminPossibleMatch[] = [];
  const seenIds = new Set<string>();
  const maximumRank = Math.max(
    0,
    ...view.searchResults.map((result) => result.hits.length),
  );
  for (let rank = 0; rank < maximumRank; rank += 1) {
    for (const result of view.searchResults) {
      const match = result.hits[rank];
      if (
        match === undefined ||
        match.id === excludedId ||
        seenIds.has(match.id) ||
        match.repoId !== repoId ||
        !scopesMayOverlap(scope, match.scope)
      ) {
        continue;
      }
      seenIds.add(match.id);
      matches.push({
        etag: match.etag,
        id: match.id,
        revision: match.revision,
        rule: match.rule,
        scope: match.scope,
        severity: match.severity,
        status: match.status,
      });
      if (matches.length === possibleMatchLimit) return matches;
    }
  }
  return matches;
}

export function findRevisionMutation(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  expectedKnowledge: AdminKnowledgeReviewBinding,
  expectedProposal: AdminRevisionProposalReviewBinding,
): {
  readonly current: CurrentKnowledge;
  readonly proposal: KnowledgeRevisionProposal;
} {
  if (
    canonicalizeJson(expectedProposal.knowledge) !==
    canonicalizeJson(expectedKnowledge)
  ) {
    throw new TypeError("reviewed proposal and knowledge bindings must match");
  }
  const current = findKnowledge(snapshot, expectedKnowledge.id, repoId);
  assertMutationBinding(current.document, expectedKnowledge);
  assertEditableStatus(current.projected.status);
  const proposal = findProposal(snapshot, expectedProposal.proposalId, repoId);
  if (proposal.knowledge_id !== current.projected.id) {
    throw new AdminPlaneError(
      "ADMIN_PROJECTION_INVALID",
      `proposal ${proposal.proposal_id} changed its knowledge target`,
    );
  }
  if (proposal.status !== "pending") {
    throw new AdminPlaneError(
      "REVISION_PROPOSAL_NOT_PENDING",
      `revision proposal ${proposal.proposal_id} is ${proposal.status}`,
    );
  }
  if (sha256Jcs(proposal) !== expectedProposal.proposalEtag) {
    throw new AdminPlaneError(
      "REVISION_PROPOSAL_CHANGED",
      `revision proposal ${proposal.proposal_id} changed after review`,
    );
  }
  return { current, proposal };
}

export function revisionProposalEvent(
  payload: KnowledgeRevisionProposal,
  recordType:
    | "KnowledgeRevisionProposalApproved"
    | "KnowledgeRevisionProposalEdited"
    | "KnowledgeRevisionProposalRejected",
  recordedAt: string,
  recordId: string,
  transactionId: string,
): CanonicalJsonlRecord<KnowledgeRevisionProposal> {
  return {
    payload,
    record_id: recordId,
    record_type: recordType,
    recorded_at: recordedAt,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

export function binding(
  review: AdminKnowledgeReview,
): AdminKnowledgeReviewBinding {
  return { etag: review.etag, id: review.id, revision: review.revision };
}

export function revisionBinding(
  review: AdminRevisionProposalReview,
): AdminRevisionProposalReviewBinding {
  return {
    knowledge: binding(review.knowledge),
    proposalEtag: sha256Jcs(review.proposal),
    proposalId: review.proposal.proposal_id,
  };
}

export function parseKnowledgeBinding(
  value: AdminKnowledgeReviewBinding,
): AdminKnowledgeReviewBinding {
  const id = KnowledgeIdSchema.parse(value.id);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError(
      "reviewed knowledge revision must be a positive integer",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(value.etag)) {
    throw new TypeError("reviewed knowledge ETag must be a lowercase SHA-256");
  }
  return { etag: value.etag, id, revision: value.revision };
}

export function parseRevisionBinding(
  value: AdminRevisionProposalReviewBinding,
): AdminRevisionProposalReviewBinding {
  const proposalId = NonEmptyStringSchema.parse(value.proposalId);
  if (!/^[a-f0-9]{64}$/u.test(value.proposalEtag)) {
    throw new TypeError("reviewed proposal ETag must be a lowercase SHA-256");
  }
  return {
    knowledge: parseKnowledgeBinding(value.knowledge),
    proposalEtag: value.proposalEtag,
    proposalId,
  };
}

export function assertMutationBinding(
  current: KnowledgeDocument,
  expected: AdminKnowledgeReviewBinding,
): void {
  if (
    current.frontmatter.id !== expected.id ||
    current.revision !== expected.revision ||
    current.etag !== expected.etag
  ) {
    throw new KnowledgeConflictError(current);
  }
}

export function assertStatusTransition(
  current: KnowledgeStatus,
  target: "active" | "rejected",
): void {
  if (
    (current !== "proposed" && current !== "stale") ||
    (target !== "active" && target !== "rejected")
  ) {
    throw new AdminPlaneError(
      "INVALID_ADMIN_STATE",
      `cannot transition knowledge from ${current} to ${target}`,
    );
  }
}

export function assertEditableStatus(status: KnowledgeStatus): void {
  if (status !== "active" && status !== "proposed" && status !== "stale") {
    throw new AdminPlaneError(
      "INVALID_ADMIN_STATE",
      `knowledge in ${status} state cannot be edited by this flow`,
    );
  }
}

export function assertKnowledgeStatus(
  review: AdminKnowledgeReview,
  allowed: readonly KnowledgeStatus[],
  action: string,
): void {
  if (!allowed.includes(review.status)) {
    throw new AdminPlaneError(
      "INVALID_ADMIN_STATE",
      `${action} is not allowed for knowledge in ${review.status} state`,
    );
  }
}

export function applyRevisionPatch(
  current: KnowledgeDocument,
  patch: KnowledgeRevisionPatch,
  updatedAt: string,
): string {
  const { detail, ...frontmatterPatch } = patch;
  return applyKnowledgeDocumentPatch(current, {
    ...(detail === undefined ? {} : { body: detail }),
    frontmatter: { ...frontmatterPatch, updated_at: updatedAt },
  });
}

export function fileTransaction(
  current: KnowledgeDocument,
  content: string,
  createdAt: string,
  transactionId: string,
): CanonicalTransactionRequest {
  return {
    appendRecords: [],
    createdAt,
    fileWrites: [
      {
        content,
        expectedSha256: current.etag,
        targetPath: current.path,
      },
    ],
    transactionId,
  };
}

export function humanActivationValue(
  current: KnowledgeDocument,
): Readonly<Record<string, unknown>> {
  const activation = optionalRecord(
    current.frontmatter.activation,
    "activation",
    current.frontmatter.id,
  );
  return { origin: "human", pinned: activation?.pinned === true };
}

export function parseAddActiveInput(
  input: AdminAddActiveInput,
): Required<AdminAddActiveInput> {
  const patch = KnowledgeRevisionPatchSchema.parse({
    category: input.category,
    detail: input.detail,
    rule: input.rule,
    scope: input.scope,
    severity: input.severity,
  });
  return {
    category: patch.category!,
    detail: patch.detail!,
    related_ids: sortAndDedupeStrings(
      (input.related_ids ?? []).map((id) => KnowledgeIdSchema.parse(id)),
    ),
    rule: patch.rule!,
    scope: patch.scope!,
    severity: patch.severity!,
  };
}

function relatedIds(value: unknown, knowledgeId: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw projectionInvalid(knowledgeId, "related_ids must be an array");
  }
  try {
    return sortAndDedupeStrings(value.map((id) => KnowledgeIdSchema.parse(id)));
  } catch (error) {
    throw projectionInvalid(knowledgeId, "related_ids are invalid", error);
  }
}

function optionalRecord(
  value: unknown,
  label: string,
  knowledgeId: string,
): Readonly<Record<string, unknown>> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw projectionInvalid(knowledgeId, `${label} must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

export function renderKnowledgeAction(
  action: "APPROVE" | "REJECT",
  review: AdminKnowledgeReview,
): string {
  return [`ADMIN ACTION: ${action}`, ...knowledgeReviewLines(review)].join(
    "\n",
  );
}

export function renderEditAction(
  review: AdminKnowledgeReview,
  patch: KnowledgeRevisionPatch,
): string {
  return [
    "ADMIN ACTION: EDIT",
    ...knowledgeReviewLines(review),
    `Patch: ${safeTerminalValue(patch)}`,
  ].join("\n");
}

export function renderRevisionAction(
  review: AdminRevisionProposalReview,
): string {
  return [
    "ADMIN ACTION: APPROVE REVISION",
    ...knowledgeReviewLines(review.knowledge),
    `Proposal ID: ${safeTerminalValue(review.proposal.proposal_id)}`,
    `Patch: ${safeTerminalValue(review.proposal.patch)}`,
    `Evidence IDs: ${safeTerminalValue(review.proposal.evidence_ids)}`,
  ].join("\n");
}

export function renderAddActiveAction(
  input: Required<AdminAddActiveInput>,
  possibleMatches: readonly AdminPossibleMatch[],
): string {
  return [
    "ADMIN ACTION: ADD ACTIVE",
    `Rule: ${safeTerminalValue(input.rule)}`,
    `Detail: ${safeTerminalValue(input.detail)}`,
    `Category: ${safeTerminalValue(input.category)}`,
    `Severity: ${safeTerminalValue(input.severity)}`,
    `Scope: ${safeTerminalValue(input.scope)}`,
    `Related IDs: ${safeTerminalValue(input.related_ids)}`,
    `Possible matches: ${safeTerminalValue(possibleMatches)}`,
    'Origin: {"type":"manual"}',
  ].join("\n");
}

function knowledgeReviewLines(review: AdminKnowledgeReview): string[] {
  return [
    `Repository: ${safeTerminalValue(review.repo)}`,
    `Knowledge ID: ${safeTerminalValue(review.id)}`,
    `Status: ${safeTerminalValue(review.status)}`,
    `Revision: ${String(review.revision)}`,
    `ETag: ${review.etag}`,
    `Rule: ${safeTerminalValue(review.rule)}`,
    `Detail: ${safeTerminalValue(review.detail)}`,
    `Category: ${safeTerminalValue(review.category)}`,
    `Severity: ${safeTerminalValue(review.severity)}`,
    `Scope: ${safeTerminalValue(review.scope)}`,
    `Evidence: ${safeTerminalValue(review.evidence)}`,
    `Actor trust: ${safeTerminalValue(
      review.evidence.flatMap((evidence) =>
        evidence.actors.map((actor) => ({
          comment_id: actor.comment_id,
          login: actor.login ?? null,
          provider: actor.provider,
          trust: actor.trust,
        })),
      ),
    )}`,
    `Origin: ${safeTerminalValue(review.origin)}`,
    `Related IDs: ${safeTerminalValue(review.related_ids)}`,
    `Possible matches: ${safeTerminalValue(review.possible_matches)}`,
  ];
}

export function safeTerminalValue(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replaceAll(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

export function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError("possibleMatchLimit must be between 1 and 100");
  }
  return value;
}

export function canonicalProposalPath(value: string): string {
  const path = NonEmptyStringSchema.parse(value);
  if (!/^events\/(?!.*(?:^|\/)\.\.?\/)[^/]+\.jsonl$/u.test(path)) {
    throw new TypeError(
      "proposalEventPath must be a direct events/*.jsonl path",
    );
  }
  return path;
}

export function operationTime(
  now: Date,
  floor?: string,
): {
  readonly recordedAt: string;
  readonly timestamp: number;
} {
  const clock = now.getTime();
  if (!Number.isSafeInteger(clock) || clock < 0) {
    throw new TypeError("now() returned an invalid Date");
  }
  const timestamp = Math.max(
    clock,
    floor === undefined ? 0 : Date.parse(floor),
  );
  return { recordedAt: new Date(timestamp).toISOString(), timestamp };
}

export function latestIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function projectionInvalid(
  knowledgeId: string,
  message: string,
  cause?: unknown,
): AdminPlaneError {
  return new AdminPlaneError(
    "ADMIN_PROJECTION_INVALID",
    `knowledge ${knowledgeId}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

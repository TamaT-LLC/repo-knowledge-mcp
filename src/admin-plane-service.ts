import { createInterface } from "node:readline/promises";

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  CanonicalTransactionStore,
  KnowledgeConflictError,
  type CanonicalTransactionRequest,
} from "./canonical-transaction-store.js";
import {
  EventIdSchema,
  KnowledgeIdSchema,
  KnowledgeRevisionPatchSchema,
  KnowledgeRevisionProposalSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  TransactionIdSchema,
  type EvidenceActor,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeRevisionPatch,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
  type Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import { createDomainId } from "./ids.js";
import {
  KnowledgeSearchError,
  normalizeKnowledgeSearchQuery,
  type ExhaustiveKnowledgeSearchRequest,
} from "./knowledge-search.js";
import {
  applyKnowledgeDocumentPatch,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { scopesMayOverlap } from "./merge-candidate-service.js";
import { REVISION_PROPOSAL_EVENT_PATH } from "./canonical-finalize-service.js";
import type {
  CanonicalKnowledgeReadView,
  CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";

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

interface CurrentKnowledge {
  readonly document: KnowledgeDocument;
  readonly projected: ProjectedKnowledge;
}

interface MutationBinding {
  readonly etag: string;
  readonly id: string;
  readonly revision: number;
}

interface AdminSearchSubject {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly rule: string;
  readonly scope: readonly string[];
}

/**
 * Human-only review and mutation service. Every state-changing public method
 * verifies a real TTY, renders the current canonical generation, and requires
 * an action-specific phrase before entering the CAS write path.
 */
export class AdminPlaneService {
  readonly repo: string;
  readonly repoId: string;

  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextKnowledgeId: (timestamp: number) => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly possibleMatchLimit: number;
  private readonly proposalEventPath: string;
  private readonly repository: CanonicalTransactionStore;

  constructor(options: AdminPlaneServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextKnowledgeId =
      options.nextKnowledgeId ??
      ((timestamp) => createDomainId("knowledge", timestamp));
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
    this.possibleMatchLimit = positiveLimit(
      options.possibleMatchLimit ?? DEFAULT_ADMIN_POSSIBLE_MATCH_LIMIT,
    );
    this.proposalEventPath = canonicalProposalPath(
      options.proposalEventPath ?? REVISION_PROPOSAL_EVENT_PATH,
    );
  }

  async listReviewQueue(): Promise<AdminReviewQueue> {
    const snapshot = (await this.repository.readKnowledgeView()).snapshot;
    return {
      knowledge: snapshot.domain.knowledge
        .filter(
          (
            knowledge,
          ): knowledge is ProjectedKnowledge & {
            readonly status: "proposed" | "stale";
          } =>
            knowledge.repoId === this.repoId &&
            (knowledge.status === "proposed" || knowledge.status === "stale"),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map((knowledge) => ({
          etag: knowledge.etag,
          evidence_count: knowledge.evidenceCount,
          id: knowledge.id,
          revision: knowledge.revision,
          rule: knowledge.rule,
          severity: knowledge.severity,
          status: knowledge.status,
        })),
      repo: this.repo,
      revision_proposals: snapshot.domain.revisionProposals
        .filter(
          (proposal) =>
            proposal.repo_id === this.repoId && proposal.status === "pending",
        )
        .sort((left, right) =>
          compareCodeUnits(left.proposal_id, right.proposal_id),
        )
        .map((proposal) => ({
          knowledge_id: proposal.knowledge_id,
          proposal_id: proposal.proposal_id,
          updated_at: proposal.updated_at,
        })),
    };
  }

  async getKnowledgeReview(id: string): Promise<AdminKnowledgeReview> {
    const knowledgeId = KnowledgeIdSchema.parse(id);
    const initial = (await this.repository.readKnowledgeView()).snapshot;
    const initialKnowledge = findKnowledge(initial, knowledgeId, this.repoId);
    const searchRequest = adminSearchRequest(
      initialKnowledge.projected,
      this.repoId,
    );
    const view = await this.repository.readKnowledgeView(searchRequest);
    return knowledgeReview(
      findKnowledge(view.snapshot, knowledgeId, this.repoId),
      view,
      this.repo,
      this.repoId,
      this.possibleMatchLimit,
    );
  }

  async getRevisionProposalReview(
    proposalId: string,
  ): Promise<AdminRevisionProposalReview> {
    const id = NonEmptyStringSchema.parse(proposalId);
    const snapshot = (await this.repository.readKnowledgeView()).snapshot;
    const proposal = findProposal(snapshot, id, this.repoId);
    return {
      knowledge: await this.getKnowledgeReview(proposal.knowledge_id),
      proposal,
    };
  }

  async approve(
    id: string,
  ): Promise<AdminInteractionResult<KnowledgeDocument>> {
    this.assertInteractiveTerminal();
    const review = await this.getKnowledgeReview(id);
    assertKnowledgeStatus(review, ["proposed", "stale"], "approve");
    if (
      !(await this.confirm(
        `approve ${review.id}`,
        renderKnowledgeAction("APPROVE", review),
      ))
    ) {
      return { confirmed: false };
    }
    return {
      confirmed: true,
      value: await this.mutateKnowledgeStatus(binding(review), "active", true),
    };
  }

  async reject(id: string): Promise<AdminInteractionResult<KnowledgeDocument>> {
    this.assertInteractiveTerminal();
    const review = await this.getKnowledgeReview(id);
    assertKnowledgeStatus(review, ["proposed", "stale"], "reject");
    if (
      !(await this.confirm(
        `reject ${review.id}`,
        renderKnowledgeAction("REJECT", review),
      ))
    ) {
      return { confirmed: false };
    }
    return {
      confirmed: true,
      value: await this.mutateKnowledgeStatus(
        binding(review),
        "rejected",
        false,
      ),
    };
  }

  async edit(
    id: string,
    patch: KnowledgeRevisionPatch,
  ): Promise<AdminInteractionResult<KnowledgeDocument>> {
    this.assertInteractiveTerminal();
    const parsedPatch = KnowledgeRevisionPatchSchema.parse(patch);
    const review = await this.getKnowledgeReview(id);
    assertKnowledgeStatus(review, ["active", "proposed", "stale"], "edit");
    if (
      !(await this.confirm(
        `edit ${review.id}`,
        renderEditAction(review, parsedPatch),
      ))
    ) {
      return { confirmed: false };
    }
    return {
      confirmed: true,
      value: await this.mutateKnowledgeEdit(binding(review), parsedPatch),
    };
  }

  async approveRevision(
    proposalId: string,
  ): Promise<AdminInteractionResult<KnowledgeDocument>> {
    this.assertInteractiveTerminal();
    const review = await this.getRevisionProposalReview(proposalId);
    if (review.proposal.status !== "pending") {
      throw new AdminPlaneError(
        "REVISION_PROPOSAL_NOT_PENDING",
        `revision proposal ${review.proposal.proposal_id} is ${review.proposal.status}`,
      );
    }
    assertKnowledgeStatus(
      review.knowledge,
      ["active", "proposed", "stale"],
      "approve-revision",
    );
    if (
      !(await this.confirm(
        `approve-revision ${review.proposal.proposal_id}`,
        renderRevisionAction(review),
      ))
    ) {
      return { confirmed: false };
    }
    return {
      confirmed: true,
      value: await this.mutateRevisionProposal(
        binding(review.knowledge),
        review.proposal,
      ),
    };
  }

  async addActive(
    input: AdminAddActiveInput,
  ): Promise<AdminInteractionResult<KnowledgeDocument>> {
    this.assertInteractiveTerminal();
    const parsed = parseAddActiveInput(input);
    const possibleMatches = await this.findPossibleMatches(parsed);
    if (
      !(await this.confirm(
        "add --active",
        renderAddActiveAction(parsed, possibleMatches),
      ))
    ) {
      return { confirmed: false };
    }
    return { confirmed: true, value: await this.createActiveKnowledge(parsed) };
  }

  private async findPossibleMatches(
    subject: AdminSearchSubject,
  ): Promise<readonly AdminPossibleMatch[]> {
    const searchRequest = adminSearchRequest(subject, this.repoId);
    if (searchRequest === undefined) {
      throw new AdminPlaneError(
        "POSSIBLE_MATCH_QUERY_INVALID",
        "add --active requires rule or detail that can be normalized for possible-match review",
      );
    }
    const view = await this.repository.readKnowledgeView(searchRequest);
    return possibleMatchesForReview(
      view,
      this.repoId,
      subject.scope,
      this.possibleMatchLimit,
    );
  }

  private async confirm(expected: string, screen: string): Promise<boolean> {
    process.stdout.write(
      `${screen}\nRequired confirmation: ${safeTerminalValue(expected)}\n`,
    );
    const input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await input.question("admin> ");
      return answer.trim() === expected;
    } finally {
      input.close();
    }
  }

  private assertInteractiveTerminal(): void {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      throw new AdminPlaneError(
        "TTY_REQUIRED",
        "admin mutations require both stdin and stdout to be real TTYs",
      );
    }
  }

  private async mutateKnowledgeStatus(
    expected: MutationBinding,
    status: "active" | "rejected",
    humanActivation: boolean,
  ): Promise<KnowledgeDocument> {
    return this.repository.runLockedMutation((snapshot) => {
      const current = findKnowledge(snapshot, expected.id, this.repoId);
      assertMutationBinding(current.document, expected);
      assertStatusTransition(current.projected.status, status);
      const operation = operationTime(this.now(), current.projected.updatedAt);
      const activation = humanActivation
        ? humanActivationValue(current.document)
        : undefined;
      const content = applyKnowledgeDocumentPatch(current.document, {
        frontmatter: {
          ...(activation === undefined ? {} : { activation }),
          status,
          updated_at: operation.recordedAt,
        },
      });
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      return {
        transaction: fileTransaction(
          current.document,
          content,
          operation.recordedAt,
          transactionId,
        ),
        value: parseKnowledgeDocument(current.document.path, content),
      };
    });
  }

  private async mutateKnowledgeEdit(
    expected: MutationBinding,
    patch: KnowledgeRevisionPatch,
  ): Promise<KnowledgeDocument> {
    return this.repository.runLockedMutation((snapshot) => {
      const current = findKnowledge(snapshot, expected.id, this.repoId);
      assertMutationBinding(current.document, expected);
      assertEditableStatus(current.projected.status);
      const operation = operationTime(this.now(), current.projected.updatedAt);
      const content = applyRevisionPatch(
        current.document,
        patch,
        operation.recordedAt,
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      return {
        transaction: fileTransaction(
          current.document,
          content,
          operation.recordedAt,
          transactionId,
        ),
        value: parseKnowledgeDocument(current.document.path, content),
      };
    });
  }

  private async mutateRevisionProposal(
    expected: MutationBinding,
    expectedProposal: KnowledgeRevisionProposal,
  ): Promise<KnowledgeDocument> {
    return this.repository.runLockedMutation((snapshot) => {
      const current = findKnowledge(snapshot, expected.id, this.repoId);
      assertMutationBinding(current.document, expected);
      assertEditableStatus(current.projected.status);
      const proposal = findProposal(
        snapshot,
        expectedProposal.proposal_id,
        this.repoId,
      );
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
      if (canonicalizeJson(proposal) !== canonicalizeJson(expectedProposal)) {
        throw new AdminPlaneError(
          "REVISION_PROPOSAL_CHANGED",
          `revision proposal ${proposal.proposal_id} changed after confirmation`,
        );
      }
      const operation = operationTime(
        this.now(),
        latestIso(current.projected.updatedAt, proposal.updated_at),
      );
      const content = applyRevisionPatch(
        current.document,
        proposal.patch,
        operation.recordedAt,
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const approved = KnowledgeRevisionProposalSchema.parse({
        ...proposal,
        status: "approved",
        updated_at: operation.recordedAt,
      });
      const event: CanonicalJsonlRecord<KnowledgeRevisionProposal> = {
        payload: approved,
        record_id: EventIdSchema.parse(this.nextEventId(operation.timestamp)),
        record_type: "KnowledgeRevisionProposalApproved",
        recorded_at: operation.recordedAt,
        schema_version: 1,
        transaction_id: transactionId,
      };
      return {
        transaction: {
          appendRecords: [
            { record: event, targetPath: this.proposalEventPath },
          ],
          createdAt: operation.recordedAt,
          fileWrites: [
            {
              content,
              expectedSha256: current.document.etag,
              targetPath: current.document.path,
            },
          ],
          transactionId,
        },
        value: parseKnowledgeDocument(current.document.path, content),
      };
    });
  }

  private async createActiveKnowledge(
    input: Required<AdminAddActiveInput>,
  ): Promise<KnowledgeDocument> {
    return this.repository.runLockedMutation((snapshot) => {
      const operation = operationTime(this.now());
      const knowledgeId = KnowledgeIdSchema.parse(
        this.nextKnowledgeId(operation.timestamp),
      );
      if (snapshot.domain.knowledge.some((item) => item.id === knowledgeId)) {
        throw new AdminPlaneError(
          "ADMIN_PROJECTION_INVALID",
          `generated knowledge ID ${knowledgeId} already exists`,
        );
      }
      for (const relatedId of input.related_ids) {
        const related = snapshot.domain.knowledge.find(
          (item) => item.id === relatedId && item.repoId === this.repoId,
        );
        if (
          related === undefined ||
          related.status === "deprecated" ||
          related.status === "rejected"
        ) {
          throw new AdminPlaneError(
            "KNOWLEDGE_NOT_FOUND",
            `related knowledge ${relatedId} is not available in this repository`,
          );
        }
      }
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const path = `knowledge/${knowledgeId}.md`;
      const content = serializeKnowledgeDocument(
        path,
        {
          activation: { origin: "human", pinned: false },
          category: input.category,
          created_at: operation.recordedAt,
          id: knowledgeId,
          origin: { type: "manual" },
          related_ids: input.related_ids,
          repo_id: this.repoId,
          revision: 1,
          rule: input.rule,
          schema_version: 1,
          scope: input.scope,
          severity: input.severity,
          status: "active",
          updated_at: operation.recordedAt,
        },
        input.detail,
      );
      return {
        transaction: {
          appendRecords: [],
          createdAt: operation.recordedAt,
          fileWrites: [{ content, expectedSha256: null, targetPath: path }],
          transactionId,
        },
        value: parseKnowledgeDocument(path, content),
      };
    });
  }
}

function knowledgeReview(
  current: CurrentKnowledge,
  view: CanonicalKnowledgeReadView,
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

function findKnowledge(
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

function findProposal(
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

function adminSearchRequest(
  subject: AdminSearchSubject,
  repoId: string,
): ExhaustiveKnowledgeSearchRequest | undefined {
  for (const value of [subject.rule, subject.detail]) {
    try {
      return {
        category: subject.category,
        query: normalizeKnowledgeSearchQuery(value).normalized,
        repoId,
        statuses: ["active", "proposed", "stale"],
      };
    } catch (error) {
      if (!(error instanceof KnowledgeSearchError)) throw error;
    }
  }
  return undefined;
}

function possibleMatchesForReview(
  view: CanonicalKnowledgeReadView,
  repoId: string,
  scope: readonly string[],
  possibleMatchLimit: number,
  excludedId?: string,
): AdminPossibleMatch[] {
  return (view.searchResult?.hits ?? [])
    .filter(
      (match) =>
        match.id !== excludedId &&
        match.repoId === repoId &&
        scopesMayOverlap(scope, match.scope),
    )
    .slice(0, possibleMatchLimit)
    .map((match) => ({
      etag: match.etag,
      id: match.id,
      revision: match.revision,
      rule: match.rule,
      scope: match.scope,
      severity: match.severity,
      status: match.status,
    }));
}

function binding(review: AdminKnowledgeReview): MutationBinding {
  return { etag: review.etag, id: review.id, revision: review.revision };
}

function assertMutationBinding(
  current: KnowledgeDocument,
  expected: MutationBinding,
): void {
  if (
    current.frontmatter.id !== expected.id ||
    current.revision !== expected.revision ||
    current.etag !== expected.etag
  ) {
    throw new KnowledgeConflictError(current);
  }
}

function assertStatusTransition(
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

function assertEditableStatus(status: KnowledgeStatus): void {
  if (status !== "active" && status !== "proposed" && status !== "stale") {
    throw new AdminPlaneError(
      "INVALID_ADMIN_STATE",
      `knowledge in ${status} state cannot be edited by this flow`,
    );
  }
}

function assertKnowledgeStatus(
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

function applyRevisionPatch(
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

function fileTransaction(
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

function humanActivationValue(
  current: KnowledgeDocument,
): Readonly<Record<string, unknown>> {
  const activation = optionalRecord(
    current.frontmatter.activation,
    "activation",
    current.frontmatter.id,
  );
  return { origin: "human", pinned: activation?.pinned === true };
}

function parseAddActiveInput(
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

function renderKnowledgeAction(
  action: "APPROVE" | "REJECT",
  review: AdminKnowledgeReview,
): string {
  return [`ADMIN ACTION: ${action}`, ...knowledgeReviewLines(review)].join(
    "\n",
  );
}

function renderEditAction(
  review: AdminKnowledgeReview,
  patch: KnowledgeRevisionPatch,
): string {
  return [
    "ADMIN ACTION: EDIT",
    ...knowledgeReviewLines(review),
    `Patch: ${safeTerminalValue(patch)}`,
  ].join("\n");
}

function renderRevisionAction(review: AdminRevisionProposalReview): string {
  return [
    "ADMIN ACTION: APPROVE REVISION",
    ...knowledgeReviewLines(review.knowledge),
    `Proposal ID: ${safeTerminalValue(review.proposal.proposal_id)}`,
    `Patch: ${safeTerminalValue(review.proposal.patch)}`,
    `Evidence IDs: ${safeTerminalValue(review.proposal.evidence_ids)}`,
  ].join("\n");
}

function renderAddActiveAction(
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

function safeTerminalValue(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replaceAll(
    /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError("possibleMatchLimit must be between 1 and 100");
  }
  return value;
}

function canonicalProposalPath(value: string): string {
  const path = NonEmptyStringSchema.parse(value);
  if (!/^events\/(?!.*(?:^|\/)\.\.?\/)[^/]+\.jsonl$/u.test(path)) {
    throw new TypeError(
      "proposalEventPath must be a direct events/*.jsonl path",
    );
  }
  return path;
}

function operationTime(
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

function latestIso(left: string, right: string): string {
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

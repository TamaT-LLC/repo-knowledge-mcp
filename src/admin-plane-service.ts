import { createInterface } from "node:readline/promises";

import { canonicalizeJson, compareCodeUnits } from "./canonical.js";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import {
  EventIdSchema,
  KnowledgeIdSchema,
  KnowledgeRevisionPatchSchema,
  KnowledgeRevisionProposalSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  TransactionIdSchema,
  type KnowledgeRevisionPatch,
  type KnowledgeRevisionProposal,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import { createDomainId } from "./ids.js";
import {
  applyKnowledgeDocumentPatch,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { REVISION_PROPOSAL_EVENT_PATH } from "./canonical-finalize-service.js";

import {
  DEFAULT_ADMIN_POSSIBLE_MATCH_LIMIT,
  AdminPlaneError,
  type AdminPossibleMatch,
  type AdminReviewQueue,
  type AdminKnowledgeReview,
  type AdminRevisionProposalReview,
  type AdminKnowledgeReviewBinding,
  type AdminRevisionProposalReviewBinding,
  type AdminInteractionResult,
  type AdminAddActiveInput,
  type AdminPlaneServiceOptions,
  type AdminSearchSubject,
} from "./admin-plane-types.js";
import {
  knowledgeReview,
  findKnowledge,
  findProposal,
  adminSearchRequests,
  possibleMatchesForReview,
  findRevisionMutation,
  revisionProposalEvent,
  binding,
  revisionBinding,
  parseKnowledgeBinding,
  parseRevisionBinding,
  assertMutationBinding,
  assertStatusTransition,
  assertEditableStatus,
  assertKnowledgeStatus,
  applyRevisionPatch,
  fileTransaction,
  humanActivationValue,
  parseAddActiveInput,
  renderKnowledgeAction,
  renderEditAction,
  renderRevisionAction,
  renderAddActiveAction,
  safeTerminalValue,
  positiveLimit,
  canonicalProposalPath,
  operationTime,
  latestIso,
} from "./admin-plane-operations.js";

export {
  DEFAULT_ADMIN_POSSIBLE_MATCH_LIMIT,
  type AdminPlaneErrorCode,
  AdminPlaneError,
  type AdminEvidenceReview,
  type AdminPossibleMatch,
  type AdminKnowledgeSummary,
  type AdminRevisionProposalSummary,
  type AdminReviewQueue,
  type AdminKnowledgeReview,
  type AdminRevisionProposalReview,
  type AdminKnowledgeReviewBinding,
  type AdminRevisionProposalReviewBinding,
  type AdminInteractionResult,
  type AdminAddActiveInput,
  type AdminPlaneServiceOptions,
} from "./admin-plane-types.js";
export { safeTerminalValue } from "./admin-plane-operations.js";

/**
 * Human-only review and mutation service. Every state-changing public method
 * verifies a real TTY and enters an exact-generation CAS write path. Ordinary
 * admin commands render and confirm here; batch methods consume the binding
 * already rendered and explicitly selected by the review session.
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
    const searchRequests = adminSearchRequests(
      initialKnowledge.projected,
      this.repoId,
    );
    const view = await this.repository.readKnowledgeSearchView(searchRequests);
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
        revisionBinding(review),
      ),
    };
  }

  /** Applies an already-rendered batch-review decision with exact CAS binding. */
  async approveReviewedKnowledge(
    expected: AdminKnowledgeReviewBinding,
  ): Promise<KnowledgeDocument> {
    this.assertInteractiveTerminal();
    return this.mutateKnowledgeStatus(
      parseKnowledgeBinding(expected),
      "active",
      true,
    );
  }

  /** Applies an already-rendered batch-review rejection with exact CAS binding. */
  async rejectReviewedKnowledge(
    expected: AdminKnowledgeReviewBinding,
  ): Promise<KnowledgeDocument> {
    this.assertInteractiveTerminal();
    return this.mutateKnowledgeStatus(
      parseKnowledgeBinding(expected),
      "rejected",
      false,
    );
  }

  /** Edits an already-rendered knowledge candidate without resolving it. */
  async editReviewedKnowledge(
    expected: AdminKnowledgeReviewBinding,
    patch: KnowledgeRevisionPatch,
  ): Promise<KnowledgeDocument> {
    this.assertInteractiveTerminal();
    return this.mutateKnowledgeEdit(
      parseKnowledgeBinding(expected),
      KnowledgeRevisionPatchSchema.parse(patch),
    );
  }

  /** Applies an already-rendered pending revision with exact proposal binding. */
  async approveReviewedRevision(
    expected: AdminRevisionProposalReviewBinding,
  ): Promise<KnowledgeDocument> {
    this.assertInteractiveTerminal();
    const parsed = parseRevisionBinding(expected);
    return this.mutateRevisionProposal(parsed.knowledge, parsed);
  }

  /** Rejects a pending revision without changing its target knowledge. */
  async rejectReviewedRevision(
    expected: AdminRevisionProposalReviewBinding,
  ): Promise<KnowledgeRevisionProposal> {
    this.assertInteractiveTerminal();
    const parsed = parseRevisionBinding(expected);
    return this.mutateRevisionProposalStatus(
      parsed.knowledge,
      parsed,
      "rejected",
    );
  }

  /** Merges a human patch into a pending revision and leaves it pending. */
  async editReviewedRevision(
    expected: AdminRevisionProposalReviewBinding,
    patch: KnowledgeRevisionPatch,
  ): Promise<KnowledgeRevisionProposal> {
    this.assertInteractiveTerminal();
    const parsed = parseRevisionBinding(expected);
    return this.mutateRevisionProposalEdit(
      parsed.knowledge,
      parsed,
      KnowledgeRevisionPatchSchema.parse(patch),
    );
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
    const searchRequests = adminSearchRequests(subject, this.repoId);
    if (searchRequests.length === 0) {
      throw new AdminPlaneError(
        "POSSIBLE_MATCH_QUERY_INVALID",
        "add --active requires rule or detail that can be normalized for possible-match review",
      );
    }
    const view = await this.repository.readKnowledgeSearchView(searchRequests);
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
    expected: AdminKnowledgeReviewBinding,
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
    expected: AdminKnowledgeReviewBinding,
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
    expected: AdminKnowledgeReviewBinding,
    expectedProposal: AdminRevisionProposalReviewBinding,
  ): Promise<KnowledgeDocument> {
    return this.repository.runLockedMutation((snapshot) => {
      const { current, proposal } = findRevisionMutation(
        snapshot,
        this.repoId,
        expected,
        expectedProposal,
      );
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
      const event = revisionProposalEvent(
        approved,
        "KnowledgeRevisionProposalApproved",
        operation.recordedAt,
        EventIdSchema.parse(this.nextEventId(operation.timestamp)),
        transactionId,
      );
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

  private async mutateRevisionProposalStatus(
    expected: AdminKnowledgeReviewBinding,
    expectedProposal: AdminRevisionProposalReviewBinding,
    status: "rejected",
  ): Promise<KnowledgeRevisionProposal> {
    return this.repository.runLockedMutation((snapshot) => {
      const { current, proposal } = findRevisionMutation(
        snapshot,
        this.repoId,
        expected,
        expectedProposal,
      );
      const operation = operationTime(
        this.now(),
        latestIso(current.projected.updatedAt, proposal.updated_at),
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const rejected = KnowledgeRevisionProposalSchema.parse({
        ...proposal,
        status,
        updated_at: operation.recordedAt,
      });
      return {
        transaction: {
          appendRecords: [
            {
              record: revisionProposalEvent(
                rejected,
                "KnowledgeRevisionProposalRejected",
                operation.recordedAt,
                EventIdSchema.parse(this.nextEventId(operation.timestamp)),
                transactionId,
              ),
              targetPath: this.proposalEventPath,
            },
          ],
          createdAt: operation.recordedAt,
          fileWrites: [],
          transactionId,
        },
        value: rejected,
      };
    });
  }

  private async mutateRevisionProposalEdit(
    expected: AdminKnowledgeReviewBinding,
    expectedProposal: AdminRevisionProposalReviewBinding,
    patch: KnowledgeRevisionPatch,
  ): Promise<KnowledgeRevisionProposal> {
    return this.repository.runLockedMutation((snapshot) => {
      const { current, proposal } = findRevisionMutation(
        snapshot,
        this.repoId,
        expected,
        expectedProposal,
      );
      const mergedPatch = KnowledgeRevisionPatchSchema.parse({
        ...proposal.patch,
        ...patch,
      });
      if (canonicalizeJson(mergedPatch) === canonicalizeJson(proposal.patch)) {
        return { transaction: null, value: proposal };
      }
      const operation = operationTime(
        this.now(),
        latestIso(current.projected.updatedAt, proposal.updated_at),
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const edited = KnowledgeRevisionProposalSchema.parse({
        ...proposal,
        patch: mergedPatch,
        updated_at: operation.recordedAt,
      });
      return {
        transaction: {
          appendRecords: [
            {
              record: revisionProposalEvent(
                edited,
                "KnowledgeRevisionProposalEdited",
                operation.recordedAt,
                EventIdSchema.parse(this.nextEventId(operation.timestamp)),
                transactionId,
              ),
              targetPath: this.proposalEventPath,
            },
          ],
          createdAt: operation.recordedAt,
          fileWrites: [],
          transactionId,
        },
        value: edited,
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

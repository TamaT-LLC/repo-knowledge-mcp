import { sortAndDedupeStrings } from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  CanonicalTransactionStore,
  type CanonicalAppendRecordRequest,
  type CanonicalFileWriteRequest,
  type CanonicalTransactionRequest,
} from "./canonical-transaction-store.js";
import {
  ExtractCandidateSchema,
  FinalizeStableResponseSchema,
  KnowledgeEvidenceSchema,
  KnowledgeRevisionProposalSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  SkipReasonSchema,
  SkippedStableResponseSchema,
  type CommentObservation,
  type DistillJob,
  type ExtractCandidate,
  type FinalizeStableResponse,
  type MergeDecision,
  type SkipReason,
  type ThreadObservation,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_SKIPPED,
  DISTILLATION_JOB_SUCCEEDED,
  applyDistillationJobRecord,
  createDistillationJobEventRecord,
} from "./distill-job-state.js";
import {
  DISTILL_JOB_EVENT_PATH,
  assertCurrentDistillJobLease,
  type DistillJobLeaseCredentials,
} from "./distill-job-coordinator.js";
import { createDomainId } from "./ids.js";
import {
  createMergeCandidateSearchPlan,
  resolveMergeCandidateSearch,
} from "./merge-candidate-service.js";
import { validateMergeDecisions } from "./merge-classifier.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import type {
  CanonicalKnowledgeSearchView,
  CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";
import type { TrustedHumanAutoActivationPolicyLike } from "./trusted-human-auto-activation-policy.js";

import {
  EVIDENCE_EVENT_PATH,
  REVISION_PROPOSAL_EVENT_PATH,
  CanonicalFinalizeError,
  type CanonicalFinalizeSourceBinding,
  type CanonicalFinalizeRequest,
  type CanonicalSkipFinalizeRequest,
  type CanonicalSkipFinalizeResult,
  type CanonicalFinalizeMutationPlan,
  type CanonicalFinalizeServiceOptions,
  type OperationTime,
  type CurrentFinalizeContext,
  type AssignedCandidate,
  PROPOSE_ONLY_AUTO_ACTIVATION_POLICY,
  type EvidenceGroup,
  type PlannedEvidenceLifecycle,
  type IdentifierFactory,
} from "./canonical-finalize-types.js";
import {
  evidenceGroups,
  isNewAssignedCandidate,
  buildActiveEvidence,
  compareComments,
  validateCandidateEvidenceComments,
  validateEvidenceCommentIds,
  newKnowledgeFileWrite,
  revisionPatch,
  staleKnowledgeFileWrites,
  currentActiveEvidence,
  hasActiveEvidenceAfter,
  isAutomaticStaleCandidate,
  emptyEvidenceLifecycle,
  parseSourceBinding,
  parseProvenance,
  parseMatchSetDigest,
  operationTime,
  canonicalEventPath,
} from "./canonical-finalize-plan.js";

export {
  EVIDENCE_EVENT_PATH,
  REVISION_PROPOSAL_EVENT_PATH,
  type CanonicalFinalizeErrorCode,
  CanonicalFinalizeError,
  type CanonicalFinalizeSourceBinding,
  type CanonicalFinalizeRequest,
  type CanonicalSkipFinalizeRequest,
  type CanonicalSkipFinalizeResult,
  type CanonicalFinalizeMutationPlan,
  type CanonicalFinalizeServiceOptions,
} from "./canonical-finalize-types.js";
export { renderDistilledCandidateBody } from "./canonical-finalize-plan.js";

/**
 * Applies merge and skip outcomes to all canonical artifacts in one commit.
 * Provider work and classification happen before this service acquires the
 * repository lock; finalize-time FTS revalidation and the commit share it.
 */
export class CanonicalFinalizeService {
  private readonly autoActivationPolicy: TrustedHumanAutoActivationPolicyLike;
  private readonly candidateLimit: number | undefined;
  private readonly evidenceEventPath: string;
  private readonly jobEventPath: string;
  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextEvidenceId: (timestamp: number) => string;
  private readonly nextKnowledgeId: (timestamp: number) => string;
  private readonly nextProposalId: (timestamp: number) => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly proposalEventPath: string;
  private readonly repoId: string;
  private readonly repository: CanonicalTransactionStore;

  constructor(options: CanonicalFinalizeServiceOptions) {
    this.autoActivationPolicy =
      options.autoActivationPolicy ?? PROPOSE_ONLY_AUTO_ACTIVATION_POLICY;
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.candidateLimit = options.candidateLimit;
    this.evidenceEventPath = canonicalEventPath(
      options.evidenceEventPath ?? EVIDENCE_EVENT_PATH,
    );
    this.jobEventPath = canonicalEventPath(
      options.jobEventPath ?? DISTILL_JOB_EVENT_PATH,
    );
    this.proposalEventPath = canonicalEventPath(
      options.proposalEventPath ?? REVISION_PROPOSAL_EVENT_PATH,
    );
    this.now = options.now ?? (() => new Date());
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextEvidenceId =
      options.nextEvidenceId ??
      ((timestamp) => createDomainId("evidence", timestamp));
    this.nextKnowledgeId =
      options.nextKnowledgeId ??
      ((timestamp) => createDomainId("knowledge", timestamp));
    this.nextProposalId =
      options.nextProposalId ??
      ((timestamp) =>
        `proposal_${createDomainId("event", timestamp).slice(4)}`);
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
  }

  async finalize(
    request: CanonicalFinalizeRequest,
  ): Promise<FinalizeStableResponse> {
    const searchPlan = this.createFinalizeSearchPlan(request);

    return this.repository.runLockedKnowledgeSearchMutation(
      searchPlan.searchable.map((entry) => entry.request),
      (view) => {
        const transaction = this.planFinalizeMutation(request, view);
        return {
          transaction: transaction.transaction,
          value: transaction.value,
        };
      },
    );
  }

  /**
   * Plans a finalize transaction against an already locked search view.
   * Callers must invoke this only from CanonicalTransactionStore's synchronous
   * locked-search planner; this method deliberately performs no I/O or commit.
   */
  planFinalizeMutation(
    request: CanonicalFinalizeRequest,
    view: CanonicalKnowledgeSearchView,
  ): CanonicalFinalizeMutationPlan {
    const source = parseSourceBinding(request);
    const provenance = parseProvenance(request.provenance);
    if (provenance.distillation_key !== source.distillation_key) {
      throw new CanonicalFinalizeError(
        "DISTILLATION_CONTEXT_CHANGED",
        "provenance is bound to a different distillation key",
      );
    }
    const expectedDigest = parseMatchSetDigest(
      request.expected_match_set_digest,
    );
    const searchPlan = this.createFinalizeSearchPlan(request);
    const context = this.currentContext(view.snapshot, request.lease, source);
    validateCandidateEvidenceComments(
      searchPlan.candidates,
      context.thread,
      context.comments,
    );
    const currentSearch = resolveMergeCandidateSearch(searchPlan, view);
    if (currentSearch.match_set_digest !== expectedDigest) {
      throw new CanonicalFinalizeError(
        "MERGE_CANDIDATES_CHANGED",
        "the merge candidate set changed before finalize",
        currentSearch,
      );
    }
    const decisions = validateMergeDecisions(
      request.decisions,
      currentSearch.candidates,
      currentSearch.possible_matches,
    );
    const transactionId = this.nextTransactionId(context.operation.timestamp);
    const ids = this.identifierFactory(context.operation.timestamp);
    return this.planFinalizeTransaction({
      candidates: currentSearch.candidates,
      context,
      decisions,
      ids,
      provenance,
      snapshot: view.snapshot,
      transactionId,
    });
  }

  private createFinalizeSearchPlan(request: CanonicalFinalizeRequest) {
    const source = parseSourceBinding(request);
    const candidates = request.candidates.map((candidate) =>
      ExtractCandidateSchema.parse(candidate),
    );
    return createMergeCandidateSearchPlan({
      ...(this.candidateLimit === undefined
        ? {}
        : { candidateLimit: this.candidateLimit }),
      candidates,
      repoId: this.repoId,
      threadId: source.thread_id,
    });
  }

  async skip(
    request: CanonicalSkipFinalizeRequest,
  ): Promise<CanonicalSkipFinalizeResult> {
    const source = parseSourceBinding(request);
    const skipReason = SkipReasonSchema.parse(request.skip_reason);
    const duplicateKnowledgeId =
      request.duplicate_knowledge_id === undefined
        ? undefined
        : NonEmptyStringSchema.parse(request.duplicate_knowledge_id);

    return this.repository.runLockedMutation((snapshot) => {
      const context = this.currentContext(snapshot, request.lease, source);
      if (
        duplicateKnowledgeId !== undefined &&
        !snapshot.domain.knowledge.some(
          (knowledge) =>
            knowledge.id === duplicateKnowledgeId &&
            knowledge.repoId === this.repoId &&
            knowledge.status !== "deprecated" &&
            knowledge.status !== "rejected",
        )
      ) {
        throw new CanonicalFinalizeError(
          "FINALIZE_REQUEST_INVALID",
          `duplicate target ${duplicateKnowledgeId} is not merge-eligible`,
        );
      }
      const transactionId = this.nextTransactionId(context.operation.timestamp);
      const ids = this.identifierFactory(context.operation.timestamp);
      const planned = this.planSkipTransaction({
        context,
        duplicateKnowledgeId,
        ids,
        skipReason,
        snapshot,
        transactionId,
      });
      return { transaction: planned.transaction, value: planned.value };
    });
  }

  private currentContext(
    snapshot: CanonicalProjectionSnapshot,
    lease: DistillJobLeaseCredentials,
    source: CanonicalFinalizeSourceBinding,
  ): CurrentFinalizeContext {
    const job = snapshot.domain.distillJobs.find(
      (candidate) => candidate.job_id === lease.job_id,
    );
    if (job === undefined) {
      throw new CanonicalFinalizeError(
        "JOB_CONTEXT_MISMATCH",
        `job ${lease.job_id} was not found`,
      );
    }
    if (job.repo_id !== this.repoId || job.thread_id !== source.thread_id) {
      throw new CanonicalFinalizeError(
        "JOB_CONTEXT_MISMATCH",
        "the job is not bound to this repository and thread",
      );
    }
    if (job.distillation_key !== source.distillation_key) {
      throw new CanonicalFinalizeError(
        "DISTILLATION_CONTEXT_CHANGED",
        "the current job uses a different distillation key",
      );
    }
    const operation = operationTime(this.now(), job.updated_at);
    assertCurrentDistillJobLease(job, lease, operation.timestamp);
    if (job.state !== "awaiting_finalize") {
      throw new CanonicalFinalizeError(
        "JOB_CONTEXT_MISMATCH",
        `job ${job.job_id} is not awaiting finalize`,
      );
    }

    const thread = snapshot.domain.threads.find(
      (candidate) =>
        candidate.repo_id === this.repoId &&
        candidate.thread_id === source.thread_id,
    );
    if (thread === undefined) {
      throw new CanonicalFinalizeError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${source.thread_id} has no current observation`,
      );
    }
    if (thread.content_fingerprint !== source.content_fingerprint) {
      throw new CanonicalFinalizeError(
        "DISTILLATION_SOURCE_CHANGED",
        "the review thread content changed before finalize",
      );
    }
    const completeSnapshot = snapshot.domain.pullRequestSnapshots.some(
      (candidate) =>
        candidate.snapshot_id === thread.snapshot_id &&
        candidate.repo_id === this.repoId &&
        candidate.pr_number === thread.pr_number,
    );
    if (!completeSnapshot) {
      throw new CanonicalFinalizeError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${thread.thread_id} is not bound to a complete snapshot`,
      );
    }
    const comments = snapshot.domain.comments
      .filter(
        (comment) =>
          comment.thread_id === thread.thread_id &&
          comment.snapshot_id === thread.snapshot_id &&
          thread.comment_ids.includes(comment.comment_id),
      )
      .sort(compareComments);
    if (comments.length !== thread.comment_ids.length) {
      throw new CanonicalFinalizeError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${thread.thread_id} is missing current comment observations`,
      );
    }
    return { comments, job, operation, thread };
  }

  private planFinalizeTransaction(input: {
    readonly candidates: readonly ExtractCandidate[];
    readonly context: CurrentFinalizeContext;
    readonly decisions: readonly MergeDecision[];
    readonly ids: IdentifierFactory;
    readonly provenance: DistillationProvenance;
    readonly snapshot: CanonicalProjectionSnapshot;
    readonly transactionId: string;
  }): {
    readonly transaction: CanonicalTransactionRequest;
    readonly value: FinalizeStableResponse;
  } {
    const candidateById = new Map(
      input.candidates.map((candidate) => [candidate.candidate_id, candidate]),
    );
    const assigned = input.decisions.map((decision): AssignedCandidate => {
      const candidate = candidateById.get(decision.candidate_id)!;
      if (decision.relation === "same") {
        return {
          candidate,
          createsKnowledge: false,
          decision,
          initialStatus: null,
          knowledgeId: decision.target_id!,
          relatedIds: [],
        };
      }
      return {
        candidate,
        createsKnowledge: true,
        decision,
        initialStatus: this.autoActivationPolicy.evaluate({
          candidate: candidate.candidate,
          comments: input.context.comments,
          provenanceTrustPolicyDigest: input.provenance.trust_policy_digest,
        }).status,
        knowledgeId: input.ids.nextKnowledgeId(),
        relatedIds:
          decision.relation === "overlaps" ? [decision.target_id!] : [],
      };
    });
    const created = assigned.filter(isNewAssignedCandidate);
    const groups = evidenceGroups(assigned);
    const lifecycle = this.planEvidenceLifecycle({
      comments: input.context.comments,
      groups,
      ids: input.ids,
      operation: input.context.operation,
      snapshot: input.snapshot,
      thread: input.context.thread,
      transactionId: input.transactionId,
    });
    const activeByKnowledge = new Map(
      lifecycle.active.map((evidence) => [evidence.knowledge_id, evidence]),
    );
    const fileWrites: CanonicalFileWriteRequest[] = created.map((entry) =>
      newKnowledgeFileWrite(
        entry,
        input.context.operation.recordedAt,
        input.provenance,
        this.repoId,
        input.transactionId,
      ),
    );
    fileWrites.push(
      ...staleKnowledgeFileWrites(
        lifecycle.staleKnowledgeIds,
        input.snapshot,
        input.context.operation.recordedAt,
        input.transactionId,
      ),
    );

    const proposalRecords: CanonicalAppendRecordRequest[] = [];
    const proposalIds: string[] = [];
    for (const entry of assigned.filter(
      (candidate) => candidate.decision.relation === "same",
    )) {
      const target = input.snapshot.domain.knowledge.find(
        (knowledge) => knowledge.id === entry.knowledgeId,
      )!;
      const patch = revisionPatch(entry.candidate, target);
      if (patch === null) continue;
      const proposalId = input.ids.nextProposalId();
      const proposal = KnowledgeRevisionProposalSchema.parse({
        created_at: input.context.operation.recordedAt,
        evidence_ids: [activeByKnowledge.get(entry.knowledgeId)!.evidence_id],
        knowledge_id: entry.knowledgeId,
        patch,
        proposal_id: proposalId,
        repo_id: this.repoId,
        status: "pending",
        updated_at: input.context.operation.recordedAt,
      });
      proposalIds.push(proposalId);
      proposalRecords.push(
        this.eventAppend(
          "KnowledgeRevisionProposal",
          proposal,
          input.context.operation,
          input.transactionId,
          this.proposalEventPath,
          input.ids,
        ),
      );
    }
    const jobRecord = this.jobEventAppend(
      input.context.job,
      DISTILLATION_JOB_SUCCEEDED,
      undefined,
      input.context.operation,
      input.transactionId,
      input.ids,
    );
    const response = FinalizeStableResponseSchema.parse({
      accepted: true,
      created_active: created
        .filter((entry) => entry.initialStatus === "active")
        .map((entry) => entry.knowledgeId),
      created_proposed: created
        .filter((entry) => entry.initialStatus === "proposed")
        .map((entry) => entry.knowledgeId),
      merged_evidence: lifecycle.active.map((evidence) => evidence.evidence_id),
      revision_proposals: proposalIds,
    });
    return {
      transaction: {
        appendRecords: [...lifecycle.records, ...proposalRecords, jobRecord],
        createdAt: input.context.operation.recordedAt,
        fileWrites,
        transactionId: input.transactionId,
      },
      value: response,
    };
  }

  private planSkipTransaction(input: {
    readonly context: CurrentFinalizeContext;
    readonly duplicateKnowledgeId: string | undefined;
    readonly ids: IdentifierFactory;
    readonly skipReason: SkipReason;
    readonly snapshot: CanonicalProjectionSnapshot;
    readonly transactionId: string;
  }): {
    readonly transaction: CanonicalTransactionRequest;
    readonly value: CanonicalSkipFinalizeResult;
  } {
    const activeForThread = currentActiveEvidence(
      input.snapshot,
      this.repoId,
      input.context.thread.thread_id,
    );
    let groups: readonly EvidenceGroup[] = [];
    let mutationMode: "preserve" | "reassociate" | "withdraw" = "preserve";
    if (
      input.skipReason === "typo" ||
      input.skipReason === "praise_or_chitchat" ||
      input.skipReason === "question_without_conclusion" ||
      input.skipReason === "pr_specific"
    ) {
      mutationMode = "withdraw";
    } else if (
      input.skipReason === "duplicate_noise" &&
      input.duplicateKnowledgeId !== undefined &&
      activeForThread.length > 0
    ) {
      mutationMode = "reassociate";
      groups = [
        {
          commentIds: sortAndDedupeStrings(
            activeForThread.flatMap((evidence) => evidence.comment_ids),
          ),
          knowledgeId: input.duplicateKnowledgeId,
        },
      ];
      validateEvidenceCommentIds(
        groups[0]!.commentIds,
        input.context.thread,
        input.context.comments,
      );
    }

    const lifecycle =
      mutationMode === "preserve"
        ? emptyEvidenceLifecycle()
        : this.planEvidenceLifecycle({
            comments: input.context.comments,
            groups,
            ids: input.ids,
            operation: input.context.operation,
            snapshot: input.snapshot,
            thread: input.context.thread,
            transactionId: input.transactionId,
            ...(mutationMode === "reassociate"
              ? { supersedeUnconfirmed: true }
              : {}),
          });
    const staleIds = lifecycle.staleKnowledgeIds;
    const fileWrites = staleKnowledgeFileWrites(
      staleIds,
      input.snapshot,
      input.context.operation.recordedAt,
      input.transactionId,
    );
    const jobRecord = this.jobEventAppend(
      input.context.job,
      DISTILLATION_JOB_SKIPPED,
      input.skipReason,
      input.context.operation,
      input.transactionId,
      input.ids,
    );
    const stableResponse = SkippedStableResponseSchema.parse({
      skip_reason: input.skipReason,
      staled_knowledge_ids: staleIds,
      state: "skipped",
      withdrawn_evidence_ids: lifecycle.withdrawnEvidenceIds,
    });
    const manualReview =
      input.skipReason === "insufficient_context"
        ? {
            evidenceIds: activeForThread.map(
              (evidence) => evidence.evidence_id,
            ),
            reason: "insufficient_context" as const,
            required: true as const,
          }
        : null;
    return {
      transaction: {
        appendRecords: [...lifecycle.records, jobRecord],
        createdAt: input.context.operation.recordedAt,
        fileWrites,
        transactionId: input.transactionId,
      },
      value: {
        manual_review: manualReview,
        reassociated_evidence_ids:
          mutationMode === "reassociate"
            ? activeForThread.map((evidence) => evidence.evidence_id)
            : [],
        stable_response: stableResponse,
      },
    };
  }

  private planEvidenceLifecycle(input: {
    readonly comments: readonly CommentObservation[];
    readonly groups: readonly EvidenceGroup[];
    readonly ids: IdentifierFactory;
    readonly operation: OperationTime;
    readonly snapshot: CanonicalProjectionSnapshot;
    readonly supersedeUnconfirmed?: boolean;
    readonly thread: ThreadObservation;
    readonly transactionId: string;
  }): PlannedEvidenceLifecycle {
    const oldActive = currentActiveEvidence(
      input.snapshot,
      this.repoId,
      input.thread.thread_id,
    );
    const groupIds = new Set(input.groups.map((group) => group.knowledgeId));
    const oldByKnowledge = new Map(
      oldActive.map((evidence) => [evidence.knowledge_id, evidence]),
    );
    const active = input.groups.map((group) => {
      const previous =
        oldByKnowledge.get(group.knowledgeId) ??
        (input.supersedeUnconfirmed === true ? oldActive[0] : undefined);
      return buildActiveEvidence({
        commentIds: group.commentIds,
        comments: input.comments,
        evidenceId: input.ids.nextEvidenceId(),
        knowledgeId: group.knowledgeId,
        previous,
        repoId: this.repoId,
        thread: input.thread,
      });
    });
    const activeByKnowledge = new Map(
      active.map((evidence) => [evidence.knowledge_id, evidence]),
    );
    const records: CanonicalAppendRecordRequest[] = [];
    const withdrawnEvidenceIds: string[] = [];
    for (const previous of oldActive) {
      const replacement =
        activeByKnowledge.get(previous.knowledge_id) ??
        (input.supersedeUnconfirmed === true ? active[0] : undefined);
      const superseded =
        replacement !== undefined || input.supersedeUnconfirmed === true;
      const updated = KnowledgeEvidenceSchema.parse({
        ...previous,
        eligible_for_count: false,
        observed_at: input.thread.observed_at,
        status: superseded ? "superseded" : "withdrawn",
        ...(replacement === undefined
          ? {}
          : { superseded_by: replacement.evidence_id }),
      });
      if (!superseded) withdrawnEvidenceIds.push(previous.evidence_id);
      records.push(
        this.eventAppend(
          superseded ? "EvidenceSuperseded" : "EvidenceWithdrawn",
          updated,
          input.operation,
          input.transactionId,
          this.evidenceEventPath,
          input.ids,
        ),
      );
    }
    for (const evidence of active) {
      records.push(
        this.eventAppend(
          "EvidenceCreated",
          evidence,
          input.operation,
          input.transactionId,
          this.evidenceEventPath,
          input.ids,
        ),
      );
    }
    const affectedKnowledgeIds = sortAndDedupeStrings(
      oldActive.map((evidence) => evidence.knowledge_id),
    );
    const staleKnowledgeIds = affectedKnowledgeIds.filter(
      (knowledgeId) =>
        !hasActiveEvidenceAfter(
          knowledgeId,
          input.snapshot,
          this.repoId,
          input.thread.thread_id,
          groupIds,
        ) && isAutomaticStaleCandidate(knowledgeId, input.snapshot),
    );
    return {
      active,
      records,
      staleKnowledgeIds,
      withdrawnEvidenceIds: sortAndDedupeStrings(withdrawnEvidenceIds),
    };
  }

  private jobEventAppend(
    job: DistillJob,
    type: typeof DISTILLATION_JOB_SKIPPED | typeof DISTILLATION_JOB_SUCCEEDED,
    skipReason: SkipReason | undefined,
    operation: OperationTime,
    transactionId: string,
    ids: IdentifierFactory,
  ): CanonicalAppendRecordRequest {
    const record =
      type === DISTILLATION_JOB_SKIPPED
        ? createDistillationJobEventRecord({
            eventId: ids.nextEventId(),
            payload: {
              job_id: job.job_id,
              lease_generation: job.lease_generation,
              skip_reason: skipReason!,
            },
            recordedAt: operation.recordedAt,
            transactionId,
            type,
          })
        : createDistillationJobEventRecord({
            eventId: ids.nextEventId(),
            payload: {
              job_id: job.job_id,
              lease_generation: job.lease_generation,
            },
            recordedAt: operation.recordedAt,
            transactionId,
            type,
          });
    applyDistillationJobRecord(job, record);
    return { record, targetPath: this.jobEventPath };
  }

  private eventAppend<T>(
    recordType: string,
    payload: T,
    operation: OperationTime,
    transactionId: string,
    targetPath: string,
    ids: IdentifierFactory,
  ): CanonicalAppendRecordRequest {
    const record: CanonicalJsonlRecord<T> = {
      payload,
      record_id: ids.nextEventId(),
      record_type: recordType,
      recorded_at: operation.recordedAt,
      schema_version: 1,
      transaction_id: transactionId,
    };
    return { record, targetPath };
  }

  private identifierFactory(timestamp: number): IdentifierFactory {
    return {
      nextEventId: () => this.nextEventId(timestamp),
      nextEvidenceId: () => this.nextEvidenceId(timestamp),
      nextKnowledgeId: () => this.nextKnowledgeId(timestamp),
      nextProposalId: () => this.nextProposalId(timestamp),
    };
  }
}

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
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
  IsoDateTimeSchema,
  KnowledgeEvidenceSchema,
  KnowledgeRevisionProposalSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  SkipReasonSchema,
  SkippedStableResponseSchema,
  type CommentObservation,
  type DistillJob,
  type EvidenceActor,
  type ExtractCandidate,
  type FinalizeStableResponse,
  type KnowledgeEvidence,
  type KnowledgeRevisionPatch,
  type MergeDecision,
  type SkipReason,
  type SkippedStableResponse,
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
import type { ManualReviewMarker } from "./evidence-policy.js";
import { createDomainId } from "./ids.js";
import {
  applyKnowledgeDocumentPatch,
  serializeKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import {
  createMergeCandidateSearchPlan,
  resolveMergeCandidateSearch,
  type MergeCandidateSearchResult,
} from "./merge-candidate-service.js";
import { validateMergeDecisions } from "./merge-classifier.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

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

export interface CanonicalFinalizeRequest extends CanonicalFinalizeSourceBinding {
  readonly candidates: readonly ExtractCandidate[];
  readonly decisions: readonly MergeDecision[];
  readonly expected_match_set_digest: string;
  readonly lease: DistillJobLeaseCredentials;
  readonly provenance: DistillationProvenance;
}

export interface CanonicalSkipFinalizeRequest extends CanonicalFinalizeSourceBinding {
  readonly duplicate_knowledge_id?: string;
  readonly lease: DistillJobLeaseCredentials;
  readonly skip_reason: SkipReason;
}

export interface CanonicalSkipFinalizeResult {
  readonly manual_review: ManualReviewMarker | null;
  readonly reassociated_evidence_ids: readonly string[];
  readonly stable_response: SkippedStableResponse;
}

export interface CanonicalFinalizeServiceOptions {
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

interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

interface CurrentFinalizeContext {
  readonly comments: readonly CommentObservation[];
  readonly job: DistillJob;
  readonly operation: OperationTime;
  readonly thread: ThreadObservation;
}

interface AssignedCandidate {
  readonly candidate: ExtractCandidate;
  readonly decision: MergeDecision;
  readonly knowledgeId: string;
  readonly relatedIds: readonly string[];
  readonly createsKnowledge: boolean;
}

interface EvidenceGroup {
  readonly commentIds: readonly string[];
  readonly knowledgeId: string;
}

interface PlannedEvidenceLifecycle {
  readonly active: readonly KnowledgeEvidence[];
  readonly records: readonly CanonicalAppendRecordRequest[];
  readonly staleKnowledgeIds: readonly string[];
  readonly withdrawnEvidenceIds: readonly string[];
}

interface IdentifierFactory {
  nextEventId(): string;
  nextEvidenceId(): string;
  nextKnowledgeId(): string;
  nextProposalId(): string;
}

/**
 * Applies merge and skip outcomes to all canonical artifacts in one commit.
 * Provider work and classification happen before this service acquires the
 * repository lock; finalize-time FTS revalidation and the commit share it.
 */
export class CanonicalFinalizeService {
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
    const candidates = request.candidates.map((candidate) =>
      ExtractCandidateSchema.parse(candidate),
    );
    const searchPlan = createMergeCandidateSearchPlan({
      ...(this.candidateLimit === undefined
        ? {}
        : { candidateLimit: this.candidateLimit }),
      candidates,
      repoId: this.repoId,
      threadId: source.thread_id,
    });

    return this.repository.runLockedKnowledgeSearchMutation(
      searchPlan.searchable.map((entry) => entry.request),
      (view) => {
        const context = this.currentContext(
          view.snapshot,
          request.lease,
          source,
        );
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
        const transactionId = this.nextTransactionId(
          context.operation.timestamp,
        );
        const ids = this.identifierFactory(context.operation.timestamp);
        const transaction = this.planFinalizeTransaction({
          candidates: currentSearch.candidates,
          context,
          decisions,
          ids,
          provenance,
          snapshot: view.snapshot,
          transactionId,
        });
        return {
          transaction: transaction.transaction,
          value: transaction.value,
        };
      },
    );
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
          knowledgeId: decision.target_id!,
          relatedIds: [],
        };
      }
      return {
        candidate,
        createsKnowledge: true,
        decision,
        knowledgeId: input.ids.nextKnowledgeId(),
        relatedIds:
          decision.relation === "overlaps" ? [decision.target_id!] : [],
      };
    });
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
    const fileWrites: CanonicalFileWriteRequest[] = assigned
      .filter((entry) => entry.createsKnowledge)
      .map((entry) =>
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
      created_proposed: assigned
        .filter((entry) => entry.createsKnowledge)
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

function evidenceGroups(
  assigned: readonly AssignedCandidate[],
): EvidenceGroup[] {
  const commentsByKnowledge = new Map<string, string[]>();
  for (const entry of assigned) {
    const comments = commentsByKnowledge.get(entry.knowledgeId) ?? [];
    comments.push(...entry.candidate.candidate.evidence_comment_ids);
    commentsByKnowledge.set(entry.knowledgeId, comments);
  }
  return [...commentsByKnowledge]
    .map(([knowledgeId, commentIds]) => ({
      commentIds: sortAndDedupeStrings(commentIds),
      knowledgeId,
    }))
    .sort((left, right) =>
      compareCodeUnits(left.knowledgeId, right.knowledgeId),
    );
}

function buildActiveEvidence(input: {
  readonly commentIds: readonly string[];
  readonly comments: readonly CommentObservation[];
  readonly evidenceId: string;
  readonly knowledgeId: string;
  readonly previous: KnowledgeEvidence | undefined;
  readonly repoId: string;
  readonly thread: ThreadObservation;
}): KnowledgeEvidence {
  const commentById = new Map(
    input.comments.map((comment) => [comment.comment_id, comment]),
  );
  const selected = input.commentIds.map((id) => commentById.get(id)!);
  const originatorComment = input.comments[0]!;
  const actors = selected.map(evidenceActor).sort(compareEvidenceActors);
  const originator = evidenceActor(originatorComment);
  return KnowledgeEvidenceSchema.parse({
    actors,
    ...(originatorComment.actor.author_association === undefined
      ? {}
      : {
          author_association: originatorComment.actor.author_association,
        }),
    comment_ids: input.commentIds,
    content_fingerprint: input.thread.content_fingerprint,
    eligible_for_count: true,
    evidence_id: input.evidenceId,
    knowledge_id: input.knowledgeId,
    observed_at: input.thread.observed_at,
    occurrence_key: `${input.knowledgeId}:${input.thread.thread_id}`,
    originator,
    ...(input.thread.path === undefined ? {} : { path: input.thread.path }),
    pr_number: input.thread.pr_number,
    repo_id: input.repoId,
    sources: sortAndDedupeStrings(actors.map((actor) => actor.provider)),
    state_fingerprint: input.thread.state_fingerprint,
    status: "active",
    ...(input.previous === undefined
      ? {}
      : { supersedes: input.previous.evidence_id }),
    thread_id: input.thread.thread_id,
    url: originatorComment.url,
  });
}

function evidenceActor(comment: CommentObservation): EvidenceActor {
  return {
    actor_kind: comment.actor.actor_kind,
    comment_id: comment.comment_id,
    provider: comment.actor.provider,
    trust: comment.actor.trust,
    ...(comment.actor.actor_id === undefined
      ? {}
      : { actor_id: comment.actor.actor_id }),
    ...(comment.actor.login === null ? {} : { login: comment.actor.login }),
  };
}

function compareEvidenceActors(
  left: EvidenceActor,
  right: EvidenceActor,
): number {
  return compareCodeUnits(left.comment_id, right.comment_id);
}

function compareComments(
  left: CommentObservation,
  right: CommentObservation,
): number {
  return (
    compareCodeUnits(left.created_at, right.created_at) ||
    compareCodeUnits(left.comment_id, right.comment_id)
  );
}

function validateCandidateEvidenceComments(
  candidates: readonly ExtractCandidate[],
  thread: ThreadObservation,
  comments: readonly CommentObservation[],
): void {
  validateEvidenceCommentIds(
    candidates.flatMap((candidate) => candidate.candidate.evidence_comment_ids),
    thread,
    comments,
  );
}

function validateEvidenceCommentIds(
  values: readonly string[],
  thread: ThreadObservation,
  comments: readonly CommentObservation[],
): void {
  const currentIds = new Set(comments.map((comment) => comment.comment_id));
  const invalid = sortAndDedupeStrings(values).filter(
    (id) => !thread.comment_ids.includes(id) || !currentIds.has(id),
  );
  if (invalid.length > 0) {
    throw new CanonicalFinalizeError(
      "EVIDENCE_COMMENTS_INVALID",
      `evidence comments are outside the current snapshot: ${invalid.join(", ")}`,
    );
  }
}

function newKnowledgeFileWrite(
  entry: AssignedCandidate,
  recordedAt: string,
  provenance: DistillationProvenance,
  repoId: string,
  transactionId: string,
): CanonicalFileWriteRequest {
  const path = `knowledge/${entry.knowledgeId}.md`;
  const candidate = entry.candidate.candidate;
  return {
    content: serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: candidate.category,
        created_at: recordedAt,
        id: entry.knowledgeId,
        last_automatic_update: {
          at: recordedAt,
          transaction_id: transactionId,
        },
        origin: {
          model: provenance.model,
          output_schema_digest: provenance.output_schema_digest,
          output_schema_version: provenance.output_schema_version,
          prompt_digest: provenance.prompt_digest,
          prompt_version: provenance.prompt_version,
          provider: provenance.provider,
          trust_policy_digest: provenance.trust_policy_digest,
          type: "distilled",
        },
        related_ids: entry.relatedIds,
        repo_id: repoId,
        revision: 1,
        rule: candidate.rule,
        schema_version: 1,
        scope: candidate.scope,
        severity: candidate.severity,
        status: "proposed",
        updated_at: recordedAt,
      },
      candidate.detail,
    ),
    expectedSha256: null,
    targetPath: path,
  };
}

function revisionPatch(
  entry: ExtractCandidate,
  target: CanonicalProjectionSnapshot["domain"]["knowledge"][number],
): KnowledgeRevisionPatch | null {
  const candidate = entry.candidate;
  const patch: Record<string, unknown> = {};
  if (candidate.category !== target.category)
    patch.category = candidate.category;
  if (
    comparableMarkdown(candidate.detail) !== comparableMarkdown(target.detail)
  ) {
    patch.detail = candidate.detail;
  }
  if (candidate.rule !== target.rule) patch.rule = candidate.rule;
  if (canonicalizeJson(candidate.scope) !== canonicalizeJson(target.scope)) {
    patch.scope = candidate.scope;
  }
  if (candidate.severity !== target.severity)
    patch.severity = candidate.severity;
  return Object.keys(patch).length === 0
    ? null
    : (patch as KnowledgeRevisionPatch);
}

function comparableMarkdown(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function staleKnowledgeFileWrites(
  knowledgeIds: readonly string[],
  snapshot: CanonicalProjectionSnapshot,
  recordedAt: string,
  transactionId: string,
): CanonicalFileWriteRequest[] {
  const documents = knowledgeDocumentsById(snapshot);
  return knowledgeIds.map((knowledgeId) => {
    const current = documents.get(knowledgeId)!;
    return {
      content: applyKnowledgeDocumentPatch(current, {
        frontmatter: {
          last_automatic_update: {
            at: recordedAt,
            transaction_id: transactionId,
          },
          status: "stale",
          updated_at: recordedAt,
        },
      }),
      expectedSha256: current.etag,
      targetPath: current.path,
    };
  });
}

function knowledgeDocumentsById(
  snapshot: CanonicalProjectionSnapshot,
): Map<string, KnowledgeDocument> {
  return new Map(
    snapshot.knowledge.map((document) => [
      NonEmptyStringSchema.parse(document.frontmatter.id),
      document,
    ]),
  );
}

function currentActiveEvidence(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  threadId: string,
): KnowledgeEvidence[] {
  return snapshot.domain.evidence
    .filter(
      (evidence) =>
        evidence.repo_id === repoId &&
        evidence.thread_id === threadId &&
        evidence.status === "active",
    )
    .sort((left, right) =>
      compareCodeUnits(left.evidence_id, right.evidence_id),
    );
}

function hasActiveEvidenceAfter(
  knowledgeId: string,
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  currentThreadId: string,
  replacementKnowledgeIds: ReadonlySet<string>,
): boolean {
  if (replacementKnowledgeIds.has(knowledgeId)) return true;
  return snapshot.domain.evidence.some(
    (evidence) =>
      evidence.repo_id === repoId &&
      evidence.knowledge_id === knowledgeId &&
      evidence.thread_id !== currentThreadId &&
      evidence.status === "active",
  );
}

function isAutomaticStaleCandidate(
  knowledgeId: string,
  snapshot: CanonicalProjectionSnapshot,
): boolean {
  const document = knowledgeDocumentsById(snapshot).get(knowledgeId);
  const projected = snapshot.domain.knowledge.find(
    (knowledge) => knowledge.id === knowledgeId,
  );
  if (
    document === undefined ||
    projected === undefined ||
    (projected.status !== "active" && projected.status !== "proposed")
  ) {
    return false;
  }
  const activation = asRecord(document.frontmatter.activation);
  if (activation?.origin === "human" || activation?.pinned === true)
    return false;
  const origin = asRecord(document.frontmatter.origin);
  return activation?.origin === "automatic" || origin?.type === "distilled";
}

function emptyEvidenceLifecycle(): PlannedEvidenceLifecycle {
  return {
    active: [],
    records: [],
    staleKnowledgeIds: [],
    withdrawnEvidenceIds: [],
  };
}

function parseSourceBinding(
  request: CanonicalFinalizeSourceBinding,
): CanonicalFinalizeSourceBinding {
  return {
    content_fingerprint: Sha256DigestSchema.parse(request.content_fingerprint),
    distillation_key: Sha256DigestSchema.parse(request.distillation_key),
    thread_id: NonEmptyStringSchema.parse(request.thread_id),
  };
}

function parseProvenance(
  value: DistillationProvenance,
): DistillationProvenance {
  return {
    distillation_key: Sha256DigestSchema.parse(value.distillation_key),
    model: NonEmptyStringSchema.parse(value.model),
    output_schema_digest: Sha256DigestSchema.parse(value.output_schema_digest),
    output_schema_version: NonEmptyStringSchema.parse(
      value.output_schema_version,
    ),
    prompt_digest: Sha256DigestSchema.parse(value.prompt_digest),
    prompt_version: NonEmptyStringSchema.parse(value.prompt_version),
    provider: NonEmptyStringSchema.parse(value.provider),
    ...(value.response_id === undefined
      ? {}
      : { response_id: NonEmptyStringSchema.parse(value.response_id) }),
    trust_policy_digest: Sha256DigestSchema.parse(value.trust_policy_digest),
  };
}

function parseMatchSetDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new CanonicalFinalizeError(
      "FINALIZE_REQUEST_INVALID",
      "expected_match_set_digest must be lowercase SHA-256 hex",
    );
  }
  return value;
}

function operationTime(now: Date, currentUpdatedAt: string): OperationTime {
  const clockTimestamp = now.getTime();
  if (!Number.isFinite(clockTimestamp)) {
    throw new CanonicalFinalizeError(
      "FINALIZE_REQUEST_INVALID",
      "now() returned an invalid Date",
    );
  }
  const timestamp = Math.max(clockTimestamp, Date.parse(currentUpdatedAt));
  return {
    recordedAt: IsoDateTimeSchema.parse(new Date(timestamp).toISOString()),
    timestamp,
  };
}

function canonicalEventPath(value: string): string {
  const path = NonEmptyStringSchema.parse(value);
  if (!path.startsWith("events/") || !path.endsWith(".jsonl")) {
    throw new TypeError("canonical event paths must be events/*.jsonl");
  }
  return path;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

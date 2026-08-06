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
} from "./canonical-transaction-store.js";
import {
  DistillationOutputSchema,
  ExtractStableResponseSchema,
  ExtractSubmissionReceiptSchema,
  JobIdSchema,
  KnowledgeEvidenceSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type CommentObservation,
  type DistillJob,
  type DistilledCandidate,
  type ExtractCandidate,
  type ExtractStableResponse,
  type KnowledgeEvidence,
  type SkipReason,
  type SubmissionReceipt,
  type ThreadObservation,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_AWAITING_FINALIZE,
  DISTILLATION_JOB_SKIPPED,
  applyDistillationJobRecord,
  createDistillationJobEventRecord,
} from "./distill-job-state.js";
import {
  DISTILL_JOB_EVENT_PATH,
  DistillJobCoordinatorError,
  assertCurrentDistillJobLease,
} from "./distill-job-coordinator.js";
import { EVIDENCE_EVENT_PATH } from "./canonical-finalize-service.js";
import { isDefinitiveNonKnowledge } from "./evidence-policy.js";
import { reviewSummaryThreadId } from "./github-pull-request-client.js";
import { computeCandidateSetSha256 } from "./host-assisted-distillation-service.js";
import { createDomainId } from "./ids.js";
import {
  applyKnowledgeDocumentPatch,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import {
  createMergeCandidateSearchPlan,
  resolveMergeCandidateSearch,
} from "./merge-candidate-service.js";
import type {
  PossibleKnowledgeMatch,
  PossibleMatchSet,
} from "./possible-match.js";
import {
  RequestIntegrityError,
  computeRequestSha256,
  type ExtractRequest,
} from "./request-integrity.js";
import {
  RuntimeFinalizeContextStore,
  RuntimeFinalizeContextStoreError,
  type RuntimeFinalizeHandle,
} from "./runtime-finalize-context-store.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

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
  readonly submissionEventPath?: string;
}

export type SubmitDistillationErrorCode =
  | "CURRENT_SNAPSHOT_INCOMPLETE"
  | "DISTILLATION_SOURCE_CHANGED"
  | "EVIDENCE_COMMENTS_INVALID"
  | "EXTRACT_REQUEST_INVALID"
  | "JOB_ALREADY_FINALIZED"
  | "JOB_CONTEXT_MISMATCH"
  | "PHASE_ALREADY_COMMITTED"
  | "RESUME_REQUIRED";

export class SubmitDistillationError extends Error {
  constructor(
    readonly code: SubmitDistillationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SubmitDistillationError";
  }
}

interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

interface ExtractContext {
  readonly comments: readonly CommentObservation[];
  readonly job: DistillJob;
  readonly operation: OperationTime;
  readonly sourceSnapshotId: string;
  readonly thread: ThreadObservation;
}

interface ExtractCommitResult {
  readonly receipt: Extract<SubmissionReceipt, { readonly phase: "extract" }>;
  readonly stableResponse: ExtractStableResponse;
}

interface SkipLifecyclePlan {
  readonly fileWrites: readonly CanonicalFileWriteRequest[];
  readonly records: readonly CanonicalAppendRecordRequest[];
  readonly staledKnowledgeIds: readonly string[];
  readonly withdrawnEvidenceIds: readonly string[];
}

/**
 * Commits host-assisted extract submissions and rehydrates their ephemeral
 * finalize authorization from canonical receipts. Plaintext handles never
 * enter a canonical transaction or the SQLite projection.
 */
export class SubmitDistillationService {
  readonly finalizeContexts: RuntimeFinalizeContextStore;

  private readonly candidateLimit: number | undefined;
  private readonly evidenceEventPath: string;
  private readonly jobEventPath: string;
  private readonly nextCandidateId: (timestamp: number) => string;
  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextReceiptId: (timestamp: number) => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly repoId: string;
  private readonly repository: CanonicalTransactionStore;
  private readonly submissionEventPath: string;

  constructor(options: SubmitDistillationServiceOptions) {
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.candidateLimit = options.candidateLimit;
    this.evidenceEventPath = canonicalEventPath(
      options.evidenceEventPath ?? EVIDENCE_EVENT_PATH,
    );
    this.jobEventPath = canonicalEventPath(
      options.jobEventPath ?? DISTILL_JOB_EVENT_PATH,
    );
    this.submissionEventPath = canonicalEventPath(
      options.submissionEventPath ?? SUBMISSION_EVENT_PATH,
    );
    this.now = options.now ?? (() => new Date());
    this.nextCandidateId =
      options.nextCandidateId ??
      ((timestamp) => createDomainId("candidate", timestamp));
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextReceiptId =
      options.nextReceiptId ??
      ((timestamp) => createDomainId("receipt", timestamp));
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
    this.finalizeContexts =
      options.finalizeContexts ??
      new RuntimeFinalizeContextStore({ now: this.now });
  }

  async submitExtract(
    request: SubmitExtractRequest,
  ): Promise<SubmitExtractResponse> {
    const submissionId = NonEmptyStringSchema.parse(request.submission_id);
    const requestSha256 = canonicalRequestDigest(request);
    const committed =
      await this.repository.runLockedMutation<ExtractCommitResult>(
        (snapshot) => {
          // Receipt lookup deliberately precedes lease, job, source, and candidate
          // validation so a committed request remains recoverable after expiry.
          const bySubmission = snapshot.domain.submissionReceipts.find(
            (receipt) => receipt.submission_id === submissionId,
          );
          if (bySubmission !== undefined) {
            if (bySubmission.phase !== "extract") {
              throw new RequestIntegrityError(
                "IDEMPOTENCY_KEY_REUSED",
                "submission_id was already committed for a different request",
              );
            }
            if (bySubmission.request_sha256 !== requestSha256) {
              throw new RequestIntegrityError(
                "IDEMPOTENCY_KEY_REUSED",
                "submission_id was already committed for a different request",
              );
            }
            return {
              transaction: null,
              value: {
                receipt: bySubmission,
                stableResponse: bySubmission.stable_response,
              },
            };
          }

          const jobId = JobIdSchema.parse(request.job_id);
          const phaseReceipt = snapshot.domain.submissionReceipts.find(
            (
              receipt,
            ): receipt is Extract<
              SubmissionReceipt,
              { readonly phase: "extract" }
            > => receipt.job_id === jobId && receipt.phase === "extract",
          );
          if (phaseReceipt !== undefined) {
            if (phaseReceipt.request_sha256 !== requestSha256) {
              throw submitError(
                "PHASE_ALREADY_COMMITTED",
                `extract was already committed for job ${jobId}`,
              );
            }
            return {
              transaction: null,
              value: {
                receipt: phaseReceipt,
                stableResponse: phaseReceipt.stable_response,
              },
            };
          }

          const output = parseExtractOutput(request);
          const context = this.currentContext(snapshot, request, "processing");
          const transactionId = this.nextTransactionId(
            context.operation.timestamp,
          );
          const receiptId = this.nextReceiptId(context.operation.timestamp);
          let stableResponse: ExtractStableResponse;
          let lifecycle: SkipLifecyclePlan = emptySkipLifecycle();
          let jobType:
            | typeof DISTILLATION_JOB_AWAITING_FINALIZE
            | typeof DISTILLATION_JOB_SKIPPED;

          if (output.candidates.length === 0) {
            lifecycle = this.planSkipLifecycle(
              snapshot,
              context,
              output.skip_reason!,
              transactionId,
            );
            stableResponse = ExtractStableResponseSchema.parse({
              skip_reason: output.skip_reason,
              staled_knowledge_ids: lifecycle.staledKnowledgeIds,
              state: "skipped",
              withdrawn_evidence_ids: lifecycle.withdrawnEvidenceIds,
            });
            jobType = DISTILLATION_JOB_SKIPPED;
          } else {
            const candidates = createMergeCandidateSearchPlan({
              ...(this.candidateLimit === undefined
                ? {}
                : { candidateLimit: this.candidateLimit }),
              candidates: sortCandidates(output.candidates).map(
                (candidate) => ({
                  candidate,
                  candidate_id: this.nextCandidateId(
                    context.operation.timestamp,
                  ),
                }),
              ),
              repoId: this.repoId,
              threadId: context.thread.thread_id,
            }).candidates;
            validateCandidateEvidenceComments(
              candidates,
              context.thread,
              context.comments,
            );
            stableResponse = ExtractStableResponseSchema.parse({
              candidates,
              state: "merge_decision_required",
            });
            jobType = DISTILLATION_JOB_AWAITING_FINALIZE;
          }

          const receipt = ExtractSubmissionReceiptSchema.parse({
            committed_at: context.operation.recordedAt,
            job_id: context.job.job_id,
            phase: "extract",
            receipt_id: receiptId,
            request_sha256: requestSha256,
            stable_response: stableResponse,
            submission_id: submissionId,
          });
          const jobRecord = createDistillationJobEventRecord({
            eventId: this.nextEventId(context.operation.timestamp),
            payload:
              jobType === DISTILLATION_JOB_SKIPPED
                ? {
                    job_id: context.job.job_id,
                    lease_generation: context.job.lease_generation,
                    skip_reason: output.skip_reason!,
                  }
                : {
                    job_id: context.job.job_id,
                    lease_generation: context.job.lease_generation,
                  },
            recordedAt: context.operation.recordedAt,
            transactionId,
            type: jobType,
          });
          applyDistillationJobRecord(context.job, jobRecord);
          const receiptRecord: CanonicalJsonlRecord<typeof receipt> = {
            payload: receipt,
            record_id: receipt.receipt_id,
            record_type: "SubmissionReceipt",
            recorded_at: context.operation.recordedAt,
            schema_version: 1,
            transaction_id: transactionId,
          };
          return {
            transaction: {
              appendRecords: [
                ...lifecycle.records,
                { record: jobRecord, targetPath: this.jobEventPath },
                { record: receiptRecord, targetPath: this.submissionEventPath },
              ],
              createdAt: context.operation.recordedAt,
              fileWrites: lifecycle.fileWrites,
              transactionId,
            },
            value: { receipt, stableResponse },
          };
        },
      );

    if (committed.stableResponse.state === "skipped") {
      return committed.stableResponse;
    }
    return this.rehydrateExtract(committed.receipt, request);
  }

  private async rehydrateExtract(
    receipt: Extract<SubmissionReceipt, { readonly phase: "extract" }>,
    request: SubmitExtractRequest,
  ): Promise<SubmitExtractMergeResponse> {
    if (receipt.stable_response.state !== "merge_decision_required") {
      throw new TypeError("cannot rehydrate a terminal extract receipt");
    }
    const candidates = receipt.stable_response.candidates;
    // Only the job's immutable thread binding is taken from this preliminary
    // view. Job state, lease, source, evidence, and search results are all
    // revalidated together by runLockedKnowledgeSearchMutation below.
    const planningSnapshot = await this.repository.readSnapshot();
    const planningJob = planningSnapshot.domain.distillJobs.find(
      (candidate) => candidate.job_id === receipt.job_id,
    );
    if (planningJob === undefined || planningJob.repo_id !== this.repoId) {
      throw submitError(
        "JOB_CONTEXT_MISMATCH",
        `job ${receipt.job_id} was not found in repository ${this.repoId}`,
      );
    }
    const plan = createMergeCandidateSearchPlan({
      ...(this.candidateLimit === undefined
        ? {}
        : { candidateLimit: this.candidateLimit }),
      candidates,
      repoId: this.repoId,
      threadId: planningJob.thread_id,
    });

    try {
      return await this.repository.runLockedKnowledgeSearchMutation(
        plan.searchable.map((entry) => entry.request),
        (view) => {
          const context = this.currentContext(
            view.snapshot,
            request,
            "awaiting_finalize",
          );
          if (context.job.job_id !== receipt.job_id) {
            throw submitError(
              "JOB_CONTEXT_MISMATCH",
              "extract receipt is bound to a different job",
            );
          }
          validateCandidateEvidenceComments(
            candidates,
            context.thread,
            context.comments,
          );
          const matches = resolveMergeCandidateSearch(
            { ...plan, threadId: context.thread.thread_id },
            view,
          );
          const candidateSetSha256 = computeCandidateSetSha256(candidates);
          const issued = this.finalizeContexts.issue({
            candidate_set_sha256: candidateSetSha256,
            content_fingerprint: context.thread.content_fingerprint,
            distillation_key: context.job.distillation_key,
            expires_at: context.job.lease_expires_at!,
            job_id: context.job.job_id,
            lease_generation: context.job.lease_generation,
            match_set_digest: matches.match_set_digest,
            possible_matches: matches.possible_matches,
            request_sha256: receipt.request_sha256,
            source_snapshot_id: context.sourceSnapshotId,
          });
          return {
            transaction: null,
            value: {
              candidate_set_sha256: candidateSetSha256,
              candidates,
              finalize_handle: issued.handle,
              match_set_digest: matches.match_set_digest,
              possible_matches: matches.possible_matches,
              state: "merge_decision_required" as const,
            },
          };
        },
      );
    } catch (error) {
      if (
        (error instanceof DistillJobCoordinatorError &&
          error.code === "STALE_LEASE") ||
        (error instanceof RuntimeFinalizeContextStoreError &&
          error.code === "FINALIZE_CONTEXT_EXPIRED")
      ) {
        throw submitError(
          "RESUME_REQUIRED",
          "the extract receipt is committed but its lease is no longer active; call prepare_distillation again",
          error,
        );
      }
      throw error;
    }
  }

  private currentContext(
    snapshot: CanonicalProjectionSnapshot,
    request: SubmitExtractRequest,
    expectedState: "awaiting_finalize" | "processing",
  ): ExtractContext {
    const jobId = JobIdSchema.parse(request.job_id);
    const job = snapshot.domain.distillJobs.find(
      (candidate) => candidate.job_id === jobId,
    );
    if (job === undefined || job.repo_id !== this.repoId) {
      throw submitError(
        "JOB_CONTEXT_MISMATCH",
        `job ${jobId} was not found in repository ${this.repoId}`,
      );
    }
    if (job.state === "done") {
      throw submitError(
        "JOB_ALREADY_FINALIZED",
        `job ${job.job_id} is already finalized`,
      );
    }
    if (job.state !== expectedState) {
      if (expectedState === "awaiting_finalize") {
        throw submitError(
          "RESUME_REQUIRED",
          `job ${job.job_id} is no longer awaiting finalize under this lease`,
        );
      }
      throw submitError(
        "JOB_CONTEXT_MISMATCH",
        `job ${job.job_id} is ${job.state}, not ${expectedState}`,
      );
    }
    const operation = operationTime(this.now, job);
    assertCurrentDistillJobLease(job, request, operation.timestamp);
    const fingerprint = Sha256DigestSchema.parse(request.thread_fingerprint);
    const thread = snapshot.domain.threads.find(
      (candidate) =>
        candidate.repo_id === this.repoId &&
        candidate.thread_id === job.thread_id,
    );
    if (thread === undefined) {
      throw submitError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${job.thread_id} has no current observation`,
      );
    }
    if (thread.content_fingerprint !== fingerprint) {
      throw submitError(
        "DISTILLATION_SOURCE_CHANGED",
        "the review thread content changed after prepare",
      );
    }
    const sourceSnapshot = snapshot.domain.pullRequestSnapshots.find(
      (candidate) =>
        candidate.snapshot_id === thread.snapshot_id &&
        candidate.repo_id === this.repoId &&
        candidate.pr_number === thread.pr_number &&
        snapshotContainsThread(candidate, thread.thread_id),
    );
    if (sourceSnapshot === undefined) {
      throw submitError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${thread.thread_id} is not bound to a complete snapshot`,
      );
    }
    const latestSnapshotId = currentPullRequestSnapshotId(
      snapshot,
      this.repoId,
      thread.pr_number,
    );
    if (
      latestSnapshotId !== null &&
      latestSnapshotId !== sourceSnapshot.snapshot_id
    ) {
      throw submitError(
        "DISTILLATION_SOURCE_CHANGED",
        "the prepared review thread is no longer in the current PR snapshot",
      );
    }
    const comments = snapshot.domain.comments
      .filter(
        (comment) =>
          comment.thread_id === thread.thread_id &&
          comment.snapshot_id === sourceSnapshot.snapshot_id &&
          thread.comment_ids.includes(comment.comment_id),
      )
      .sort(compareComments);
    if (comments.length !== thread.comment_ids.length) {
      throw submitError(
        "CURRENT_SNAPSHOT_INCOMPLETE",
        `thread ${thread.thread_id} is missing current comments`,
      );
    }
    return {
      comments,
      job,
      operation,
      sourceSnapshotId: sourceSnapshot.snapshot_id,
      thread,
    };
  }

  private planSkipLifecycle(
    snapshot: CanonicalProjectionSnapshot,
    context: ExtractContext,
    skipReason: SkipReason,
    transactionId: string,
  ): SkipLifecyclePlan {
    if (!isDefinitiveNonKnowledge(skipReason)) return emptySkipLifecycle();

    const active = currentActiveEvidence(
      snapshot,
      this.repoId,
      context.thread.thread_id,
    );
    const records = active.map((previous) => {
      const withdrawn = KnowledgeEvidenceSchema.parse({
        ...previous,
        eligible_for_count: false,
        observed_at: context.thread.observed_at,
        status: "withdrawn",
      });
      const record: CanonicalJsonlRecord<typeof withdrawn> = {
        payload: withdrawn,
        record_id: this.nextEventId(context.operation.timestamp),
        record_type: "EvidenceWithdrawn",
        recorded_at: context.operation.recordedAt,
        schema_version: 1,
        transaction_id: transactionId,
      };
      return { record, targetPath: this.evidenceEventPath };
    });
    const affectedKnowledgeIds = sortAndDedupeStrings(
      active.map((evidence) => evidence.knowledge_id),
    );
    const staledKnowledgeIds = affectedKnowledgeIds.filter(
      (knowledgeId) =>
        !snapshot.domain.evidence.some(
          (evidence) =>
            evidence.repo_id === this.repoId &&
            evidence.knowledge_id === knowledgeId &&
            evidence.thread_id !== context.thread.thread_id &&
            evidence.status === "active",
        ) && isAutomaticStaleCandidate(knowledgeId, snapshot),
    );
    return {
      fileWrites: staleKnowledgeFileWrites(
        staledKnowledgeIds,
        snapshot,
        context.operation.recordedAt,
        transactionId,
      ),
      records,
      staledKnowledgeIds,
      withdrawnEvidenceIds: active.map((evidence) => evidence.evidence_id),
    };
  }
}

function parseExtractOutput(request: SubmitExtractRequest) {
  try {
    if (request.phase !== "extract" || request.request_schema_version !== 1) {
      throw new TypeError(
        "phase must be extract and request_schema_version must be 1",
      );
    }
    return DistillationOutputSchema.parse({
      candidates: request.candidates,
      skip_reason: request.skip_reason,
    });
  } catch (error) {
    throw submitError(
      "EXTRACT_REQUEST_INVALID",
      "candidate payload and skip_reason are inconsistent or invalid",
      error,
    );
  }
}

function canonicalRequestDigest(request: SubmitExtractRequest): string {
  return Sha256DigestSchema.parse(`sha256:${computeRequestSha256(request)}`);
}

function sortCandidates(
  candidates: readonly DistilledCandidate[],
): DistilledCandidate[] {
  return [...candidates].sort((left, right) =>
    compareCodeUnits(canonicalizeJson(left), canonicalizeJson(right)),
  );
}

function validateCandidateEvidenceComments(
  candidates: readonly ExtractCandidate[],
  thread: ThreadObservation,
  comments: readonly CommentObservation[],
): void {
  const currentIds = new Set(comments.map((comment) => comment.comment_id));
  const invalid = sortAndDedupeStrings(
    candidates.flatMap((candidate) => candidate.candidate.evidence_comment_ids),
  ).filter((id) => !thread.comment_ids.includes(id) || !currentIds.has(id));
  if (invalid.length > 0) {
    throw submitError(
      "EVIDENCE_COMMENTS_INVALID",
      `evidence comments are outside the current snapshot: ${invalid.join(", ")}`,
    );
  }
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
  if (activation?.origin === "human" || activation?.pinned === true) {
    return false;
  }
  const origin = asRecord(document.frontmatter.origin);
  return activation?.origin === "automatic" || origin?.type === "distilled";
}

function emptySkipLifecycle(): SkipLifecyclePlan {
  return {
    fileWrites: [],
    records: [],
    staledKnowledgeIds: [],
    withdrawnEvidenceIds: [],
  };
}

function currentPullRequestSnapshotId(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  prNumber: number,
): string | null {
  const pullRequest = snapshot.domain.pullRequests.find(
    (candidate) =>
      candidate.repo_id === repoId && candidate.pr_number === prNumber,
  );
  if (pullRequest !== undefined) return pullRequest.snapshot_id;
  return (
    snapshot.domain.pullRequestSnapshots
      .filter(
        (candidate) =>
          candidate.repo_id === repoId && candidate.pr_number === prNumber,
      )
      .sort(
        (first, second) =>
          compareCodeUnits(second.observed_at, first.observed_at) ||
          compareCodeUnits(second.snapshot_id, first.snapshot_id),
      )[0]?.snapshot_id ?? null
  );
}

function snapshotContainsThread(
  snapshot: CanonicalProjectionSnapshot["domain"]["pullRequestSnapshots"][number],
  threadId: string,
): boolean {
  return (
    snapshot.thread_ids.includes(threadId) ||
    snapshot.review_summary_ids.some(
      (reviewId) => reviewSummaryThreadId(reviewId) === threadId,
    )
  );
}

function operationTime(now: () => Date, job: DistillJob): OperationTime {
  const timestamp = now().getTime();
  if (!Number.isFinite(timestamp)) {
    throw submitError(
      "EXTRACT_REQUEST_INVALID",
      "now() returned an invalid Date",
    );
  }
  const monotonicTimestamp = Math.max(timestamp, Date.parse(job.updated_at));
  return {
    recordedAt: new Date(monotonicTimestamp).toISOString(),
    timestamp: monotonicTimestamp,
  };
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

function canonicalEventPath(value: string): string {
  const segments = value.split("/");
  if (
    !value.startsWith("events/") ||
    !value.endsWith(".jsonl") ||
    value.includes("\\") ||
    value.includes("\0") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError("event path must be a safe events/**/*.jsonl path");
  }
  return value;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function submitError(
  code: SubmitDistillationErrorCode,
  message: string,
  cause?: unknown,
): SubmitDistillationError {
  return new SubmitDistillationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

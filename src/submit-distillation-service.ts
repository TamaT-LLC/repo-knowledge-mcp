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
import { evaluateCodeExampleGrounding } from "./code-example-grounding.js";
import { computeTrustPolicyDigest } from "./config.js";
import {
  DistillationOutputSchema,
  ExtractStableResponseSchema,
  ExtractSubmissionReceiptSchema,
  FinalizeSubmissionReceiptSchema,
  JobIdSchema,
  KnowledgeEvidenceSchema,
  NonEmptyStringSchema,
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type CommentObservation,
  type DistillJob,
  type DistilledCandidate,
  type ExtractCandidate,
  type ExtractStableResponse,
  type FinalizeStableResponse,
  type KnowledgeEvidence,
  type RepoKnowledgeConfig,
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
import {
  CanonicalFinalizeError,
  CanonicalFinalizeService,
  EVIDENCE_EVENT_PATH,
} from "./canonical-finalize-service.js";
import {
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
} from "./distillation-prompt.js";
import { isDefinitiveNonKnowledge } from "./evidence-policy.js";
import type { FinalizeContext } from "./finalize-guard.js";
import { reviewSummaryThreadId } from "./github-pull-request-client.js";
import {
  HostAssistedDistillationError,
  computeCandidateSetSha256,
  resolveHostAssistedDistillationSource,
} from "./host-assisted-distillation-service.js";
import { createDomainId } from "./ids.js";
import {
  applyKnowledgeDocumentPatch,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import {
  createMergeCandidateSearchPlan,
  resolveMergeCandidateSearch,
} from "./merge-candidate-service.js";
import { MergeClassifierError } from "./merge-classifier.js";
import type {
  PossibleKnowledgeMatch,
  PossibleMatchSet,
} from "./possible-match.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import {
  RequestIntegrityError,
  computeRequestSha256,
  type ExtractRequest,
  type FinalizeRequest,
  type PhaseRequest,
} from "./request-integrity.js";
import {
  RuntimeFinalizeContextStore,
  RuntimeFinalizeContextStoreError,
  hashFinalizeToken,
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

interface FinalizeReceiptMiss {
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

type FinalizeReceiptLookup = FinalizeReceiptMiss | FinalizeReceiptReplay;

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

type FinalizeLockedResult = FinalizeCommitted | FinalizeMatchChanged;

interface ValidatedSubmitDistillationContext {
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

  private readonly canonicalFinalizer: CanonicalFinalizeService;
  private readonly candidateLimit: number | undefined;
  private readonly distillationContext:
    ValidatedSubmitDistillationContext | undefined;
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
    this.distillationContext =
      options.distillationContext === undefined
        ? undefined
        : validateDistillationContext(options.distillationContext);
    this.finalizeContexts =
      options.finalizeContexts ??
      new RuntimeFinalizeContextStore({ now: this.now });
    this.canonicalFinalizer = new CanonicalFinalizeService({
      ...(this.candidateLimit === undefined
        ? {}
        : { candidateLimit: this.candidateLimit }),
      evidenceEventPath: this.evidenceEventPath,
      jobEventPath: this.jobEventPath,
      now: this.now,
      repoId: this.repoId,
      repository: this.repository,
    });
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

  async submitFinalize(
    request: SubmitFinalizeRequest,
  ): Promise<FinalizeStableResponse> {
    const submissionId = NonEmptyStringSchema.parse(request.submission_id);
    const requestSha256 = canonicalRequestDigest(request);
    const lookup =
      await this.repository.runLockedMutation<FinalizeReceiptLookup>(
        (snapshot) => {
          // This lookup intentionally precedes request token, lease, job-state,
          // and source validation. A durable success must replay after every
          // ephemeral authorization has expired or disappeared.
          const replay = findFinalizeReceiptReplay(
            snapshot,
            submissionId,
            request.job_id,
            requestSha256,
          );
          if (replay !== undefined) {
            return {
              transaction: null,
              value: { kind: "replay", stableResponse: replay },
            };
          }

          const jobId = JobIdSchema.parse(request.job_id);
          const extractReceipt = requiredExtractCandidateReceipt(
            snapshot,
            jobId,
          );
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
              `job ${jobId} is finalized without a replayable receipt`,
            );
          }
          return {
            transaction: null,
            value: {
              extractReceipt,
              kind: "miss",
              threadId: job.thread_id,
            },
          };
        },
      );
    if (lookup.kind === "replay") return lookup.stableResponse;

    const parsed = parseFinalizeRequest(request);
    const runtimeContext = this.finalizeContexts.find(request.finalize_token);
    if (runtimeContext === undefined) {
      const lateReplay = await this.repository.runLockedMutation(
        (snapshot) => ({
          transaction: null,
          value: findFinalizeReceiptReplay(
            snapshot,
            submissionId,
            parsed.jobId,
            requestSha256,
          ),
        }),
      );
      if (lateReplay !== undefined) return lateReplay;
      throw submitError(
        "UNKNOWN_FINALIZE_TOKEN",
        "the finalize token is unknown, expired, or belongs to an earlier process",
      );
    }
    validateFinalizeRuntimeBinding(
      parsed,
      runtimeContext,
      lookup.extractReceipt,
      request.finalize_token,
    );
    const candidates = lookup.extractReceipt.stable_response.candidates;
    const searchPlan = createMergeCandidateSearchPlan({
      ...(this.candidateLimit === undefined
        ? {}
        : { candidateLimit: this.candidateLimit }),
      candidates,
      repoId: this.repoId,
      threadId: lookup.threadId,
    });
    const distillationContext = this.requireDistillationContext();

    let result: FinalizeLockedResult;
    try {
      result =
        await this.repository.runLockedKnowledgeSearchMutation<FinalizeLockedResult>(
          searchPlan.searchable.map((entry) => entry.request),
          (view) => {
            // Close the miss-to-commit race under the same lock. A concurrent
            // successful finalize wins and is replayed without another write.
            const replay = findFinalizeReceiptReplay(
              view.snapshot,
              submissionId,
              parsed.jobId,
              requestSha256,
            );
            if (replay !== undefined) {
              return {
                transaction: null,
                value: {
                  kind: "replay" as const,
                  stableResponse: replay,
                },
              };
            }

            const job = view.snapshot.domain.distillJobs.find(
              (candidate) => candidate.job_id === parsed.jobId,
            );
            if (
              job === undefined ||
              job.repo_id !== this.repoId ||
              job.thread_id !== lookup.threadId
            ) {
              throw submitError(
                "JOB_CONTEXT_MISMATCH",
                "the finalize job is not bound to the extracted repository and thread",
              );
            }
            if (job.state !== "awaiting_finalize") {
              throw submitError(
                job.state === "done"
                  ? "JOB_ALREADY_FINALIZED"
                  : "JOB_CONTEXT_MISMATCH",
                `job ${job.job_id} is not awaiting finalize`,
              );
            }
            const operation = operationTime(this.now, job);
            assertCurrentDistillJobLease(
              job,
              {
                job_id: parsed.jobId,
                lease_generation: parsed.leaseGeneration,
                lease_token: request.lease_token,
              },
              operation.timestamp,
            );
            if (Date.parse(runtimeContext.expires_at) <= operation.timestamp) {
              throw submitError(
                "UNKNOWN_FINALIZE_TOKEN",
                "the finalize token expired before canonical commit",
              );
            }
            const currentThread = view.snapshot.domain.threads.find(
              (candidate) =>
                candidate.repo_id === this.repoId &&
                candidate.thread_id === job.thread_id,
            );
            if (
              currentThread === undefined ||
              currentThread.content_fingerprint !==
                runtimeContext.content_fingerprint
            ) {
              throw submitError(
                "DISTILLATION_SOURCE_CHANGED",
                "the review source changed after the finalize token was issued",
              );
            }
            const source = resolveHostAssistedDistillationSource(
              view.snapshot,
              job,
              {
                outputSchemaDigest: distillationContext.outputSchemaDigest,
                promptDigest: distillationContext.promptDigest,
                repoId: this.repoId,
                repositoryContext: distillationContext.repositoryContext,
                trustPolicyDigest: distillationContext.trustPolicyDigest,
              },
            );
            if (
              source.contentFingerprint !== runtimeContext.content_fingerprint
            ) {
              throw submitError(
                "DISTILLATION_SOURCE_CHANGED",
                "the review source changed after the finalize token was issued",
              );
            }
            if (source.distillationKey !== runtimeContext.distillation_key) {
              throw submitError(
                "DISTILLATION_CONTEXT_CHANGED",
                "the prompt, schema, trust policy, or repository context changed",
              );
            }

            try {
              const planned = this.canonicalFinalizer.planFinalizeMutation(
                {
                  candidates,
                  content_fingerprint: source.contentFingerprint,
                  decisions: request.decisions,
                  distillation_key: source.distillationKey,
                  expected_match_set_digest: runtimeContext.match_set_digest,
                  lease: {
                    job_id: parsed.jobId,
                    lease_generation: parsed.leaseGeneration,
                    lease_token: request.lease_token,
                  },
                  provenance: finalizeProvenance(
                    distillationContext,
                    source.distillationKey,
                  ),
                  thread_id: job.thread_id,
                },
                view,
              );
              const receipt = FinalizeSubmissionReceiptSchema.parse({
                committed_at: planned.transaction.createdAt,
                job_id: parsed.jobId,
                phase: "finalize",
                receipt_id: this.nextReceiptId(
                  Date.parse(planned.transaction.createdAt),
                ),
                request_sha256: requestSha256,
                stable_response: planned.value,
                submission_id: submissionId,
              });
              const receiptRecord: CanonicalJsonlRecord<typeof receipt> = {
                payload: receipt,
                record_id: receipt.receipt_id,
                record_type: "SubmissionReceipt",
                recorded_at: planned.transaction.createdAt,
                schema_version: 1,
                transaction_id: planned.transaction.transactionId,
              };
              return {
                transaction: {
                  ...planned.transaction,
                  appendRecords: [
                    ...planned.transaction.appendRecords,
                    {
                      record: receiptRecord,
                      targetPath: this.submissionEventPath,
                    },
                  ],
                },
                value: {
                  kind: "committed" as const,
                  stableResponse: planned.value,
                },
              };
            } catch (error) {
              if (
                error instanceof CanonicalFinalizeError &&
                error.code === "MERGE_CANDIDATES_CHANGED" &&
                error.currentSearch !== undefined
              ) {
                return {
                  transaction: null,
                  value: {
                    contentFingerprint: source.contentFingerprint,
                    distillationKey: source.distillationKey,
                    expiresAt: job.lease_expires_at!,
                    kind: "match_changed" as const,
                    search: error.currentSearch,
                    sourceSnapshotId: source.snapshotId,
                  },
                };
              }
              throw error;
            }
          },
        );
    } catch (error) {
      throw translateFinalizeError(error);
    }

    if (result.kind === "match_changed") {
      let issued: ReturnType<RuntimeFinalizeContextStore["issue"]>;
      try {
        issued = this.finalizeContexts.issue({
          candidate_set_sha256: parsed.candidateSetSha256,
          content_fingerprint: result.contentFingerprint,
          distillation_key: result.distillationKey,
          expires_at: result.expiresAt,
          job_id: parsed.jobId,
          lease_generation: parsed.leaseGeneration,
          match_set_digest: result.search.match_set_digest,
          possible_matches: result.search.possible_matches,
          request_sha256: lookup.extractReceipt.request_sha256,
          source_snapshot_id: result.sourceSnapshotId,
        });
      } catch (error) {
        if (
          error instanceof RuntimeFinalizeContextStoreError &&
          error.code === "FINALIZE_CONTEXT_EXPIRED"
        ) {
          throw submitError(
            "RESUME_REQUIRED",
            "the lease expired while refreshing changed merge candidates",
            error,
          );
        }
        throw error;
      }
      this.finalizeContexts.remove(request.finalize_token);
      throw new SubmitDistillationError(
        "MERGE_CANDIDATES_CHANGED",
        "the possible match set changed; classify the latest matches and retry with a new submission_id",
        {
          retry: {
            candidate_set_sha256: parsed.candidateSetSha256,
            finalize_handle: issued.handle,
            match_set_digest: result.search.match_set_digest,
            possible_matches: result.search.possible_matches,
            state: "merge_decision_required",
          },
        },
      );
    }

    if (result.kind === "committed") {
      this.finalizeContexts.remove(request.finalize_token);
    }
    return result.stableResponse;
  }

  private requireDistillationContext(): ValidatedSubmitDistillationContext {
    if (this.distillationContext === undefined) {
      throw submitError(
        "FINALIZE_REQUEST_INVALID",
        "submit finalize requires host-assisted distillation context configuration",
      );
    }
    return this.distillationContext;
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

interface ParsedFinalizeRequest {
  readonly candidateSetSha256: string;
  readonly jobId: string;
  readonly leaseGeneration: number;
}

function parseFinalizeRequest(
  request: SubmitFinalizeRequest,
): ParsedFinalizeRequest {
  try {
    if (request.phase !== "finalize" || request.request_schema_version !== 1) {
      throw new TypeError(
        "phase must be finalize and request_schema_version must be 1",
      );
    }
    NonEmptyStringSchema.parse(request.submission_id);
    NonEmptyStringSchema.parse(request.lease_token);
    NonEmptyStringSchema.parse(request.finalize_token);
    if (
      !Number.isSafeInteger(request.lease_generation) ||
      request.lease_generation < 1
    ) {
      throw new TypeError("lease_generation must be a positive safe integer");
    }
    if (!Array.isArray(request.decisions)) {
      throw new TypeError("decisions must be an array");
    }
    return {
      candidateSetSha256: rawSha256(
        request.candidate_set_sha256,
        "candidate_set_sha256",
      ),
      jobId: JobIdSchema.parse(request.job_id),
      leaseGeneration: request.lease_generation,
    };
  } catch (error) {
    throw submitError(
      "FINALIZE_REQUEST_INVALID",
      "the finalize request envelope is invalid",
      error,
    );
  }
}

function findFinalizeReceiptReplay(
  snapshot: CanonicalProjectionSnapshot,
  submissionId: string,
  jobId: string,
  requestSha256: string,
): FinalizeStableResponse | undefined {
  const bySubmission = snapshot.domain.submissionReceipts.find(
    (receipt) => receipt.submission_id === submissionId,
  );
  if (bySubmission !== undefined) {
    if (
      bySubmission.phase !== "finalize" ||
      bySubmission.request_sha256 !== requestSha256
    ) {
      throw new RequestIntegrityError(
        "IDEMPOTENCY_KEY_REUSED",
        "submission_id was already committed for a different request",
      );
    }
    return bySubmission.stable_response;
  }

  const phaseReceipt = snapshot.domain.submissionReceipts.find(
    (
      receipt,
    ): receipt is Extract<SubmissionReceipt, { readonly phase: "finalize" }> =>
      receipt.job_id === jobId && receipt.phase === "finalize",
  );
  if (phaseReceipt === undefined) return undefined;
  if (phaseReceipt.request_sha256 !== requestSha256) {
    throw submitError(
      "PHASE_ALREADY_COMMITTED",
      `finalize was already committed for job ${jobId}`,
    );
  }
  return phaseReceipt.stable_response;
}

function requiredExtractCandidateReceipt(
  snapshot: CanonicalProjectionSnapshot,
  jobId: string,
): FinalizeReceiptMiss["extractReceipt"] {
  const receipts = snapshot.domain.submissionReceipts.filter(
    (
      receipt,
    ): receipt is Extract<SubmissionReceipt, { readonly phase: "extract" }> =>
      receipt.job_id === jobId && receipt.phase === "extract",
  );
  if (receipts.length !== 1) {
    throw submitError(
      "FINALIZE_REQUEST_INVALID",
      `job ${jobId} does not have exactly one canonical extract receipt`,
    );
  }
  const receipt = receipts[0]!;
  if (receipt.stable_response.state !== "merge_decision_required") {
    throw submitError(
      "FINALIZE_REQUEST_INVALID",
      `job ${jobId} has a terminal extract receipt and cannot be finalized`,
    );
  }
  return receipt as FinalizeReceiptMiss["extractReceipt"];
}

function validateFinalizeRuntimeBinding(
  parsed: ParsedFinalizeRequest,
  context: FinalizeContext,
  extractReceipt: FinalizeReceiptMiss["extractReceipt"],
  finalizeToken: string,
): void {
  if (context.token_hash !== hashFinalizeToken(finalizeToken)) {
    throw submitError(
      "UNKNOWN_FINALIZE_TOKEN",
      "the runtime finalize context has an inconsistent token binding",
    );
  }
  const candidateSetSha256 = computeCandidateSetSha256(
    extractReceipt.stable_response.candidates,
  );
  if (
    parsed.jobId !== context.job_id ||
    parsed.jobId !== extractReceipt.job_id ||
    parsed.leaseGeneration !== context.lease_generation ||
    parsed.candidateSetSha256 !== context.candidate_set_sha256 ||
    parsed.candidateSetSha256 !== candidateSetSha256 ||
    context.request_sha256 !== extractReceipt.request_sha256
  ) {
    throw submitError(
      "FINALIZE_REQUEST_INVALID",
      "the finalize request is not bound to its extract receipt, lease generation, and candidate set",
    );
  }
}

function validateDistillationContext(
  input: SubmitDistillationContextOptions,
): ValidatedSubmitDistillationContext {
  const config = RepoKnowledgeConfigSchema.parse(input.config);
  return {
    config,
    model: NonEmptyStringSchema.parse(input.model ?? "mcp-host"),
    outputSchemaDigest: Sha256DigestSchema.parse(
      input.outputSchemaDigest ?? DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    ),
    outputSchemaVersion: NonEmptyStringSchema.parse(
      input.outputSchemaVersion ?? DISTILLATION_OUTPUT_SCHEMA_VERSION,
    ),
    promptDigest: Sha256DigestSchema.parse(input.promptDigest),
    promptVersion: NonEmptyStringSchema.parse(input.promptVersion),
    provider: NonEmptyStringSchema.parse(input.provider ?? "host-assisted"),
    repositoryContext: JSON.parse(
      canonicalizeJson(input.repositoryContext),
    ) as unknown,
    trustPolicyDigest: computeTrustPolicyDigest(config.trust),
  };
}

function finalizeProvenance(
  context: ValidatedSubmitDistillationContext,
  distillationKey: string,
): DistillationProvenance {
  return {
    distillation_key: distillationKey,
    model: context.model,
    output_schema_digest: context.outputSchemaDigest,
    output_schema_version: context.outputSchemaVersion,
    prompt_digest: context.promptDigest,
    prompt_version: context.promptVersion,
    provider: context.provider,
    trust_policy_digest: context.trustPolicyDigest,
  };
}

function translateFinalizeError(error: unknown): Error {
  if (error instanceof SubmitDistillationError) return error;
  if (error instanceof HostAssistedDistillationError) {
    return submitError(
      error.code === "DISTILLATION_CONTEXT_CHANGED"
        ? "DISTILLATION_CONTEXT_CHANGED"
        : "DISTILLATION_SOURCE_CHANGED",
      error.message,
      error,
    );
  }
  if (error instanceof MergeClassifierError) {
    return submitError(
      "FINALIZE_REQUEST_INVALID",
      "the finalize decisions are incomplete, duplicated, or target an invalid match",
      error,
    );
  }
  if (error instanceof CanonicalFinalizeError) {
    if (error.code === "FINALIZE_REQUEST_INVALID") {
      return submitError("FINALIZE_REQUEST_INVALID", error.message, error);
    }
    if (
      error.code === "CURRENT_SNAPSHOT_INCOMPLETE" ||
      error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_CHANGED" ||
      error.code === "EVIDENCE_COMMENTS_INVALID" ||
      error.code === "JOB_CONTEXT_MISMATCH"
    ) {
      return submitError(error.code, error.message, error);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
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

function canonicalRequestDigest(request: PhaseRequest): string {
  return Sha256DigestSchema.parse(`sha256:${computeRequestSha256(request)}`);
}

function rawSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase hexadecimal SHA-256`);
  }
  return value;
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
    candidates.flatMap((candidate) => [
      ...candidate.candidate.evidence_comment_ids,
      ...(candidate.candidate.code_example?.evidence_comment_ids ?? []),
    ]),
  ).filter((id) => !thread.comment_ids.includes(id) || !currentIds.has(id));
  if (invalid.length > 0) {
    throw submitError(
      "EVIDENCE_COMMENTS_INVALID",
      `evidence comments are outside the current snapshot: ${invalid.join(", ")}`,
    );
  }
  const sources = comments.map((comment) => ({
    body: comment.body,
    ...(comment.diff_hunk === undefined ? {} : { diffHunk: comment.diff_hunk }),
    id: comment.comment_id,
  }));
  for (const candidate of candidates) {
    const example = candidate.candidate.code_example;
    if (example === undefined) continue;
    const grounding = evaluateCodeExampleGrounding(example, sources);
    if (!grounding.grounded) {
      throw submitError(
        "EVIDENCE_COMMENTS_INVALID",
        `code_example content references tokens absent from its cited evidence: ${grounding.ungrounded_tokens.join(
          ", ",
        )}`,
      );
    }
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

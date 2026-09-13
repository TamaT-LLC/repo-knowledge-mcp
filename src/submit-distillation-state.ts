import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import { type CanonicalFileWriteRequest } from "./canonical-transaction-store.js";
import { evaluateCodeExampleGrounding } from "./code-example-grounding.js";
import { computeTrustPolicyDigest } from "./config.js";
import {
  DistillationOutputSchema,
  JobIdSchema,
  NonEmptyStringSchema,
  RepoKnowledgeConfigSchema,
  Sha256DigestSchema,
  type CommentObservation,
  type DistillJob,
  type DistilledCandidate,
  type ExtractCandidate,
  type FinalizeStableResponse,
  type KnowledgeEvidence,
  type SubmissionReceipt,
  type ThreadObservation,
} from "./domain-schemas.js";
import { CanonicalFinalizeError } from "./canonical-finalize-service.js";
import {
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
} from "./distillation-prompt.js";
import type { FinalizeContext } from "./finalize-guard.js";
import { reviewSummaryThreadId } from "./github-pull-request-client.js";
import {
  HostAssistedDistillationError,
  computeCandidateSetSha256,
} from "./host-assisted-distillation-service.js";
import {
  applyKnowledgeDocumentPatch,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { MergeClassifierError } from "./merge-classifier.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import {
  RequestIntegrityError,
  computeRequestSha256,
  type PhaseRequest,
} from "./request-integrity.js";
import { hashFinalizeToken } from "./runtime-finalize-context-store.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

import {
  type SubmitExtractRequest,
  type SubmitFinalizeRequest,
  type SubmitDistillationContextOptions,
  type SubmitDistillationErrorCode,
  SubmitDistillationError,
  type OperationTime,
  type FinalizeReceiptMiss,
  type ValidatedSubmitDistillationContext,
  type SkipLifecyclePlan,
} from "./submit-distillation-types.js";

interface ParsedFinalizeRequest {
  readonly candidateSetSha256: string;
  readonly jobId: string;
  readonly leaseGeneration: number;
}

export function parseFinalizeRequest(
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

export function findFinalizeReceiptReplay(
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

export function requiredExtractCandidateReceipt(
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

export function validateFinalizeRuntimeBinding(
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

export function validateDistillationContext(
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

export function finalizeProvenance(
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

export function translateFinalizeError(error: unknown): Error {
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

export function parseExtractOutput(request: SubmitExtractRequest) {
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

export function canonicalRequestDigest(request: PhaseRequest): string {
  return Sha256DigestSchema.parse(`sha256:${computeRequestSha256(request)}`);
}

function rawSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase hexadecimal SHA-256`);
  }
  return value;
}

export function sortCandidates(
  candidates: readonly DistilledCandidate[],
): DistilledCandidate[] {
  return [...candidates].sort((left, right) =>
    compareCodeUnits(canonicalizeJson(left), canonicalizeJson(right)),
  );
}

export function validateCandidateEvidenceComments(
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

export function currentActiveEvidence(
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

export function staleKnowledgeFileWrites(
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

export function isAutomaticStaleCandidate(
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

export function emptySkipLifecycle(): SkipLifecyclePlan {
  return {
    fileWrites: [],
    records: [],
    staledKnowledgeIds: [],
    withdrawnEvidenceIds: [],
  };
}

export function currentPullRequestSnapshotId(
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

export function snapshotContainsThread(
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

export function operationTime(now: () => Date, job: DistillJob): OperationTime {
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

export function compareComments(
  left: CommentObservation,
  right: CommentObservation,
): number {
  return (
    compareCodeUnits(left.created_at, right.created_at) ||
    compareCodeUnits(left.comment_id, right.comment_id)
  );
}

export function canonicalEventPath(value: string): string {
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

export function submitError(
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

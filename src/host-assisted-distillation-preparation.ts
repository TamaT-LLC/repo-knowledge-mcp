import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeComments,
  sha256Jcs,
} from "./canonical.js";
import {
  ExtractCandidateSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type DistillJob,
  type ExtractCandidate,
  type RepoKnowledgeConfig,
  type ReviewerIdentity,
  type SubmissionReceipt,
} from "./domain-schemas.js";
import { type DistillJobLease } from "./distill-job-coordinator.js";
import {
  classifyCommentExclusion,
  computeDistillationInputDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  type NormalizedDistillationActor,
  type NormalizedDistillationComment,
} from "./github-snapshot-normalizer.js";
import { reviewSummaryThreadId } from "./github-pull-request-client.js";
import { type MergeCandidateSearchResult } from "./merge-candidate-service.js";
import {
  SensitiveContentTransmissionError,
  findSensitiveContent,
} from "./sensitive-content.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

import {
  DEFAULT_PREPARE_DISTILLATION_LIMIT,
  MAX_PREPARE_DISTILLATION_LIMIT,
  MAX_PREPARE_BLOCKED_JOB_METADATA,
  REQUIRED_HOST_ASSISTED_SETTINGS,
  type HostAssistedSetting,
  type HostAssistedDistillationJobMetadata,
  type HostAssistedDistillationActor,
  type HostAssistedBlockedJobReason,
  type HostAssistedBlockedJob,
  type HostAssistedDistillationDisabledResult,
  type HostAssistedDistillationErrorCode,
  HostAssistedDistillationError,
  type CurrentHostAssistedDistillationSource,
  type ResolveHostAssistedDistillationSourceInput,
  type PreparedReviewContent,
} from "./host-assisted-distillation-types.js";

export function resolveHostAssistedDistillationSource(
  snapshot: CanonicalProjectionSnapshot,
  job: DistillJob,
  input: ResolveHostAssistedDistillationSourceInput,
): CurrentHostAssistedDistillationSource {
  const repoId = RepositoryIdSchema.parse(input.repoId);
  const promptDigest = Sha256DigestSchema.parse(input.promptDigest);
  const outputSchemaDigest = Sha256DigestSchema.parse(input.outputSchemaDigest);
  const trustPolicyDigest = Sha256DigestSchema.parse(input.trustPolicyDigest);
  const thread = snapshot.domain.threads.find(
    (candidate) =>
      candidate.repo_id === repoId && candidate.thread_id === job.thread_id,
  );
  if (thread === undefined) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "the canonical review thread is unavailable",
    );
  }

  const sourceSnapshot = snapshot.domain.pullRequestSnapshots.find(
    (candidate) => candidate.snapshot_id === thread.snapshot_id,
  );
  if (
    sourceSnapshot === undefined ||
    sourceSnapshot.repo_id !== repoId ||
    sourceSnapshot.pr_number !== thread.pr_number ||
    !snapshotContainsThread(sourceSnapshot, thread.thread_id)
  ) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "the complete source snapshot is unavailable",
    );
  }
  const latestSnapshotId = currentPullRequestSnapshotId(
    snapshot,
    repoId,
    thread.pr_number,
  );
  if (
    latestSnapshotId !== null &&
    latestSnapshotId !== sourceSnapshot.snapshot_id
  ) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "the review thread is no longer part of the current snapshot",
    );
  }

  const commentsById = new Map(
    snapshot.domain.comments.map((comment) => [comment.comment_id, comment]),
  );
  const working = thread.comment_ids.map((commentId) => {
    const comment = commentsById.get(commentId);
    if (
      comment === undefined ||
      comment.thread_id !== thread.thread_id ||
      comment.snapshot_id !== sourceSnapshot.snapshot_id
    ) {
      throw hostError(
        "DISTILLATION_SOURCE_UNAVAILABLE",
        "the complete canonical comment set is unavailable",
      );
    }
    const normalized: NormalizedDistillationComment = {
      body: comment.body,
      createdAt: comment.created_at,
      ...(comment.diff_hunk === undefined
        ? {}
        : { diffHunk: comment.diff_hunk }),
      id: comment.comment_id,
      updatedAt: comment.updated_at,
    };
    return {
      actor: normalizeActor(comment.actor),
      createdAt: normalized.createdAt,
      excluded: classifyCommentExclusion(comment.body, comment.actor) !== null,
      id: normalized.id,
      normalized,
    };
  });
  const included = normalizeComments(working).filter(
    (comment) => !comment.excluded,
  );
  if (included.length === 0) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "the review thread has no distillable comments",
    );
  }
  const normalizedComments = included.map((comment) => comment.normalized);
  const normalizedActors = included.map((comment) => comment.actor);
  const path = thread.path ?? null;
  const contentFingerprint = computeThreadContentFingerprint(
    thread.thread_id,
    path,
    normalizedComments,
  );
  if (contentFingerprint !== thread.content_fingerprint) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "the canonical review fingerprint is inconsistent",
    );
  }
  const distillationInputDigest = computeDistillationInputDigest({
    normalizedActors,
    normalizedComments,
    path,
    repositoryContext: input.repositoryContext,
    threadId: thread.thread_id,
  });
  const distillationKey = computeThreadDistillationKey({
    distillationInputDigest,
    outputSchemaDigest,
    promptDigest,
    trustPolicyDigest,
  });
  if (distillationKey !== job.distillation_key) {
    throw hostError(
      "DISTILLATION_CONTEXT_CHANGED",
      "the review source, prompt, schema, or trust policy changed",
    );
  }

  return {
    contentFingerprint,
    distillationKey,
    normalizedActors,
    normalizedComments,
    path,
    snapshotId: sourceSnapshot.snapshot_id,
  };
}

export function disabledResult(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  config: RepoKnowledgeConfig,
  limit: number,
): HostAssistedDistillationDisabledResult {
  const missingSettings: HostAssistedSetting[] = [];
  if (!config.hostAssistedDistillation.enabled) {
    missingSettings.push("hostAssistedDistillation.enabled");
  }
  if (!config.hostAssistedDistillation.allowReviewContentTransmission) {
    missingSettings.push(
      "hostAssistedDistillation.allowReviewContentTransmission",
    );
  }
  const jobs = snapshot.domain.distillJobs
    .filter(
      (job) =>
        job.repo_id === repoId &&
        (job.state === "pending" ||
          job.state === "processing" ||
          job.state === "awaiting_finalize"),
    )
    .sort(comparePrepareCandidates)
    .slice(0, limit)
    .map(jobMetadata);
  return {
    instructions: [
      "Review content remains local while host-assisted distillation is disabled.",
      "Set both required settings to true only if the MCP host model may receive review content.",
    ],
    jobs,
    missing_settings: missingSettings,
    required_settings: REQUIRED_HOST_ASSISTED_SETTINGS,
    state: "disabled",
  };
}

export function prepareReviewContent(
  source: CurrentHostAssistedDistillationSource,
  includeDiffHunk: boolean,
): PreparedReviewContent {
  const comments = source.normalizedComments.map((comment, index) => ({
    actor: publicActor(source.normalizedActors[index]!),
    body: comment.body,
    created_at: comment.createdAt,
    ...(includeDiffHunk && comment.diffHunk !== undefined
      ? { diff_hunk: comment.diffHunk }
      : {}),
    id: comment.id,
    updated_at: comment.updatedAt,
  }));
  const rawReviewContent = {
    comments,
    ...(source.path === null ? {} : { path: source.path }),
  };
  return {
    characters: countCodePoints(canonicalizeJson(rawReviewContent)),
    comments,
    path: source.path,
  };
}

function normalizeActor(actor: ReviewerIdentity): NormalizedDistillationActor {
  return {
    actor_id: actor.actor_id ?? null,
    actor_kind: actor.actor_kind,
    authorAssociation: actor.author_association ?? null,
    login: actor.login,
    provider: actor.provider,
    trust: actor.trust,
  };
}

function publicActor(
  actor: NormalizedDistillationActor,
): HostAssistedDistillationActor {
  return {
    actor_id: actor.actor_id,
    actor_kind: actor.actor_kind,
    author_association: actor.authorAssociation,
    login: actor.login,
    provider: actor.provider,
    trust: actor.trust,
  };
}

export function extractCandidates(
  snapshot: CanonicalProjectionSnapshot,
  jobId: string,
): readonly ExtractCandidate[] {
  return extractReceipt(snapshot, jobId).stable_response.candidates;
}

export function extractReceipt(
  snapshot: CanonicalProjectionSnapshot,
  jobId: string,
): Extract<SubmissionReceipt, { readonly phase: "extract" }> & {
  readonly stable_response: Extract<
    SubmissionReceipt["stable_response"],
    { readonly state: "merge_decision_required" }
  >;
} {
  const receipts = snapshot.domain.submissionReceipts
    .filter(
      (
        receipt,
      ): receipt is Extract<SubmissionReceipt, { readonly phase: "extract" }> =>
        receipt.job_id === jobId && receipt.phase === "extract",
    )
    .sort((first, second) => {
      const timeOrder = compareCodeUnits(
        first.committed_at,
        second.committed_at,
      );
      return timeOrder === 0
        ? compareCodeUnits(first.receipt_id, second.receipt_id)
        : timeOrder;
    });
  if (receipts.length === 0) {
    throw hostError(
      "EXTRACT_RECEIPT_UNAVAILABLE",
      "awaiting-finalize job has no canonical extract receipt",
    );
  }
  const first = receipts[0]!;
  if (first.stable_response.state !== "merge_decision_required") {
    throw hostError(
      "EXTRACT_RECEIPT_UNAVAILABLE",
      "awaiting-finalize job has a terminal extract receipt",
    );
  }
  const digest = sha256Jcs(first.stable_response);
  for (const receipt of receipts.slice(1)) {
    if (
      receipt.stable_response.state !== "merge_decision_required" ||
      sha256Jcs(receipt.stable_response) !== digest
    ) {
      throw hostError(
        "EXTRACT_RECEIPT_UNAVAILABLE",
        "canonical extract receipts disagree for the same job",
      );
    }
  }
  return first as Extract<SubmissionReceipt, { readonly phase: "extract" }> & {
    readonly stable_response: Extract<
      SubmissionReceipt["stable_response"],
      { readonly state: "merge_decision_required" }
    >;
  };
}

/** Computes the candidate-set binding independent of receipt array order. */
export function computeCandidateSetSha256(
  candidates: readonly ExtractCandidate[],
): string {
  const normalized = candidates
    .map((candidate) => ExtractCandidateSchema.parse(candidate))
    .sort((first, second) =>
      compareCodeUnits(first.candidate_id, second.candidate_id),
    );
  if (normalized.length === 0) {
    throw hostError(
      "EXTRACT_RECEIPT_UNAVAILABLE",
      "candidate-set binding requires at least one candidate",
    );
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if (
      normalized[index - 1]!.candidate_id === normalized[index]!.candidate_id
    ) {
      throw hostError(
        "EXTRACT_RECEIPT_UNAVAILABLE",
        `duplicate candidate ID ${normalized[index]!.candidate_id}`,
      );
    }
  }
  return sha256Jcs(normalized);
}

export function assertCandidateIdentityPreserved(
  receiptCandidates: readonly ExtractCandidate[],
  result: MergeCandidateSearchResult,
): void {
  const receiptIds = receiptCandidates
    .map((candidate) => candidate.candidate_id)
    .sort(compareCodeUnits);
  const resultIds = result.candidates
    .map((candidate) => candidate.candidate_id)
    .sort(compareCodeUnits);
  if (
    receiptIds.length !== resultIds.length ||
    receiptIds.some((candidateId, index) => candidateId !== resultIds[index])
  ) {
    throw hostError(
      "EXTRACT_RECEIPT_UNAVAILABLE",
      "canonical extract candidates collapse to a different candidate set",
    );
  }
}

export function findLeasedJob(
  snapshot: CanonicalProjectionSnapshot,
  lease: DistillJobLease,
): DistillJob {
  const job = snapshot.domain.distillJobs.find(
    (candidate) => candidate.job_id === lease.job_id,
  );
  if (
    job === undefined ||
    job.repo_id !== lease.job.repo_id ||
    job.lease_generation !== lease.lease_generation ||
    (job.state !== "processing" && job.state !== "awaiting_finalize")
  ) {
    throw hostError(
      "LEASE_EXPIRED_DURING_PREPARE",
      "the leased job changed before its payload was prepared",
    );
  }
  return job;
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
      .sort((first, second) => {
        const timeOrder = compareCodeUnits(
          second.observed_at,
          first.observed_at,
        );
        return timeOrder === 0
          ? compareCodeUnits(second.snapshot_id, first.snapshot_id)
          : timeOrder;
      })[0]?.snapshot_id ?? null
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

export function jobMetadata(
  job: DistillJob,
): HostAssistedDistillationJobMetadata {
  const availableAt =
    job.state === "processing" || job.state === "awaiting_finalize"
      ? job.lease_expires_at
      : job.state === "pending"
        ? (job.next_retry_at ?? undefined)
        : undefined;
  return {
    ...(availableAt === undefined ? {} : { available_at: availableAt }),
    job_id: job.job_id,
    lease_generation: job.lease_generation,
    state: job.state,
    thread_id: job.thread_id,
    updated_at: job.updated_at,
  };
}

export function isPrepareLeaseEligible(
  job: DistillJob,
  timestamp: number,
): boolean {
  if (job.state === "pending") {
    return (
      job.next_retry_at == null || Date.parse(job.next_retry_at) <= timestamp
    );
  }
  if (job.state === "processing" || job.state === "awaiting_finalize") {
    if (job.state === "awaiting_finalize") return true;
    return Date.parse(job.lease_expires_at!) <= timestamp;
  }
  return false;
}

export function comparePrepareCandidates(
  first: DistillJob,
  second: DistillJob,
): number {
  const timeOrder = compareCodeUnits(first.updated_at, second.updated_at);
  return timeOrder === 0
    ? compareCodeUnits(first.job_id, second.job_id)
    : timeOrder;
}

export function hostAssistedTransmissionAllowed(
  config: RepoKnowledgeConfig,
): boolean {
  return (
    config.hostAssistedDistillation.enabled &&
    config.hostAssistedDistillation.allowReviewContentTransmission
  );
}

export function validatePrepareLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_PREPARE_DISTILLATION_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PREPARE_DISTILLATION_LIMIT
  ) {
    throw hostError(
      "INVALID_PREPARE_LIMIT",
      `limit must be an integer from 1 through ${String(
        MAX_PREPARE_DISTILLATION_LIMIT,
      )}`,
    );
  }
  return value;
}

export function cloneCanonicalJson(value: unknown): unknown {
  return JSON.parse(canonicalizeJson(value)) as unknown;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function operationTimestamp(now: () => Date): number {
  const timestamp = now().getTime();
  if (!Number.isFinite(timestamp)) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "now() returned an invalid Date",
    );
  }
  return timestamp;
}

export function appendBlocked(
  blocked: HostAssistedBlockedJob[],
  value: HostAssistedBlockedJob,
): void {
  if (blocked.length < MAX_PREPARE_BLOCKED_JOB_METADATA) blocked.push(value);
}

type SafePerJobError =
  | HostAssistedDistillationError
  | SensitiveContentTransmissionError;

export function isSafePerJobError(error: unknown): error is SafePerJobError {
  if (error instanceof SensitiveContentTransmissionError) return true;
  return (
    error instanceof HostAssistedDistillationError &&
    (error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_UNAVAILABLE" ||
      error.code === "EXTRACT_RECEIPT_UNAVAILABLE" ||
      error.code === "LEASE_EXPIRED_DURING_PREPARE")
  );
}

export function blockedReason(
  error: SafePerJobError,
): HostAssistedBlockedJobReason {
  if (error instanceof SensitiveContentTransmissionError) {
    return "sensitive_content_detected";
  }
  switch (error.code) {
    case "DISTILLATION_CONTEXT_CHANGED":
      return "distillation_context_changed";
    case "DISTILLATION_SOURCE_UNAVAILABLE":
      return "source_unavailable";
    case "EXTRACT_RECEIPT_UNAVAILABLE":
      return "extract_receipt_unavailable";
    case "LEASE_EXPIRED_DURING_PREPARE":
      return "lease_expired_during_prepare";
    case "INVALID_PREPARE_LIMIT":
      throw error;
  }
}

export function blockedJobFromError(
  job: DistillJob,
  error: SafePerJobError,
): HostAssistedBlockedJob {
  return {
    job: jobMetadata(job),
    reason: blockedReason(error),
    ...(error instanceof SensitiveContentTransmissionError
      ? { sensitive_content_findings: error.findings }
      : {}),
  };
}

export function sensitiveContentBlockedJob(
  job: DistillJob,
  value: unknown,
): HostAssistedBlockedJob | null {
  const findings = findSensitiveContent(value);
  return findings.length === 0
    ? null
    : {
        job: jobMetadata(job),
        reason: "sensitive_content_detected",
        sensitive_content_findings: findings,
      };
}

export function hostError(
  code: HostAssistedDistillationErrorCode,
  message: string,
  cause?: unknown,
): HostAssistedDistillationError {
  return new HostAssistedDistillationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeComments,
  sha256Jcs,
} from "./canonical.js";
import { computeTrustPolicyDigest } from "./config.js";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import {
  ExtractCandidateSchema,
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type DistillJob,
  type ExtractCandidate,
  type RepoKnowledgeConfig,
  type ReviewerIdentity,
  type SubmissionReceipt,
} from "./domain-schemas.js";
import {
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
} from "./distillation-prompt.js";
import {
  DistillJobCoordinator,
  DistillJobCoordinatorError,
  assertCurrentDistillJobLease,
  type DistillJobCoordinatorOptions,
  type DistillJobLease,
} from "./distill-job-coordinator.js";
import {
  classifyCommentExclusion,
  computeDistillationInputDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  type NormalizedDistillationActor,
  type NormalizedDistillationComment,
} from "./github-snapshot-normalizer.js";
import { reviewSummaryThreadId } from "./github-pull-request-client.js";
import {
  MergeCandidateSearchService,
  type MergeCandidateSearchRequest,
  type MergeCandidateSearchResult,
} from "./merge-candidate-service.js";
import type {
  PossibleKnowledgeMatch,
  PossibleMatchSet,
} from "./possible-match.js";
import type { RepositoryResolution } from "./repository-resolver.js";
import {
  RuntimeFinalizeContextStore,
  RuntimeFinalizeContextStoreError,
  type RuntimeFinalizeHandle,
} from "./runtime-finalize-context-store.js";
import {
  SensitiveContentTransmissionError,
  assertNoSensitiveContent,
  findSensitiveContent,
  type SensitiveContentFinding,
} from "./sensitive-content.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

export const DEFAULT_PREPARE_DISTILLATION_LIMIT = 1;
export const MAX_PREPARE_DISTILLATION_LIMIT = 10;
export const MAX_PREPARE_BLOCKED_JOB_METADATA = 10;

const REQUIRED_HOST_ASSISTED_SETTINGS = Object.freeze({
  "hostAssistedDistillation.allowReviewContentTransmission": true,
  "hostAssistedDistillation.enabled": true,
});

type HostAssistedSetting = keyof typeof REQUIRED_HOST_ASSISTED_SETTINGS;

export interface PrepareDistillationRequest {
  readonly limit?: number;
}

export interface HostAssistedDistillationJobMetadata {
  readonly available_at?: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly state: DistillJob["state"];
  readonly thread_id: string;
  readonly updated_at: string;
}

export interface HostAssistedDistillationActor {
  readonly actor_id: string | null;
  readonly actor_kind: ReviewerIdentity["actor_kind"];
  readonly author_association: string | null;
  readonly login: string | null;
  readonly provider: ReviewerIdentity["provider"];
  readonly trust: ReviewerIdentity["trust"];
}

export interface HostAssistedDistillationComment {
  readonly actor: HostAssistedDistillationActor;
  readonly body: string;
  readonly created_at: string;
  readonly diff_hunk?: string;
  readonly id: string;
  readonly updated_at: string;
}

interface PreparedJobBase {
  readonly expires_at: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token: string;
  readonly thread_fingerprint: string;
}

export interface HostAssistedExtractJob extends PreparedJobBase {
  readonly comments: readonly HostAssistedDistillationComment[];
  readonly output_schema: Readonly<Record<string, unknown>>;
  readonly path?: string;
  readonly phase: "extract";
  /** Code points in the exact canonical comments/path object returned. */
  readonly review_content_characters: number;
}

export interface HostAssistedFinalizeJob extends PreparedJobBase {
  readonly candidate_set_sha256: string;
  readonly candidates: readonly ExtractCandidate[];
  readonly finalize_handle: RuntimeFinalizeHandle;
  readonly match_set_digest: string;
  readonly phase: "finalize";
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
}

export type HostAssistedPreparedJob =
  | HostAssistedExtractJob
  | HostAssistedFinalizeJob;

export type HostAssistedBlockedJobReason =
  | "distillation_context_changed"
  | "extract_receipt_unavailable"
  | "lease_expired_during_prepare"
  | "max_characters_exceeded"
  | "sensitive_content_detected"
  | "source_unavailable";

export interface HostAssistedBlockedJob {
  readonly job: HostAssistedDistillationJobMetadata;
  readonly max_characters_per_job?: number;
  readonly reason: HostAssistedBlockedJobReason;
  readonly review_content_characters?: number;
  readonly sensitive_content_findings?: readonly SensitiveContentFinding[];
}

export interface HostAssistedDistillationDisabledResult {
  readonly instructions: readonly string[];
  readonly jobs: readonly HostAssistedDistillationJobMetadata[];
  readonly missing_settings: readonly HostAssistedSetting[];
  readonly required_settings: Readonly<Record<HostAssistedSetting, true>>;
  readonly state: "disabled";
}

export interface HostAssistedDistillationPreparedResult {
  readonly blocked_jobs: readonly HostAssistedBlockedJob[];
  readonly jobs: readonly HostAssistedPreparedJob[];
  readonly state: "prepared";
}

export type PrepareDistillationResult =
  | HostAssistedDistillationDisabledResult
  | HostAssistedDistillationPreparedResult;

export interface HostAssistedDistillationServiceOptions {
  readonly config: RepoKnowledgeConfig;
  readonly coordinatorOptions?: DistillJobCoordinatorOptions;
  readonly finalizeContexts?: RuntimeFinalizeContextStore;
  /** Test/composition seam; production callers normally use the canonical service. */
  readonly mergeCandidateSearch?: HostAssistedMergeCandidateSearch;
  readonly promptDigest: string;
  readonly repository: RepositoryResolution;
  readonly repositoryContext: unknown;
}

export interface HostAssistedMergeCandidateSearch {
  search(
    request: MergeCandidateSearchRequest,
  ): Promise<MergeCandidateSearchResult>;
}

export type HostAssistedDistillationErrorCode =
  | "DISTILLATION_CONTEXT_CHANGED"
  | "DISTILLATION_SOURCE_UNAVAILABLE"
  | "EXTRACT_RECEIPT_UNAVAILABLE"
  | "INVALID_PREPARE_LIMIT"
  | "LEASE_EXPIRED_DURING_PREPARE";

export class HostAssistedDistillationError extends Error {
  constructor(
    readonly code: HostAssistedDistillationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "HostAssistedDistillationError";
  }
}

export interface CurrentHostAssistedDistillationSource {
  readonly contentFingerprint: string;
  readonly distillationKey: string;
  readonly normalizedActors: readonly NormalizedDistillationActor[];
  readonly normalizedComments: readonly NormalizedDistillationComment[];
  readonly path: string | null;
  readonly snapshotId: string;
}

export interface ResolveHostAssistedDistillationSourceInput {
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly repoId: string;
  readonly repositoryContext: unknown;
  readonly trustPolicyDigest: string;
}

interface PreparedReviewContent {
  readonly characters: number;
  readonly comments: readonly HostAssistedDistillationComment[];
  readonly path: string | null;
}

/**
 * Leases host-assisted work only after its canonical source and transmission
 * policy have been validated. No plaintext review content is reachable from a
 * disabled result.
 */
export class HostAssistedDistillationService {
  readonly finalizeContexts: RuntimeFinalizeContextStore;

  private readonly config: RepoKnowledgeConfig;
  private readonly coordinator: DistillJobCoordinator;
  private readonly mergeCandidates: HostAssistedMergeCandidateSearch;
  private readonly now: () => Date;
  private readonly promptDigest: string;
  private readonly repoId: string;
  private readonly repositoryContext: unknown;
  private readonly store: CanonicalTransactionStore;
  private readonly trustPolicyDigest: string;

  constructor(options: HostAssistedDistillationServiceOptions) {
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.repoId = RepositoryIdSchema.parse(options.repository.repoId);
    this.promptDigest = Sha256DigestSchema.parse(options.promptDigest);
    this.repositoryContext = cloneCanonicalJson(options.repositoryContext);
    this.trustPolicyDigest = computeTrustPolicyDigest(this.config.trust);
    this.store = new CanonicalTransactionStore(options.repository.absolutePath);
    this.now = options.coordinatorOptions?.now ?? (() => new Date());
    this.coordinator = new DistillJobCoordinator(this.store, {
      ...options.coordinatorOptions,
      now: this.now,
    });
    this.mergeCandidates =
      options.mergeCandidateSearch ??
      new MergeCandidateSearchService({
        repoId: this.repoId,
        repository: this.store,
      });
    this.finalizeContexts =
      options.finalizeContexts ??
      new RuntimeFinalizeContextStore({ now: this.now });
  }

  async prepare(
    request: PrepareDistillationRequest = {},
  ): Promise<PrepareDistillationResult> {
    const limit = validatePrepareLimit(request.limit);
    const snapshot = await this.store.readSnapshot();
    if (!hostAssistedTransmissionAllowed(this.config)) {
      return disabledResult(snapshot, this.repoId, this.config, limit);
    }

    const timestamp = operationTimestamp(this.now);
    const candidates = snapshot.domain.distillJobs
      .filter(
        (job) =>
          job.repo_id === this.repoId && isPrepareLeaseEligible(job, timestamp),
      )
      .sort(comparePrepareCandidates);
    const jobs: HostAssistedPreparedJob[] = [];
    const blockedJobs: HostAssistedBlockedJob[] = [];

    for (const candidate of candidates) {
      if (jobs.length >= limit) break;

      const preview = this.previewCandidate(snapshot, candidate);
      if (preview.blocked !== undefined) {
        appendBlocked(blockedJobs, preview.blocked);
        continue;
      }

      const lease = await this.coordinator.acquireLease({
        job_id: candidate.job_id,
        repo_id: this.repoId,
        ...(candidate.state === "awaiting_finalize"
          ? { resume_awaiting_finalize: true }
          : {}),
      });
      if (lease === null) continue;

      try {
        const prepared = await this.prepareLeasedJob(lease);
        if (prepared.blocked !== undefined) {
          appendBlocked(blockedJobs, prepared.blocked);
          continue;
        }
        assertNoSensitiveContent(prepared.job, "host_assisted_payload");
        jobs.push(prepared.job);
      } catch (error) {
        if (!isSafePerJobError(error)) throw error;
        const failed = await this.failOwnedLease(lease);
        appendBlocked(
          blockedJobs,
          blockedJobFromError(failed ?? lease.job, error),
        );
      }
    }

    return { blocked_jobs: blockedJobs, jobs, state: "prepared" };
  }

  private previewCandidate(
    snapshot: CanonicalProjectionSnapshot,
    job: DistillJob,
  ):
    | { readonly blocked: HostAssistedBlockedJob }
    | { readonly blocked?: undefined } {
    let source: CurrentHostAssistedDistillationSource;
    try {
      source = this.currentSource(snapshot, job);
      if (job.state === "awaiting_finalize") {
        const blocked = sensitiveContentBlockedJob(job, {
          candidates: extractCandidates(snapshot, job.job_id),
        });
        if (blocked !== null) return { blocked };
      }
    } catch (error) {
      if (!isSafePerJobError(error)) throw error;
      return {
        blocked: {
          job: jobMetadata(job),
          reason: blockedReason(error),
        },
      };
    }

    if (job.state !== "awaiting_finalize") {
      const content = prepareReviewContent(
        source,
        this.config.hostAssistedDistillation.includeDiffHunk,
      );
      const blocked = sensitiveContentBlockedJob(job, {
        comments: content.comments,
        ...(content.path === null ? {} : { path: content.path }),
      });
      if (blocked !== null) return { blocked };
      const maximum = this.config.hostAssistedDistillation.maxCharactersPerJob;
      if (content.characters > maximum) {
        return {
          blocked: {
            job: jobMetadata(job),
            max_characters_per_job: maximum,
            reason: "max_characters_exceeded",
            review_content_characters: content.characters,
          },
        };
      }
    }
    return {};
  }

  private async prepareLeasedJob(
    lease: DistillJobLease,
  ): Promise<
    | { readonly blocked: HostAssistedBlockedJob }
    | { readonly blocked?: undefined; readonly job: HostAssistedPreparedJob }
  > {
    const snapshot = await this.store.readSnapshot();
    const job = findLeasedJob(snapshot, lease);
    const source = this.currentSource(snapshot, job);
    if (job.state === "awaiting_finalize") {
      return { job: await this.prepareFinalizeJob(lease, source, snapshot) };
    }

    const content = prepareReviewContent(
      source,
      this.config.hostAssistedDistillation.includeDiffHunk,
    );
    const maximum = this.config.hostAssistedDistillation.maxCharactersPerJob;
    if (content.characters > maximum) {
      const failed = await this.failOwnedLease(lease);
      return {
        blocked: {
          job: jobMetadata(failed ?? job),
          max_characters_per_job: maximum,
          reason: "max_characters_exceeded",
          review_content_characters: content.characters,
        },
      };
    }

    return {
      job: {
        comments: content.comments,
        expires_at: lease.expires_at,
        job_id: lease.job_id,
        lease_generation: lease.lease_generation,
        lease_token: lease.lease_token,
        output_schema: DISTILLATION_OUTPUT_JSON_SCHEMA,
        ...(content.path === null ? {} : { path: content.path }),
        phase: "extract",
        review_content_characters: content.characters,
        thread_fingerprint: source.contentFingerprint,
      },
    };
  }

  private async prepareFinalizeJob(
    lease: DistillJobLease,
    source: CurrentHostAssistedDistillationSource,
    snapshot: CanonicalProjectionSnapshot,
  ): Promise<HostAssistedFinalizeJob> {
    const receipt = extractReceipt(snapshot, lease.job_id);
    const candidates = receipt.stable_response.candidates;
    const matches = await this.mergeCandidates.search({
      candidates,
      threadId: lease.job.thread_id,
    });
    assertCandidateIdentityPreserved(candidates, matches);
    assertNoSensitiveContent(
      {
        candidates,
        possible_matches: matches.possible_matches,
      },
      "host_assisted_payload",
    );

    const current = await this.store.readSnapshot();
    const currentJob = findLeasedJob(current, lease);
    // The search is intentionally lock-free. Rebuild the source from the
    // post-search snapshot so a concurrent ingest cannot produce a handle that
    // mixes old review provenance with newer merge-search state.
    const currentSource = this.currentSource(current, currentJob);
    if (currentSource.contentFingerprint !== source.contentFingerprint) {
      throw hostError(
        "DISTILLATION_CONTEXT_CHANGED",
        "the review source changed while merge candidates were prepared",
      );
    }
    try {
      assertCurrentDistillJobLease(
        currentJob,
        lease,
        operationTimestamp(this.now),
      );
    } catch (error) {
      if (
        error instanceof DistillJobCoordinatorError &&
        error.code === "STALE_LEASE"
      ) {
        throw hostError(
          "LEASE_EXPIRED_DURING_PREPARE",
          "the lease expired while preparing merge candidates",
          error,
        );
      }
      throw error;
    }

    const candidateSetSha256 = computeCandidateSetSha256(candidates);
    let issued: ReturnType<RuntimeFinalizeContextStore["issue"]>;
    try {
      issued = this.finalizeContexts.issue({
        candidate_set_sha256: candidateSetSha256,
        content_fingerprint: currentSource.contentFingerprint,
        distillation_key: currentJob.distillation_key,
        expires_at: lease.expires_at,
        job_id: lease.job_id,
        lease_generation: lease.lease_generation,
        match_set_digest: matches.match_set_digest,
        possible_matches: matches.possible_matches,
        request_sha256: receipt.request_sha256,
        source_snapshot_id: currentSource.snapshotId,
      });
    } catch (error) {
      if (
        error instanceof RuntimeFinalizeContextStoreError &&
        error.code === "FINALIZE_CONTEXT_EXPIRED"
      ) {
        throw hostError(
          "LEASE_EXPIRED_DURING_PREPARE",
          "the lease expired before a finalize token could be issued",
          error,
        );
      }
      throw error;
    }

    return {
      candidate_set_sha256: candidateSetSha256,
      candidates,
      expires_at: lease.expires_at,
      finalize_handle: issued.handle,
      job_id: lease.job_id,
      lease_generation: lease.lease_generation,
      lease_token: lease.lease_token,
      match_set_digest: matches.match_set_digest,
      phase: "finalize",
      possible_matches: matches.possible_matches,
      thread_fingerprint: currentSource.contentFingerprint,
    };
  }

  private currentSource(
    snapshot: CanonicalProjectionSnapshot,
    job: DistillJob,
  ): CurrentHostAssistedDistillationSource {
    return resolveHostAssistedDistillationSource(snapshot, job, {
      outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      promptDigest: this.promptDigest,
      repoId: this.repoId,
      repositoryContext: this.repositoryContext,
      trustPolicyDigest: this.trustPolicyDigest,
    });
  }

  private async failOwnedLease(
    lease: DistillJobLease,
  ): Promise<DistillJob | null> {
    try {
      return await this.coordinator.fail({
        failure_kind: "system",
        job_id: lease.job_id,
        last_error: "host-assisted prepare source or context became invalid",
        lease_generation: lease.lease_generation,
        lease_token: lease.lease_token,
      });
    } catch (error) {
      if (
        error instanceof DistillJobCoordinatorError &&
        (error.code === "STALE_LEASE" || error.code === "INVALID_LEASE_TOKEN")
      ) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * Reconstructs the current canonical source and distillation key without I/O.
 * It is shared by prepare and the submit-finalize locked mutation so both
 * enforce identical source, prompt, schema, and trust-policy bindings.
 */
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

function disabledResult(
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

function prepareReviewContent(
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

function extractCandidates(
  snapshot: CanonicalProjectionSnapshot,
  jobId: string,
): readonly ExtractCandidate[] {
  return extractReceipt(snapshot, jobId).stable_response.candidates;
}

function extractReceipt(
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

function assertCandidateIdentityPreserved(
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

function findLeasedJob(
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

function jobMetadata(job: DistillJob): HostAssistedDistillationJobMetadata {
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

function isPrepareLeaseEligible(job: DistillJob, timestamp: number): boolean {
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

function comparePrepareCandidates(
  first: DistillJob,
  second: DistillJob,
): number {
  const timeOrder = compareCodeUnits(first.updated_at, second.updated_at);
  return timeOrder === 0
    ? compareCodeUnits(first.job_id, second.job_id)
    : timeOrder;
}

function hostAssistedTransmissionAllowed(config: RepoKnowledgeConfig): boolean {
  return (
    config.hostAssistedDistillation.enabled &&
    config.hostAssistedDistillation.allowReviewContentTransmission
  );
}

function validatePrepareLimit(limit: number | undefined): number {
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

function cloneCanonicalJson(value: unknown): unknown {
  return JSON.parse(canonicalizeJson(value)) as unknown;
}

function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function operationTimestamp(now: () => Date): number {
  const timestamp = now().getTime();
  if (!Number.isFinite(timestamp)) {
    throw hostError(
      "DISTILLATION_SOURCE_UNAVAILABLE",
      "now() returned an invalid Date",
    );
  }
  return timestamp;
}

function appendBlocked(
  blocked: HostAssistedBlockedJob[],
  value: HostAssistedBlockedJob,
): void {
  if (blocked.length < MAX_PREPARE_BLOCKED_JOB_METADATA) blocked.push(value);
}

type SafePerJobError =
  | HostAssistedDistillationError
  | SensitiveContentTransmissionError;

function isSafePerJobError(error: unknown): error is SafePerJobError {
  if (error instanceof SensitiveContentTransmissionError) return true;
  return (
    error instanceof HostAssistedDistillationError &&
    (error.code === "DISTILLATION_CONTEXT_CHANGED" ||
      error.code === "DISTILLATION_SOURCE_UNAVAILABLE" ||
      error.code === "EXTRACT_RECEIPT_UNAVAILABLE" ||
      error.code === "LEASE_EXPIRED_DURING_PREPARE")
  );
}

function blockedReason(error: SafePerJobError): HostAssistedBlockedJobReason {
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

function blockedJobFromError(
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

function sensitiveContentBlockedJob(
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

function hostError(
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

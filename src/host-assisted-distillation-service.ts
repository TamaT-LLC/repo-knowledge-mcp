import { computeTrustPolicyDigest } from "./config.js";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import {
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type DistillJob,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import {
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
} from "./distillation-prompt.js";
import {
  DistillJobCoordinator,
  DistillJobCoordinatorError,
  assertCurrentDistillJobLease,
  type DistillJobLease,
} from "./distill-job-coordinator.js";
import { MergeCandidateSearchService } from "./merge-candidate-service.js";
import {
  RuntimeFinalizeContextStore,
  RuntimeFinalizeContextStoreError,
} from "./runtime-finalize-context-store.js";
import { assertNoSensitiveContent } from "./sensitive-content.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

import {
  type PrepareDistillationRequest,
  type HostAssistedFinalizeJob,
  type HostAssistedPreparedJob,
  type HostAssistedBlockedJob,
  type PrepareDistillationResult,
  type HostAssistedDistillationServiceOptions,
  type HostAssistedMergeCandidateSearch,
  type CurrentHostAssistedDistillationSource,
} from "./host-assisted-distillation-types.js";
import {
  resolveHostAssistedDistillationSource,
  disabledResult,
  prepareReviewContent,
  extractCandidates,
  extractReceipt,
  computeCandidateSetSha256,
  assertCandidateIdentityPreserved,
  findLeasedJob,
  jobMetadata,
  isPrepareLeaseEligible,
  comparePrepareCandidates,
  hostAssistedTransmissionAllowed,
  validatePrepareLimit,
  cloneCanonicalJson,
  operationTimestamp,
  appendBlocked,
  isSafePerJobError,
  blockedReason,
  blockedJobFromError,
  sensitiveContentBlockedJob,
  hostError,
} from "./host-assisted-distillation-preparation.js";

export {
  DEFAULT_PREPARE_DISTILLATION_LIMIT,
  MAX_PREPARE_DISTILLATION_LIMIT,
  MAX_PREPARE_BLOCKED_JOB_METADATA,
  type PrepareDistillationRequest,
  type HostAssistedDistillationJobMetadata,
  type HostAssistedDistillationActor,
  type HostAssistedDistillationComment,
  type HostAssistedExtractJob,
  type HostAssistedFinalizeJob,
  type HostAssistedPreparedJob,
  type HostAssistedBlockedJobReason,
  type HostAssistedBlockedJob,
  type HostAssistedDistillationDisabledResult,
  type HostAssistedDistillationPreparedResult,
  type PrepareDistillationResult,
  type HostAssistedDistillationServiceOptions,
  type HostAssistedMergeCandidateSearch,
  type HostAssistedDistillationErrorCode,
  HostAssistedDistillationError,
  type CurrentHostAssistedDistillationSource,
  type ResolveHostAssistedDistillationSourceInput,
} from "./host-assisted-distillation-types.js";
export {
  resolveHostAssistedDistillationSource,
  computeCandidateSetSha256,
} from "./host-assisted-distillation-preparation.js";

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

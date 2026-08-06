import {
  normalizeComments,
  sha256Jcs,
  sha256NormalizedJcs,
} from "./canonical.js";
import {
  computeMatchSetDigest,
  normalizePossibleMatchBindings,
  type PossibleMatchBinding,
} from "./possible-match.js";

export {
  computeMatchSetDigest,
  normalizePossibleMatchBindings,
} from "./possible-match.js";

export interface FingerprintComment {
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly resolved?: boolean;
}

export interface DistillationKeyInput {
  readonly prompt: unknown;
  readonly schema: unknown;
  readonly trustPolicy: unknown;
}

export interface FinalizeContext {
  readonly candidate_set_sha256: string;
  readonly content_fingerprint: string;
  readonly distillation_key: string;
  readonly expires_at: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchBinding[];
  /** Provenance only; a changed snapshot ID is not itself a mismatch. */
  readonly source_snapshot_id: string;
  readonly token_hash: string;
}

export interface FinalizeJob {
  readonly candidate_set_sha256: string;
  readonly id: string;
  readonly lease_generation: number;
  readonly status: "awaiting_finalize" | "finalized";
}

export interface CurrentFinalizeSource {
  readonly content_fingerprint: string;
  readonly source_snapshot_id: string;
}

export type FinalizeGuardErrorCode =
  | "DISTILLATION_CONTEXT_CHANGED"
  | "DISTILLATION_SOURCE_CHANGED"
  | "FINALIZE_JOB_INVALID"
  | "MERGE_CANDIDATES_CHANGED";

export class FinalizeGuardError extends Error {
  constructor(
    readonly code: FinalizeGuardErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FinalizeGuardError";
  }
}

type MaybePromise<T> = Promise<T> | T;

export interface FinalizeGuardDependencies<TResult> {
  readonly canonicalWrite: (
    context: FinalizeContext,
    currentMatches: readonly PossibleMatchBinding[],
  ) => MaybePromise<TResult>;
  readonly computeCurrentDistillationKey: (
    context: FinalizeContext,
  ) => MaybePromise<string>;
  readonly ensureProjectionCurrent: () => MaybePromise<void>;
  readonly ensureRecovered: () => MaybePromise<void>;
  readonly loadCurrentSource: (
    jobId: string,
  ) => MaybePromise<CurrentFinalizeSource>;
  readonly loadJob: (jobId: string) => MaybePromise<FinalizeJob | undefined>;
  readonly searchPossibleMatches: (
    context: FinalizeContext,
  ) => MaybePromise<readonly PossibleMatchBinding[]>;
  readonly withRepoLock: <T>(operation: () => MaybePromise<T>) => Promise<T>;
}

/**
 * Enforces the canonical-write guard sequence while holding the repository
 * lock. No write callback is reachable until every generation check passes.
 */
export class FinalizeGuard<TResult> {
  constructor(readonly dependencies: FinalizeGuardDependencies<TResult>) {}

  finalize(context: FinalizeContext): Promise<TResult> {
    return this.dependencies.withRepoLock(async () => {
      await this.dependencies.ensureRecovered();
      await this.dependencies.ensureProjectionCurrent();

      const job = await this.dependencies.loadJob(context.job_id);
      assertFinalizeJob(job, context);

      const currentSource = await this.dependencies.loadCurrentSource(
        context.job_id,
      );
      if (currentSource.content_fingerprint !== context.content_fingerprint) {
        throw guardError(
          "DISTILLATION_SOURCE_CHANGED",
          "The source content fingerprint has changed",
        );
      }

      const currentDistillationKey =
        await this.dependencies.computeCurrentDistillationKey(context);
      if (currentDistillationKey !== context.distillation_key) {
        throw guardError(
          "DISTILLATION_CONTEXT_CHANGED",
          "The prompt, schema, or trust policy has changed",
        );
      }

      const currentMatches = normalizePossibleMatchBindings(
        await this.dependencies.searchPossibleMatches(context),
      );
      if (computeMatchSetDigest(currentMatches) !== context.match_set_digest) {
        throw guardError(
          "MERGE_CANDIDATES_CHANGED",
          "The possible match set has changed",
        );
      }

      return this.dependencies.canonicalWrite(context, currentMatches);
    });
  }
}

/**
 * Fingerprints content-bearing comment fields only. In particular, resolved is
 * intentionally excluded so workflow-only changes do not invalidate content.
 */
export function computeContentFingerprint(
  comments: readonly FingerprintComment[],
): string {
  const content = normalizeComments(comments).map(
    ({ body, createdAt, id }) => ({
      body,
      created_at: createdAt,
      id,
    }),
  );
  return sha256Jcs(content);
}

/** Binds a distillation to its prompt, schema, and normalized trust policy. */
export function computeDistillationKey(input: DistillationKeyInput): string {
  return sha256NormalizedJcs({
    prompt: input.prompt,
    schema: input.schema,
    trust_policy: input.trustPolicy,
  });
}

function assertFinalizeJob(
  job: FinalizeJob | undefined,
  context: FinalizeContext,
): asserts job is FinalizeJob {
  if (
    job === undefined ||
    job.id !== context.job_id ||
    job.status !== "awaiting_finalize" ||
    job.lease_generation !== context.lease_generation ||
    job.candidate_set_sha256 !== context.candidate_set_sha256
  ) {
    throw guardError(
      "FINALIZE_JOB_INVALID",
      "The job is not awaiting finalize for this lease and candidate set",
    );
  }
}

function guardError(
  code: FinalizeGuardErrorCode,
  message: string,
): FinalizeGuardError {
  return new FinalizeGuardError(code, message);
}

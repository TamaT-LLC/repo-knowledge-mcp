import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { compareCodeUnits } from "./canonical.js";
import {
  CanonicalTransactionStore,
  type CanonicalTransactionRequest,
} from "./canonical-transaction-store.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  JobIdSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  type DistillJob,
  type SkipReason,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_AWAITING_FINALIZE,
  DISTILLATION_JOB_CREATED,
  DISTILLATION_JOB_FAILED,
  DISTILLATION_JOB_LEASED,
  DISTILLATION_JOB_LEASE_EXPIRED,
  DISTILLATION_JOB_LEASE_RENEWED,
  DISTILLATION_JOB_SKIPPED,
  DISTILLATION_JOB_SUCCEEDED,
  applyDistillationJobRecord,
  createDistillationJobEventRecord,
  jobUniqueKey,
  type DistillationFailureKind,
  type DistillationJobEvent,
  type DistillationJobEventType,
} from "./distill-job-state.js";
import { createDomainId } from "./ids.js";

export const DISTILL_JOB_EVENT_PATH = "events/distillation.jsonl";
export const DEFAULT_DISTILL_JOB_LEASE_DURATION_MS = 5 * 60 * 1_000;
export const DEFAULT_JSON_VALIDATION_RETRY_DELAY_MS = 1_000;

export interface DistillJobCoordinatorOptions {
  readonly eventPath?: string;
  readonly jsonValidationRetryDelayMs?: number;
  readonly leaseDurationMs?: number;
  /** Test seam. Production callers should use the cryptographic default. */
  readonly nextLeaseToken?: () => string;
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextJobId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
}

export interface CreateDistillJobRequest {
  readonly distillation_key: string;
  readonly repo_id: string;
  readonly thread_id: string;
}

export interface CreateDistillJobResult {
  readonly created: boolean;
  readonly job: DistillJob;
}

export interface AcquireDistillJobLeaseRequest {
  readonly job_id?: string;
  readonly lease_duration_ms?: number;
  readonly repo_id: string;
}

export interface DistillJobLeaseCredentials {
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token: string;
}

export interface DistillJobLease extends DistillJobLeaseCredentials {
  readonly expires_at: string;
  readonly job: DistillJob;
}

export interface RenewDistillJobLeaseRequest extends DistillJobLeaseCredentials {
  readonly lease_duration_ms?: number;
}

export interface SkipDistillJobRequest extends DistillJobLeaseCredentials {
  readonly skip_reason: SkipReason;
}

export interface FailDistillJobRequest extends DistillJobLeaseCredentials {
  readonly failure_kind: DistillationFailureKind;
  readonly last_error: string;
  readonly next_retry_at?: string | null;
}

export type DistillJobCoordinatorErrorCode =
  | "DISTILL_JOB_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "INVALID_LEASE_TOKEN"
  | "STALE_LEASE";

export class DistillJobCoordinatorError extends Error {
  constructor(
    readonly code: DistillJobCoordinatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "DistillJobCoordinatorError";
  }
}

interface BuiltJobTransaction {
  readonly records: readonly CanonicalJsonlRecord[];
  readonly transaction: CanonicalTransactionRequest;
}

/**
 * Serializes short job mutations through the canonical repo lock. Provider and
 * LLM work starts only after acquireLease returns its ephemeral plaintext token.
 */
export class DistillJobCoordinator {
  private readonly eventPath: string;
  private readonly jsonValidationRetryDelayMs: number;
  private readonly leaseDurationMs: number;
  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextJobId: (timestamp: number) => string;
  private readonly nextLeaseToken: () => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;

  constructor(
    private readonly store: CanonicalTransactionStore,
    options: DistillJobCoordinatorOptions = {},
  ) {
    this.eventPath = distillJobEventPath(
      options.eventPath ?? DISTILL_JOB_EVENT_PATH,
    );
    this.leaseDurationMs = positiveDuration(
      options.leaseDurationMs ?? DEFAULT_DISTILL_JOB_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.jsonValidationRetryDelayMs = positiveDuration(
      options.jsonValidationRetryDelayMs ??
        DEFAULT_JSON_VALIDATION_RETRY_DELAY_MS,
      "jsonValidationRetryDelayMs",
    );
    this.now = options.now ?? (() => new Date());
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextJobId =
      options.nextJobId ?? ((timestamp) => createDomainId("job", timestamp));
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
    this.nextLeaseToken =
      options.nextLeaseToken ?? (() => randomBytes(32).toString("base64url"));
  }

  async createJob(
    request: CreateDistillJobRequest,
  ): Promise<CreateDistillJobResult> {
    const repoId = RepositoryIdSchema.parse(request.repo_id);
    const threadId = NonEmptyStringSchema.parse(request.thread_id);
    const uniqueKey = jobUniqueKey({
      distillation_key: Sha256DigestSchema.parse(request.distillation_key),
      repo_id: repoId,
      thread_id: threadId,
    });

    return this.store.runLockedMutation<CreateDistillJobResult>((snapshot) => {
      const existing = snapshot.domain.distillJobs.find(
        (job) => jobUniqueKey(job) === uniqueKey,
      );
      if (existing !== undefined) {
        return {
          transaction: null,
          value: { created: false, job: existing },
        };
      }

      const operation = this.operationTime();
      const event: DistillationJobEvent = {
        payload: {
          distillation_key: request.distillation_key,
          job_id: JobIdSchema.parse(this.nextJobId(operation.timestamp)),
          repo_id: repoId,
          thread_id: threadId,
        },
        type: DISTILLATION_JOB_CREATED,
      };
      const built = this.buildTransaction(operation, [event]);
      return {
        transaction: built.transaction,
        value: {
          created: true,
          job: foldJobEvents(undefined, built.records),
        },
      };
    });
  }

  async acquireLease(
    request: AcquireDistillJobLeaseRequest,
  ): Promise<DistillJobLease | null> {
    const repoId = RepositoryIdSchema.parse(request.repo_id);
    const requestedJobId =
      request.job_id === undefined
        ? undefined
        : JobIdSchema.parse(request.job_id);
    const duration =
      request.lease_duration_ms === undefined
        ? this.leaseDurationMs
        : positiveDuration(request.lease_duration_ms, "lease_duration_ms");

    return this.store.runLockedMutation((snapshot) => {
      const operation = this.operationTime();
      if (
        requestedJobId !== undefined &&
        !snapshot.domain.distillJobs.some(
          (job) => job.job_id === requestedJobId && job.repo_id === repoId,
        )
      ) {
        throw coordinatorError(
          "DISTILL_JOB_NOT_FOUND",
          `job ${requestedJobId} was not found`,
        );
      }

      const job = snapshot.domain.distillJobs
        .filter(
          (candidate) =>
            candidate.repo_id === repoId &&
            (requestedJobId === undefined ||
              candidate.job_id === requestedJobId) &&
            isLeaseEligible(candidate, operation.timestamp),
        )
        .sort(compareLeaseCandidates)[0];
      if (job === undefined) {
        return { transaction: null, value: null };
      }
      const mutationOperation = this.operationTime(job);

      const leaseToken = this.nextLeaseToken();
      const leaseTokenHash = hashLeaseToken(leaseToken);
      const events: DistillationJobEvent[] = [];
      if (job.state === "processing" || job.state === "awaiting_finalize") {
        events.push({
          payload: {
            job_id: job.job_id,
            lease_generation: job.lease_generation,
          },
          type: DISTILLATION_JOB_LEASE_EXPIRED,
        });
      }
      const expiresAt = futureIso(
        mutationOperation.timestamp,
        duration,
        "lease_duration_ms",
      );
      events.push({
        payload: {
          job_id: job.job_id,
          lease_expires_at: expiresAt,
          lease_generation: job.lease_generation + 1,
          lease_token_hash: leaseTokenHash,
        },
        type: DISTILLATION_JOB_LEASED,
      });
      const built = this.buildTransaction(mutationOperation, events);
      const next = foldJobEvents(job, built.records);
      return {
        transaction: built.transaction,
        value: leaseResult(next, leaseToken),
      };
    });
  }

  async renewLease(
    request: RenewDistillJobLeaseRequest,
  ): Promise<DistillJobLease> {
    const duration =
      request.lease_duration_ms === undefined
        ? this.leaseDurationMs
        : positiveDuration(request.lease_duration_ms, "lease_duration_ms");
    return this.mutateActiveLease(request, (job, operation) => {
      const currentExpiry = Date.parse(job.lease_expires_at!);
      const requestedExpiry = futureTimestamp(
        operation.timestamp,
        duration,
        "lease_duration_ms",
      );
      const expiresAt = timestampIso(
        Math.max(requestedExpiry, currentExpiry + 1),
        "lease_duration_ms",
      );
      return {
        event: {
          payload: {
            job_id: job.job_id,
            lease_expires_at: expiresAt,
            lease_generation: job.lease_generation,
          },
          type: DISTILLATION_JOB_LEASE_RENEWED,
        },
        value: (next) => leaseResult(next, request.lease_token),
      };
    });
  }

  async markAwaitingFinalize(
    request: DistillJobLeaseCredentials,
  ): Promise<DistillJob> {
    return this.mutateActiveLease(request, (job) => ({
      event: {
        payload: {
          job_id: job.job_id,
          lease_generation: job.lease_generation,
        },
        type: DISTILLATION_JOB_AWAITING_FINALIZE,
      },
      value: (next) => next,
    }));
  }

  async succeed(request: DistillJobLeaseCredentials): Promise<DistillJob> {
    return this.mutateActiveLease(request, (job) => ({
      event: {
        payload: {
          job_id: job.job_id,
          lease_generation: job.lease_generation,
        },
        type: DISTILLATION_JOB_SUCCEEDED,
      },
      value: (next) => next,
    }));
  }

  async skip(request: SkipDistillJobRequest): Promise<DistillJob> {
    return this.mutateActiveLease(request, (job) => ({
      event: {
        payload: {
          job_id: job.job_id,
          lease_generation: job.lease_generation,
          skip_reason: request.skip_reason,
        },
        type: DISTILLATION_JOB_SKIPPED,
      },
      value: (next) => next,
    }));
  }

  async fail(request: FailDistillJobRequest): Promise<DistillJob> {
    return this.mutateActiveLease(request, (job, operation) => {
      const nextRetryAt = failureRetryAt(
        job,
        request,
        operation.timestamp,
        this.jsonValidationRetryDelayMs,
      );
      return {
        event: {
          payload: {
            failure_kind: request.failure_kind,
            job_id: job.job_id,
            last_error: request.last_error,
            lease_generation: job.lease_generation,
            next_retry_at: nextRetryAt,
          },
          type: DISTILLATION_JOB_FAILED,
        },
        value: (next) => next,
      };
    });
  }

  private async mutateActiveLease<T>(
    request: DistillJobLeaseCredentials,
    plan: (
      job: DistillJob,
      operation: OperationTime,
    ) => {
      readonly event: DistillationJobEvent;
      readonly value: (next: DistillJob) => T;
    },
  ): Promise<T> {
    const jobId = JobIdSchema.parse(request.job_id);
    return this.store.runLockedMutation((snapshot) => {
      const job = snapshot.domain.distillJobs.find(
        (candidate) => candidate.job_id === jobId,
      );
      if (job === undefined) {
        throw coordinatorError(
          "DISTILL_JOB_NOT_FOUND",
          `job ${jobId} was not found`,
        );
      }
      const operation = this.operationTime(job);
      assertCurrentLease(job, request, operation.timestamp);
      const mutation = plan(job, operation);
      const built = this.buildTransaction(operation, [mutation.event]);
      const next = foldJobEvents(job, built.records);
      return {
        transaction: built.transaction,
        value: mutation.value(next),
      };
    });
  }

  private operationTime(current?: DistillJob): OperationTime {
    const now = this.now();
    const clockTimestamp = now.getTime();
    if (!Number.isFinite(clockTimestamp)) {
      throw coordinatorError(
        "INVALID_ARGUMENT",
        "now() returned an invalid Date",
      );
    }
    const timestamp = Math.max(
      clockTimestamp,
      current === undefined ? 0 : Date.parse(current.updated_at),
    );
    return { recordedAt: new Date(timestamp).toISOString(), timestamp };
  }

  private buildTransaction(
    operation: OperationTime,
    events: readonly DistillationJobEvent[],
  ): BuiltJobTransaction {
    const transactionId = this.nextTransactionId(operation.timestamp);
    const records = events.map((event) =>
      createDistillationJobEventRecord<DistillationJobEventType>({
        eventId: this.nextEventId(operation.timestamp),
        payload: event.payload,
        recordedAt: operation.recordedAt,
        transactionId,
        type: event.type,
      }),
    );
    return {
      records,
      transaction: {
        appendRecords: records.map((record) => ({
          record,
          targetPath: this.eventPath,
        })),
        createdAt: operation.recordedAt,
        fileWrites: [],
        transactionId,
      },
    };
  }
}

interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

function foldJobEvents(
  current: DistillJob | undefined,
  records: readonly CanonicalJsonlRecord[],
): DistillJob {
  let next = current;
  for (const record of records) {
    next = applyDistillationJobRecord(next, record);
  }
  if (next === undefined) {
    throw new TypeError("job transaction did not produce a job");
  }
  return next;
}

function isLeaseEligible(job: DistillJob, timestamp: number): boolean {
  if (job.state === "pending") {
    return (
      job.next_retry_at == null || Date.parse(job.next_retry_at) <= timestamp
    );
  }
  if (job.state === "processing" || job.state === "awaiting_finalize") {
    return Date.parse(job.lease_expires_at!) <= timestamp;
  }
  return false;
}

function compareLeaseCandidates(first: DistillJob, second: DistillJob): number {
  const timeOrder = compareCodeUnits(first.updated_at, second.updated_at);
  return timeOrder === 0
    ? compareCodeUnits(first.job_id, second.job_id)
    : timeOrder;
}

function assertCurrentLease(
  job: DistillJob,
  request: DistillJobLeaseCredentials,
  timestamp: number,
): void {
  if (
    (job.state !== "processing" && job.state !== "awaiting_finalize") ||
    request.lease_generation !== job.lease_generation ||
    Date.parse(job.lease_expires_at!) <= timestamp
  ) {
    throw staleLease(job.job_id);
  }
  const expectedHash = job.lease_token_hash!;
  const actualHash = hashLeaseToken(request.lease_token);
  const expected = Buffer.from(expectedHash.slice("sha256:".length), "hex");
  const actual = Buffer.from(actualHash.slice("sha256:".length), "hex");
  if (!timingSafeEqual(expected, actual)) {
    throw coordinatorError(
      "INVALID_LEASE_TOKEN",
      `lease token does not match job ${job.job_id}`,
    );
  }
}

function failureRetryAt(
  job: DistillJob,
  request: FailDistillJobRequest,
  timestamp: number,
  jsonRetryDelayMs: number,
): string | null {
  if (request.failure_kind === "json_validation") {
    if (job.validation_failures > 0) return null;
    return (
      request.next_retry_at ??
      futureIso(timestamp, jsonRetryDelayMs, "jsonValidationRetryDelayMs")
    );
  }
  return request.next_retry_at ?? null;
}

function leaseResult(job: DistillJob, leaseToken: string): DistillJobLease {
  return {
    expires_at: job.lease_expires_at!,
    job,
    job_id: job.job_id,
    lease_generation: job.lease_generation,
    lease_token: leaseToken,
  };
}

/** Hashes an ephemeral lease token for canonical persistence. */
export function hashLeaseToken(leaseToken: string): string {
  if (typeof leaseToken !== "string" || leaseToken.length === 0) {
    throw coordinatorError("INVALID_ARGUMENT", "lease token must not be empty");
  }
  return Sha256DigestSchema.parse(
    `sha256:${createHash("sha256").update(leaseToken, "utf8").digest("hex")}`,
  );
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw coordinatorError(
      "INVALID_ARGUMENT",
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function distillJobEventPath(value: string): string {
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
    throw coordinatorError(
      "INVALID_ARGUMENT",
      "eventPath must be a safe events/**/*.jsonl path included in canonical projection",
    );
  }
  return value;
}

function futureIso(timestamp: number, duration: number, field: string): string {
  return timestampIso(futureTimestamp(timestamp, duration, field), field);
}

function futureTimestamp(
  timestamp: number,
  duration: number,
  field: string,
): number {
  const expiresAt = timestamp + duration;
  if (!Number.isSafeInteger(expiresAt)) {
    throw coordinatorError(
      "INVALID_ARGUMENT",
      `${field} produces an invalid timestamp`,
    );
  }
  return expiresAt;
}

function timestampIso(timestamp: number, field: string): string {
  try {
    return new Date(timestamp).toISOString();
  } catch (error) {
    throw new DistillJobCoordinatorError(
      "INVALID_ARGUMENT",
      `${field} produces an invalid timestamp`,
      { cause: error },
    );
  }
}

function staleLease(jobId: string): DistillJobCoordinatorError {
  return coordinatorError(
    "STALE_LEASE",
    `job ${jobId} no longer owns this lease generation; call prepare_distillation again`,
  );
}

function coordinatorError(
  code: DistillJobCoordinatorErrorCode,
  message: string,
): DistillJobCoordinatorError {
  return new DistillJobCoordinatorError(code, message);
}

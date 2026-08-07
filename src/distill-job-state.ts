import { z } from "zod";

import { compareCodeUnits } from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  DistillJobSchema,
  EventIdSchema,
  IsoDateTimeSchema,
  JobIdSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  Sha256DigestSchema,
  SkipReasonSchema,
  TransactionIdSchema,
  type DistillJob,
} from "./domain-schemas.js";

export const DISTILLATION_JOB_CREATED = "DistillationJobCreated";
export const DISTILLATION_JOB_LEASED = "DistillationJobLeased";
export const DISTILLATION_JOB_LEASE_RENEWED = "DistillationJobLeaseRenewed";
export const DISTILLATION_JOB_LEASE_EXPIRED = "DistillationJobLeaseExpired";
export const DISTILLATION_JOB_LEASE_REVOKED = "DistillationJobLeaseRevoked";
export const DISTILLATION_JOB_AWAITING_FINALIZE =
  "DistillationJobAwaitingFinalize";
export const DISTILLATION_JOB_SUCCEEDED = "DistillationJobSucceeded";
export const DISTILLATION_JOB_SKIPPED = "DistillationJobSkipped";
export const DISTILLATION_JOB_FAILED = "DistillationJobFailed";
export const DISTILLATION_JOB_REDISTILL_REQUESTED =
  "DistillationJobRedistillRequested";

export const DISTILLATION_JOB_RECORD_TYPES = new Set<string>([
  "DistillJob",
  DISTILLATION_JOB_CREATED,
  DISTILLATION_JOB_LEASED,
  DISTILLATION_JOB_LEASE_RENEWED,
  DISTILLATION_JOB_LEASE_EXPIRED,
  DISTILLATION_JOB_LEASE_REVOKED,
  DISTILLATION_JOB_AWAITING_FINALIZE,
  DISTILLATION_JOB_SUCCEEDED,
  DISTILLATION_JOB_SKIPPED,
  DISTILLATION_JOB_FAILED,
  DISTILLATION_JOB_REDISTILL_REQUESTED,
]);

const CreatedPayloadSchema = z
  .object({
    distillation_key: Sha256DigestSchema,
    job_id: JobIdSchema,
    repo_id: RepositoryIdSchema,
    thread_id: NonEmptyStringSchema,
  })
  .strict();

const LeasedPayloadSchema = z
  .object({
    job_id: JobIdSchema,
    lease_expires_at: IsoDateTimeSchema,
    lease_generation: z.number().int().positive(),
    lease_token_hash: Sha256DigestSchema,
  })
  .strict();

const LeaseRenewedPayloadSchema = z
  .object({
    job_id: JobIdSchema,
    lease_expires_at: IsoDateTimeSchema,
    lease_generation: z.number().int().positive(),
  })
  .strict();

const GenerationPayloadSchema = z
  .object({
    job_id: JobIdSchema,
    lease_generation: z.number().int().positive(),
  })
  .strict();

const SkippedPayloadSchema = GenerationPayloadSchema.extend({
  skip_reason: SkipReasonSchema,
}).strict();

export const DistillationFailureKindSchema = z.enum([
  "json_validation",
  "model",
  "system",
]);

const FailedPayloadSchema = GenerationPayloadSchema.extend({
  failure_kind: DistillationFailureKindSchema,
  last_error: NonEmptyStringSchema,
  next_retry_at: IsoDateTimeSchema.nullable(),
}).strict();

const RedistillRequestedPayloadSchema = GenerationPayloadSchema.extend({
  distillation_key: Sha256DigestSchema,
}).strict();

export interface DistillationJobEventPayloadByType {
  readonly DistillationJobAwaitingFinalize: z.infer<
    typeof GenerationPayloadSchema
  >;
  readonly DistillationJobCreated: z.infer<typeof CreatedPayloadSchema>;
  readonly DistillationJobFailed: z.infer<typeof FailedPayloadSchema>;
  readonly DistillationJobLeaseExpired: z.infer<typeof GenerationPayloadSchema>;
  readonly DistillationJobLeaseRevoked: z.infer<typeof GenerationPayloadSchema>;
  readonly DistillationJobLeaseRenewed: z.infer<
    typeof LeaseRenewedPayloadSchema
  >;
  readonly DistillationJobLeased: z.infer<typeof LeasedPayloadSchema>;
  readonly DistillationJobRedistillRequested: z.infer<
    typeof RedistillRequestedPayloadSchema
  >;
  readonly DistillationJobSkipped: z.infer<typeof SkippedPayloadSchema>;
  readonly DistillationJobSucceeded: z.infer<typeof GenerationPayloadSchema>;
}

export type DistillationJobEventType = keyof DistillationJobEventPayloadByType;
export type DistillationJobEventPayload =
  DistillationJobEventPayloadByType[DistillationJobEventType];
export type DistillationJobEvent = {
  readonly [TType in DistillationJobEventType]: {
    readonly payload: DistillationJobEventPayloadByType[TType];
    readonly type: TType;
  };
}[DistillationJobEventType];
export type DistillationFailureKind = z.infer<
  typeof DistillationFailureKindSchema
>;

export type DistillJobStateErrorCode =
  | "DISTILL_JOB_DUPLICATE"
  | "DISTILL_JOB_EVENT_INVALID"
  | "DISTILL_JOB_NOT_FOUND"
  | "DISTILL_JOB_TRANSITION_INVALID";

export class DistillJobStateError extends Error {
  constructor(
    readonly code: DistillJobStateErrorCode,
    message: string,
    readonly recordId?: string,
    readonly recordType?: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "DistillJobStateError";
  }
}

export interface CreateDistillationJobEventRecordRequest<
  TType extends DistillationJobEventType,
> {
  readonly eventId: string;
  readonly payload: DistillationJobEventPayloadByType[TType];
  readonly recordedAt: string;
  readonly transactionId: string;
  readonly type: TType;
}

/** Creates one validated canonical job event without accepting plaintext tokens. */
export function createDistillationJobEventRecord<
  TType extends DistillationJobEventType,
>(
  request: CreateDistillationJobEventRecordRequest<TType>,
): CanonicalJsonlRecord<DistillationJobEventPayloadByType[TType]> {
  const payload = parseEventPayload(request.type, request.payload);
  return {
    payload: payload as DistillationJobEventPayloadByType[TType],
    record_id: EventIdSchema.parse(request.eventId),
    record_type: request.type,
    recorded_at: IsoDateTimeSchema.parse(request.recordedAt),
    schema_version: 1,
    transaction_id: TransactionIdSchema.parse(request.transactionId),
  };
}

/** Folds canonical job events by aggregate generation and event time. */
export function reduceDistillationJobRecords(
  records: readonly CanonicalJsonlRecord[],
): DistillJob[] {
  const recordsByJob = new Map<
    string,
    Array<{ readonly record: CanonicalJsonlRecord; readonly sequence: number }>
  >();
  const uniqueKeys = new Map<string, string>();

  records.forEach((record, sequence) => {
    if (!DISTILLATION_JOB_RECORD_TYPES.has(record.record_type)) {
      throw stateError(
        "DISTILL_JOB_EVENT_INVALID",
        `unsupported job record type ${record.record_type}`,
        record,
      );
    }
    const jobId = payloadJobId(record);
    const aggregate = recordsByJob.get(jobId) ?? [];
    aggregate.push({ record, sequence });
    recordsByJob.set(jobId, aggregate);
  });

  const jobs: DistillJob[] = [];
  for (const aggregate of recordsByJob.values()) {
    let next: DistillJob | undefined;
    for (const { record } of aggregate.sort(compareJobAggregateRecords)) {
      next = applyDistillationJobRecord(next, record);
    }
    if (next === undefined) continue;
    const uniqueKey = jobUniqueKey(next);
    const existingJobId = uniqueKeys.get(uniqueKey);
    if (existingJobId !== undefined && existingJobId !== next.job_id) {
      throw stateError(
        "DISTILL_JOB_DUPLICATE",
        `thread ${next.thread_id} already has a job for ${next.distillation_key}`,
        aggregate[0]!.record,
      );
    }
    uniqueKeys.set(uniqueKey, next.job_id);
    jobs.push(next);
  }

  return jobs.sort((a, b) => compareCodeUnits(a.job_id, b.job_id));
}

function compareJobAggregateRecords(
  first: { readonly record: CanonicalJsonlRecord; readonly sequence: number },
  second: { readonly record: CanonicalJsonlRecord; readonly sequence: number },
): number {
  const baseOrder =
    baseRecordRank(first.record) - baseRecordRank(second.record);
  if (baseOrder !== 0) return baseOrder;
  const generationOrder =
    recordLeaseGeneration(first.record) - recordLeaseGeneration(second.record);
  if (generationOrder !== 0) return generationOrder;
  const timeOrder =
    recordTimestamp(first.record) - recordTimestamp(second.record);
  if (timeOrder !== 0) return timeOrder;
  const transitionOrder =
    transitionRank(first.record) - transitionRank(second.record);
  if (transitionOrder !== 0) return transitionOrder;
  const expiryOrder =
    recordLeaseExpiry(first.record) - recordLeaseExpiry(second.record);
  return expiryOrder === 0 ? first.sequence - second.sequence : expiryOrder;
}

function baseRecordRank(record: CanonicalJsonlRecord): number {
  return record.record_type === "DistillJob" ||
    record.record_type === DISTILLATION_JOB_CREATED
    ? 0
    : 1;
}

function recordLeaseGeneration(record: CanonicalJsonlRecord): number {
  if (baseRecordRank(record) === 0) return 0;
  const generation = recordPayloadNumber(record, "lease_generation");
  return Number.isSafeInteger(generation)
    ? generation
    : Number.MAX_SAFE_INTEGER;
}

function recordTimestamp(record: CanonicalJsonlRecord): number {
  const timestamp = Date.parse(record.recorded_at);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function transitionRank(record: CanonicalJsonlRecord): number {
  switch (record.record_type) {
    case DISTILLATION_JOB_LEASED:
      return 0;
    case DISTILLATION_JOB_LEASE_RENEWED:
      return 1;
    case DISTILLATION_JOB_AWAITING_FINALIZE:
      return 2;
    case DISTILLATION_JOB_SUCCEEDED:
    case DISTILLATION_JOB_SKIPPED:
    case DISTILLATION_JOB_FAILED:
      return 3;
    case DISTILLATION_JOB_LEASE_EXPIRED:
      return 4;
    case DISTILLATION_JOB_LEASE_REVOKED:
      return 4;
    case DISTILLATION_JOB_REDISTILL_REQUESTED:
      return 5;
    default:
      return 0;
  }
}

function recordLeaseExpiry(record: CanonicalJsonlRecord): number {
  if (record.record_type !== DISTILLATION_JOB_LEASE_RENEWED) return 0;
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    !("lease_expires_at" in record.payload) ||
    typeof record.payload.lease_expires_at !== "string"
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  const timestamp = Date.parse(record.payload.lease_expires_at);
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function recordPayloadNumber(
  record: CanonicalJsonlRecord,
  key: string,
): number {
  if (record.payload === null || typeof record.payload !== "object") {
    return Number.NaN;
  }
  const payload = record.payload as Record<string, unknown>;
  return typeof payload[key] === "number"
    ? (payload[key] as number)
    : Number.NaN;
}

/** Applies one canonical event to a single job aggregate. */
export function applyDistillationJobRecord(
  current: DistillJob | undefined,
  record: CanonicalJsonlRecord,
): DistillJob {
  try {
    const recordedAt = IsoDateTimeSchema.parse(record.recorded_at);
    if (record.record_type === "DistillJob") {
      if (current !== undefined) {
        throw transition(record, "legacy snapshots may only initialize a job");
      }
      return DistillJobSchema.parse(record.payload);
    }
    if (!isEventType(record.record_type)) {
      throw stateError(
        "DISTILL_JOB_EVENT_INVALID",
        `unsupported job record type ${record.record_type}`,
        record,
      );
    }
    if (record.record_type === DISTILLATION_JOB_CREATED) {
      const payload = CreatedPayloadSchema.parse(record.payload);
      if (current !== undefined) {
        throw transition(record, `job ${payload.job_id} was already created`);
      }
      return DistillJobSchema.parse({
        attempts: 0,
        distillation_key: payload.distillation_key,
        job_id: payload.job_id,
        last_error: null,
        lease_generation: 0,
        next_retry_at: null,
        repo_id: payload.repo_id,
        skip_reason: null,
        state: "pending",
        thread_id: payload.thread_id,
        updated_at: recordedAt,
        validation_failures: 0,
      });
    }
    if (current === undefined) {
      throw stateError(
        "DISTILL_JOB_NOT_FOUND",
        `event references job ${payloadJobId(record)} before creation`,
        record,
      );
    }
    if (Date.parse(recordedAt) < Date.parse(current.updated_at)) {
      throw transition(record, "event recorded_at moved backwards");
    }

    switch (record.record_type) {
      case DISTILLATION_JOB_LEASED: {
        const payload = LeasedPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        return applyLeased(current, payload, recordedAt, record);
      }
      case DISTILLATION_JOB_LEASE_RENEWED: {
        const payload = LeaseRenewedPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        return applyLeaseRenewed(current, payload, recordedAt, record);
      }
      case DISTILLATION_JOB_LEASE_EXPIRED: {
        const payload = GenerationPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        return applyLeaseExpired(current, payload, recordedAt, record);
      }
      case DISTILLATION_JOB_LEASE_REVOKED: {
        const payload = GenerationPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        return applyLeaseRevoked(current, payload, recordedAt, record);
      }
      case DISTILLATION_JOB_AWAITING_FINALIZE: {
        const payload = GenerationPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        assertActiveGeneration(current, payload.lease_generation, record);
        if (current.state !== "processing") {
          throw transition(record, "only processing jobs can await finalize");
        }
        return activeJob(current, "awaiting_finalize", recordedAt);
      }
      case DISTILLATION_JOB_SUCCEEDED: {
        const payload = GenerationPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        assertActiveGeneration(current, payload.lease_generation, record);
        return terminalJob(current, "done", recordedAt, null, null);
      }
      case DISTILLATION_JOB_SKIPPED: {
        const payload = SkippedPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        assertActiveGeneration(current, payload.lease_generation, record);
        return terminalJob(
          current,
          "skipped",
          recordedAt,
          null,
          payload.skip_reason,
        );
      }
      case DISTILLATION_JOB_FAILED: {
        const payload = FailedPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        assertActiveGeneration(current, payload.lease_generation, record);
        return applyFailed(current, payload, recordedAt, record);
      }
      case DISTILLATION_JOB_REDISTILL_REQUESTED: {
        const payload = RedistillRequestedPayloadSchema.parse(record.payload);
        assertMatchingJob(current, payload.job_id, record);
        return applyRedistillRequested(current, payload, recordedAt, record);
      }
      default:
        throw stateError(
          "DISTILL_JOB_EVENT_INVALID",
          `unsupported job record type ${record.record_type}`,
          record,
        );
    }
  } catch (error) {
    if (error instanceof DistillJobStateError) throw error;
    throw stateError(
      "DISTILL_JOB_EVENT_INVALID",
      error instanceof Error ? error.message : String(error),
      record,
      error,
    );
  }
}

export function jobUniqueKey(
  job: Pick<DistillJob, "distillation_key" | "repo_id" | "thread_id">,
): string {
  return JSON.stringify([job.repo_id, job.thread_id, job.distillation_key]);
}

function applyLeased(
  current: DistillJob,
  payload: z.infer<typeof LeasedPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  if (current.state !== "pending" && current.state !== "awaiting_finalize") {
    throw transition(
      record,
      "only pending or expired awaiting_finalize jobs can be leased",
    );
  }
  if (
    current.state === "awaiting_finalize" &&
    Date.parse(current.lease_expires_at!) > Date.parse(recordedAt)
  ) {
    throw transition(
      record,
      "an active awaiting_finalize lease cannot be replaced",
    );
  }
  if (payload.lease_generation !== current.lease_generation + 1) {
    throw transition(record, "lease_generation must increase by exactly one");
  }
  if (Date.parse(payload.lease_expires_at) <= Date.parse(recordedAt)) {
    throw transition(record, "lease must expire after its recorded_at");
  }
  return DistillJobSchema.parse({
    ...jobIdentity(current),
    attempts: current.attempts + 1,
    last_error: current.last_error ?? null,
    lease_expires_at: payload.lease_expires_at,
    lease_generation: payload.lease_generation,
    lease_token_hash: payload.lease_token_hash,
    next_retry_at: null,
    skip_reason: null,
    state:
      current.state === "awaiting_finalize"
        ? "awaiting_finalize"
        : "processing",
    updated_at: recordedAt,
    validation_failures: current.validation_failures,
  });
}

function applyLeaseRenewed(
  current: DistillJob,
  payload: z.infer<typeof LeaseRenewedPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  assertActiveGeneration(current, payload.lease_generation, record);
  if (
    Date.parse(payload.lease_expires_at) <=
    Date.parse(current.lease_expires_at!)
  ) {
    throw transition(record, "renewed lease must extend lease_expires_at");
  }
  return DistillJobSchema.parse({
    ...current,
    lease_expires_at: payload.lease_expires_at,
    updated_at: recordedAt,
  });
}

function applyLeaseExpired(
  current: DistillJob,
  payload: z.infer<typeof GenerationPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  assertActiveGeneration(current, payload.lease_generation, record);
  if (Date.parse(current.lease_expires_at!) > Date.parse(recordedAt)) {
    throw transition(record, "an unexpired lease cannot be reclaimed");
  }
  if (current.state === "awaiting_finalize") {
    return DistillJobSchema.parse({
      ...current,
      last_error: "lease expired",
      updated_at: recordedAt,
    });
  }
  return DistillJobSchema.parse({
    ...jobIdentity(current),
    attempts: current.attempts,
    last_error: "lease expired",
    lease_generation: current.lease_generation,
    next_retry_at: null,
    skip_reason: null,
    state: "pending",
    updated_at: recordedAt,
    validation_failures: current.validation_failures,
  });
}

function applyLeaseRevoked(
  current: DistillJob,
  payload: z.infer<typeof GenerationPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  assertActiveGeneration(current, payload.lease_generation, record);
  if (current.state !== "awaiting_finalize") {
    throw transition(
      record,
      "only an awaiting_finalize lease can be explicitly revoked",
    );
  }
  return DistillJobSchema.parse({
    ...current,
    lease_expires_at: recordedAt,
    updated_at: recordedAt,
  });
}

function applyFailed(
  current: DistillJob,
  payload: z.infer<typeof FailedPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  const validationFailures =
    current.validation_failures +
    (payload.failure_kind === "json_validation" ? 1 : 0);
  const isFirstJsonValidationFailure =
    payload.failure_kind === "json_validation" &&
    current.validation_failures === 0;
  if (isFirstJsonValidationFailure && payload.next_retry_at === null) {
    throw transition(
      record,
      "the first JSON validation failure must schedule one retry",
    );
  }
  if (
    payload.failure_kind === "json_validation" &&
    current.validation_failures > 0 &&
    payload.next_retry_at !== null
  ) {
    throw transition(record, "JSON validation may be retried only once");
  }
  const retryAllowed =
    payload.next_retry_at !== null &&
    (payload.failure_kind !== "json_validation" ||
      isFirstJsonValidationFailure);
  if (
    retryAllowed &&
    Date.parse(payload.next_retry_at!) <= Date.parse(recordedAt)
  ) {
    throw transition(record, "next_retry_at must be after recorded_at");
  }
  return DistillJobSchema.parse({
    ...jobIdentity(current),
    attempts: current.attempts,
    last_error: payload.last_error,
    lease_generation: current.lease_generation,
    next_retry_at: retryAllowed ? payload.next_retry_at : null,
    skip_reason: null,
    state: retryAllowed ? "pending" : "failed",
    updated_at: recordedAt,
    validation_failures: validationFailures,
  });
}

function applyRedistillRequested(
  current: DistillJob,
  payload: z.infer<typeof RedistillRequestedPayloadSchema>,
  recordedAt: string,
  record: CanonicalJsonlRecord,
): DistillJob {
  if (payload.distillation_key !== current.distillation_key) {
    throw transition(record, "redistill request changed the job key");
  }
  if (payload.lease_generation !== current.lease_generation) {
    throw transition(record, "redistill request lease_generation is stale");
  }
  if (
    current.state !== "done" &&
    current.state !== "failed" &&
    current.state !== "skipped"
  ) {
    throw transition(
      record,
      "only terminal jobs can be explicitly redistilled",
    );
  }
  return DistillJobSchema.parse({
    ...jobIdentity(current),
    attempts: current.attempts,
    last_error: null,
    lease_generation: current.lease_generation,
    next_retry_at: null,
    skip_reason: null,
    state: "pending",
    updated_at: recordedAt,
    validation_failures: 0,
  });
}

function assertMatchingJob(
  current: DistillJob,
  jobId: string,
  record: CanonicalJsonlRecord,
): void {
  if (jobId !== current.job_id) {
    throw transition(record, "event job_id does not match aggregate");
  }
}

function activeJob(
  current: DistillJob,
  state: "awaiting_finalize" | "processing",
  updatedAt: string,
): DistillJob {
  return DistillJobSchema.parse({ ...current, state, updated_at: updatedAt });
}

function terminalJob(
  current: DistillJob,
  state: "done" | "skipped",
  updatedAt: string,
  lastError: string | null,
  skipReason: z.infer<typeof SkipReasonSchema> | null,
): DistillJob {
  return DistillJobSchema.parse({
    ...jobIdentity(current),
    attempts: current.attempts,
    last_error: lastError,
    lease_generation: current.lease_generation,
    next_retry_at: null,
    skip_reason: skipReason,
    state,
    updated_at: updatedAt,
    validation_failures: current.validation_failures,
  });
}

function assertActiveGeneration(
  current: DistillJob,
  generation: number,
  record: CanonicalJsonlRecord,
): void {
  if (current.state !== "processing" && current.state !== "awaiting_finalize") {
    throw transition(record, `job ${current.job_id} has no active lease`);
  }
  if (generation !== current.lease_generation) {
    throw transition(record, "event lease_generation is stale");
  }
}

function jobIdentity(
  job: DistillJob,
): Pick<DistillJob, "distillation_key" | "job_id" | "repo_id" | "thread_id"> {
  return {
    distillation_key: job.distillation_key,
    job_id: job.job_id,
    repo_id: job.repo_id,
    thread_id: job.thread_id,
  };
}

function payloadJobId(record: CanonicalJsonlRecord): string {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    !("job_id" in record.payload) ||
    typeof record.payload.job_id !== "string"
  ) {
    throw stateError(
      "DISTILL_JOB_EVENT_INVALID",
      "job event payload requires job_id",
      record,
    );
  }
  return record.payload.job_id;
}

function parseEventPayload<TType extends DistillationJobEventType>(
  type: TType,
  payload: unknown,
): DistillationJobEventPayloadByType[TType] {
  switch (type) {
    case DISTILLATION_JOB_CREATED:
      return CreatedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_LEASED:
      return LeasedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_LEASE_RENEWED:
      return LeaseRenewedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_SKIPPED:
      return SkippedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_FAILED:
      return FailedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_REDISTILL_REQUESTED:
      return RedistillRequestedPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
    case DISTILLATION_JOB_LEASE_EXPIRED:
    case DISTILLATION_JOB_LEASE_REVOKED:
    case DISTILLATION_JOB_AWAITING_FINALIZE:
    case DISTILLATION_JOB_SUCCEEDED:
      return GenerationPayloadSchema.parse(
        payload,
      ) as DistillationJobEventPayloadByType[TType];
  }
}

function isEventType(value: string): value is DistillationJobEventType {
  return value !== "DistillJob" && DISTILLATION_JOB_RECORD_TYPES.has(value);
}

function transition(
  record: CanonicalJsonlRecord,
  message: string,
): DistillJobStateError {
  return stateError("DISTILL_JOB_TRANSITION_INVALID", message, record);
}

function stateError(
  code: DistillJobStateErrorCode,
  message: string,
  record: CanonicalJsonlRecord,
  cause?: unknown,
): DistillJobStateError {
  return new DistillJobStateError(
    code,
    message,
    record.record_id,
    record.record_type,
    cause === undefined ? undefined : { cause },
  );
}

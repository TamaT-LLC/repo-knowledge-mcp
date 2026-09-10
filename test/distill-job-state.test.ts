import { describe, expect, it } from "vitest";

import type { CanonicalJsonlRecord } from "../src/canonical-jsonl.js";
import type { DistillJob } from "../src/domain-schemas.js";
import {
  applyDistillationJobRecord,
  reduceDistillationJobRecords,
} from "../src/distill-job-state.js";

const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const KEY = `sha256:${"a".repeat(64)}`;
const OTHER_KEY = `sha256:${"b".repeat(64)}`;
const START = "2026-08-06T00:00:00.000Z";
const LATER = "2026-08-06T00:01:00.000Z";
const EXPIRY = "2026-08-06T01:00:00.000Z";
const generation = { job_id: JOB_ID, lease_generation: 1 };
const created = event("DistillationJobCreated", {
  job_id: JOB_ID,
  distillation_key: KEY,
  repo_id: "repo-1",
  thread_id: "thread-1",
});
const leased = event("DistillationJobLeased", {
  ...generation,
  lease_expires_at: EXPIRY,
  lease_token_hash: OTHER_KEY,
});
const pending = applyDistillationJobRecord(undefined, created);
const processing = applyDistillationJobRecord(pending, leased);
const awaiting = applyDistillationJobRecord(
  processing,
  event("DistillationJobAwaitingFinalize", generation),
);
const done = applyDistillationJobRecord(
  processing,
  event("DistillationJobSucceeded", generation),
);

describe("canonical job state transitions", () => {
  it.each<{
    name: string;
    current: DistillJob | undefined;
    record: CanonicalJsonlRecord;
    message: string;
  }>([
    {
      name: "reinitializing a legacy snapshot",
      current: pending,
      record: event("DistillJob", pending),
      message: "legacy snapshots may only initialize",
    },
    {
      name: "creating an existing job",
      current: pending,
      record: created,
      message: "already created",
    },
    {
      name: "an event before creation",
      current: undefined,
      record: leased,
      message: "DISTILL_JOB_NOT_FOUND",
    },
    {
      name: "an unknown event",
      current: pending,
      record: event("UnknownJobEvent", generation),
      message: "DISTILL_JOB_EVENT_INVALID",
    },
    {
      name: "an invalid timestamp",
      current: pending,
      record: event("DistillationJobSucceeded", generation, "not-a-date"),
      message: "DISTILL_JOB_EVENT_INVALID",
    },
    {
      name: "time moving backwards",
      current: { ...processing, updated_at: LATER },
      record: event("DistillationJobSucceeded", generation),
      message: "moved backwards",
    },
    {
      name: "an invalid payload",
      current: pending,
      record: event("DistillationJobLeased", null),
      message: "DISTILL_JOB_EVENT_INVALID",
    },
    {
      name: "leasing a processing job",
      current: processing,
      record: leased,
      message: "only pending or expired",
    },
    {
      name: "replacing an active finalize lease",
      current: awaiting,
      record: leased,
      message: "cannot be replaced",
    },
    {
      name: "skipping a lease generation",
      current: pending,
      record: event("DistillationJobLeased", {
        ...(leased.payload as object),
        lease_generation: 2,
      }),
      message: "increase by exactly one",
    },
    {
      name: "a lease that already expired",
      current: pending,
      record: event("DistillationJobLeased", {
        ...(leased.payload as object),
        lease_expires_at: START,
      }),
      message: "expire after",
    },
    {
      name: "awaiting finalize twice",
      current: awaiting,
      record: event("DistillationJobAwaitingFinalize", generation),
      message: "only processing jobs",
    },
    {
      name: "an event for another job",
      current: processing,
      record: event("DistillationJobSucceeded", {
        ...generation,
        job_id: OTHER_JOB_ID,
      }),
      message: "does not match aggregate",
    },
    {
      name: "a stale completion",
      current: processing,
      record: event("DistillationJobSucceeded", {
        ...generation,
        lease_generation: 2,
      }),
      message: "lease_generation is stale",
    },
    {
      name: "completion without a lease",
      current: pending,
      record: event("DistillationJobSucceeded", generation),
      message: "no active lease",
    },
    {
      name: "a renewal without extension",
      current: processing,
      record: event("DistillationJobLeaseRenewed", {
        ...generation,
        lease_expires_at: EXPIRY,
      }),
      message: "must extend",
    },
    {
      name: "reclaiming an unexpired lease",
      current: processing,
      record: event("DistillationJobLeaseExpired", generation),
      message: "unexpired lease",
    },
    {
      name: "revoking a processing lease",
      current: processing,
      record: event("DistillationJobLeaseRevoked", generation),
      message: "only an awaiting_finalize lease",
    },
    {
      name: "omitting the first validation retry",
      current: processing,
      record: failure(null),
      message: "must schedule one retry",
    },
    {
      name: "retrying validation twice",
      current: { ...processing, validation_failures: 1 },
      record: failure(EXPIRY),
      message: "retried only once",
    },
    {
      name: "scheduling a retry in the past",
      current: processing,
      record: failure(START),
      message: "next_retry_at must be after",
    },
    {
      name: "superseding a job with itself",
      current: pending,
      record: event("DistillationJobObsoleted", {
        job_id: JOB_ID,
        reason: "superseded_context",
        superseded_by_distillation_key: KEY,
      }),
      message: "its own distillation key",
    },
    {
      name: "superseding completed work",
      current: done,
      record: event("DistillationJobObsoleted", {
        job_id: JOB_ID,
        reason: "source_removed",
      }),
      message: "only unfinished jobs",
    },
    {
      name: "redistilling with a changed key",
      current: done,
      record: event("DistillationJobRedistillRequested", {
        ...generation,
        distillation_key: OTHER_KEY,
      }),
      message: "changed the job key",
    },
    {
      name: "redistilling a stale generation",
      current: done,
      record: event("DistillationJobRedistillRequested", {
        ...generation,
        lease_generation: 2,
        distillation_key: KEY,
      }),
      message: "lease_generation is stale",
    },
    {
      name: "redistilling unfinished work",
      current: processing,
      record: event("DistillationJobRedistillRequested", {
        ...generation,
        distillation_key: KEY,
      }),
      message: "only terminal jobs",
    },
  ])(
    "rejects $name without changing the aggregate",
    ({ current, record, message }) => {
      const before = structuredClone(current);
      expect(() => applyDistillationJobRecord(current, record)).toThrow(
        message,
      );
      expect(current).toEqual(before);
    },
  );

  it("orders same-time lease renewals before finalize and completion", () => {
    const records = [
      event("DistillationJobSucceeded", generation, LATER),
      event("DistillationJobAwaitingFinalize", generation, LATER),
      event(
        "DistillationJobLeaseRenewed",
        { ...generation, lease_expires_at: "2026-08-06T03:00:00.000Z" },
        LATER,
      ),
      event(
        "DistillationJobLeaseRenewed",
        { ...generation, lease_expires_at: "2026-08-06T02:00:00.000Z" },
        LATER,
      ),
      leased,
      created,
    ];
    const reduced = reduceDistillationJobRecords(records);
    expect(reduced).toEqual([{ ...done, updated_at: LATER }]);
    expect(reduceDistillationJobRecords([...records].reverse())).toEqual(
      reduced,
    );
  });

  it("rejects duplicate job identities across different IDs", () => {
    expect(() =>
      reduceDistillationJobRecords([
        created,
        event("DistillationJobCreated", {
          ...(created.payload as object),
          job_id: OTHER_JOB_ID,
        }),
      ]),
    ).toThrow("DISTILL_JOB_DUPLICATE");
  });

  it.each([null, {}, { job_id: 42 }])(
    "rejects a malformed aggregate identity %j",
    (payload) => {
      expect(() =>
        reduceDistillationJobRecords([
          event("DistillationJobCreated", payload),
        ]),
      ).toThrow("job event payload requires job_id");
    },
  );

  it("rejects unrelated records in the job log", () => {
    expect(() =>
      reduceDistillationJobRecords([event("UnknownJobEvent", generation)]),
    ).toThrow("DISTILL_JOB_EVENT_INVALID");
  });
});

function failure(nextRetryAt: string | null): CanonicalJsonlRecord {
  return event("DistillationJobFailed", {
    ...generation,
    failure_kind: "json_validation",
    last_error: "invalid JSON",
    next_retry_at: nextRetryAt,
  });
}

function event(
  type: string,
  payload: unknown,
  recordedAt = START,
): CanonicalJsonlRecord {
  return {
    record_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    record_type: type,
    recorded_at: recordedAt,
    payload,
    schema_version: 1,
    transaction_id: "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  };
}

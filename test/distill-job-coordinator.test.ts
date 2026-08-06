import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  DISTILLATION_JOB_LEASE_EXPIRED,
  DISTILLATION_JOB_LEASED,
  DISTILL_JOB_EVENT_PATH,
  DistillJobCoordinator,
  reduceDistillationJobRecords,
  type CanonicalLockedMutationPlanner,
} from "../src/index.js";

const REPO_ID = "repo-1";
const DISTILLATION_KEY = `sha256:${"a".repeat(64)}`;
const OTHER_DISTILLATION_KEY = `sha256:${"b".repeat(64)}`;
const START = Date.parse("2026-08-06T00:00:00.000Z");

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("DistillJobCoordinator", () => {
  it("rejects asynchronous work inside the short repo-lock planner", async () => {
    const repository = await createRepository();
    const store = new CanonicalTransactionStore(repository);
    const asynchronousPlanner = (async () => ({
      transaction: null,
      value: null,
    })) as unknown as CanonicalLockedMutationPlanner<null>;

    await expect(
      store.runLockedMutation(asynchronousPlanner),
    ).rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
  });

  it("atomically reuses the unique thread and distillation key job", async () => {
    const repository = await createRepository();
    const first = coordinator(repository);
    const second = coordinator(repository);

    const results = await Promise.all([
      first.createJob(jobRequest()),
      second.createJob(jobRequest()),
    ]);
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(results.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(results.map((result) => result.job.job_id)).size).toBe(1);
    expect(snapshot.domain.distillJobs).toHaveLength(1);
    expect(snapshot.records).toHaveLength(1);
  });

  it("releases the repo writer lock before LLM-equivalent waiting", async () => {
    const repository = await createRepository();
    const first = coordinator(repository, { tokens: ["lease-token-1"] });
    await first.createJob(jobRequest());
    const lease = await first.acquireLease({ repo_id: REPO_ID });
    expect(lease).not.toBeNull();

    const independentWriter = coordinator(repository);
    const mutation = independentWriter.createJob(
      jobRequest("thread-2", OTHER_DISTILLATION_KEY),
    );
    const result = await Promise.race([
      mutation,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("repo lock remained held")), 1_000);
      }),
    ]);

    expect(result.created).toBe(true);
  });

  it("reconstructs transitions when job events span lexical file order", async () => {
    const repository = await createRepository();
    const createdWriter = coordinator(repository, {
      eventPath: "events/z-created.jsonl",
      now: () => new Date(START),
    });
    const created = await createdWriter.createJob(jobRequest());
    const leaseWriter = coordinator(repository, {
      eventPath: "events/a-leases.jsonl",
      now: () => new Date(START),
      tokens: ["cross-file-token"],
    });

    const lease = await leaseWriter.acquireLease({
      job_id: created.job.job_id,
      repo_id: REPO_ID,
    });
    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();

    expect(lease?.job.state).toBe("processing");
    expect(snapshot.domain.distillJobs[0]).toEqual(lease?.job);
  });

  it("reclaims an expired processing job and fences the delayed worker", async () => {
    const repository = await createRepository();
    let now = START;
    const service = coordinator(repository, {
      now: () => new Date(now),
      tokens: ["old-plaintext-token", "new-plaintext-token"],
    });
    const created = await service.createJob(jobRequest());
    const oldLease = await service.acquireLease({
      job_id: created.job.job_id,
      lease_duration_ms: 1_000,
      repo_id: REPO_ID,
    });
    expect(oldLease).not.toBeNull();

    now += 1_001;
    const newLease = await service.acquireLease({
      job_id: created.job.job_id,
      lease_duration_ms: 1_000,
      repo_id: REPO_ID,
    });
    expect(newLease).not.toBeNull();
    expect(newLease!.lease_generation).toBe(2);
    expect(newLease!.job.attempts).toBe(2);

    await expect(service.succeed(oldLease!)).rejects.toMatchObject({
      code: "STALE_LEASE",
      message: expect.stringContaining("prepare_distillation"),
    });
    const completed = await service.succeed(newLease!);
    expect(completed.state).toBe("done");

    const snapshot = await new CanonicalTransactionStore(
      repository,
    ).readSnapshot();
    const jobRecords = snapshot.records.map((entry) => entry.record);
    expect(jobRecords.map((record) => record.record_type)).toEqual(
      expect.arrayContaining([
        DISTILLATION_JOB_LEASED,
        DISTILLATION_JOB_LEASE_EXPIRED,
      ]),
    );
    expect(reduceDistillationJobRecords(jobRecords)).toEqual(
      snapshot.domain.distillJobs,
    );
  });

  it("never persists a plaintext lease token in canonical JSONL or SQLite", async () => {
    const repository = await createRepository();
    const plaintext = "plaintext-token-that-must-stay-ephemeral";
    const service = coordinator(repository, { tokens: [plaintext] });
    await service.createJob(jobRequest());
    const lease = await service.acquireLease({ repo_id: REPO_ID });
    expect(lease?.lease_token).toBe(plaintext);

    const jsonl = await readFile(
      join(repository, DISTILL_JOB_EVENT_PATH),
      "utf8",
    );
    expect(jsonl).not.toContain(plaintext);
    expect(jsonl).toContain("sha256:");

    const database = new Database(join(repository, "index.sqlite"), {
      readonly: true,
    });
    try {
      const persisted = JSON.stringify({
        jobs: database.prepare("SELECT payload_json FROM distill_jobs").all(),
        records: database
          .prepare("SELECT record_json FROM canonical_records")
          .all(),
      });
      expect(persisted).not.toContain(plaintext);
      expect(persisted).toContain("sha256:");
    } finally {
      database.close();
    }
  });

  it("retries one JSON validation failure and makes the second terminal", async () => {
    const repository = await createRepository();
    let now = START;
    const service = coordinator(repository, {
      now: () => new Date(now),
      tokens: ["retry-token-1", "retry-token-2"],
    });
    await service.createJob(jobRequest());
    const firstLease = await service.acquireLease({ repo_id: REPO_ID });
    const retry = await service.fail({
      ...firstLease!,
      failure_kind: "json_validation",
      last_error: "candidate JSON did not match the schema",
    });

    expect(retry).toMatchObject({
      attempts: 1,
      last_error: "candidate JSON did not match the schema",
      state: "pending",
      validation_failures: 1,
    });
    expect(retry.next_retry_at).toBe("2026-08-06T00:00:01.000Z");
    expect(await service.acquireLease({ repo_id: REPO_ID })).toBeNull();

    now += 1_000;
    const secondLease = await service.acquireLease({ repo_id: REPO_ID });
    const failed = await service.fail({
      ...secondLease!,
      failure_kind: "json_validation",
      last_error: "candidate JSON was still invalid",
      next_retry_at: "2026-08-07T00:00:00.000Z",
    });

    expect(failed).toMatchObject({
      attempts: 2,
      last_error: "candidate JSON was still invalid",
      next_retry_at: null,
      state: "failed",
      validation_failures: 2,
    });
  });

  it("renews and reacquires awaiting-finalize jobs without losing the phase", async () => {
    const repository = await createRepository();
    let now = START;
    const service = coordinator(repository, {
      now: () => new Date(now),
      tokens: ["finalize-token-1", "finalize-token-2"],
    });
    await service.createJob(jobRequest());
    const firstLease = await service.acquireLease({
      lease_duration_ms: 1_000,
      repo_id: REPO_ID,
    });
    now += 100;
    const renewed = await service.renewLease({
      ...firstLease!,
      lease_duration_ms: 2_000,
    });
    const awaiting = await service.markAwaitingFinalize(renewed);
    expect(awaiting.state).toBe("awaiting_finalize");

    now = Date.parse(renewed.expires_at) + 1;
    const resumed = await service.acquireLease({
      job_id: renewed.job_id,
      repo_id: REPO_ID,
    });
    expect(resumed).toMatchObject({
      lease_generation: 2,
      job: { state: "awaiting_finalize" },
    });
  });

  it("rejects an incorrect token for the current generation", async () => {
    const repository = await createRepository();
    const service = coordinator(repository, { tokens: ["correct-token"] });
    await service.createJob(jobRequest());
    const lease = await service.acquireLease({ repo_id: REPO_ID });

    await expect(
      service.succeed({ ...lease!, lease_token: "incorrect-token" }),
    ).rejects.toMatchObject({ code: "INVALID_LEASE_TOKEN" });
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-distill-jobs-"));
  temporaryRepositories.push(repository);
  return repository;
}

function coordinator(
  repository: string,
  options: {
    readonly eventPath?: string;
    readonly now?: () => Date;
    readonly tokens?: string[];
  } = {},
): DistillJobCoordinator {
  const tokens = options.tokens ?? [];
  return new DistillJobCoordinator(new CanonicalTransactionStore(repository), {
    ...(options.eventPath === undefined
      ? {}
      : { eventPath: options.eventPath }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(tokens.length === 0
      ? {}
      : {
          nextLeaseToken: () => {
            const token = tokens.shift();
            if (token === undefined) throw new Error("lease token exhausted");
            return token;
          },
        }),
  });
}

function jobRequest(
  threadId = "thread-1",
  distillationKey = DISTILLATION_KEY,
): {
  readonly distillation_key: string;
  readonly repo_id: string;
  readonly thread_id: string;
} {
  return {
    distillation_key: distillationKey,
    repo_id: REPO_ID,
    thread_id: threadId,
  };
}

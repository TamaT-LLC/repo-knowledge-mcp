import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  StatsReadError,
  StatsReadService,
  SyncCheckpointStore,
  createDomainId,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistillJob,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeStatus,
  type RepositoryStats,
  type RepositoryStatsRequest,
  type Severity,
  type SourceProviderKey,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const REPO_ID = "R_repo_1";
const OTHER_REPO_ID = "R_repo_2";
const REPO_NAME = "owner/repository";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("StatsReadService.getStats", () => {
  it("aggregates a fixed fixture into one deterministic versioned response", async () => {
    const repository = await createRepository();
    await writeFixedFixture(repository);
    await new SyncCheckpointStore(repository).write({
      cursor: {
        last_pr_number: 41,
        last_updated_at: "2026-08-05T10:00:00.000Z",
        repo_id: REPO_ID,
        version: 1,
      },
      schema_version: 1,
      updated_at: "2026-08-05T10:00:05.000Z",
    });
    const readService = service(repository);

    const stats = await readService.getStats();

    expect(stats).toEqual({
      buckets: null,
      canonical_digest: stats.canonical_digest,
      evidence: {
        by_source: { bugbot: 0, devin: 1, greptile: 1, human: 2, other: 0 },
        by_status: { active: 2, superseded: 1, withdrawn: 1 },
        eligible_for_count: 2,
        total: 4,
      },
      jobs: {
        by_state: {
          awaiting_finalize: 0,
          done: 1,
          failed: 2,
          pending: 3,
          processing: 1,
          skipped: 1,
        },
        total: 8,
      },
      knowledge: {
        by_category: {
          architecture: 0,
          docs: 0,
          "error-handling": 0,
          naming: 0,
          other: 0,
          perf: 0,
          security: 2,
          style: 1,
          test: 1,
        },
        by_severity: { consider: 1, must: 2, should: 1 },
        by_status: {
          active: 2,
          deprecated: 0,
          proposed: 1,
          rejected: 0,
          stale: 1,
        },
        total: 4,
      },
      operations: {
        failed_jobs: 2,
        last_sync_checkpoint_at: "2026-08-05T10:00:05.000Z",
        pending_jobs: 3,
      },
      outcomes: {
        by_type: {
          applied: 2,
          false_positive: 1,
          not_applicable: 1,
          violated: 3,
        },
        total: 7,
      },
      repo: REPO_NAME,
      stats_schema_version: 1,
      sync: {
        last_checkpoint: {
          last_pr_number: 41,
          last_updated_at: "2026-08-05T10:00:00.000Z",
          updated_at: "2026-08-05T10:00:05.000Z",
        },
      },
      window: { bucket: "total", since: null, timezone: "UTC", until: null },
    } satisfies RepositoryStats);
    expect(stats.canonical_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("returns the byte-identical response for repeated reads of one canonical state", async () => {
    const repository = await createRepository();
    await writeFixedFixture(repository);
    const readService = service(repository);

    const first = await readService.getStats({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });
    const second = await readService.getStats({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps every aggregate identical before and after reindex", async () => {
    const repository = await createRepository();
    await writeFixedFixture(repository);
    const store = new CanonicalTransactionStore(repository);
    const readService = new StatsReadService({
      repo: REPO_NAME,
      repoId: REPO_ID,
      repository: store,
      syncCheckpoints: new SyncCheckpointStore(repository),
    });

    const before = await readService.getStats({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });
    await store.reindex();
    const after = await readService.getStats({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-08T00:00:00.000Z",
    });

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("returns zero-filled enum keys and null sync state for an empty repository", async () => {
    const repository = await createRepository();

    const stats = await service(repository).getStats();

    expect(stats.knowledge).toEqual({
      by_category: {
        architecture: 0,
        docs: 0,
        "error-handling": 0,
        naming: 0,
        other: 0,
        perf: 0,
        security: 0,
        style: 0,
        test: 0,
      },
      by_severity: { consider: 0, must: 0, should: 0 },
      by_status: {
        active: 0,
        deprecated: 0,
        proposed: 0,
        rejected: 0,
        stale: 0,
      },
      total: 0,
    });
    expect(stats.evidence).toEqual({
      by_source: { bugbot: 0, devin: 0, greptile: 0, human: 0, other: 0 },
      by_status: { active: 0, superseded: 0, withdrawn: 0 },
      eligible_for_count: 0,
      total: 0,
    });
    expect(stats.outcomes.total).toBe(0);
    expect(stats.jobs.total).toBe(0);
    expect(stats.operations).toEqual({
      failed_jobs: 0,
      last_sync_checkpoint_at: null,
      pending_jobs: 0,
    });
    expect(stats.sync.last_checkpoint).toBeNull();
  });

  it("treats the window as half-open: since is included and until is excluded", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      rule: "Boundary rule",
    });
    await writeRecords(repository, [
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId,
          observedAt: "2026-08-01T00:00:00.000Z",
          source: "human",
          status: "active",
          threadId: "thread-at-since",
        }),
      ),
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId,
          observedAt: "2026-08-02T00:00:00.000Z",
          source: "human",
          status: "active",
          threadId: "thread-at-until",
        }),
      ),
      canonicalRecord(
        "OutcomeRecorded",
        outcome(knowledgeId, "applied", "2026-08-01T23:59:59.999Z"),
      ),
      canonicalRecord(
        "OutcomeRecorded",
        outcome(knowledgeId, "violated", "2026-07-31T23:59:59.999Z"),
      ),
    ]);

    const stats = await service(repository).getStats({
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
    });

    expect(stats.evidence.total).toBe(1);
    expect(stats.outcomes.by_type).toEqual({
      applied: 1,
      false_positive: 0,
      not_applicable: 0,
      violated: 0,
    });
    expect(stats.window).toEqual({
      bucket: "total",
      since: "2026-08-01T00:00:00.000Z",
      timezone: "UTC",
      until: "2026-08-02T00:00:00.000Z",
    });
  });

  it("normalizes offsets to UTC instants and assigns day buckets by UTC date", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      rule: "Timezone rule",
    });
    await writeRecords(repository, [
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId,
          // UTC instant 2026-08-01T15:30:00Z -> UTC day 2026-08-01
          observedAt: "2026-08-02T00:30:00.000+09:00",
          source: "human",
          status: "active",
          threadId: "thread-jst",
        }),
      ),
      canonicalRecord(
        "OutcomeRecorded",
        // UTC instant 2026-07-31T15:30:00Z -> before the window
        outcome(knowledgeId, "violated", "2026-08-01T00:30:00.000+09:00"),
      ),
    ]);

    const stats = await service(repository).getStats({
      bucket: "day",
      since: "2026-08-01T09:00:00.000+09:00",
      until: "2026-08-03T09:00:00.000+09:00",
    });

    expect(stats.window).toEqual({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      timezone: "UTC",
      until: "2026-08-03T00:00:00.000Z",
    });
    expect(stats.outcomes.total).toBe(0);
    expect(stats.buckets).toEqual([
      {
        day: "2026-08-01",
        evidence_total: 1,
        outcome_by_type: {
          applied: 0,
          false_positive: 0,
          not_applicable: 0,
          violated: 0,
        },
        outcome_total: 0,
      },
      {
        day: "2026-08-02",
        evidence_total: 0,
        outcome_by_type: {
          applied: 0,
          false_positive: 0,
          not_applicable: 0,
          violated: 0,
        },
        outcome_total: 0,
      },
    ]);
  });

  it("enumerates every UTC day intersecting the window even without observations", async () => {
    const repository = await createRepository();

    const stats = await service(repository).getStats({
      bucket: "day",
      since: "2026-08-01T12:00:00.000Z",
      until: "2026-08-04T06:00:00.000Z",
    });

    expect(stats.buckets?.map((bucket) => bucket.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(
      stats.buckets?.every(
        (bucket) => bucket.evidence_total === 0 && bucket.outcome_total === 0,
      ),
    ).toBe(true);
  });

  it("excludes another repository's knowledge, evidence, outcomes, and jobs", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      rule: "This repository rule",
    });
    await writeKnowledge(repository, {
      repoId: OTHER_REPO_ID,
      rule: "Foreign repository rule",
    });
    await writeRecords(repository, [
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId,
          observedAt: NOW,
          source: "human",
          status: "active",
          threadId: "thread-local",
        }),
      ),
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId,
          observedAt: NOW,
          repoId: OTHER_REPO_ID,
          source: "devin",
          status: "active",
          threadId: "thread-foreign",
        }),
      ),
      canonicalRecord("OutcomeRecorded", outcome(knowledgeId, "applied", NOW)),
      canonicalRecord("OutcomeRecorded", {
        ...outcome(knowledgeId, "violated", NOW),
        repo_id: OTHER_REPO_ID,
      }),
      canonicalRecord("DistillJob", job({ state: "pending" })),
      canonicalRecord(
        "DistillJob",
        job({ repoId: OTHER_REPO_ID, state: "failed" }),
      ),
    ]);

    const stats = await service(repository).getStats();

    expect(stats.knowledge.total).toBe(1);
    expect(stats.evidence.total).toBe(1);
    expect(stats.evidence.by_source.devin).toBe(0);
    expect(stats.outcomes.total).toBe(1);
    expect(stats.outcomes.by_type.violated).toBe(0);
    expect(stats.jobs.total).toBe(1);
    expect(stats.operations.failed_jobs).toBe(0);
  });

  it("fails closed when the stored sync checkpoint belongs to another repository", async () => {
    const repository = await createRepository();
    await new SyncCheckpointStore(repository).write({
      cursor: {
        last_pr_number: 7,
        last_updated_at: NOW,
        repo_id: OTHER_REPO_ID,
        version: 1,
      },
      schema_version: 1,
      updated_at: NOW,
    });

    await expect(service(repository).getStats()).rejects.toMatchObject({
      code: "STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
      name: "StatsReadError",
    });
  });

  it.each<readonly [string, RepositoryStatsRequest, StatsReadError["code"]]>([
    ["malformed since", { since: "2026-08-01" }, "INVALID_STATS_REQUEST"],
    [
      "unknown field",
      { timezone: "Asia/Tokyo" } as never,
      "INVALID_STATS_REQUEST",
    ],
    [
      "since not before until",
      {
        since: "2026-08-02T00:00:00.000Z",
        until: "2026-08-02T09:00:00.000+09:00",
      },
      "INVALID_STATS_WINDOW",
    ],
    [
      "day bucket without window",
      { bucket: "day", since: "2026-08-01T00:00:00.000Z" },
      "STATS_WINDOW_REQUIRED",
    ],
    [
      "day bucket over 366 days",
      {
        bucket: "day",
        since: "2025-01-01T00:00:00.000Z",
        until: "2026-01-03T00:00:00.000Z",
      },
      "STATS_WINDOW_TOO_LARGE",
    ],
  ])("rejects %s", async (_label, request, code) => {
    const repository = await createRepository();

    await expect(service(repository).getStats(request)).rejects.toMatchObject({
      code,
    });
    expect(new StatsReadError(code, "message").message).toContain(code);
  });
});

interface KnowledgeInput {
  readonly category?: KnowledgeCategory;
  readonly repoId?: string;
  readonly rule: string;
  readonly severity?: Severity;
  readonly status?: KnowledgeStatus;
}

interface EvidenceInput {
  readonly eligibleForCount?: boolean;
  readonly evidenceId: string;
  readonly knowledgeId: string;
  readonly observedAt: string;
  readonly repoId?: string;
  readonly source: SourceProviderKey;
  readonly status: KnowledgeEvidence["status"];
  readonly threadId: string;
}

interface JobInput {
  readonly repoId?: string;
  readonly state: DistillJob["state"];
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-stats-service-"));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, "knowledge"), { recursive: true });
  return repository;
}

function service(repository: string): StatsReadService {
  return new StatsReadService({
    repo: REPO_NAME,
    repoId: REPO_ID,
    repository: new CanonicalTransactionStore(repository),
    syncCheckpoints: new SyncCheckpointStore(repository),
  });
}

async function writeFixedFixture(repository: string): Promise<void> {
  const knowledgeId = await writeKnowledge(repository, {
    category: "security",
    rule: "Active security must rule",
    severity: "must",
  });
  await writeKnowledge(repository, {
    category: "security",
    rule: "Active security should rule",
    severity: "should",
  });
  await writeKnowledge(repository, {
    category: "style",
    rule: "Proposed style rule",
    severity: "consider",
    status: "proposed",
  });
  await writeKnowledge(repository, {
    category: "test",
    rule: "Stale test rule",
    severity: "must",
    status: "stale",
  });

  const evidenceRecords = [
    evidence({
      evidenceId: createDomainId("evidence"),
      knowledgeId,
      observedAt: "2026-08-01T09:00:00.000Z",
      source: "human",
      status: "active",
      threadId: "thread-1",
    }),
    evidence({
      evidenceId: createDomainId("evidence"),
      knowledgeId,
      observedAt: "2026-08-02T09:00:00.000Z",
      source: "devin",
      status: "active",
      threadId: "thread-2",
    }),
    evidence({
      eligibleForCount: false,
      evidenceId: createDomainId("evidence"),
      knowledgeId,
      observedAt: "2026-08-03T09:00:00.000Z",
      source: "greptile",
      status: "superseded",
      threadId: "thread-3",
    }),
    evidence({
      eligibleForCount: false,
      evidenceId: createDomainId("evidence"),
      knowledgeId,
      observedAt: "2026-08-04T09:00:00.000Z",
      source: "human",
      status: "withdrawn",
      threadId: "thread-4",
    }),
  ];
  const outcomeRecords: readonly KnowledgeOutcome[] = [
    outcome(knowledgeId, "applied", "2026-08-01T10:00:00.000Z"),
    outcome(knowledgeId, "applied", "2026-08-02T10:00:00.000Z"),
    outcome(knowledgeId, "violated", "2026-08-03T10:00:00.000Z"),
    outcome(knowledgeId, "violated", "2026-08-04T10:00:00.000Z"),
    outcome(knowledgeId, "violated", "2026-08-05T10:00:00.000Z"),
    outcome(knowledgeId, "not_applicable", "2026-08-05T11:00:00.000Z"),
    outcome(knowledgeId, "false_positive", "2026-08-05T12:00:00.000Z"),
  ];
  const jobRecords: readonly DistillJob[] = [
    job({ state: "pending" }),
    job({ state: "pending" }),
    job({ state: "pending" }),
    job({ state: "processing" }),
    job({ state: "done" }),
    job({ state: "skipped" }),
    job({ state: "failed" }),
    job({ state: "failed" }),
  ];

  await writeRecords(repository, [
    ...evidenceRecords.map((value) =>
      canonicalRecord("EvidenceCreated", value),
    ),
    ...outcomeRecords.map((value) => canonicalRecord("OutcomeRecorded", value)),
    ...jobRecords.map((value) => canonicalRecord("DistillJob", value)),
  ]);
}

async function writeKnowledge(
  repository: string,
  input: KnowledgeInput,
): Promise<string> {
  const id = createDomainId("knowledge");
  const relativePath = `knowledge/${id}.md`;
  await writeFile(
    join(repository, relativePath),
    serializeKnowledgeDocument(
      relativePath,
      {
        category: input.category ?? "test",
        created_at: NOW,
        id,
        repo_id: input.repoId ?? REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: ["src/**"],
        severity: input.severity ?? "should",
        status: input.status ?? "active",
        updated_at: NOW,
      },
      "Stats service detail.\n",
    ),
  );
  return id;
}

function evidence(input: EvidenceInput): KnowledgeEvidence {
  const actor = {
    actor_kind: "user" as const,
    comment_id: `comment-${input.evidenceId}`,
    login: "alice",
    provider: input.source,
    trust: "trusted" as const,
  };
  return {
    actors: [actor],
    comment_ids: [actor.comment_id],
    content_fingerprint: HASH_A,
    eligible_for_count: input.eligibleForCount ?? true,
    evidence_id: input.evidenceId,
    knowledge_id: input.knowledgeId,
    observed_at: input.observedAt,
    occurrence_key: `${input.knowledgeId}:${input.threadId}`,
    originator: actor,
    pr_number: 1,
    repo_id: input.repoId ?? REPO_ID,
    sources: [input.source],
    state_fingerprint: HASH_B,
    status: input.status,
    thread_id: input.threadId,
  };
}

function outcome(
  knowledgeId: string,
  value: KnowledgeOutcome["outcome"],
  at: string,
): KnowledgeOutcome {
  return {
    at,
    knowledge_id: knowledgeId,
    outcome: value,
    repo_id: REPO_ID,
  };
}

function job(input: JobInput): DistillJob {
  const jobId = createDomainId("job");
  const needsLease =
    input.state === "processing" || input.state === "awaiting_finalize";
  return {
    attempts: input.state === "pending" ? 0 : 1,
    distillation_key: HASH_A,
    job_id: jobId,
    ...(input.state === "failed" ? { last_error: "distillation failed" } : {}),
    ...(needsLease
      ? {
          lease_expires_at: "2026-08-06T01:00:00.000Z",
          lease_token_hash: HASH_B,
        }
      : {}),
    lease_generation: needsLease ? 1 : 0,
    repo_id: input.repoId ?? REPO_ID,
    ...(input.state === "skipped" ? { skip_reason: "typo" as const } : {}),
    state: input.state,
    thread_id: `thread-${jobId}`,
    updated_at: NOW,
    validation_failures: 0,
  };
}

async function writeRecords(
  repository: string,
  records: readonly CanonicalJsonlRecord[],
): Promise<void> {
  await mkdir(join(repository, "events"), { recursive: true });
  await writeFile(
    join(repository, "events", "stats-service.jsonl"),
    Buffer.concat(
      records.map((record) => serializeCanonicalJsonlRecord(record)),
    ),
  );
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    recorded_at: NOW,
    record_id: createDomainId("event"),
    record_type: recordType,
    schema_version: 1,
    transaction_id: createDomainId("transaction"),
  };
}

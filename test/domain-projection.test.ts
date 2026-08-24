import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DomainProjectionError,
  PROJECTION_SCHEMA_VERSION,
  SqliteCanonicalProjection,
  createDomainId,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type CommentObservation,
  type DistillJob,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeRevisionProposal,
  type PullRequestObservation,
  type PullRequestSnapshot,
  type SubmissionReceipt,
  type ThreadObservation,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const LATER = "2026-08-06T00:01:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("domain SQLite projection", () => {
  it("projects every domain entity and applies deterministic observation LWW", async () => {
    const repository = await createRepository();
    const ids = await seedCompleteDomainState(repository);
    const projection = new SqliteCanonicalProjection(repository);

    const snapshot = await projection.rebuild();

    expect(snapshot.domain.pullRequests).toHaveLength(1);
    expect(snapshot.domain.pullRequestSnapshots).toHaveLength(1);
    expect(snapshot.domain.threads).toHaveLength(1);
    expect(snapshot.domain.comments).toEqual([
      expect.objectContaining({ body: "new body", comment_id: ids.commentId }),
    ]);
    expect(snapshot.domain.distillJobs).toEqual([
      expect.objectContaining({ job_id: ids.jobId, state: "pending" }),
    ]);
    expect(snapshot.domain.evidence).toEqual([
      expect.objectContaining({ evidence_id: ids.evidenceId }),
    ]);
    expect(snapshot.domain.revisionProposals).toEqual([
      expect.objectContaining({ proposal_id: "proposal-1" }),
    ]);
    expect(snapshot.domain.submissionReceipts).toEqual([
      expect.objectContaining({ receipt_id: ids.receiptId }),
    ]);
    expect(snapshot.domain.knowledge).toEqual([
      expect.objectContaining({
        appliedCount: 1,
        evidenceCount: 1,
        falsePositiveCount: 1,
        id: ids.knowledgeId,
        notApplicableCount: 1,
        sources: ["human"],
        violationCount: 1,
      }),
    ]);

    const database = new Database(projection.databasePath, { readonly: true });
    try {
      const names = (
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "distill_jobs",
          "evidence",
          "knowledge",
          "knowledge_fts",
          "outcomes",
          "pull_request_snapshots",
          "pull_requests",
          "review_comments",
          "review_threads",
          "revision_proposals",
          "submission_receipts",
          "thread_removals",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("rebuilds deterministic snapshots, search results, counts, FTS rows, and metadata", async () => {
    const repository = await createRepository();
    const ids = await seedCompleteDomainState(repository);
    const projection = new SqliteCanonicalProjection(repository);
    const checkpoint = createDomainId("transaction");

    const firstSnapshot = await projection.rebuild(checkpoint);
    const firstSearch = await projection.searchKnowledge({
      query: "regression test",
      repoId: "repo-1",
    });
    const firstState = readProjectionVerificationState(projection.databasePath);

    const secondSnapshot = await projection.rebuild(checkpoint);
    const secondSearch = await projection.searchKnowledge({
      query: "regression test",
      repoId: "repo-1",
    });
    const secondState = readProjectionVerificationState(
      projection.databasePath,
    );

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(secondSearch).toEqual(firstSearch);
    expect(secondState).toEqual(firstState);
    expect(secondSearch.hits.map((hit) => hit.id)).toEqual([ids.knowledgeId]);
    expect(secondSnapshot.domain.knowledge).toEqual([
      expect.objectContaining({
        appliedCount: 1,
        evidenceCount: 1,
        falsePositiveCount: 1,
        notApplicableCount: 1,
        violationCount: 1,
      }),
    ]);
    expect(secondState.metadata).toEqual(
      expect.arrayContaining([
        { key: "canonical_digest", value: secondSnapshot.canonicalDigest },
        { key: "index_dirty", value: "false" },
        { key: "last_committed_transaction_id", value: checkpoint },
        { key: "schema_version", value: PROJECTION_SCHEMA_VERSION },
      ]),
    );
  });

  it("rolls back every rebuild phase when metadata finalization fails", async () => {
    const repository = await createRepository();
    await seedCompleteDomainState(repository);
    const projection = new SqliteCanonicalProjection(repository);
    const previousCheckpoint = createDomainId("transaction");
    await projection.rebuild(previousCheckpoint);
    const before = readProjectionVerificationState(projection.databasePath);

    const addedKnowledgeId = createDomainId("knowledge");
    await writeKnowledge(repository, addedKnowledgeId, "repo-1");
    const database = new Database(projection.databasePath);
    try {
      database.exec(`
        CREATE TRIGGER inject_projection_metadata_failure
        BEFORE UPDATE OF value ON projection_meta
        WHEN OLD.key = 'canonical_digest'
        BEGIN
          SELECT RAISE(ABORT, 'injected projection metadata failure');
        END;
      `);
    } finally {
      database.close();
    }

    const nextCheckpoint = createDomainId("transaction");
    await expect(projection.rebuild(nextCheckpoint)).rejects.toThrow(
      "injected projection metadata failure",
    );

    expect(readProjectionVerificationState(projection.databasePath)).toEqual(
      before,
    );

    const cleanup = new Database(projection.databasePath);
    try {
      cleanup.exec("DROP TRIGGER inject_projection_metadata_failure");
    } finally {
      cleanup.close();
    }
    const rebuilt = await projection.rebuild(nextCheckpoint);
    expect(rebuilt.checkpointTransactionId).toBe(nextCheckpoint);
    expect(rebuilt.domain.knowledge.map((value) => value.id)).toContain(
      addedKnowledgeId,
    );
  });

  it("drops and rebuilds derived tables left by an older schema version", async () => {
    const repository = await createRepository();
    await seedCompleteDomainState(repository);
    const projection = new SqliteCanonicalProjection(repository);
    const before = await projection.rebuild();

    const database = new Database(projection.databasePath);
    try {
      database.exec("ALTER TABLE knowledge DROP COLUMN not_applicable_count");
      database
        .prepare("UPDATE projection_meta SET value = '2' WHERE key = ?")
        .run("schema_version");
    } finally {
      database.close();
    }

    const after = await projection.ensureCurrent();

    expect(after.domain.knowledge).toEqual(before.domain.knowledge);
    const reopened = new Database(projection.databasePath, { readonly: true });
    try {
      expect(
        reopened
          .prepare("SELECT value FROM projection_meta WHERE key = ?")
          .get("schema_version"),
      ).toEqual({ value: PROJECTION_SCHEMA_VERSION });
    } finally {
      reopened.close();
    }
  });

  it("fails closed on a malformed recognized domain record", async () => {
    const repository = await createRepository();
    await writeRecords(repository, [
      canonicalRecord("PullRequestObservation", { repo_id: "repo-only" }),
    ]);

    await expect(
      new SqliteCanonicalProjection(repository).rebuild(),
    ).rejects.toBeInstanceOf(DomainProjectionError);
  });

  it("enforces one active evidence per knowledge and thread", async () => {
    const repository = await createRepository();
    const knowledgeId = createDomainId("knowledge");
    await writeKnowledge(repository, knowledgeId, "repo-1");
    const first = evidence(knowledgeId, createDomainId("evidence"), "thread-1");
    const second = evidence(
      knowledgeId,
      createDomainId("evidence"),
      "thread-1",
    );
    await writeRecords(repository, [
      canonicalRecord("EvidenceCreated", first),
      canonicalRecord("EvidenceCreated", second),
    ]);

    const projection = new SqliteCanonicalProjection(repository);
    await expect(projection.rebuild()).rejects.toThrow(
      /UNIQUE constraint failed/u,
    );

    const database = new Database(projection.databasePath, { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_meta'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});

async function seedCompleteDomainState(repository: string): Promise<{
  commentId: string;
  evidenceId: string;
  jobId: string;
  knowledgeId: string;
  receiptId: string;
}> {
  const knowledgeId = createDomainId("knowledge");
  const evidenceId = createDomainId("evidence");
  const jobId = createDomainId("job");
  const receiptId = createDomainId("receipt");
  const snapshotId = createDomainId("snapshot");
  const commentId = "C_comment_1";
  await writeKnowledge(repository, knowledgeId, "repo-1");

  const pullRequest: PullRequestObservation = {
    base_ref_oid: "base-oid",
    head_ref_oid: "head-oid",
    merged_at: NOW,
    name_with_owner: "owner/repository",
    observation_id: createDomainId("observation"),
    observation_type: "pull_request",
    observed_at: NOW,
    pr_number: 7,
    pull_request_id: "PR_node_7",
    repo_id: "repo-1",
    snapshot_id: snapshotId,
    title: "Projection test",
  };
  const snapshot: PullRequestSnapshot = {
    complete: true,
    observed_at: NOW,
    pr_number: 7,
    repo_id: "repo-1",
    review_summary_ids: [],
    snapshot_id: snapshotId,
    thread_ids: ["thread-1"],
  };
  const thread: ThreadObservation = {
    comment_ids: [commentId],
    content_fingerprint: HASH_A,
    is_outdated: false,
    is_resolved: true,
    observation_id: createDomainId("observation"),
    observation_type: "thread",
    observed_at: NOW,
    path: "src/index.ts",
    pr_number: 7,
    repo_id: "repo-1",
    snapshot_id: snapshotId,
    state_fingerprint: HASH_B,
    thread_id: "thread-1",
  };
  const commentBase: Omit<CommentObservation, "body" | "observation_id"> = {
    actor: {
      actor_kind: "user",
      login: "alice",
      provider: "human",
      trust: "trusted",
    },
    comment_id: commentId,
    created_at: NOW,
    observation_type: "comment",
    observed_at: NOW,
    snapshot_id: snapshotId,
    thread_id: "thread-1",
    updated_at: NOW,
    url: "https://github.com/owner/repository/pull/7#discussion_r1",
  };
  const job: DistillJob = {
    attempts: 0,
    distillation_key: HASH_A,
    job_id: jobId,
    lease_generation: 0,
    repo_id: "repo-1",
    state: "pending",
    thread_id: "thread-1",
    updated_at: NOW,
    validation_failures: 0,
  };
  const projectedEvidence = evidence(knowledgeId, evidenceId, "thread-1");
  const proposal: KnowledgeRevisionProposal = {
    created_at: NOW,
    evidence_ids: [evidenceId],
    knowledge_id: knowledgeId,
    patch: { rule: "Prefer the revised rule" },
    proposal_id: "proposal-1",
    repo_id: "repo-1",
    status: "pending",
    updated_at: NOW,
  };
  const receipt: SubmissionReceipt = {
    committed_at: NOW,
    job_id: jobId,
    phase: "extract",
    receipt_id: receiptId,
    request_sha256: HASH_A,
    stable_response: {
      skip_reason: "typo",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    },
    submission_id: "submission-1",
  };
  const outcomes: readonly KnowledgeOutcome[] = (
    ["violated", "applied", "not_applicable", "false_positive"] as const
  ).map((outcome) => ({
    at: NOW,
    knowledge_id: knowledgeId,
    outcome,
    repo_id: "repo-1",
  }));

  await writeRecords(repository, [
    canonicalRecord("PullRequestObservation", pullRequest),
    canonicalRecord("PullRequestSnapshot", snapshot),
    canonicalRecord("ThreadObservation", thread),
    canonicalRecord(
      "CommentObservation",
      {
        ...commentBase,
        body: "new body",
        observation_id: createDomainId("observation"),
      },
      LATER,
    ),
    canonicalRecord(
      "CommentObservation",
      {
        ...commentBase,
        body: "old body",
        observation_id: createDomainId("observation"),
      },
      NOW,
    ),
    canonicalRecord("DistillationJobCreated", {
      distillation_key: job.distillation_key,
      job_id: job.job_id,
      repo_id: job.repo_id,
      thread_id: job.thread_id,
    }),
    canonicalRecord("EvidenceCreated", projectedEvidence),
    canonicalRecord("KnowledgeRevisionProposal", proposal),
    canonicalRecord("SubmissionReceipt", receipt),
    ...outcomes.map((outcome) => canonicalRecord("OutcomeRecorded", outcome)),
  ]);
  return { commentId, evidenceId, jobId, knowledgeId, receiptId };
}

function evidence(
  knowledgeId: string,
  evidenceId: string,
  threadId: string,
): KnowledgeEvidence {
  const actor = {
    actor_kind: "user" as const,
    comment_id: `comment-${evidenceId}`,
    login: "alice",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  return {
    actors: [actor],
    comment_ids: [actor.comment_id],
    content_fingerprint: HASH_A,
    eligible_for_count: true,
    evidence_id: evidenceId,
    knowledge_id: knowledgeId,
    observed_at: NOW,
    occurrence_key: `${knowledgeId}:${threadId}`,
    originator: actor,
    pr_number: 7,
    repo_id: "repo-1",
    sources: ["human"],
    state_fingerprint: HASH_B,
    status: "active",
    thread_id: threadId,
  };
}

function readProjectionVerificationState(databasePath: string): {
  readonly counts: Readonly<Record<string, number>>;
  readonly fileState: readonly unknown[];
  readonly fts: readonly unknown[];
  readonly metadata: readonly { key: string; value: string }[];
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = [
      "canonical_records",
      "distill_jobs",
      "evidence",
      "knowledge",
      "knowledge_documents",
      "knowledge_file_state",
      "knowledge_fts",
      "outcomes",
      "pull_request_snapshots",
      "pull_requests",
      "review_comments",
      "review_threads",
      "revision_proposals",
      "submission_receipts",
      "thread_removals",
    ] as const;
    return {
      counts: Object.fromEntries(
        tables.map((table) => {
          const row = database
            .prepare(`SELECT count(*) AS count FROM ${table}`)
            .get() as { count: number };
          return [table, row.count];
        }),
      ),
      fileState: database
        .prepare(
          `SELECT path, knowledge_id, byte_sha256, size, mtime_ns
           FROM knowledge_file_state ORDER BY path`,
        )
        .all(),
      fts: database
        .prepare(
          `SELECT knowledge_id, rule, detail
           FROM knowledge_fts ORDER BY knowledge_id`,
        )
        .all(),
      metadata: database
        .prepare("SELECT key, value FROM projection_meta ORDER BY key")
        .all() as Array<{ key: string; value: string }>,
    };
  } finally {
    database.close();
  }
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-domain-projection-"));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, "knowledge"), { recursive: true });
  return repository;
}

async function writeKnowledge(
  repository: string,
  knowledgeId: string,
  repoId: string,
): Promise<void> {
  await writeFile(
    join(repository, "knowledge", `${knowledgeId}.md`),
    serializeKnowledgeDocument(
      `knowledge/${knowledgeId}.md`,
      {
        category: "test",
        created_at: NOW,
        id: knowledgeId,
        repo_id: repoId,
        revision: 1,
        rule: "Always add a regression test",
        schema_version: 1,
        scope: ["test/**"],
        severity: "must",
        status: "active",
        updated_at: NOW,
      },
      "Explain the regression in the test name.\n",
    ),
  );
}

async function writeRecords(
  repository: string,
  records: readonly CanonicalJsonlRecord[],
): Promise<void> {
  await mkdir(join(repository, "events"), { recursive: true });
  await writeFile(
    join(repository, "events", "domain.jsonl"),
    Buffer.concat(
      records.map((record) => serializeCanonicalJsonlRecord(record)),
    ),
  );
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  recordedAt = NOW,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    recorded_at: recordedAt,
    record_id: createDomainId("event"),
    record_type: recordType,
    schema_version: 1,
    transaction_id: createDomainId("transaction"),
  };
}

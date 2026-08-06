import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeSearchError,
  SqliteCanonicalProjection,
  computeKnowledgeSearchScore,
  createDomainId,
  evidenceBoost,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  violationBoost,
  type CanonicalJsonlRecord,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeStatus,
  type Severity,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const LOW_RANKING_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HIGH_RANKING_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("knowledge search query handling", () => {
  it("uses literal FTS, NFKC, and a two-code-point LIKE fallback", async () => {
    const repository = await createRepository();
    const syntaxId = await writeKnowledge(repository, {
      rule: 'Parser handles OR - "quoted" (group): safely',
    });
    const japaneseId = await writeKnowledge(repository, {
      rule: "例外処理を統一する",
    });
    const nfkcId = await writeKnowledge(repository, {
      rule: "ＡＰＩ規約を守る",
    });
    const projection = new SqliteCanonicalProjection(repository);

    const syntax = await projection.searchKnowledge({
      query: 'Parser handles OR - "quoted" (group): safely',
      repoId: "repo-a",
    });
    const operatorWord = await projection.searchKnowledge({
      query: "OR",
      repoId: "repo-a",
    });
    const japanese = await projection.searchKnowledge({
      query: "例外",
      repoId: "repo-a",
    });
    const nfkc = await projection.searchKnowledge({
      query: "API",
      repoId: "repo-a",
    });

    expect(syntax.hits.map((hit) => hit.id)).toContain(syntaxId);
    expect(operatorWord).toMatchObject({
      hits: [expect.objectContaining({ id: syntaxId })],
      mode: "like",
    });
    expect(japanese).toMatchObject({
      hits: [expect.objectContaining({ id: japaneseId })],
      mode: "like",
    });
    expect(nfkc.hits.map((hit) => hit.id)).toContain(nfkcId);
  });

  it("escapes percent and underscore in LIKE patterns", async () => {
    const repository = await createRepository();
    const percentId = await writeKnowledge(repository, {
      rule: "Use a% literal",
    });
    await writeKnowledge(repository, { rule: "Use ax literal" });
    const underscoreId = await writeKnowledge(repository, {
      rule: "Use b_ literal",
    });
    await writeKnowledge(repository, { rule: "Use bx literal" });
    const projection = new SqliteCanonicalProjection(repository);

    const percent = await projection.searchKnowledge({
      query: "a%",
      repoId: "repo-a",
    });
    const underscore = await projection.searchKnowledge({
      query: "b_",
      repoId: "repo-a",
    });

    expect(percent.hits.map((hit) => hit.id)).toEqual([percentId]);
    expect(underscore.hits.map((hit) => hit.id)).toEqual([underscoreId]);
  });

  it.each(["", "   ", "-", "()::", "_", "%"])(
    "rejects empty or symbol-only query %j",
    async (query) => {
      const repository = await createRepository();
      const projection = new SqliteCanonicalProjection(repository);

      await expect(
        projection.searchKnowledge({ query, repoId: "repo-a" }),
      ).rejects.toBeInstanceOf(KnowledgeSearchError);
    },
  );
});

describe("knowledge search filtering and ranking", () => {
  it("applies repo, status, and category filters before candidate LIMIT", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      category: "security",
      repoId: "repo-other",
      rule: "shared needle",
    });
    await writeKnowledge(repository, {
      category: "security",
      rule: "shared needle",
      status: "proposed",
    });
    await writeKnowledge(repository, {
      category: "test",
      rule: "shared needle",
    });
    const expectedId = await writeKnowledge(repository, {
      category: "security",
      rule: "shared needle",
    });
    const projection = new SqliteCanonicalProjection(repository);

    const result = await projection.searchKnowledge({
      candidateLimit: 1,
      category: "security",
      query: "shared needle",
      repoId: "repo-a",
      statuses: ["active"],
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        category: "security",
        id: expectedId,
        repoId: "repo-a",
        status: "active",
      }),
    ]);
  });

  it("caps evidence and violation boosts", () => {
    expect(evidenceBoost(10_000)).toBe(0.3);
    expect(violationBoost(10_000)).toBe(0.15);
    expect(computeKnowledgeSearchScore(0, "consider", 0, 0)).toBe(1);
    expect(computeKnowledgeSearchScore(1, "must", 10_000, 10_000)).toBeCloseTo(
      1.35,
    );
  });

  it("reranks FTS candidates with bounded domain boosts", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      id: LOW_RANKING_KNOWLEDGE_ID,
      rule: "shared ranking phrase",
      severity: "consider",
    });
    await writeKnowledge(repository, {
      id: HIGH_RANKING_KNOWLEDGE_ID,
      rule: "shared ranking phrase",
      severity: "must",
    });
    const records: CanonicalJsonlRecord[] = [];
    for (let index = 0; index < 8; index += 1) {
      records.push(
        canonicalRecord(
          "EvidenceCreated",
          evidence(
            HIGH_RANKING_KNOWLEDGE_ID,
            createDomainId("evidence"),
            `ranking-thread-${index}`,
          ),
        ),
      );
    }
    for (let index = 0; index < 25; index += 1) {
      records.push(
        canonicalRecord("OutcomeRecorded", {
          at: NOW,
          knowledge_id: HIGH_RANKING_KNOWLEDGE_ID,
          outcome: "violated",
          repo_id: "repo-a",
        } satisfies KnowledgeOutcome),
      );
    }
    await writeRecords(repository, records);

    const result = await new SqliteCanonicalProjection(
      repository,
    ).searchKnowledge({ query: "shared ranking phrase", repoId: "repo-a" });

    expect(result.hits.map((hit) => hit.id)).toEqual([
      HIGH_RANKING_KNOWLEDGE_ID,
      LOW_RANKING_KNOWLEDGE_ID,
    ]);
    expect(result.hits[0]!.textRank).toBe(1);
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
  });

  it("derives bounded counters from canonical evidence and outcomes", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      rule: "bounded ranking signal",
      severity: "must",
    });
    const records: CanonicalJsonlRecord[] = [];
    for (let index = 0; index < 8; index += 1) {
      records.push(
        canonicalRecord(
          "EvidenceCreated",
          evidence(knowledgeId, createDomainId("evidence"), `thread-${index}`),
        ),
      );
    }
    for (let index = 0; index < 25; index += 1) {
      const outcome: KnowledgeOutcome = {
        at: NOW,
        knowledge_id: knowledgeId,
        outcome: "violated",
        repo_id: "repo-a",
      };
      records.push(canonicalRecord("OutcomeRecorded", outcome));
    }
    await writeRecords(repository, records);
    const projection = new SqliteCanonicalProjection(repository);

    const result = await projection.searchKnowledge({
      query: "bounded ranking",
      repoId: "repo-a",
    });

    expect(result.hits[0]).toMatchObject({
      evidenceCount: 8,
      id: knowledgeId,
      violationCount: 25,
    });
    expect(evidenceBoost(result.hits[0]!.evidenceCount)).toBe(0.3);
    expect(violationBoost(result.hits[0]!.violationCount)).toBe(0.15);
  });
});

describe("knowledge FTS rebuild", () => {
  it("removes the old FTS row before inserting an updated document", async () => {
    const repository = await createRepository();
    const knowledgeId = createDomainId("knowledge");
    await writeKnowledge(repository, {
      id: knowledgeId,
      rule: "legacy search phrase",
    });
    const projection = new SqliteCanonicalProjection(repository);
    expect(
      (
        await projection.searchKnowledge({
          query: "legacy search",
          repoId: "repo-a",
        })
      ).hits,
    ).toHaveLength(1);

    await writeKnowledge(repository, {
      id: knowledgeId,
      rule: "replacement search phrase",
    });

    expect(
      (
        await projection.searchKnowledge({
          query: "legacy search",
          repoId: "repo-a",
        })
      ).hits,
    ).toHaveLength(0);
    expect(
      (
        await projection.searchKnowledge({
          query: "replacement search",
          repoId: "repo-a",
        })
      ).hits.map((hit) => hit.id),
    ).toEqual([knowledgeId]);

    const database = new Database(projection.databasePath, { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT count(*) AS count FROM knowledge_fts WHERE knowledge_id = ?",
          )
          .get(knowledgeId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("rebuilds identical results after index deletion without changing canonical bytes", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      rule: "rebuild deterministic projection",
    });
    await writeRecords(repository, [
      canonicalRecord(
        "EvidenceCreated",
        evidence(knowledgeId, createDomainId("evidence"), "thread-rebuild"),
      ),
    ]);
    const projection = new SqliteCanonicalProjection(repository);
    const before = await projection.searchKnowledge({
      query: "deterministic projection",
      repoId: "repo-a",
    });
    const canonicalBefore = await canonicalHashes(repository, knowledgeId);

    await Promise.all(
      ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"].map(
        async (name) => rm(join(repository, name), { force: true }),
      ),
    );
    await projection.rebuild();
    const after = await projection.searchKnowledge({
      query: "deterministic projection",
      repoId: "repo-a",
    });

    expect(after).toEqual(before);
    expect(await canonicalHashes(repository, knowledgeId)).toEqual(
      canonicalBefore,
    );
  });
});

interface KnowledgeInput {
  readonly category?: KnowledgeCategory;
  readonly detail?: string;
  readonly id?: string;
  readonly repoId?: string;
  readonly rule: string;
  readonly severity?: Severity;
  readonly status?: KnowledgeStatus;
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-knowledge-search-"));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, "knowledge"), { recursive: true });
  return repository;
}

async function writeKnowledge(
  repository: string,
  input: KnowledgeInput,
): Promise<string> {
  const id = input.id ?? createDomainId("knowledge");
  const relativePath = `knowledge/${id}.md`;
  await writeFile(
    join(repository, relativePath),
    serializeKnowledgeDocument(
      relativePath,
      {
        category: input.category ?? "test",
        created_at: NOW,
        id,
        repo_id: input.repoId ?? "repo-a",
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: ["**/*"],
        severity: input.severity ?? "should",
        status: input.status ?? "active",
        updated_at: NOW,
      },
      input.detail ?? "Searchable detail.\n",
    ),
  );
  return id;
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
    pr_number: 1,
    repo_id: "repo-a",
    sources: ["human"],
    state_fingerprint: HASH_B,
    status: "active",
    thread_id: threadId,
  };
}

async function writeRecords(
  repository: string,
  records: readonly CanonicalJsonlRecord[],
): Promise<void> {
  await mkdir(join(repository, "events"), { recursive: true });
  await writeFile(
    join(repository, "events", "search.jsonl"),
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

async function canonicalHashes(
  repository: string,
  knowledgeId: string,
): Promise<Record<string, string>> {
  const paths = [`knowledge/${knowledgeId}.md`, "events/search.jsonl"];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(repository, path)))
          .digest("hex"),
      ]),
    ),
  );
}

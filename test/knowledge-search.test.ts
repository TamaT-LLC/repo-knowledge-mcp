import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeSearchError,
  MAX_OUTCOME_SCORE,
  MIN_OUTCOME_SCORE,
  OUTCOME_RANKING_POLICY,
  SqliteCanonicalProjection,
  appliedBoost,
  computeKnowledgeSearchScore,
  createDomainId,
  evidenceBoost,
  falsePositivePenalty,
  notApplicablePenalty,
  outcomeScore,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  violationBoost,
  type CanonicalJsonlRecord,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeOutcomeCounts,
  type KnowledgeStatus,
  type Severity,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const LOW_RANKING_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HIGH_RANKING_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TOP_TEXT_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const FALSE_POSITIVE_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const APPLIED_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const ZERO_OUTCOMES: KnowledgeOutcomeCounts = {
  appliedCount: 0,
  falsePositiveCount: 0,
  notApplicableCount: 0,
  violationCount: 0,
};
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
    expect(computeKnowledgeSearchScore(0, "consider", 0, ZERO_OUTCOMES)).toBe(
      1,
    );
    expect(
      computeKnowledgeSearchScore(1, "must", 10_000, {
        ...ZERO_OUTCOMES,
        violationCount: 10_000,
      }),
    ).toBeCloseTo(1.35);
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

describe("M2 outcome ranking policy", () => {
  it("keeps zero-outcome scores identical to the M1 formula", () => {
    expect(outcomeScore(ZERO_OUTCOMES)).toBe(0);
    expect(computeKnowledgeSearchScore(1, "must", 4, ZERO_OUTCOMES)).toBe(
      1 / 2 + 0.4 + evidenceBoost(4),
    );
  });

  it("disables the applied boost below the minimum sample", () => {
    const belowSample = OUTCOME_RANKING_POLICY.minAppliedSample - 1;
    expect(appliedBoost(belowSample)).toBe(0);
    expect(appliedBoost(OUTCOME_RANKING_POLICY.minAppliedSample)).toBeCloseTo(
      OUTCOME_RANKING_POLICY.appliedBoostWeight *
        Math.log1p(OUTCOME_RANKING_POLICY.minAppliedSample),
    );
  });

  it("caps every outcome term for arbitrarily large event floods", () => {
    expect(appliedBoost(1_000_000)).toBe(
      OUTCOME_RANKING_POLICY.appliedBoostCap,
    );
    expect(notApplicablePenalty(1_000_000)).toBe(
      OUTCOME_RANKING_POLICY.notApplicablePenaltyCap,
    );
    expect(falsePositivePenalty(1_000_000)).toBe(
      OUTCOME_RANKING_POLICY.falsePositivePenaltyCap,
    );
    expect(
      outcomeScore({
        appliedCount: 1_000_000,
        falsePositiveCount: 0,
        notApplicableCount: 0,
        violationCount: 0,
      }),
    ).toBe(MAX_OUTCOME_SCORE);
    expect(
      outcomeScore({
        appliedCount: 0,
        falsePositiveCount: 1_000_000,
        notApplicableCount: 1_000_000,
        violationCount: 0,
      }),
    ).toBe(MIN_OUTCOME_SCORE);
  });

  it("never lets not_applicable or false_positive raise a score", () => {
    for (const counts of [
      { ...ZERO_OUTCOMES, falsePositiveCount: 1 },
      { ...ZERO_OUTCOMES, notApplicableCount: 1 },
      { ...ZERO_OUTCOMES, falsePositiveCount: 50, notApplicableCount: 50 },
    ]) {
      expect(outcomeScore(counts)).toBeLessThan(0);
    }
  });

  it("accepts the legacy numeric form as the M1 violation count", () => {
    expect(computeKnowledgeSearchScore(0, "consider", 0, 0)).toBe(1);
    expect(computeKnowledgeSearchScore(1, "must", 10_000, 10_000)).toBe(
      computeKnowledgeSearchScore(1, "must", 10_000, {
        ...ZERO_OUTCOMES,
        violationCount: 10_000,
      }),
    );
    expect(computeKnowledgeSearchScore(2, "should", 3, 5)).toBe(
      1 / 3 + 0.2 + evidenceBoost(3) + violationBoost(5),
    );
  });

  it("publishes a frozen machine-trackable policy version", () => {
    expect(OUTCOME_RANKING_POLICY.version).toBe("m2-outcome-v1");
    expect(Object.isFrozen(OUTCOME_RANKING_POLICY)).toBe(true);
  });

  it("reranks mixed outcomes deterministically within the bounded signal", async () => {
    const repository = await createRepository();
    for (const id of [
      TOP_TEXT_KNOWLEDGE_ID,
      FALSE_POSITIVE_KNOWLEDGE_ID,
      APPLIED_KNOWLEDGE_ID,
    ]) {
      await writeKnowledge(repository, {
        id,
        rule: "outcome ranking phrase",
        severity: "should",
      });
    }
    await writeRecords(repository, [
      ...outcomeRecords(FALSE_POSITIVE_KNOWLEDGE_ID, "false_positive", 12),
      ...outcomeRecords(APPLIED_KNOWLEDGE_ID, "applied", 8),
      ...outcomeRecords(APPLIED_KNOWLEDGE_ID, "violated", 2),
      ...outcomeRecords(FALSE_POSITIVE_KNOWLEDGE_ID, "violated", 2),
    ]);
    const projection = new SqliteCanonicalProjection(repository);

    const first = await projection.searchKnowledge({
      query: "outcome ranking phrase",
      repoId: "repo-a",
    });
    const second = await projection.searchKnowledge({
      query: "outcome ranking phrase",
      repoId: "repo-a",
    });
    await projection.rebuild();
    const rebuilt = await projection.searchKnowledge({
      query: "outcome ranking phrase",
      repoId: "repo-a",
    });

    expect(first.hits.map((hit) => hit.id)).toEqual([
      TOP_TEXT_KNOWLEDGE_ID,
      APPLIED_KNOWLEDGE_ID,
      FALSE_POSITIVE_KNOWLEDGE_ID,
    ]);
    expect(first.hits[1]).toMatchObject({
      appliedCount: 8,
      falsePositiveCount: 0,
      notApplicableCount: 0,
      violationCount: 2,
    });
    expect(first.hits[2]).toMatchObject({
      appliedCount: 0,
      falsePositiveCount: 12,
      violationCount: 2,
    });
    expect(second).toEqual(first);
    expect(rebuilt).toEqual(first);
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

function outcomeRecords(
  knowledgeId: string,
  outcome: KnowledgeOutcome["outcome"],
  count: number,
): CanonicalJsonlRecord[] {
  return Array.from({ length: count }, () =>
    canonicalRecord("OutcomeRecorded", {
      at: NOW,
      knowledge_id: knowledgeId,
      outcome,
      repo_id: "repo-a",
    } satisfies KnowledgeOutcome),
  );
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

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX,
  KnowledgeReadError,
  KnowledgeReadService,
  createDomainId,
  renderKnowledgeBodyWithCodeExample,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistillJob,
  type GeneratedCodeExample,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeStatus,
  type Severity,
  type SyncCheckpoint,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const REPO_ID = "R_repo_1";
const REPO_NAME = "owner/repository";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("KnowledgeReadService.getRules", () => {
  it("returns only global and matching active rules with normalized scope reasons", async () => {
    const repository = await createRepository();
    const globalId = await writeKnowledge(repository, {
      rule: "Global guidance",
      scope: [],
    });
    const matchingId = await writeKnowledge(repository, {
      rule: "TypeScript source guidance",
      scope: ["test/**", "src/**/*.ts"],
    });
    await writeKnowledge(repository, {
      rule: "Documentation guidance",
      scope: ["docs/**"],
    });
    await writeKnowledge(repository, {
      rule: "Case-sensitive non-match",
      scope: ["SRC/**"],
    });
    for (const status of [
      "proposed",
      "stale",
      "deprecated",
      "rejected",
    ] satisfies readonly KnowledgeStatus[]) {
      await writeKnowledge(repository, {
        rule: `Hidden ${status} guidance`,
        scope: ["src/**"],
        status,
      });
    }

    const result = await service(repository).getRules({
      filePaths: ["src\\api\\handler.ts"],
    });

    expect(result).toMatchObject({
      matched_count: 2,
      repo: REPO_NAME,
      truncated: false,
    });
    expect(result.rules.map((rule) => rule.id).sort()).toEqual(
      [globalId, matchingId].sort(),
    );
    expect(
      result.rules.find((rule) => rule.id === globalId)?.match_reasons,
    ).toEqual([{ type: "global" }]);
    expect(
      result.rules.find((rule) => rule.id === matchingId)?.match_reasons,
    ).toEqual([
      {
        file_path: "src/api/handler.ts",
        pattern: "src/**/*.ts",
        type: "scope",
      },
    ]);
  });

  it("does not return every scoped rule when file paths and task are absent", async () => {
    const repository = await createRepository();
    const globalId = await writeKnowledge(repository, {
      rule: "Global only",
      scope: [],
    });
    await writeKnowledge(repository, {
      rule: "Scoped only",
      scope: ["src/**"],
    });

    const result = await service(repository).getRules();

    expect(result.rules.map((rule) => rule.id)).toEqual([globalId]);
  });

  it("adds task matches without leaking proposed or path-mismatched rules", async () => {
    const repository = await createRepository();
    const globalId = await writeKnowledge(repository, {
      rule: "Global unrelated guidance",
      scope: [],
    });
    const taskId = await writeKnowledge(repository, {
      rule: "Retry failures with backoff",
      scope: ["backend/**"],
    });
    await writeKnowledge(repository, {
      rule: "Retry failures immediately",
      scope: ["backend/**"],
      status: "proposed",
    });
    const readService = service(repository);

    const taskOnly = await readService.getRules({ task: "retry failures" });
    const pathConstrained = await readService.getRules({
      filePaths: ["frontend/view.ts"],
      task: "retry failures",
    });

    expect(taskOnly.rules.map((rule) => rule.id).sort()).toEqual(
      [globalId, taskId].sort(),
    );
    expect(
      taskOnly.rules.find((rule) => rule.id === taskId)?.match_reasons,
    ).toEqual([expect.objectContaining({ type: "task" })]);
    expect(pathConstrained.rules.map((rule) => rule.id)).toEqual([globalId]);
  });

  it("keeps task reasons beyond the bounded search candidate window", async () => {
    const repository = await createRepository();
    for (let index = 0; index < 60; index += 1) {
      await writeKnowledge(repository, {
        rule: `Retry failure ${index}`,
        scope: ["src/**"],
        severity: "should",
      });
    }
    const mustId = await writeKnowledge(repository, {
      rule: `Retry failure ${"with additional context ".repeat(200)}`,
      scope: ["src/**"],
      severity: "must",
    });

    const result = await service(repository).getRules({
      filePaths: ["src/index.ts"],
      limit: 20,
      task: "retry failure",
    });

    expect(result).toMatchObject({ matched_count: 61, truncated: true });
    expect(
      result.rules.find((rule) => rule.id === mustId)?.match_reasons,
    ).toEqual([
      { file_path: "src/index.ts", pattern: "src/**", type: "scope" },
      expect.objectContaining({ type: "task" }),
    ]);
  });

  it("prioritizes must rules before applying limit and reports truncation", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      rule: "Consider this convention",
      scope: [],
      severity: "consider",
    });
    const mustId = await writeKnowledge(repository, {
      rule: "Mandatory convention",
      scope: [],
      severity: "must",
    });

    const result = await service(repository).getRules({ limit: 1 });

    expect(result).toMatchObject({ matched_count: 2, truncated: true });
    expect(result.rules).toEqual([
      expect.objectContaining({ id: mustId, severity: "must" }),
    ]);
  });

  it("reports setup_required for a repository without sync, jobs, or knowledge", async () => {
    const repository = await createRepository();

    const result = await service(repository).getRules({
      filePaths: ["src/index.ts"],
    });

    expect(result).toMatchObject({
      matched_count: 0,
      readiness: {
        next_action: expect.stringContaining(
          `repo-knowledge setup ${REPO_NAME}`,
        ),
        state: "setup_required",
      },
      rules: [],
      truncated: false,
    });
  });

  it("reports learning for pending jobs or proposed knowledge", async () => {
    const pendingRepository = await createRepository();
    await writeRecords(pendingRepository, [
      canonicalRecord("DistillJob", distillJob("pending")),
    ]);
    const proposedRepository = await createRepository();
    await writeKnowledge(proposedRepository, {
      rule: "Review this proposed guidance",
      status: "proposed",
    });

    const pending = await service(pendingRepository).getRules();
    const proposed = await service(proposedRepository).getRules();

    expect(pending.readiness).toMatchObject({
      next_action: expect.stringContaining(
        `repo-knowledge distill ${REPO_NAME}`,
      ),
      state: "learning",
    });
    expect(pending.readiness.next_action).toContain("llm.mode");
    expect(pending.readiness.next_action).toContain("hostAssistedDistillation");
    expect(proposed.readiness).toMatchObject({
      next_action: expect.stringContaining(
        `repo-knowledge list ${REPO_NAME} --status proposed`,
      ),
      state: "learning",
    });
  });

  it("reports ready for a normal mismatch when any active rule exists", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      rule: "Backend-only guidance",
      scope: ["backend/**"],
    });

    const result = await service(repository).getRules({
      filePaths: ["frontend/view.ts"],
      task: "render a frontend view",
    });

    expect(result).toMatchObject({
      matched_count: 0,
      readiness: {
        next_action: expect.stringContaining("no active rule matched"),
        state: "ready",
      },
      rules: [],
    });
  });

  it("reports empty after sync when no reusable candidate remains", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      rule: "Rejected guidance",
      status: "rejected",
    });

    const result = await service(repository, checkpoint()).getRules();

    expect(result).toMatchObject({
      matched_count: 0,
      readiness: {
        next_action: expect.stringContaining(
          `repo-knowledge sync ${REPO_NAME}`,
        ),
        state: "empty",
      },
      rules: [],
    });
  });

  it("fails closed for a foreign checkpoint instead of returning readiness", async () => {
    const repository = await createRepository();

    await expect(
      service(repository, checkpoint("R_other_repo")).getRules(),
    ).rejects.toMatchObject({
      code: "READINESS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
    });
  });

  it("does not hide a broken canonical projection behind a readiness state", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "knowledge", "broken.md"), "not markdown");

    await expect(service(repository).getRules()).rejects.toMatchObject({
      code: "KNOWLEDGE_STORE_INVALID",
    });
  });

  it.each(["/absolute.ts", "../escape.ts", "src/../escape.ts", "C:\\root.ts"])(
    "rejects non-repository-relative file path %j",
    async (filePath) => {
      const repository = await createRepository();

      await expect(
        service(repository).getRules({ filePaths: [filePath] }),
      ).rejects.toMatchObject({ code: "INVALID_FILE_PATH" });
    },
  );

  it("rejects negative scope patterns before matching", async () => {
    const repository = await createRepository();
    await writeKnowledge(repository, {
      rule: "Invalid negative scope",
      scope: ["!src/**"],
    });

    await expect(
      service(repository).getRules({ filePaths: ["src/index.ts"] }),
    ).rejects.toThrow(/negative scope patterns are not supported/u);
  });
});

describe("KnowledgeReadService.searchKnowledge", () => {
  it("returns ranked active results only and applies category filtering", async () => {
    const repository = await createRepository();
    const activeId = await writeKnowledge(repository, {
      category: "security",
      detail: "Detailed active explanation.\n",
      rule: "Validate searchable input",
    });
    await writeKnowledge(repository, {
      category: "security",
      rule: "Validate searchable input before approval",
      status: "proposed",
    });
    await writeKnowledge(repository, {
      category: "test",
      rule: "Validate searchable input in tests",
    });

    const result = await service(repository).searchKnowledge({
      category: "security",
      query: "searchable input",
    });

    expect(result).toMatchObject({ mode: "fts", repo: REPO_NAME });
    expect(result.results).toEqual([
      expect.objectContaining({
        category: "security",
        detail: "Detailed active explanation.\n",
        id: activeId,
      }),
    ]);
  });
});

describe("KnowledgeReadService.getKnowledge", () => {
  it("returns full frontmatter, exact-byte ETag, derived values, and stable evidence pages", async () => {
    const repository = await createRepository();
    const knowledgeId = await writeKnowledge(repository, {
      extraFrontmatter: { activation: { origin: "human", pinned: true } },
      detail: "Canonical detail body.\n",
      rule: "Paginate evidence deterministically",
    });
    const evidenceValues = [
      evidence({
        evidenceId: createDomainId("evidence"),
        knowledgeId,
        observedAt: "2026-08-06T03:00:00.000Z",
        source: "human",
        status: "active",
        threadId: "thread-3",
        url: "https://github.com/owner/repository/pull/1#discussion_r3",
      }),
      evidence({
        eligibleForCount: false,
        evidenceId: createDomainId("evidence"),
        knowledgeId,
        observedAt: "2026-08-06T02:00:00.000Z",
        source: "greptile",
        status: "superseded",
        threadId: "thread-2",
      }),
      evidence({
        eligibleForCount: false,
        evidenceId: createDomainId("evidence"),
        knowledgeId,
        observedAt: "2026-08-06T01:00:00.000Z",
        source: "human",
        status: "withdrawn",
        threadId: "thread-1",
      }),
    ];
    await writeRecords(repository, [
      ...evidenceValues.map((value) =>
        canonicalRecord("EvidenceCreated", value),
      ),
      canonicalRecord("OutcomeRecorded", outcome(knowledgeId, "applied")),
      canonicalRecord("OutcomeRecorded", outcome(knowledgeId, "violated")),
    ]);
    const readService = service(repository);

    const first = await readService.getKnowledge({
      evidenceLimit: 2,
      id: knowledgeId,
    });
    const second = await readService.getKnowledge({
      cursor: first.next_cursor!,
      evidenceLimit: 2,
      id: knowledgeId,
    });

    const markdown = await readFile(
      join(repository, "knowledge", `${knowledgeId}.md`),
    );
    expect(first.knowledge).toMatchObject({
      applied_count: 1,
      detail: "Canonical detail body.\n",
      etag: createHash("sha256").update(markdown).digest("hex"),
      evidence_count: 1,
      frontmatter: {
        activation: { origin: "human", pinned: true },
        id: knowledgeId,
      },
      revision: 1,
      sources: ["human"],
      violation_count: 1,
    });
    expect(first.evidence.map((item) => item.observed_at)).toEqual([
      "2026-08-06T03:00:00.000Z",
      "2026-08-06T02:00:00.000Z",
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(second.evidence.map((item) => item.observed_at)).toEqual([
      "2026-08-06T01:00:00.000Z",
    ]);
    expect(second.next_cursor).toBeNull();
    expect(
      new Set(
        [...first.evidence, ...second.evidence].map((item) => item.evidence_id),
      ).size,
    ).toBe(3);
  });

  it("binds cursors to one knowledge item and hides non-active knowledge", async () => {
    const repository = await createRepository();
    const firstId = await writeKnowledge(repository, {
      rule: "First active rule",
    });
    const secondId = await writeKnowledge(repository, {
      rule: "Second active rule",
    });
    const proposedId = await writeKnowledge(repository, {
      rule: "Proposed rule",
      status: "proposed",
    });
    await writeRecords(repository, [
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId: firstId,
          observedAt: NOW,
          source: "human",
          status: "active",
          threadId: "thread-cursor",
        }),
      ),
      canonicalRecord(
        "EvidenceCreated",
        evidence({
          evidenceId: createDomainId("evidence"),
          knowledgeId: firstId,
          observedAt: "2026-08-05T00:00:00.000Z",
          source: "human",
          status: "active",
          threadId: "thread-cursor-older",
        }),
      ),
    ]);
    const readService = service(repository);
    const firstPage = await readService.getKnowledge({
      evidenceLimit: 1,
      id: firstId,
    });

    await expect(
      readService.getKnowledge({
        cursor: firstPage.next_cursor!,
        id: secondId,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      readService.getKnowledge({ id: proposedId }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
    await expect(
      readService.getKnowledge({ cursor: "not+base64", id: firstId }),
    ).rejects.toBeInstanceOf(KnowledgeReadError);
  });

  it("returns the structured code example while get_rules stays example-free", async () => {
    const repository = await createRepository();
    const example: GeneratedCodeExample = {
      content: "const result = await invoke();\nnotifyFailure(result);",
      evidence_comment_ids: ["comment-example"],
      generated_example: true,
      language: "typescript",
    };
    const knowledgeId = await writeKnowledge(repository, {
      detail: renderKnowledgeBodyWithCodeExample(
        "Surface backend errors to the UI layer.",
        example,
      ),
      rule: "Report backend errors",
      scope: [],
    });
    const readService = service(repository);

    const detail = await readService.getKnowledge({ id: knowledgeId });
    expect(detail.knowledge.code_example).toEqual(example);
    expect(detail.knowledge.detail).toContain(
      KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX,
    );

    const search = await readService.searchKnowledge({
      query: "notifyFailure",
    });
    expect(search.results.map((item) => item.id)).toEqual([knowledgeId]);

    const rules = await service(repository).getRules();
    expect(rules.rules.map((rule) => rule.id)).toEqual([knowledgeId]);
    const serialized = JSON.stringify(rules);
    expect(rules.rules[0]).not.toHaveProperty("detail");
    expect(rules.rules[0]).not.toHaveProperty("code_example");
    expect(serialized).not.toContain("notifyFailure");
    expect(serialized).not.toContain("generated_example");
  });

  it("reads M1-era documents without migration and fails soft on hand edits", async () => {
    const repository = await createRepository();
    const legacyId = await writeKnowledge(repository, {
      detail:
        "## 背景\nM1 の本文構成のままの文書。\n## 適用条件\n`invoke` 呼び出し箇所。\n",
      extraFrontmatter: {
        applied_count: 0,
        distillation: { prompt_version: "distill-v1", provider: "anthropic" },
        evidence_count: 3,
        representative_evidence: [],
        sources: ["human"],
        violation_count: 0,
      },
      rule: "Legacy schema rule",
      scope: [],
    });
    const editedId = await writeKnowledge(repository, {
      detail: `Edited by hand.\n\n${KNOWLEDGE_CODE_EXAMPLE_MARKER_PREFIX}comment-1 -->\n\nThe fence was deleted manually.\n`,
      rule: "Hand-edited example section",
      scope: [],
    });
    const readService = service(repository);

    const legacy = await readService.getKnowledge({ id: legacyId });
    expect(legacy.knowledge.code_example).toBeNull();
    expect(legacy.knowledge.frontmatter).toMatchObject({
      evidence_count: 3,
      schema_version: 1,
    });

    const edited = await readService.getKnowledge({ id: editedId });
    expect(edited.knowledge.code_example).toBeNull();
    expect(edited.knowledge.detail).toContain(
      "The fence was deleted manually.",
    );
  });
});

interface KnowledgeInput {
  readonly category?: KnowledgeCategory;
  readonly detail?: string;
  readonly extraFrontmatter?: Readonly<Record<string, unknown>>;
  readonly rule: string;
  readonly scope?: readonly string[];
  readonly severity?: Severity;
  readonly status?: KnowledgeStatus;
}

interface EvidenceInput {
  readonly eligibleForCount?: boolean;
  readonly evidenceId: string;
  readonly knowledgeId: string;
  readonly observedAt: string;
  readonly source: "greptile" | "human";
  readonly status: KnowledgeEvidence["status"];
  readonly threadId: string;
  readonly url?: string;
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-read-service-"));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, "knowledge"), { recursive: true });
  return repository;
}

function service(
  repository: string,
  syncCheckpoint: SyncCheckpoint | null = null,
): KnowledgeReadService {
  return new KnowledgeReadService({
    repo: REPO_NAME,
    repoId: REPO_ID,
    repository: new CanonicalTransactionStore(repository),
    syncCheckpoints: { read: async () => syncCheckpoint },
  });
}

function checkpoint(repoId = REPO_ID): SyncCheckpoint {
  return {
    cursor: {
      last_pr_number: 7,
      last_updated_at: NOW,
      repo_id: repoId,
      version: 1,
    },
    schema_version: 1,
    updated_at: NOW,
  };
}

function distillJob(state: DistillJob["state"]): DistillJob {
  const jobId = createDomainId("job");
  return {
    attempts: 0,
    distillation_key: HASH_A,
    job_id: jobId,
    lease_generation: 0,
    repo_id: REPO_ID,
    state,
    thread_id: `thread-${jobId}`,
    updated_at: NOW,
    validation_failures: 0,
  };
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
        ...input.extraFrontmatter,
        category: input.category ?? "test",
        created_at: NOW,
        id,
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: input.scope ?? ["src/**"],
        severity: input.severity ?? "should",
        status: input.status ?? "active",
        updated_at: NOW,
      },
      input.detail ?? "Read service detail.\n",
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
    repo_id: REPO_ID,
    sources: [input.source],
    state_fingerprint: HASH_B,
    status: input.status,
    thread_id: input.threadId,
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

function outcome(
  knowledgeId: string,
  value: KnowledgeOutcome["outcome"],
): KnowledgeOutcome {
  return {
    at: NOW,
    knowledge_id: knowledgeId,
    outcome: value,
    repo_id: REPO_ID,
  };
}

async function writeRecords(
  repository: string,
  records: readonly CanonicalJsonlRecord[],
): Promise<void> {
  await mkdir(join(repository, "events"), { recursive: true });
  await writeFile(
    join(repository, "events", "read-service.jsonl"),
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

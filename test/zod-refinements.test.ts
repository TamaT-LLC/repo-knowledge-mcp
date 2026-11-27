import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { type z } from "zod";

import {
  AnonymizedThreadCorpusSchema,
  DistillJobSchema,
  GeneratedCodeExampleSchema,
  GoldenFixtureSchema,
  IngestPrOutputSchema,
  KnowledgeEvidenceSchema,
  KnowledgeRevisionPatchSchema,
  ObservedPilotDailyRecordSchema,
  OutcomeRankingFixtureSchema,
  PilotHumanRubricSchema,
  RecordOutcomeRequestSchema,
  RepositoryNameSchema,
  SubmitDistillationInputSchema,
  UpdateKnowledgeInputSchema,
  UtcDaySchema,
  createDomainId,
} from "../src/experimental.js";
import { repositoryRoot } from "./support/quality-gate-fixtures.js";

// Cross-field rules written as `.check()` callbacks. Each case starts from an
// input the schema accepts, breaks one rule, and expects exactly that custom
// issue, so a rule that stops firing or fires at a different path fails here.

type Json = Record<string, unknown>;

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

interface CustomIssueSummary {
  readonly message: string;
  readonly path: PropertyKey[];
}

function customIssues(schema: z.ZodType, input: unknown): CustomIssueSummary[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  const nonCustom = result.error.issues.filter(
    (issue) => issue.code !== "custom",
  );
  expect(nonCustom).toEqual([]);
  return result.error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path,
  }));
}

/** Reads a committed fixture, typed as the input of the schema it feeds. */
async function readJson<S extends z.ZodType>(
  _schema: S,
  ...segments: string[]
): Promise<z.input<S>> {
  return JSON.parse(
    await readFile(join(repositoryRoot, ...segments), "utf8"),
  ) as z.input<S>;
}

function readGoldenFixture<S extends z.ZodType>(
  schema: S,
  name: string,
): Promise<z.input<S>> {
  return readJson(schema, "test", "fixtures", "golden", name);
}

describe("GoldenFixtureSchema expected rules", () => {
  const load = () => readGoldenFixture(GoldenFixtureSchema, "m1-golden.json");

  it("accepts the committed fixture", async () => {
    const fixture = await load();
    expect(customIssues(GoldenFixtureSchema, fixture)).toEqual([]);
  });

  it("requires category and severity for knowledge cases", async () => {
    const fixture = await load();
    const index = fixture.cases.findIndex(
      (entry) => entry.expected.is_knowledge,
    );
    at(fixture.cases, index).expected.severity = null;
    expect(customIssues(GoldenFixtureSchema, fixture)).toEqual([
      {
        message: "knowledge fixtures require category and severity",
        path: ["cases", index, "expected"],
      },
    ]);
  });

  it("rejects merge groups on non-knowledge cases", async () => {
    const fixture = await load();
    const index = fixture.cases.findIndex(
      (entry) => !entry.expected.is_knowledge,
    );
    at(fixture.cases, index).expected.merge_group = "group-a";
    expect(customIssues(GoldenFixtureSchema, fixture)).toEqual([
      {
        message: "non-knowledge fixtures cannot belong to a merge group",
        path: ["cases", index, "expected"],
      },
    ]);
  });

  it("rejects duplicate search ids", async () => {
    const fixture = await load();
    at(fixture.searches, 1).id = at(fixture.searches, 0).id;
    expect(customIssues(GoldenFixtureSchema, fixture)).toEqual([
      {
        message: `duplicate searches id ${at(fixture.searches, 0).id}`,
        path: ["searches", 1, "id"],
      },
    ]);
  });
});

describe("AnonymizedThreadCorpusSchema rules", () => {
  const load = () =>
    readGoldenFixture(
      AnonymizedThreadCorpusSchema,
      "m2-anonymized-corpus.json",
    );

  it("accepts the committed corpus", async () => {
    expect(customIssues(AnonymizedThreadCorpusSchema, await load())).toEqual(
      [],
    );
  });

  it("requires category and severity for knowledge threads", async () => {
    const corpus = await load();
    const index = corpus.threads.findIndex(
      (thread) => thread.expected.is_knowledge,
    );
    at(corpus.threads, index).expected.category = null;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: "knowledge threads require expected category and severity",
        path: ["threads", index, "expected"],
      },
    ]);
  });

  it("rejects merge groups on non-knowledge threads", async () => {
    const corpus = await load();
    const index = corpus.threads.findIndex(
      (thread) => !thread.expected.is_knowledge,
    );
    at(corpus.threads, index).expected.merge_group = "group-a";
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: "non-knowledge threads cannot belong to a merge group",
        path: ["threads", index, "expected"],
      },
    ]);
  });

  it("rejects duplicate comment ids within a thread", async () => {
    const corpus = await load();
    const comments = at(corpus.threads, 0).comments;
    at(comments, 1).id = at(comments, 0).id;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: `duplicate comment id ${at(comments, 0).id}`,
        path: ["threads", 0, "comments", 1, "id"],
      },
    ]);
  });

  it("rejects duplicate thread ids", async () => {
    const corpus = await load();
    // Keep every relevance id resolvable: the duplicate reuses an id that
    // already exists, and the renamed thread was not referenced.
    const referenced = new Set(
      corpus.searches.flatMap((search) => Object.keys(search.relevance)),
    );
    const index = corpus.threads.findIndex(
      (thread, position) => position > 0 && !referenced.has(thread.id),
    );
    expect(index).toBeGreaterThan(0);
    at(corpus.threads, index).id = at(corpus.threads, 0).id;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: `duplicate thread id ${at(corpus.threads, 0).id}`,
        path: ["threads", index, "id"],
      },
    ]);
  });

  it("reports a thread issue and a corpus issue together", async () => {
    const corpus = await load();
    const comments = at(corpus.threads, 0).comments;
    at(comments, 1).id = at(comments, 0).id;
    at(corpus.searches, 1).id = at(corpus.searches, 0).id;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: `duplicate comment id ${at(comments, 0).id}`,
        path: ["threads", 0, "comments", 1, "id"],
      },
      {
        message: `duplicate search id ${at(corpus.searches, 0).id}`,
        path: ["searches", 1, "id"],
      },
    ]);
  });

  it("rejects duplicate search ids", async () => {
    const corpus = await load();
    at(corpus.searches, 1).id = at(corpus.searches, 0).id;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: `duplicate search id ${at(corpus.searches, 0).id}`,
        path: ["searches", 1, "id"],
      },
    ]);
  });

  it("rejects relevance ids that are not corpus threads", async () => {
    const corpus = await load();
    at(corpus.searches, 0).relevance["missing-thread"] = 1;
    expect(customIssues(AnonymizedThreadCorpusSchema, corpus)).toEqual([
      {
        message: "relevance id missing-thread is not a corpus thread",
        path: ["searches", 0, "relevance"],
      },
    ]);
  });
});

describe("OutcomeRankingFixtureSchema rules", () => {
  const load = () =>
    readGoldenFixture(
      OutcomeRankingFixtureSchema,
      "m2-outcome-ranking-golden.json",
    );

  it("accepts the committed fixture", async () => {
    expect(customIssues(OutcomeRankingFixtureSchema, await load())).toEqual([]);
  });

  it("rejects duplicate rubric ids", async () => {
    const fixture = await load();
    const queryIndex = fixture.queries.findIndex(
      (query) => query.rubric.length > 1,
    );
    const rubric = at(fixture.queries, queryIndex).rubric;
    at(rubric, 1).id = at(rubric, 0).id;
    expect(customIssues(OutcomeRankingFixtureSchema, fixture)).toEqual([
      {
        message: `duplicate rubric id ${at(rubric, 0).id}`,
        path: ["queries", queryIndex, "rubric", 1, "id"],
      },
    ]);
  });

  it("requires rubric higher and lower to differ", async () => {
    const fixture = await load();
    const entry = at(at(fixture.queries, 0).rubric, 0);
    entry.lower = entry.higher;
    expect(customIssues(OutcomeRankingFixtureSchema, fixture)).toEqual([
      {
        message: "rubric higher and lower must differ",
        path: ["queries", 0, "rubric", 0],
      },
    ]);
  });

  it("rejects duplicate query ids", async () => {
    const fixture = await load();
    at(fixture.queries, 1).id = at(fixture.queries, 0).id;
    expect(customIssues(OutcomeRankingFixtureSchema, fixture)).toEqual([
      {
        message: `duplicate queries id ${at(fixture.queries, 0).id}`,
        path: ["queries", 1, "id"],
      },
    ]);
  });
});

describe("PilotHumanRubricSchema rules", () => {
  const load = () =>
    readJson(
      PilotHumanRubricSchema,
      "docs",
      "testing",
      "m2-pilot-human-rubric.json",
    );

  it("accepts the committed rubric", async () => {
    expect(customIssues(PilotHumanRubricSchema, await load())).toEqual([]);
  });

  it("rejects duplicate criterion ids within a query", async () => {
    const rubric = await load();
    const criteria = at(rubric.queries, 0).criteria;
    at(criteria, 1).id = at(criteria, 0).id;
    expect(customIssues(PilotHumanRubricSchema, rubric)).toEqual([
      {
        message: `duplicate criterion id ${at(criteria, 0).id}`,
        path: ["queries", 0, "criteria", 1, "id"],
      },
    ]);
  });

  it("rejects duplicate checkpoint ids", async () => {
    const rubric = await load();
    at(rubric.checkpoints, 1).id = at(rubric.checkpoints, 0).id;
    expect(customIssues(PilotHumanRubricSchema, rubric)).toEqual([
      {
        message: `duplicate checkpoints id ${at(rubric.checkpoints, 0).id}`,
        path: ["checkpoints", 1, "id"],
      },
    ]);
  });

  it("requires unique checkpoint days", async () => {
    const rubric = await load();
    at(rubric.checkpoints, 1).day = at(rubric.checkpoints, 0).day;
    expect(customIssues(PilotHumanRubricSchema, rubric)).toEqual([
      {
        message: "checkpoint days must be unique",
        path: ["checkpoints"],
      },
    ]);
  });

  it("requires unique scale scores and stops checking the scale", async () => {
    const rubric = await load();
    at(rubric.scale, 1).score = at(rubric.scale, 0).score;
    expect(customIssues(PilotHumanRubricSchema, rubric)).toEqual([
      { message: "scale scores must be unique", path: ["scale"] },
    ]);
  });
});

describe("DistillJobSchema lease and outcome rules", () => {
  const NOW = "2026-08-06T12:00:00.000Z";
  const SHA_A = `sha256:${"a".repeat(64)}`;
  const SHA_B = `sha256:${"b".repeat(64)}`;

  function job(overrides: Json): Json {
    return {
      attempts: 0,
      distillation_key: SHA_A,
      job_id: createDomainId("job"),
      lease_generation: 0,
      repo_id: "R_kgDOExample",
      state: "pending",
      thread_id: "PRRT_example",
      updated_at: NOW,
      ...overrides,
    };
  }

  it("accepts a pending job without a lease", () => {
    expect(customIssues(DistillJobSchema, job({}))).toEqual([]);
  });

  it("rejects a lease on jobs that are not running", () => {
    expect(
      customIssues(
        DistillJobSchema,
        job({ lease_expires_at: NOW, lease_token_hash: SHA_B }),
      ),
    ).toEqual([
      {
        message: "pending jobs must not retain a lease",
        path: ["lease_expires_at"],
      },
    ]);
  });

  it("requires skip_reason for skipped jobs", () => {
    expect(customIssues(DistillJobSchema, job({ state: "skipped" }))).toEqual([
      { message: "skipped jobs require skip_reason", path: ["skip_reason"] },
    ]);
  });

  it("rejects skip_reason on jobs that are not skipped", () => {
    expect(
      customIssues(DistillJobSchema, job({ skip_reason: "typo" })),
    ).toEqual([
      {
        message: "pending jobs must not have skip_reason",
        path: ["skip_reason"],
      },
    ]);
  });

  it("requires last_error for failed jobs", () => {
    expect(customIssues(DistillJobSchema, job({ state: "failed" }))).toEqual([
      { message: "failed jobs require last_error", path: ["last_error"] },
    ]);
  });

  it("reports every broken rule, not only the first", () => {
    expect(
      customIssues(
        DistillJobSchema,
        job({
          lease_expires_at: NOW,
          lease_token_hash: SHA_B,
          skip_reason: "typo",
          state: "failed",
        }),
      ),
    ).toEqual([
      {
        message: "failed jobs must not retain a lease",
        path: ["lease_expires_at"],
      },
      {
        message: "failed jobs must not have skip_reason",
        path: ["skip_reason"],
      },
      { message: "failed jobs require last_error", path: ["last_error"] },
    ]);
  });
});

describe("mutation output rules", () => {
  const result = {
    changed_threads: 0,
    distilled: 0,
    jobs_created: 0,
    new_threads: 0,
    pending: 0,
    repo_id: "R_kgDOExample",
    snapshot_id: createDomainId("snapshot"),
    unchanged: 0,
    warnings: [],
  };
  const error = { code: "FAILED", message: "failed", retryable: false };
  const summary = { counts: {}, next_action: null, retryable: false };

  it("accepts a result on success and an error on failure", () => {
    expect(
      customIssues(IngestPrOutputSchema, { ok: true, result, summary }),
    ).toEqual([]);
    expect(
      customIssues(IngestPrOutputSchema, { error, ok: false, summary }),
    ).toEqual([]);
  });

  it("requires only result on success", () => {
    expect(
      customIssues(IngestPrOutputSchema, { error, ok: true, summary }),
    ).toEqual([
      { message: "successful mutation output requires only result", path: [] },
    ]);
  });

  it("requires only error on failure", () => {
    expect(
      customIssues(IngestPrOutputSchema, { ok: false, result, summary }),
    ).toEqual([
      { message: "failed mutation output requires only error", path: [] },
    ]);
  });
});

describe("SubmitDistillationInputSchema rules", () => {
  const SHA = "c".repeat(64);
  const candidate = {
    category: "style",
    confidence: 0.9,
    detail: "Prefer early returns.",
    evidence_comment_ids: ["PRRC_example"],
    rule: "Use early returns",
    scope: [],
    severity: "should",
  };

  function extract(overrides: Json): Json {
    return {
      candidates: [candidate],
      job_id: createDomainId("job"),
      lease_generation: 1,
      lease_token: "lease-token",
      phase: "extract",
      request_schema_version: 1,
      skip_reason: null,
      submission_id: "submission",
      thread_fingerprint: `sha256:${SHA}`,
      ...overrides,
    };
  }

  function finalize(decision: Json): Json {
    return {
      candidate_set_sha256: SHA,
      decisions: [{ candidate_id: createDomainId("candidate"), ...decision }],
      finalize_token: "finalize-token",
      job_id: createDomainId("job"),
      lease_generation: 1,
      lease_token: "lease-token",
      phase: "finalize",
      request_schema_version: 1,
      submission_id: "submission",
    };
  }

  it("accepts candidates without skip_reason and none with one", () => {
    expect(customIssues(SubmitDistillationInputSchema, extract({}))).toEqual(
      [],
    );
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        extract({ candidates: [], skip_reason: "typo" }),
      ),
    ).toEqual([]);
  });

  it("requires skip_reason when there are no candidates", () => {
    expect(
      customIssues(SubmitDistillationInputSchema, extract({ candidates: [] })),
    ).toEqual([
      { message: "zero candidates require skip_reason", path: ["skip_reason"] },
    ]);
  });

  it("rejects skip_reason alongside candidates", () => {
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        extract({ skip_reason: "typo" }),
      ),
    ).toEqual([
      {
        message: "candidate output must not include skip_reason",
        path: ["skip_reason"],
      },
    ]);
  });

  it("accepts merge decisions that follow the target_id rule", () => {
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        finalize({ relation: "different" }),
      ),
    ).toEqual([]);
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        finalize({ relation: "same", target_id: createDomainId("knowledge") }),
      ),
    ).toEqual([]);
  });

  it("rejects target_id on different decisions", () => {
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        finalize({
          relation: "different",
          target_id: createDomainId("knowledge"),
        }),
      ),
    ).toEqual([
      {
        message: "different decisions must not include target_id",
        path: ["decisions", 0, "target_id"],
      },
    ]);
  });

  it("requires target_id on same and overlaps decisions", () => {
    expect(
      customIssues(
        SubmitDistillationInputSchema,
        finalize({ relation: "overlaps" }),
      ),
    ).toEqual([
      {
        message: "overlaps decisions require target_id",
        path: ["decisions", 0, "target_id"],
      },
    ]);
  });
});

describe("refine error messages", () => {
  const sync = {
    discovered: 0,
    failed_pull_requests: [],
    ingested: 0,
    jobs_created: 0,
    retry_attempts: 0,
    runs_failed: 0,
    runs_total: 0,
    unchanged: 0,
  };

  it.each([
    {
      input: "owner/..",
      message: "repository name must not be '.' or '..'",
      schema: RepositoryNameSchema,
    },
    {
      input: {
        content: "   ",
        evidence_comment_ids: ["PRRC_example"],
        generated_example: true,
        language: "typescript",
      },
      message: "code example content must not be blank",
      path: ["content"],
      schema: GeneratedCodeExampleSchema,
    },
    {
      input: {},
      message: "revision proposal patch must not be empty",
      schema: KnowledgeRevisionPatchSchema,
    },
    {
      input: {},
      message: "patch must not be empty",
      schema: UpdateKnowledgeInputSchema.shape.patch,
    },
    {
      input: {},
      message: "context must contain at least one field",
      schema: RecordOutcomeRequestSchema.shape.context,
    },
    {
      input: "2026-02-30",
      message: "must be a valid UTC calendar day",
      schema: UtcDaySchema,
    },
    {
      input: { ...sync, runs_failed: 1 },
      message: "runs_failed must not exceed runs_total",
      schema: ObservedPilotDailyRecordSchema.shape.sync,
    },
  ])("keeps the message: $message", ({ input, message, path = [], schema }) => {
    expect(customIssues(schema, input)).toEqual([{ message, path }]);
  });

  it("accepts the values next to each rejected one", () => {
    expect(customIssues(RepositoryNameSchema, "owner/.name")).toEqual([]);
    expect(UtcDaySchema.parse("2026-02-28")).toBe("2026-02-28");
    expect(customIssues(KnowledgeRevisionPatchSchema, { rule: "x" })).toEqual(
      [],
    );
    expect(
      customIssues(ObservedPilotDailyRecordSchema.shape.sync, {
        ...sync,
        runs_failed: 1,
        runs_total: 1,
      }),
    ).toEqual([]);
  });
});

describe("sorted string sets", () => {
  const commentIds = KnowledgeEvidenceSchema.shape.comment_ids;

  it("sorts and removes duplicates", () => {
    expect(commentIds.parse(["C_b", "C_a", "C_b"])).toEqual(["C_a", "C_b"]);
  });

  it.each([
    { expected: [{ code: "too_small", path: [] }], input: [] },
    { expected: [{ code: "invalid_type", path: [0] }], input: [1, "C_a"] },
    { expected: [{ code: "invalid_type", path: [] }], input: "C_a" },
  ])("rejects $input with $expected", ({ expected, input }) => {
    expect(
      commentIds
        .safeParse(input)
        .error?.issues.map(({ code, path }) => ({ code, path })),
    ).toEqual(expected);
  });
});

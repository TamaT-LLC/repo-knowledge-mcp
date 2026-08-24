import { describe, expect, it } from "vitest";

import {
  CandidateIdSchema,
  DistillJobSchema,
  DistillationOutputSchema,
  EvidenceIdSchema,
  ExtractSubmissionReceiptSchema,
  FinalizeStableResponseSchema,
  JobIdSchema,
  KnowledgeEvidenceSchema,
  KnowledgeIdSchema,
  MergeDecisionSchema,
  PullRequestSnapshotSchema,
  RawObservationSchema,
  ReceiptIdSchema,
  RepositoryReadinessSchema,
  RepositoryReadinessStateSchema,
  ReviewerIdentitySchema,
  SnapshotIdSchema,
  TransactionIdSchema,
  createDomainId,
  type DistilledCandidate,
} from "../src/experimental.js";

const NOW = "2026-08-06T12:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

describe("domain IDs", () => {
  it("creates prefixed monotonic ULIDs accepted by their schemas", () => {
    const timestamp = Date.now() + 60_000;
    const firstTransaction = createDomainId("transaction", timestamp);
    const secondTransaction = createDomainId("transaction", timestamp);

    expect(TransactionIdSchema.parse(firstTransaction)).toBe(firstTransaction);
    expect(TransactionIdSchema.parse(secondTransaction)).toBe(
      secondTransaction,
    );
    expect(secondTransaction > firstTransaction).toBe(true);
    expect(KnowledgeIdSchema.parse(createDomainId("knowledge"))).toMatch(
      /^kn_/u,
    );
    expect(EvidenceIdSchema.parse(createDomainId("evidence"))).toMatch(/^ev_/u);
    expect(JobIdSchema.parse(createDomainId("job"))).toMatch(/^job_/u);
    expect(SnapshotIdSchema.parse(createDomainId("snapshot"))).toMatch(
      /^snap_/u,
    );
    expect(ReceiptIdSchema.parse(createDomainId("receipt"))).toMatch(/^rcpt_/u);
    expect(CandidateIdSchema.parse(createDomainId("candidate"))).toMatch(
      /^cand_/u,
    );
  });

  it("rejects unknown prefixes and malformed ULIDs", () => {
    expect(() => KnowledgeIdSchema.parse("knowledge-1")).toThrow();
    expect(() => JobIdSchema.parse(`job_${"I".repeat(26)}`)).toThrow();
  });
});

describe("identity and raw observation schemas", () => {
  it("strictly validates reviewer identities", () => {
    expect(
      ReviewerIdentitySchema.parse({
        actor_id: "MDQ6VXNlcjE=",
        actor_kind: "user",
        author_association: "MEMBER",
        login: "take",
        provider: "human",
        trust: "trusted",
      }),
    ).toMatchObject({ login: "take", trust: "trusted" });

    expect(() =>
      ReviewerIdentitySchema.parse({
        actor_kind: "robot",
        login: null,
        provider: "other",
        trust: "unknown",
      }),
    ).toThrow();
  });

  it("validates complete snapshots and deterministically normalizes ID sets", () => {
    const snapshot = PullRequestSnapshotSchema.parse({
      complete: true,
      observed_at: NOW,
      pr_number: 42,
      repo_id: "R_kgDOExample",
      review_summary_ids: ["review-z", "review-a", "review-z"],
      snapshot_id: createDomainId("snapshot"),
      thread_ids: ["thread-z", "thread-a", "thread-z"],
    });

    expect(snapshot.thread_ids).toEqual(["thread-a", "thread-z"]);
    expect(snapshot.review_summary_ids).toEqual(["review-a", "review-z"]);
    expect(() =>
      PullRequestSnapshotSchema.parse({ ...snapshot, complete: false }),
    ).toThrow();
  });

  it("rejects observation shapes that do not match their discriminant", () => {
    expect(() =>
      RawObservationSchema.parse({
        observation_id: createDomainId("observation"),
        observation_type: "comment",
        observed_at: NOW,
      }),
    ).toThrow();
  });
});

describe("repository readiness schema", () => {
  it("fixes the four additive get_rules states and requires a next action", () => {
    expect(RepositoryReadinessStateSchema.options).toEqual([
      "setup_required",
      "learning",
      "ready",
      "empty",
    ]);
    expect(
      RepositoryReadinessSchema.parse({
        next_action: "Run repo-knowledge setup owner/repository.",
        state: "setup_required",
      }),
    ).toMatchObject({ state: "setup_required" });
    expect(() =>
      RepositoryReadinessSchema.parse({
        next_action: "",
        state: "unknown",
      }),
    ).toThrow();
  });
});

describe("distillation schemas", () => {
  it("adds an empty active set when replaying a pre-M3 finalize response", () => {
    expect(
      FinalizeStableResponseSchema.parse({
        accepted: true,
        created_proposed: [],
        merged_evidence: [],
        revision_proposals: [],
      }),
    ).toMatchObject({ created_active: [], created_proposed: [] });
  });

  it("derives candidate types and normalizes set-like fields", () => {
    const output = DistillationOutputSchema.parse({
      candidates: [candidateFixture()],
      skip_reason: null,
    });
    const candidate: DistilledCandidate = output.candidates[0]!;

    expect(candidate.evidence_comment_ids).toEqual(["PRRC_a", "PRRC_z"]);
    expect(candidate.scope).toEqual(["src/**", "test/**"]);
  });

  it("normalizes grounded code examples and requires the generated flag", () => {
    const output = DistillationOutputSchema.parse({
      candidates: [
        {
          ...candidateFixture(),
          code_example: codeExampleFixture(),
        },
      ],
      skip_reason: null,
    });
    const candidate: DistilledCandidate = output.candidates[0]!;

    expect(candidate.code_example).toEqual({
      content: "const result = await invoke();",
      evidence_comment_ids: ["PRRC_a", "PRRC_z"],
      generated_example: true,
      language: "typescript",
    });
    expect(
      DistillationOutputSchema.parse({
        candidates: [candidateFixture()],
        skip_reason: null,
      }).candidates[0]!.code_example,
    ).toBeUndefined();
  });

  it("rejects unflagged, empty, oversized, and mislabeled code examples", () => {
    const invalidExamples: Record<string, unknown>[] = [
      { ...codeExampleFixture(), generated_example: undefined },
      { ...codeExampleFixture(), generated_example: false },
      { ...codeExampleFixture(), content: "" },
      { ...codeExampleFixture(), content: " \n\t" },
      { ...codeExampleFixture(), content: "x".repeat(4_001) },
      { ...codeExampleFixture(), evidence_comment_ids: [] },
      { ...codeExampleFixture(), language: "TypeScript" },
      { ...codeExampleFixture(), language: "" },
      { ...codeExampleFixture(), unexpected: "field" },
    ];

    for (const example of invalidExamples) {
      expect(() =>
        DistillationOutputSchema.parse({
          candidates: [{ ...candidateFixture(), code_example: example }],
          skip_reason: null,
        }),
      ).toThrow();
    }
  });

  it("requires skip_reason exactly for zero-candidate output", () => {
    expect(
      DistillationOutputSchema.parse({
        candidates: [],
        skip_reason: "insufficient_context",
      }),
    ).toEqual({ candidates: [], skip_reason: "insufficient_context" });
    expect(() =>
      DistillationOutputSchema.parse({ candidates: [], skip_reason: null }),
    ).toThrow("zero candidates require skip_reason");
    expect(() =>
      DistillationOutputSchema.parse({
        candidates: [candidateFixture()],
        skip_reason: "pr_specific",
      }),
    ).toThrow("candidate output must not include skip_reason");
    for (const serverReason of [
      "superseded_context",
      "source_removed",
    ] as const) {
      expect(() =>
        DistillationOutputSchema.parse({
          candidates: [],
          skip_reason: serverReason,
        }),
      ).toThrow();
    }
  });

  it("enforces relation-specific merge targets", () => {
    const candidateId = createDomainId("candidate");
    const knowledgeId = createDomainId("knowledge");

    expect(
      MergeDecisionSchema.parse({
        candidate_id: candidateId,
        relation: "same",
        target_id: knowledgeId,
      }),
    ).toMatchObject({ relation: "same", target_id: knowledgeId });
    expect(() =>
      MergeDecisionSchema.parse({
        candidate_id: candidateId,
        relation: "same",
      }),
    ).toThrow("same decisions require target_id");
    expect(() =>
      MergeDecisionSchema.parse({
        candidate_id: candidateId,
        relation: "different",
        target_id: knowledgeId,
      }),
    ).toThrow("different decisions must not include target_id");
  });

  it("requires active lease metadata for processing jobs", () => {
    const job = {
      attempts: 1,
      distillation_key: SHA_A,
      job_id: createDomainId("job"),
      lease_generation: 2,
      repo_id: "R_kgDOExample",
      state: "processing",
      thread_id: "PRRT_example",
      updated_at: NOW,
    };

    expect(() => DistillJobSchema.parse(job)).toThrow(
      "processing jobs require an active lease",
    );
    expect(
      DistillJobSchema.parse({
        ...job,
        lease_expires_at: "2026-08-06T12:05:00.000Z",
        lease_token_hash: SHA_B,
      }),
    ).toMatchObject({ state: "processing" });
  });

  it.each(["superseded_context", "source_removed"] as const)(
    "accepts the server-only %s reason for skipped jobs",
    (skipReason) => {
      expect(
        DistillJobSchema.parse({
          attempts: 0,
          distillation_key: SHA_A,
          job_id: createDomainId("job"),
          lease_generation: 0,
          repo_id: "R_kgDOExample",
          skip_reason: skipReason,
          state: "skipped",
          thread_id: "PRRT_example",
          updated_at: NOW,
        }),
      ).toMatchObject({
        skip_reason: skipReason,
        state: "skipped",
      });
    },
  );
});

describe("evidence and receipt schemas", () => {
  it("validates evidence actors and normalizes source sets", () => {
    const actor = {
      actor_id: "BOT_example",
      actor_kind: "bot" as const,
      comment_id: "PRRC_a",
      login: "greptile-apps[bot]",
      provider: "greptile" as const,
      trust: "trusted" as const,
    };
    const evidence = KnowledgeEvidenceSchema.parse({
      actors: [actor],
      comment_ids: ["PRRC_z", "PRRC_a", "PRRC_z"],
      content_fingerprint: SHA_A,
      eligible_for_count: true,
      evidence_id: createDomainId("evidence"),
      knowledge_id: createDomainId("knowledge"),
      observed_at: NOW,
      occurrence_key: "knowledge:thread",
      originator: actor,
      pr_number: 42,
      repo_id: "R_kgDOExample",
      sources: ["greptile", "human", "greptile"],
      state_fingerprint: SHA_B,
      status: "active",
      thread_id: "PRRT_example",
    });

    expect(evidence.comment_ids).toEqual(["PRRC_a", "PRRC_z"]);
    expect(evidence.sources).toEqual(["greptile", "human"]);
  });

  it("keeps ephemeral finalize tokens out of stable receipts", () => {
    const receipt = {
      committed_at: NOW,
      job_id: createDomainId("job"),
      phase: "extract",
      receipt_id: createDomainId("receipt"),
      request_sha256: SHA_A,
      stable_response: {
        candidates: [
          {
            candidate: candidateFixture(),
            candidate_id: createDomainId("candidate"),
          },
        ],
        state: "merge_decision_required",
      },
      submission_id: "submission-1",
    };

    expect(ExtractSubmissionReceiptSchema.parse(receipt)).toMatchObject({
      phase: "extract",
    });
    expect(() =>
      ExtractSubmissionReceiptSchema.parse({
        ...receipt,
        stable_response: {
          ...receipt.stable_response,
          finalize_token: "must-not-be-persisted",
        },
      }),
    ).toThrow();
  });
});

function candidateFixture(): Record<string, unknown> {
  return {
    category: "test",
    confidence: 0.9,
    detail: "変更時に回帰テストを追加する。",
    evidence_comment_ids: ["PRRC_z", "PRRC_a", "PRRC_z"],
    rule: "不具合修正には回帰テストを追加する",
    scope: ["test/**", "src/**", "test/**"],
    severity: "must",
  };
}

function codeExampleFixture(): Record<string, unknown> {
  return {
    content: "const result = await invoke();",
    evidence_comment_ids: ["PRRC_z", "PRRC_a", "PRRC_z"],
    generated_example: true,
    language: "typescript",
  };
}

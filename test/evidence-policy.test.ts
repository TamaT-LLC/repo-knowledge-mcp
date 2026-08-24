import { describe, expect, it } from "vitest";

import {
  DEFINITIVE_NON_KNOWLEDGE_SKIP_REASONS,
  applySkipReasonPolicy,
  isDefinitiveNonKnowledge,
  type EvidenceRecord,
} from "../src/experimental.js";

describe("definitive non-knowledge policy", () => {
  it.each(DEFINITIVE_NON_KNOWLEDGE_SKIP_REASONS)(
    "withdraws active evidence for %s",
    (skipReason) => {
      const result = applySkipReasonPolicy({
        evidence: evidenceFixture(),
        skipReason,
      });

      expect(isDefinitiveNonKnowledge(skipReason)).toBe(true);
      expect(result.evidence).toEqual([
        { id: "evidence-2", knowledgeId: "knowledge-1", status: "withdrawn" },
        { id: "evidence-1", knowledgeId: "knowledge-1", status: "withdrawn" },
        {
          id: "evidence-old",
          knowledgeId: "knowledge-old",
          status: "withdrawn",
        },
      ]);
      expect(result.stableResponse).toEqual({
        skip_reason: skipReason,
        staled_knowledge_ids: ["knowledge-1"],
        state: "skipped",
        withdrawn_evidence_ids: ["evidence-1", "evidence-2"],
      });
      expect(result.manualReview).toBeNull();
      expect(result.reassociatedEvidenceIds).toEqual([]);
    },
  );
});

describe("acceptance test 62", () => {
  it("preserves active evidence and marks insufficient_context for manual review", () => {
    const evidence = evidenceFixture();
    const before = structuredClone(evidence);

    const result = applySkipReasonPolicy({
      evidence,
      skipReason: "insufficient_context",
    });

    expect(result.evidence).toEqual(before);
    expect(evidence).toEqual(before);
    expect(result.stableResponse).toEqual({
      skip_reason: "insufficient_context",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
    expect(result.manualReview).toEqual({
      evidenceIds: ["evidence-1", "evidence-2"],
      reason: "insufficient_context",
      required: true,
    });
    expect(result.reassociatedEvidenceIds).toEqual([]);
  });
});

describe("duplicate_noise policy", () => {
  it("preserves evidence when the duplicate target is unknown", () => {
    const evidence = evidenceFixture();

    const result = applySkipReasonPolicy({
      evidence,
      skipReason: "duplicate_noise",
    });

    expect(result.evidence).toEqual(evidence);
    expect(result.stableResponse).toEqual({
      skip_reason: "duplicate_noise",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
    expect(result.reassociatedEvidenceIds).toEqual([]);
  });

  it("reassociates only active evidence when the duplicate target is known", () => {
    const evidence = [
      ...evidenceFixture(),
      {
        id: "evidence-target",
        knowledgeId: "knowledge-duplicate",
        status: "active" as const,
      },
    ];

    const result = applySkipReasonPolicy({
      duplicateKnowledgeId: "knowledge-duplicate",
      evidence,
      skipReason: "duplicate_noise",
    });

    expect(result.evidence).toEqual([
      {
        id: "evidence-2",
        knowledgeId: "knowledge-duplicate",
        status: "active",
      },
      {
        id: "evidence-1",
        knowledgeId: "knowledge-duplicate",
        status: "active",
      },
      {
        id: "evidence-old",
        knowledgeId: "knowledge-old",
        status: "withdrawn",
      },
      {
        id: "evidence-target",
        knowledgeId: "knowledge-duplicate",
        status: "active",
      },
    ]);
    expect(result.reassociatedEvidenceIds).toEqual([
      "evidence-1",
      "evidence-2",
    ]);
    expect(result.stableResponse).toEqual({
      skip_reason: "duplicate_noise",
      staled_knowledge_ids: ["knowledge-1"],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
  });

  it("rejects an empty duplicate target", () => {
    expect(() =>
      applySkipReasonPolicy({
        duplicateKnowledgeId: "",
        evidence: evidenceFixture(),
        skipReason: "duplicate_noise",
      }),
    ).toThrow("duplicateKnowledgeId must not be empty");
  });
});

describe("evidence identity", () => {
  it("accepts the canonical superseded status without treating it as active", () => {
    const evidence: EvidenceRecord[] = [
      {
        id: "evidence-superseded",
        knowledgeId: "knowledge-old",
        status: "superseded",
      },
    ];

    const result = applySkipReasonPolicy({ evidence, skipReason: "typo" });

    expect(result.evidence).toEqual(evidence);
    expect(result.stableResponse).toEqual({
      skip_reason: "typo",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
  });

  it("rejects duplicate evidence ids before planning mutations", () => {
    expect(() =>
      applySkipReasonPolicy({
        evidence: [
          { id: "duplicate", knowledgeId: "knowledge-1", status: "active" },
          { id: "duplicate", knowledgeId: "knowledge-2", status: "active" },
        ],
        skipReason: "typo",
      }),
    ).toThrow("Duplicate evidence id: duplicate");
  });
});

function evidenceFixture(): EvidenceRecord[] {
  return [
    { id: "evidence-2", knowledgeId: "knowledge-1", status: "active" },
    { id: "evidence-1", knowledgeId: "knowledge-1", status: "active" },
    {
      id: "evidence-old",
      knowledgeId: "knowledge-old",
      status: "withdrawn",
    },
  ];
}

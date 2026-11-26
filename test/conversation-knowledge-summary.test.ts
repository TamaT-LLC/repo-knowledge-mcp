import { describe, expect, it } from "vitest";

import {
  ConversationSummarySchema,
  conversationSummary,
  isConversationKnowledge,
} from "../src/conversation-knowledge-summary.js";
import {
  buildDomainProjectionSnapshot,
  createDomainId,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type CanonicalProjectionSnapshot,
  type KnowledgeDocument,
  type KnowledgeStatus,
  type ProjectedCanonicalRecord,
} from "../src/experimental.js";

const NOW = "2026-08-06T00:00:00.000Z";
const REPO_ID = "R_repo_1";
const EVIDENCE_PATH = "events/conversation_evidence.jsonl";
const CONVERSATION_ORIGIN = { type: "distilled", source: "conversation" };

describe("isConversationKnowledge", () => {
  it("accepts frontmatter whose origin source is conversation", () => {
    expect(
      isConversationKnowledge(
        knowledgeDocument({ origin: CONVERSATION_ORIGIN }).frontmatter,
      ),
    ).toBe(true);
  });

  it("rejects missing, non-object, and non-conversation origins", () => {
    expect(isConversationKnowledge(knowledgeDocument().frontmatter)).toBe(
      false,
    );
    expect(
      isConversationKnowledge(
        knowledgeDocument({ origin: "conversation" }).frontmatter,
      ),
    ).toBe(false);
    expect(
      isConversationKnowledge(
        knowledgeDocument({ origin: { type: "distilled", source: "github" } })
          .frontmatter,
      ),
    ).toBe(false);
  });
});

describe("conversationSummary", () => {
  it("returns an empty summary when there are no canonical records", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });

    const summary = conversationSummary(
      snapshot([], [document]),
      document.frontmatter,
    );

    expect(summary).toEqual({
      session_count: 0,
      project_count: 0,
      period: null,
      enforcement_hint: null,
      has_conflict: false,
    });
    expect(ConversationSummarySchema.parse(summary)).toEqual(summary);
  });

  it("counts distinct sessions and projects and spans the observed period", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;

    const summary = conversationSummary(
      snapshot(
        [
          created({
            knowledge_id: id,
            session_key: "s1",
            project_key: "p1",
            observed_at: "2026-03-01T00:00:00.000Z",
          }),
          created({
            knowledge_id: id,
            session_key: "s2",
            project_key: "p1",
            observed_at: "2026-01-15T00:00:00.000Z",
          }),
          created({
            knowledge_id: id,
            session_key: "s1",
            project_key: "p2",
            observed_at: "2026-02-01T00:00:00.000Z",
          }),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toEqual({
      session_count: 2,
      project_count: 2,
      period: {
        from: "2026-01-15T00:00:00.000Z",
        to: "2026-03-01T00:00:00.000Z",
      },
      enforcement_hint: null,
      has_conflict: false,
    });
    expect(ConversationSummarySchema.parse(summary)).toEqual(summary);
  });

  it("orders the period by instant rather than by string when offsets differ", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;

    const summary = conversationSummary(
      snapshot(
        [
          // Lexically first, but 2026-01-01T15:00Z as an instant.
          created({
            knowledge_id: id,
            observed_at: "2026-01-02T00:00:00+09:00",
          }),
          created({ knowledge_id: id, observed_at: "2026-01-01T12:00:00Z" }),
          created({ knowledge_id: id, observed_at: "2026-01-01T18:00:00Z" }),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary.period).toEqual({
      from: "2026-01-01T12:00:00Z",
      to: "2026-01-01T18:00:00Z",
    });
  });

  it("reports a single observation as a zero-length period", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });

    const summary = conversationSummary(
      snapshot(
        [created({ knowledge_id: document.frontmatter.id, observed_at: NOW })],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 1,
      project_count: 1,
      period: { from: NOW, to: NOW },
    });
  });

  it("excludes evidence with invalid observed_at values from the period and counts", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;

    const summary = conversationSummary(
      snapshot(
        [
          created({
            knowledge_id: id,
            session_key: "valid-session",
            project_key: "valid-project",
            observed_at: "2026-02-01T00:00:00.000Z",
          }),
          ...[
            "2026-01-01",
            "2025-12-31T23:59",
            "2026-13-01T00:00:00Z",
            "2026-01-01T00:00:00",
            "not a date",
            "",
          ].map((observed_at, index) =>
            created({
              knowledge_id: id,
              session_key: `invalid-session-${index}`,
              project_key: `invalid-project-${index}`,
              observed_at,
            }),
          ),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 1,
      project_count: 1,
      period: {
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("returns a null period when every observed_at value is invalid", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });

    const summary = conversationSummary(
      snapshot(
        [
          created({
            knowledge_id: document.frontmatter.id,
            observed_at: "2026-01-01",
          }),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 0,
      project_count: 0,
      period: null,
    });
  });

  it("drops evidence that a later Superseded or Withdrawn event names", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;
    const kept = created({
      knowledge_id: id,
      session_key: "kept",
      project_key: "kept",
      observed_at: "2026-02-01T00:00:00.000Z",
    });
    const superseded = created({
      knowledge_id: id,
      session_key: "superseded",
      project_key: "superseded",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const withdrawn = created({
      knowledge_id: id,
      session_key: "withdrawn",
      project_key: "withdrawn",
      observed_at: "2026-03-01T00:00:00.000Z",
    });

    const summary = conversationSummary(
      snapshot(
        [
          kept,
          superseded,
          withdrawn,
          lifecycle("ConversationEvidenceSuperseded", superseded),
          lifecycle("ConversationEvidenceWithdrawn", withdrawn),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 1,
      project_count: 1,
      period: {
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("returns an empty summary when all supporting evidence was superseded or withdrawn", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;
    const first = created({ knowledge_id: id, session_key: "s1" });
    const second = created({ knowledge_id: id, session_key: "s2" });

    const summary = conversationSummary(
      snapshot(
        [
          first,
          second,
          lifecycle("ConversationEvidenceSuperseded", first),
          lifecycle("ConversationEvidenceWithdrawn", second),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 0,
      project_count: 0,
      period: null,
    });
  });

  it("applies lifecycle events in record order so a re-created evidence counts again", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const evidence = created({ knowledge_id: document.frontmatter.id });

    const summary = conversationSummary(
      snapshot(
        [
          lifecycle("ConversationEvidenceWithdrawn", evidence),
          evidence,
          lifecycle("ConversationEvidenceWithdrawn", evidence),
          evidence,
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary.session_count).toBe(1);
  });

  it("ignores lifecycle events without a string evidence_id", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const evidence = created({ knowledge_id: document.frontmatter.id });

    const summary = conversationSummary(
      snapshot(
        [
          evidence,
          record("ConversationEvidenceWithdrawn", { evidence_id: 42 }),
          record("ConversationEvidenceSuperseded", {}),
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary.session_count).toBe(1);
  });

  it("only counts active supporting evidence for this knowledge with complete keys", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const other = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;
    const base = {
      knowledge_id: id,
      polarity: "supports",
      status: "active",
      session_key: "s",
      project_key: "p",
      observed_at: NOW,
    };
    const rejectedVariants: readonly Record<string, unknown>[] = [
      { ...base, knowledge_id: other.frontmatter.id },
      { ...base, polarity: "contradicts" },
      { ...base, status: "superseded" },
      { ...base, status: "withdrawn" },
      { ...base, session_key: 1 },
      { ...base, project_key: null },
      { ...base, observed_at: Date.parse(NOW) },
    ];

    const summary = conversationSummary(
      snapshot(
        [
          ...rejectedVariants.map((payload) =>
            record("ConversationEvidenceCreated", {
              ...payload,
              evidence_id: createDomainId("evidence"),
            }),
          ),
          // Missing evidence_id: skipped before any other check.
          record("ConversationEvidenceCreated", base),
          // Unknown record types on the evidence log are ignored.
          record("ConversationEvidenceRecorded", {
            ...base,
            evidence_id: createDomainId("evidence"),
          }),
        ],
        [document, other],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 0,
      project_count: 0,
      period: null,
    });
  });

  it("ignores records outside the conversation evidence log and non-object payloads", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const id = document.frontmatter.id;
    const valid = created({ knowledge_id: id, session_key: "kept" });

    const summary = conversationSummary(
      snapshot(
        [
          valid,
          {
            ...created({ knowledge_id: id, session_key: "elsewhere" }),
            targetPath: "events/other.jsonl",
          },
          record("ConversationEvidenceCreated", null),
          record("ConversationEvidenceCreated", "payload"),
          record("ConversationEvidenceCreated", [
            { evidence_id: "ev", knowledge_id: id },
          ]),
          // A conflict outside the evidence log does not count either.
          {
            ...record("ConversationConflictRecorded", { knowledge_ids: [id] }),
            targetPath: "events/other.jsonl",
          },
        ],
        [document],
      ),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 1,
      project_count: 1,
      has_conflict: false,
    });
  });

  it("does not treat a later Created event for the same evidence_id as a second session", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const evidence = created({
      knowledge_id: document.frontmatter.id,
      session_key: "first",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const replacement = record("ConversationEvidenceCreated", {
      ...(evidence.record.payload as Record<string, unknown>),
      session_key: "second",
      observed_at: "2026-02-01T00:00:00.000Z",
    });

    const summary = conversationSummary(
      snapshot([evidence, replacement], [document]),
      document.frontmatter,
    );

    expect(summary).toMatchObject({
      session_count: 1,
      period: {
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  describe("has_conflict", () => {
    it("is true when a conflict names this knowledge and every named knowledge is live", () => {
      const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
      const proposed = knowledgeDocument({ status: "proposed" });
      const stale = knowledgeDocument({ status: "stale" });

      const summary = conversationSummary(
        snapshot(
          [
            conflict([
              document.frontmatter.id,
              proposed.frontmatter.id,
              stale.frontmatter.id,
            ]),
          ],
          [document, proposed, stale],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(true);
      expect(summary).toMatchObject({ session_count: 0, period: null });
    });

    it("is false when the conflict does not name this knowledge", () => {
      const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
      const left = knowledgeDocument();
      const right = knowledgeDocument();

      const summary = conversationSummary(
        snapshot(
          [conflict([left.frontmatter.id, right.frontmatter.id])],
          [document, left, right],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(false);
    });

    it.each(["deprecated", "rejected"] as const)(
      "is false when a named counterpart is %s",
      (status) => {
        const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
        const counterpart = knowledgeDocument({ status });

        const summary = conversationSummary(
          snapshot(
            [conflict([document.frontmatter.id, counterpart.frontmatter.id])],
            [document, counterpart],
          ),
          document.frontmatter,
        );

        expect(summary.has_conflict).toBe(false);
      },
    );

    it("is false when this knowledge itself is deprecated", () => {
      const document = knowledgeDocument({
        origin: CONVERSATION_ORIGIN,
        status: "deprecated",
      });
      const counterpart = knowledgeDocument();

      const summary = conversationSummary(
        snapshot(
          [conflict([document.frontmatter.id, counterpart.frontmatter.id])],
          [document, counterpart],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(false);
    });

    it("is false when a named counterpart is not in the projection", () => {
      const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });

      const summary = conversationSummary(
        snapshot(
          [conflict([document.frontmatter.id, createDomainId("knowledge")])],
          [document],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(false);
    });

    it("is false when knowledge_ids is not an array", () => {
      const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });

      const summary = conversationSummary(
        snapshot(
          [
            record("ConversationConflictRecorded", {
              knowledge_ids: document.frontmatter.id,
            }),
            record("ConversationConflictRecorded", {}),
          ],
          [document],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(false);
    });

    it("is true when any one of several conflicts qualifies", () => {
      const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
      const deprecated = knowledgeDocument({ status: "deprecated" });
      const active = knowledgeDocument();

      const summary = conversationSummary(
        snapshot(
          [
            conflict([document.frontmatter.id, deprecated.frontmatter.id]),
            conflict([document.frontmatter.id, active.frontmatter.id]),
          ],
          [document, deprecated, active],
        ),
        document.frontmatter,
      );

      expect(summary.has_conflict).toBe(true);
    });
  });

  describe("enforcement_hint", () => {
    it.each(["hook", "skill", "permission", "prose"] as const)(
      "returns a valid %s hint without extra keys",
      (kind) => {
        const document = knowledgeDocument({
          origin: CONVERSATION_ORIGIN,
          enforcement_hint: {
            kind,
            rationale: "Repeated in every session.",
            internal: "dropped",
          },
        });

        const summary = conversationSummary(
          snapshot([], [document]),
          document.frontmatter,
        );

        expect(summary.enforcement_hint).toEqual({
          kind,
          rationale: "Repeated in every session.",
        });
        expect(ConversationSummarySchema.parse(summary)).toEqual(summary);
      },
    );

    it.each([
      ["an unknown kind", { kind: "lint", rationale: "x" }],
      ["a missing rationale", { kind: "hook" }],
      ["a non-object value", "hook"],
    ])("returns null for %s", (_label, enforcement_hint) => {
      const document = knowledgeDocument({
        origin: CONVERSATION_ORIGIN,
        enforcement_hint,
      });

      const summary = conversationSummary(
        snapshot([], [document]),
        document.frontmatter,
      );

      expect(summary.enforcement_hint).toBeNull();
    });
  });

  it("never exposes evidence or event identifiers in its output", () => {
    const document = knowledgeDocument({ origin: CONVERSATION_ORIGIN });
    const evidence = created({ knowledge_id: document.frontmatter.id });
    const evidenceId = (evidence.record.payload as { evidence_id: string })
      .evidence_id;

    const summary = conversationSummary(
      snapshot([evidence], [document]),
      document.frontmatter,
    );

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(evidenceId);
    expect(serialized).not.toContain(evidence.record.record_id);
    expect(serialized).not.toContain("utterance");
    expect(Object.keys(summary).sort()).toEqual([
      "enforcement_hint",
      "has_conflict",
      "period",
      "project_count",
      "session_count",
    ]);
  });
});

function knowledgeDocument(
  overrides: Readonly<Record<string, unknown>> & {
    readonly status?: KnowledgeStatus;
  } = {},
): KnowledgeDocument {
  const id = createDomainId("knowledge");
  const path = `knowledge/${id}.md`;
  return parseKnowledgeDocument(
    path,
    serializeKnowledgeDocument(
      path,
      {
        category: "test",
        created_at: NOW,
        id,
        repo_id: REPO_ID,
        revision: 1,
        rule: "Prefer pnpm",
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status: "active",
        updated_at: NOW,
        ...overrides,
      },
      "Conversation knowledge detail.\n",
    ),
  );
}

function snapshot(
  records: readonly ProjectedCanonicalRecord[],
  knowledge: readonly KnowledgeDocument[],
): CanonicalProjectionSnapshot {
  return {
    canonicalDigest: `sha256:${"a".repeat(64)}`,
    checkpointTransactionId: null,
    domain: buildDomainProjectionSnapshot(
      records.map((item) => item.record),
      knowledge,
    ),
    knowledge,
    records,
  };
}

function record(
  recordType: string,
  payload: unknown,
  targetPath = EVIDENCE_PATH,
): ProjectedCanonicalRecord {
  const canonical: CanonicalJsonlRecord = {
    schema_version: 1,
    record_type: recordType,
    recorded_at: NOW,
    record_id: createDomainId("event"),
    transaction_id: createDomainId("transaction"),
    payload,
  };
  return { lineSha256: "0".repeat(64), record: canonical, targetPath };
}

function created(
  overrides: Readonly<Record<string, unknown>> & {
    readonly knowledge_id: string;
  },
): ProjectedCanonicalRecord {
  return record("ConversationEvidenceCreated", {
    evidence_id: createDomainId("evidence"),
    utterance_id: "utterance-private",
    excerpt: "confidential-snippet",
    status: "active",
    polarity: "supports",
    session_key: "session-1",
    project_key: "project-1",
    observed_at: NOW,
    ...overrides,
  });
}

function lifecycle(
  recordType:
    | "ConversationEvidenceSuperseded"
    | "ConversationEvidenceWithdrawn",
  evidence: ProjectedCanonicalRecord,
): ProjectedCanonicalRecord {
  const { evidence_id } = evidence.record.payload as { evidence_id: string };
  return record(recordType, { evidence_id });
}

function conflict(knowledgeIds: readonly string[]): ProjectedCanonicalRecord {
  return record("ConversationConflictRecorded", {
    knowledge_ids: knowledgeIds,
  });
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalFinalizeService,
  CanonicalTransactionStore,
  MergeCandidateSearchService,
  createDistillationJobEventRecord,
  createDomainId,
  hashLeaseToken,
  parseKnowledgeBodyCodeExample,
  parseKnowledgeDocument,
  renderDistilledCandidateBody,
  renderKnowledgeBodyWithCodeExample,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type CommentObservation,
  type DistillationProvenance,
  type DomainExtractCandidate,
  type KnowledgeEvidence,
  type KnowledgeStatus,
  type MergeDecision,
  type PullRequestSnapshot,
  type ThreadObservation,
  type TrustedHumanAutoActivationPolicyLike,
} from "../src/index.js";

const CREATED_AT = "2026-08-06T00:00:00.000Z";
const LEASED_AT = "2026-08-06T00:10:00.000Z";
const AWAITING_AT = "2026-08-06T00:20:00.000Z";
const OBSERVED_AT = "2026-08-06T00:30:00.000Z";
const FINALIZED_AT = "2026-08-06T01:00:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-06T03:00:00.000Z";
const REPO_ID = "repo-finalize";
const THREAD_ID = "thread-finalize";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRANSACTION_ID = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONTENT_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const STATE_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const DISTILLATION_KEY = `sha256:${"c".repeat(64)}`;
const PROMPT_DIGEST = `sha256:${"d".repeat(64)}`;
const OUTPUT_SCHEMA_DIGEST = `sha256:${"e".repeat(64)}`;
const TRUST_POLICY_DIGEST = `sha256:${"f".repeat(64)}`;
const TOKEN = "lease-token-finalize";
const ROOT_COMMENT_ID = "comment-root";
const BOT_COMMENT_ID = "comment-bot";
const KNOWLEDGE_A = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_B = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CANDIDATE_A = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CANDIDATE_B = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CanonicalFinalizeService", () => {
  it("collapses same-target candidates, derives actors, and protects active Markdown", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A],
      knowledge: [
        knowledge(KNOWLEDGE_A, {
          detail: "Canonical detail",
          rule: "Keep the canonical rule",
        }),
      ],
    });
    const before = await knowledgeBytes(fixture.root, KNOWLEDGE_A);
    const candidates = [
      candidate(CANDIDATE_A, "Keep the canonical rule", {
        detail: "Canonical detail",
        evidence_comment_ids: [ROOT_COMMENT_ID],
      }),
      candidate(CANDIDATE_B, "Clarify the canonical rule", {
        detail: "Canonical detail",
        evidence_comment_ids: [BOT_COMMENT_ID],
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    const result = await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [
        same(CANDIDATE_A, KNOWLEDGE_A),
        same(CANDIDATE_B, KNOWLEDGE_A),
      ],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result).toMatchObject({
      accepted: true,
      created_proposed: [],
      merged_evidence: [expect.stringMatching(/^ev_/u)],
      revision_proposals: [expect.stringMatching(/^proposal_/u)],
    });
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(before);

    const snapshot = await fixture.store.readSnapshot();
    const oldEvidence = snapshot.domain.evidence.find(
      (item) => item.evidence_id === fixture.evidenceIds[0],
    );
    const active = snapshot.domain.evidence.filter(
      (item) => item.knowledge_id === KNOWLEDGE_A && item.status === "active",
    );
    expect(oldEvidence).toMatchObject({
      eligible_for_count: false,
      status: "superseded",
      superseded_by: active[0]?.evidence_id,
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      comment_ids: [BOT_COMMENT_ID, ROOT_COMMENT_ID],
      originator: {
        comment_id: ROOT_COMMENT_ID,
        login: "alice",
        provider: "human",
        trust: "trusted",
      },
      sources: ["greptile", "human"],
      supersedes: fixture.evidenceIds[0],
    });
    expect(active[0]?.actors).toEqual([
      expect.objectContaining({
        comment_id: BOT_COMMENT_ID,
        provider: "greptile",
        trust: "untrusted",
      }),
      expect.objectContaining({
        comment_id: ROOT_COMMENT_ID,
        provider: "human",
        trust: "trusted",
      }),
    ]);
    expect(snapshot.domain.revisionProposals).toEqual([
      expect.objectContaining({
        evidence_ids: [active[0]?.evidence_id],
        knowledge_id: KNOWLEDGE_A,
        patch: { rule: "Clarify the canonical rule" },
        status: "pending",
      }),
    ]);
    expect(jobState(snapshot)).toBe("done");
  });

  it("creates only proposed documents and keeps overlaps one-way", async () => {
    const fixture = await createFixture({
      knowledge: [
        knowledge(KNOWLEDGE_A, {
          detail: "Existing target detail",
          rule: "Use deterministic transactions",
        }),
      ],
    });
    const targetBefore = await knowledgeBytes(fixture.root, KNOWLEDGE_A);
    const candidates = [
      candidate(CANDIDATE_A, "Use deterministic transactions", {
        detail: "Related but independently useful",
        evidence_comment_ids: [ROOT_COMMENT_ID],
      }),
      candidate(CANDIDATE_B, "Validate evidence before commit", {
        detail: "A distinct rule",
        evidence_comment_ids: [BOT_COMMENT_ID],
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    const result = await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [overlaps(CANDIDATE_A, KNOWLEDGE_A), different(CANDIDATE_B)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result.created_proposed).toHaveLength(2);
    const documents = await Promise.all(
      result.created_proposed.map(async (id) =>
        parseKnowledgeDocument(
          `knowledge/${id}.md`,
          await knowledgeBytes(fixture.root, id),
        ),
      ),
    );
    expect(documents.map((document) => document.frontmatter.status)).toEqual([
      "proposed",
      "proposed",
    ]);
    expect(
      documents.map((document) => document.frontmatter.activation),
    ).toEqual([
      { origin: "automatic", pinned: false },
      { origin: "automatic", pinned: false },
    ]);
    const overlapDocument = documents.find(
      (document) =>
        document.frontmatter.rule === "Use deterministic transactions",
    );
    const differentDocument = documents.find(
      (document) =>
        document.frontmatter.rule === "Validate evidence before commit",
    );
    expect(overlapDocument?.frontmatter.related_ids).toEqual([KNOWLEDGE_A]);
    expect(differentDocument?.frontmatter.related_ids).toEqual([]);
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(
      targetBefore,
    );
    expect(result.merged_evidence).toHaveLength(2);
    expect(jobState(await fixture.store.readSnapshot())).toBe("done");
  });

  it("does not downgrade an existing active rule when auto activation is stopped", async () => {
    const fixture = await createFixture({
      knowledge: [knowledge(KNOWLEDGE_A)],
    });
    const existingBefore = await knowledgeBytes(fixture.root, KNOWLEDGE_A);
    const candidates = [candidate(CANDIDATE_A, "A distinct guarded rule")];
    const search = await mergeSearch(fixture.store, candidates);
    const gateStoppedPolicy: TrustedHumanAutoActivationPolicyLike = {
      evaluate: () => ({
        reasons: ["quality_gate_not_pass"],
        status: "proposed",
      }),
    };

    const result = await finalizer(fixture.store, gateStoppedPolicy).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [different(CANDIDATE_A)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result).toMatchObject({
      created_active: [],
      created_proposed: [expect.stringMatching(/^kn_/u)],
    });
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(
      existingBefore,
    );
    expect((await fixture.store.readSnapshot()).domain.knowledge).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: KNOWLEDGE_A, status: "active" }),
        expect.objectContaining({
          id: result.created_proposed[0],
          status: "proposed",
        }),
      ]),
    );
  });

  it("withdraws lost associations, stales distilled knowledge, and preserves human-pinned knowledge", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A, KNOWLEDGE_B],
      knowledge: [
        knowledge(KNOWLEDGE_A, { rule: "Automatic old rule" }),
        knowledge(KNOWLEDGE_B, {
          activation: { origin: "human", pinned: true },
          origin: { type: "manual" },
          rule: "Pinned human rule",
        }),
      ],
    });
    const pinnedBefore = await knowledgeBytes(fixture.root, KNOWLEDGE_B);
    const candidates = [candidate(CANDIDATE_A, "A newly extracted rule")];
    const search = await mergeSearch(fixture.store, candidates);

    await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [different(CANDIDATE_A)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    const snapshot = await fixture.store.readSnapshot();
    expect(
      snapshot.domain.evidence
        .filter((item) => fixture.evidenceIds.includes(item.evidence_id))
        .map((item) => item.status),
    ).toEqual(["withdrawn", "withdrawn"]);
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_A)?.status,
    ).toBe("stale");
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_B)?.status,
    ).toBe("active");
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_B)).toEqual(
      pinnedBefore,
    );
  });

  it("preserves active evidence for insufficient_context", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A],
      knowledge: [knowledge(KNOWLEDGE_A)],
    });
    const before = await knowledgeBytes(fixture.root, KNOWLEDGE_A);

    const result = await finalizer(fixture.store).skip({
      ...sourceBinding(),
      lease: lease(),
      skip_reason: "insufficient_context",
    });

    expect(result.stable_response).toEqual({
      skip_reason: "insufficient_context",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
    expect(result.manual_review).toEqual({
      evidenceIds: fixture.evidenceIds,
      reason: "insufficient_context",
      required: true,
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(
      snapshot.domain.evidence.find(
        (item) => item.evidence_id === fixture.evidenceIds[0],
      )?.status,
    ).toBe("active");
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(before);
    expect(jobState(snapshot)).toBe("skipped");
  });

  it("atomically withdraws definitive skips and applies stale policy", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A, KNOWLEDGE_B],
      knowledge: [
        knowledge(KNOWLEDGE_A),
        knowledge(KNOWLEDGE_B, {
          activation: { origin: "human", pinned: true },
          origin: { type: "manual" },
          rule: "Pinned rule",
        }),
      ],
    });

    const result = await finalizer(fixture.store).skip({
      ...sourceBinding(),
      lease: lease(),
      skip_reason: "typo",
    });

    expect(result.stable_response).toEqual({
      skip_reason: "typo",
      staled_knowledge_ids: [KNOWLEDGE_A],
      state: "skipped",
      withdrawn_evidence_ids: fixture.evidenceIds,
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(
      snapshot.domain.evidence
        .filter((item) => fixture.evidenceIds.includes(item.evidence_id))
        .map((item) => item.status),
    ).toEqual(["withdrawn", "withdrawn"]);
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_A)?.status,
    ).toBe("stale");
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_B)?.status,
    ).toBe("active");
    expect(jobState(snapshot)).toBe("skipped");
  });

  it("reassociates duplicate_noise to one target evidence without withdrawal", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A, KNOWLEDGE_B],
      knowledge: [knowledge(KNOWLEDGE_A), knowledge(KNOWLEDGE_B)],
    });

    const result = await finalizer(fixture.store).skip({
      ...sourceBinding(),
      duplicate_knowledge_id: KNOWLEDGE_B,
      lease: lease(),
      skip_reason: "duplicate_noise",
    });

    expect(result.reassociated_evidence_ids).toEqual(fixture.evidenceIds);
    expect(result.stable_response).toEqual({
      skip_reason: "duplicate_noise",
      staled_knowledge_ids: [KNOWLEDGE_A],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(
      snapshot.domain.evidence.filter((item) => item.status === "active"),
    ).toEqual([
      expect.objectContaining({
        knowledge_id: KNOWLEDGE_B,
        supersedes: fixture.evidenceIds[1],
      }),
    ]);
    expect(
      snapshot.domain.evidence
        .filter((item) => fixture.evidenceIds.includes(item.evidence_id))
        .map((item) => item.status),
    ).toEqual(["superseded", "superseded"]);
  });

  it("renders a grounded code example with its generated flag into new knowledge", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [
      candidate(CANDIDATE_A, "Surface invoke failures to the UI", {
        code_example: {
          content: "const result = await invoke();",
          evidence_comment_ids: [ROOT_COMMENT_ID],
          generated_example: true,
          language: "typescript",
        },
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    const result = await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [different(CANDIDATE_A)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result.created_proposed).toHaveLength(1);
    const knowledgeId = result.created_proposed[0]!;
    const document = parseKnowledgeDocument(
      `knowledge/${knowledgeId}.md`,
      await knowledgeBytes(fixture.root, knowledgeId),
    );
    expect(document.body).toContain(
      renderDistilledCandidateBody(candidates[0]!.candidate),
    );
    expect(document.body).toContain(
      `<!-- generated_example: true; evidence_comment_ids: ${ROOT_COMMENT_ID} -->`,
    );
    expect(document.body).toContain(
      "```typescript\nconst result = await invoke();\n```",
    );
  }, 15_000);

  it("routes example additions through a revision proposal and never edits active Markdown", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A],
      knowledge: [
        knowledge(KNOWLEDGE_A, {
          detail: "Canonical detail",
          rule: "Keep the canonical rule",
        }),
      ],
    });
    const before = await knowledgeBytes(fixture.root, KNOWLEDGE_A);
    const candidates = [
      candidate(CANDIDATE_A, "Keep the canonical rule", {
        code_example: {
          content: "const result = await invoke();",
          evidence_comment_ids: [ROOT_COMMENT_ID],
          generated_example: true,
          language: "typescript",
        },
        detail: "Canonical detail",
        evidence_comment_ids: [ROOT_COMMENT_ID],
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    const result = await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [same(CANDIDATE_A, KNOWLEDGE_A)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result.revision_proposals).toHaveLength(1);
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(before);
    const snapshot = await fixture.store.readSnapshot();
    const proposal = snapshot.domain.revisionProposals[0]!;
    expect(proposal).toMatchObject({
      knowledge_id: KNOWLEDGE_A,
      status: "pending",
    });
    const patchDetail = proposal.patch.detail!;
    expect(parseKnowledgeBodyCodeExample(patchDetail)).toEqual({
      code_example: {
        content: "const result = await invoke();",
        evidence_comment_ids: [ROOT_COMMENT_ID],
        generated_example: true,
        language: "typescript",
      },
      detail: "Canonical detail",
    });
  }, 15_000);

  it("drops a stored example once the redistilled candidate no longer grounds one", async () => {
    const fixture = await createFixture({
      evidenceKnowledgeIds: [KNOWLEDGE_A],
      knowledge: [
        knowledge(KNOWLEDGE_A, {
          detail: renderKnowledgeBodyWithCodeExample("Canonical detail", {
            content: "const result = await invoke();",
            evidence_comment_ids: [ROOT_COMMENT_ID],
            generated_example: true,
            language: "typescript",
          }),
          rule: "Keep the canonical rule",
        }),
      ],
    });
    const before = await knowledgeBytes(fixture.root, KNOWLEDGE_A);
    const candidates = [
      candidate(CANDIDATE_A, "Keep the canonical rule", {
        detail: "Canonical detail",
        evidence_comment_ids: [ROOT_COMMENT_ID],
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    const result = await finalizer(fixture.store).finalize({
      ...sourceBinding(),
      candidates: search.candidates,
      decisions: [same(CANDIDATE_A, KNOWLEDGE_A)],
      expected_match_set_digest: search.match_set_digest,
      lease: lease(),
      provenance: provenance(),
    });

    expect(result.revision_proposals).toHaveLength(1);
    expect(await knowledgeBytes(fixture.root, KNOWLEDGE_A)).toEqual(before);
    const proposal = (await fixture.store.readSnapshot()).domain
      .revisionProposals[0]!;
    expect(proposal.patch).toEqual({ detail: "Canonical detail" });
    expect(proposal.patch.detail).not.toContain("generated_example");
  }, 15_000);

  it("rejects a code example whose content is not grounded in its cited evidence", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [
      candidate(CANDIDATE_A, "Reject fabricated example content", {
        code_example: {
          content: "superMagicFramework.doEverything();",
          evidence_comment_ids: [ROOT_COMMENT_ID],
          generated_example: true,
          language: "typescript",
        },
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    await expect(
      finalizer(fixture.store).finalize({
        ...sourceBinding(),
        candidates: search.candidates,
        decisions: [different(CANDIDATE_A)],
        expected_match_set_digest: search.match_set_digest,
        lease: lease(),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_COMMENTS_INVALID",
      message: expect.stringContaining(
        "code_example content references tokens absent from its cited evidence: doEverything, superMagicFramework",
      ),
    });

    const after = await fixture.store.readSnapshot();
    expect(after.domain.knowledge).toHaveLength(0);
    expect(jobState(after)).toBe("awaiting_finalize");
  }, 15_000);

  it("rejects code example evidence outside the current snapshot before writing", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [
      candidate(CANDIDATE_A, "Reject ungrounded code examples", {
        code_example: {
          content: "const result = await invoke();",
          evidence_comment_ids: ["comment-from-old-snapshot"],
          generated_example: true,
          language: "typescript",
        },
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);

    await expect(
      finalizer(fixture.store).finalize({
        ...sourceBinding(),
        candidates: search.candidates,
        decisions: [different(CANDIDATE_A)],
        expected_match_set_digest: search.match_set_digest,
        lease: lease(),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_COMMENTS_INVALID",
    });

    const after = await fixture.store.readSnapshot();
    expect(after.domain.knowledge).toHaveLength(0);
    expect(jobState(after)).toBe("awaiting_finalize");
  }, 15_000);

  it("rejects evidence comment IDs outside the current complete snapshot before writing", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [
      candidate(CANDIDATE_A, "Reject stale evidence IDs", {
        evidence_comment_ids: ["comment-from-old-snapshot"],
      }),
    ];
    const search = await mergeSearch(fixture.store, candidates);
    const before = await fixture.store.readSnapshot();

    await expect(
      finalizer(fixture.store).finalize({
        ...sourceBinding(),
        candidates: search.candidates,
        decisions: [different(CANDIDATE_A)],
        expected_match_set_digest: search.match_set_digest,
        lease: lease(),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_COMMENTS_INVALID",
    });

    const after = await fixture.store.readSnapshot();
    expect(after.records).toHaveLength(before.records.length);
    expect(after.domain.knowledge).toHaveLength(0);
    expect(jobState(after)).toBe("awaiting_finalize");
  }, 15_000);

  it("rejects a changed match set without any canonical write", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [candidate(CANDIDATE_A, "Detect concurrent duplicates")];
    const search = await mergeSearch(fixture.store, candidates);
    await writeKnowledge(
      fixture.root,
      knowledge(KNOWLEDGE_A, { rule: "Detect concurrent duplicates" }),
    );

    await expect(
      finalizer(fixture.store).finalize({
        ...sourceBinding(),
        candidates: search.candidates,
        decisions: [different(CANDIDATE_A)],
        expected_match_set_digest: search.match_set_digest,
        lease: lease(),
        provenance: provenance(),
      }),
    ).rejects.toMatchObject({
      code: "MERGE_CANDIDATES_CHANGED",
      currentSearch: expect.objectContaining({
        possible_matches: [
          expect.objectContaining({
            possible_matches: [
              expect.objectContaining({ knowledge_id: KNOWLEDGE_A }),
            ],
          }),
        ],
      }),
    });
    expect(jobState(await fixture.store.readSnapshot())).toBe(
      "awaiting_finalize",
    );
  });

  it("recovers one finalize transaction after a failure past prepared", async () => {
    const fixture = await createFixture({ knowledge: [] });
    const candidates = [candidate(CANDIDATE_A, "Recover canonical finalize")];
    const search = await mergeSearch(fixture.store, candidates);
    let failed = false;
    const crashingStore = new CanonicalTransactionStore(fixture.root, {
      faultInjector(point) {
        if (!failed && point === "after_prepared") {
          failed = true;
          throw new Error("simulated finalize crash");
        }
      },
    });

    await expect(
      finalizer(crashingStore).finalize({
        ...sourceBinding(),
        candidates: search.candidates,
        decisions: [different(CANDIDATE_A)],
        expected_match_set_digest: search.match_set_digest,
        lease: lease(),
        provenance: provenance(),
      }),
    ).rejects.toThrow("simulated finalize crash");

    const recovered = await new CanonicalTransactionStore(
      fixture.root,
    ).readSnapshot();
    expect(jobState(recovered)).toBe("done");
    expect(recovered.domain.knowledge).toEqual([
      expect.objectContaining({ status: "proposed" }),
    ]);
    expect(recovered.domain.evidence).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
  });
});

interface KnowledgeFixture {
  readonly activation?: Readonly<Record<string, unknown>>;
  readonly category: "test";
  readonly detail: string;
  readonly id: string;
  readonly origin?: Readonly<Record<string, unknown>>;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: "should";
  readonly status: KnowledgeStatus;
}

interface Fixture {
  readonly evidenceIds: readonly string[];
  readonly root: string;
  readonly store: CanonicalTransactionStore;
}

async function createFixture(input: {
  readonly evidenceKnowledgeIds?: readonly string[];
  readonly knowledge: readonly KnowledgeFixture[];
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rkm-finalize-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "knowledge"), { recursive: true });
  for (const item of input.knowledge) await writeKnowledge(root, item);

  const transactionId = TRANSACTION_ID;
  const records: CanonicalJsonlRecord[] = [
    canonicalRecord("PullRequestSnapshot", snapshot(), transactionId),
    canonicalRecord("ThreadObservation", thread(), transactionId),
    ...comments().map((comment) =>
      canonicalRecord("CommentObservation", comment, transactionId),
    ),
  ];
  const evidenceIds = (input.evidenceKnowledgeIds ?? []).map(
    (knowledgeId, index) => {
      const evidenceId = createDomainId("evidence", 10_000 + index);
      records.push(
        canonicalRecord(
          "EvidenceCreated",
          evidence(knowledgeId, evidenceId),
          transactionId,
        ),
      );
      return evidenceId;
    },
  );
  records.push(...jobRecords(transactionId));
  const store = new CanonicalTransactionStore(root);
  await store.commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath: "events/seed.jsonl",
    })),
    createdAt: AWAITING_AT,
    fileWrites: [],
    transactionId,
  });
  return { evidenceIds, root, store };
}

function knowledge(
  id: string,
  overrides: Partial<KnowledgeFixture> = {},
): KnowledgeFixture {
  return {
    activation: { origin: "automatic", pinned: false },
    category: "test",
    detail: "Canonical detail",
    id,
    origin: { type: "distilled" },
    rule: "Canonical rule",
    scope: ["src/**"],
    severity: "should",
    status: "active",
    ...overrides,
  };
}

async function writeKnowledge(
  root: string,
  input: KnowledgeFixture,
): Promise<void> {
  const path = `knowledge/${input.id}.md`;
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      {
        ...(input.activation === undefined
          ? {}
          : { activation: input.activation }),
        category: input.category,
        created_at: CREATED_AT,
        id: input.id,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        related_ids: [],
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: input.scope,
        severity: input.severity,
        status: input.status,
        updated_at: CREATED_AT,
      },
      input.detail,
    ),
  );
}

function snapshot(): PullRequestSnapshot {
  return {
    complete: true,
    observed_at: OBSERVED_AT,
    pr_number: 25,
    repo_id: REPO_ID,
    review_summary_ids: [],
    snapshot_id: SNAPSHOT_ID,
    thread_ids: [THREAD_ID],
  };
}

function thread(): ThreadObservation {
  return {
    comment_ids: [ROOT_COMMENT_ID, BOT_COMMENT_ID],
    content_fingerprint: CONTENT_FINGERPRINT,
    is_outdated: false,
    is_resolved: false,
    observation_id: "obs_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    observation_type: "thread",
    observed_at: OBSERVED_AT,
    path: "src/index.ts",
    pr_number: 25,
    repo_id: REPO_ID,
    snapshot_id: SNAPSHOT_ID,
    state_fingerprint: STATE_FINGERPRINT,
    thread_id: THREAD_ID,
  };
}

function comments(): CommentObservation[] {
  return [
    {
      actor: {
        actor_id: "actor-alice",
        actor_kind: "user",
        author_association: "MEMBER",
        login: "alice",
        provider: "human",
        trust: "trusted",
      },
      body: "Handle the Result of invoke() instead of ignoring the failure.",
      comment_id: ROOT_COMMENT_ID,
      created_at: "2026-08-06T00:01:00.000Z",
      observation_id: "obs_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      observation_type: "comment",
      observed_at: OBSERVED_AT,
      snapshot_id: SNAPSHOT_ID,
      thread_id: THREAD_ID,
      updated_at: "2026-08-06T00:01:00.000Z",
      url: "https://github.com/owner/repo/pull/25#discussion_r1",
    },
    {
      actor: {
        actor_id: "actor-greptile",
        actor_kind: "bot",
        author_association: "NONE",
        login: "greptile-apps[bot]",
        provider: "greptile",
        trust: "untrusted",
      },
      body: "Bot follow-up",
      comment_id: BOT_COMMENT_ID,
      created_at: "2026-08-06T00:02:00.000Z",
      observation_id: "obs_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      observation_type: "comment",
      observed_at: OBSERVED_AT,
      snapshot_id: SNAPSHOT_ID,
      thread_id: THREAD_ID,
      updated_at: "2026-08-06T00:02:00.000Z",
      url: "https://github.com/owner/repo/pull/25#discussion_r2",
    },
  ];
}

function evidence(knowledgeId: string, evidenceId: string): KnowledgeEvidence {
  const root = comments()[0]!;
  const actor = {
    actor_id: root.actor.actor_id,
    actor_kind: root.actor.actor_kind,
    comment_id: root.comment_id,
    login: root.actor.login!,
    provider: root.actor.provider,
    trust: root.actor.trust,
  };
  return {
    actors: [actor],
    author_association: root.actor.author_association,
    comment_ids: [ROOT_COMMENT_ID],
    content_fingerprint: `sha256:${"0".repeat(64)}`,
    eligible_for_count: true,
    evidence_id: evidenceId,
    knowledge_id: knowledgeId,
    observed_at: CREATED_AT,
    occurrence_key: `${knowledgeId}:${THREAD_ID}`,
    originator: actor,
    path: "src/index.ts",
    pr_number: 25,
    repo_id: REPO_ID,
    sources: ["human"],
    state_fingerprint: STATE_FINGERPRINT,
    status: "active",
    thread_id: THREAD_ID,
    url: root.url,
  };
}

function jobRecords(transactionId: string): CanonicalJsonlRecord[] {
  return [
    createDistillationJobEventRecord({
      eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      payload: {
        distillation_key: DISTILLATION_KEY,
        job_id: JOB_ID,
        repo_id: REPO_ID,
        thread_id: THREAD_ID,
      },
      recordedAt: CREATED_AT,
      transactionId,
      type: "DistillationJobCreated",
    }),
    createDistillationJobEventRecord({
      eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      payload: {
        job_id: JOB_ID,
        lease_expires_at: LEASE_EXPIRES_AT,
        lease_generation: 1,
        lease_token_hash: hashLeaseToken(TOKEN),
      },
      recordedAt: LEASED_AT,
      transactionId,
      type: "DistillationJobLeased",
    }),
    createDistillationJobEventRecord({
      eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      payload: { job_id: JOB_ID, lease_generation: 1 },
      recordedAt: AWAITING_AT,
      transactionId,
      type: "DistillationJobAwaitingFinalize",
    }),
  ];
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  transactionId: string,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    record_id: createDomainId("event", 20_000),
    record_type: recordType,
    recorded_at: OBSERVED_AT,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

function candidate(
  candidateId: string,
  rule: string,
  overrides: Partial<DomainExtractCandidate["candidate"]> = {},
): DomainExtractCandidate {
  return {
    candidate: {
      category: "test",
      confidence: 0.9,
      detail: "Canonical detail",
      evidence_comment_ids: [ROOT_COMMENT_ID],
      rule,
      scope: ["src/**"],
      severity: "should",
      ...overrides,
    },
    candidate_id: candidateId,
  };
}

async function mergeSearch(
  store: CanonicalTransactionStore,
  candidates: readonly DomainExtractCandidate[],
) {
  return new MergeCandidateSearchService({
    repoId: REPO_ID,
    repository: store,
  }).search({ candidates, threadId: THREAD_ID });
}

function finalizer(
  store: CanonicalTransactionStore,
  autoActivationPolicy?: TrustedHumanAutoActivationPolicyLike,
): CanonicalFinalizeService {
  return new CanonicalFinalizeService({
    ...(autoActivationPolicy === undefined ? {} : { autoActivationPolicy }),
    now: () => new Date(FINALIZED_AT),
    repoId: REPO_ID,
    repository: store,
  });
}

function sourceBinding() {
  return {
    content_fingerprint: CONTENT_FINGERPRINT,
    distillation_key: DISTILLATION_KEY,
    thread_id: THREAD_ID,
  } as const;
}

function lease() {
  return {
    job_id: JOB_ID,
    lease_generation: 1,
    lease_token: TOKEN,
  } as const;
}

function provenance(): DistillationProvenance {
  return {
    distillation_key: DISTILLATION_KEY,
    model: "claude-test",
    output_schema_digest: OUTPUT_SCHEMA_DIGEST,
    output_schema_version: "distillation-output-v1",
    prompt_digest: PROMPT_DIGEST,
    prompt_version: "distill-v1",
    provider: "anthropic",
    trust_policy_digest: TRUST_POLICY_DIGEST,
  };
}

function same(candidateId: string, targetId: string): MergeDecision {
  return { candidate_id: candidateId, relation: "same", target_id: targetId };
}

function overlaps(candidateId: string, targetId: string): MergeDecision {
  return {
    candidate_id: candidateId,
    relation: "overlaps",
    target_id: targetId,
  };
}

function different(candidateId: string): MergeDecision {
  return { candidate_id: candidateId, relation: "different" };
}

async function knowledgeBytes(root: string, knowledgeId: string) {
  return readFile(join(root, "knowledge", `${knowledgeId}.md`));
}

function jobState(
  snapshot: Awaited<ReturnType<CanonicalTransactionStore["readSnapshot"]>>,
) {
  return snapshot.domain.distillJobs.find((job) => job.job_id === JOB_ID)
    ?.state;
}

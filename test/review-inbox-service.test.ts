import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdminPlaneService,
  CanonicalTransactionStore,
  KnowledgeReadService,
  ReviewInboxService,
  canonicalizeJson,
  captureCanonicalStateReadOnly,
  createDomainId,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type KnowledgeEvidence,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
  type ReviewInboxDetailReader,
  type Severity,
} from "../src/index.js";

const REPO = "owner/repository";
const REPO_ID = "R_review_inbox";
const PROPOSED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STALE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ACTIVE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const REJECTED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const DEPRECATED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const DRIFT_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROPOSED_EVIDENCE_ID = "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STALE_EVIDENCE_ID = "ev_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REVISION_EVIDENCE_ID = "ev_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROPOSAL_ID = "proposal-inbox-pending";
const RESOLVED_PROPOSAL_ID = "proposal-inbox-resolved";
const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T00:01:00.000Z";
const T2 = "2026-08-06T00:02:00.000Z";
const T3 = "2026-08-06T00:03:00.000Z";
const T4 = "2026-08-06T00:04:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const temporaryRepositories: string[] = [];

interface Fixture {
  readonly admin: AdminPlaneService;
  readonly root: string;
  readonly service: ReviewInboxService;
  readonly store: CanonicalTransactionStore;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ReviewInboxService", () => {
  it("unifies candidate knowledge and pending revisions with approval context", async () => {
    const fixture = await createFixture();

    const result = await fixture.service.list({ limit: 10 });

    expect(result.total_count).toBe(3);
    expect(result.next_cursor).toBeNull();
    expect(result.items.map((item) => item.item_id)).toEqual([
      PROPOSED_ID,
      STALE_ID,
      PROPOSAL_ID,
    ]);
    expect(result.items[0]).toMatchObject({
      evidence: [
        {
          evidence_id: PROPOSED_EVIDENCE_ID,
          url: "https://github.com/owner/repository/pull/1#discussion_r1",
        },
      ],
      kind: "knowledge",
      knowledge_status: "proposed",
      origin: { model: "test-model", type: "distilled" },
      possible_matches: [expect.objectContaining({ id: ACTIVE_ID })],
      proposal_id: null,
      related_ids: [ACTIVE_ID],
      severity: "must",
      sources: ["greptile"],
      status: "proposed",
      trust_classes: ["untrusted"],
    });
    expect(result.items[2]).toMatchObject({
      detail: "Apply the proposed revision detail.",
      evidence: [
        expect.objectContaining({ evidence_id: REVISION_EVIDENCE_ID }),
      ],
      kind: "revision_proposal",
      knowledge_id: ACTIVE_ID,
      knowledge_status: "active",
      proposal_id: PROPOSAL_ID,
      proposal_patch: {
        detail: "Apply the proposed revision detail.",
        rule: "Validate inbox cursor updates",
        scope: ["src/review/**"],
        severity: "consider",
      },
      rule: "Validate inbox cursor updates",
      severity: "consider",
      sources: ["human"],
      status: "pending",
      trust_classes: ["trusted"],
    });
  });

  it("applies kind, source, and severity filters before pagination", async () => {
    const fixture = await createFixture();

    const revision = await fixture.service.list({
      kind: "revision_proposal",
    });
    const greptile = await fixture.service.list({ source: "greptile" });
    const should = await fixture.service.list({ severity: "should" });

    expect(revision.items.map((item) => item.item_id)).toEqual([PROPOSAL_ID]);
    expect(greptile.items.map((item) => item.item_id)).toEqual([PROPOSED_ID]);
    expect(should.items.map((item) => item.item_id)).toEqual([STALE_ID]);
  });

  it("paginates without gaps or duplicates and binds cursors to filters and state", async () => {
    const fixture = await createFixture();
    const ids: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await fixture.service.list({
        ...(cursor === undefined ? {} : { cursor }),
        limit: 1,
      });
      ids.push(...page.items.map((item) => item.item_id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);

    expect(ids).toEqual([PROPOSED_ID, STALE_ID, PROPOSAL_ID]);
    expect(new Set(ids).size).toBe(ids.length);

    const first = await fixture.service.list({ limit: 1 });
    await expect(
      fixture.service.list({ cursor: first.next_cursor!, kind: "knowledge" }),
    ).rejects.toMatchObject({ code: "INVALID_REVIEW_INBOX_CURSOR" });

    await writeKnowledge(fixture.root, {
      createdAt: T4,
      id: DRIFT_ID,
      rule: "New candidate invalidates an old page cursor",
      status: "proposed",
    });
    await expect(
      fixture.service.list({ cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "REVIEW_INBOX_CURSOR_STALE" });
  });

  it("retries a projection drift and returns one stable generation", async () => {
    const fixture = await createFixture();
    let changed = false;
    const driftingDetails: ReviewInboxDetailReader = {
      async getKnowledgeReview(id) {
        const review = await fixture.admin.getKnowledgeReview(id);
        if (!changed) {
          changed = true;
          await writeKnowledge(fixture.root, {
            createdAt: T4,
            id: DRIFT_ID,
            rule: "Candidate added during the first projection read",
            status: "proposed",
          });
        }
        return review;
      },
      getRevisionProposalReview: (id) =>
        fixture.admin.getRevisionProposalReview(id),
    };
    const service = inbox(fixture.store, driftingDetails);

    const result = await service.list({ limit: 10 });

    expect(changed).toBe(true);
    expect(result.total_count).toBe(4);
    expect(result.items.map((item) => item.item_id)).toEqual([
      PROPOSED_ID,
      STALE_ID,
      PROPOSAL_ID,
      DRIFT_ID,
    ]);
  });

  it("does not change canonical data or the logical projection", async () => {
    const fixture = await createFixture();
    const knowledgeReads = new KnowledgeReadService({
      repo: REPO,
      repoId: REPO_ID,
      repository: fixture.store,
    });
    const beforeCanonical = await captureCanonicalStateReadOnly(fixture.root);
    const beforeProjection = await fixture.store.readSnapshot();
    const beforeRules = await knowledgeReads.getRules({
      filePaths: ["src/review-inbox-service.ts"],
    });

    await fixture.service.list({ limit: 10 });

    const afterCanonical = await captureCanonicalStateReadOnly(fixture.root);
    const afterProjection = await fixture.store.readSnapshot();
    const afterRules = await knowledgeReads.getRules({
      filePaths: ["src/review-inbox-service.ts"],
    });
    expect(canonicalizeJson(afterCanonical)).toBe(
      canonicalizeJson(beforeCanonical),
    );
    expect(afterProjection.canonicalDigest).toBe(
      beforeProjection.canonicalDigest,
    );
    expect(canonicalizeJson(afterProjection.domain)).toBe(
      canonicalizeJson(beforeProjection.domain),
    );
    expect(afterRules).toEqual(beforeRules);
    expect(afterRules).toMatchObject({
      matched_count: 1,
      readiness: { state: "ready" },
      rules: [expect.objectContaining({ id: ACTIVE_ID })],
    });
  });

  it("returns an empty page and fails closed for an invalid proposal projection", async () => {
    const emptyRoot = await createRoot();
    const emptyStore = new CanonicalTransactionStore(emptyRoot);
    const emptyAdmin = admin(emptyStore);
    await expect(inbox(emptyStore, emptyAdmin).list()).resolves.toEqual({
      items: [],
      next_cursor: null,
      repo: REPO,
      total_count: 0,
    });

    const invalidRoot = await createRoot();
    await writeKnowledge(invalidRoot, {
      createdAt: T0,
      id: ACTIVE_ID,
      rule: "Invalid proposal target",
      status: "active",
    });
    await writeRecords(invalidRoot, [
      canonicalRecord(
        "KnowledgeRevisionProposal",
        revisionProposal({ evidenceIds: [REVISION_EVIDENCE_ID] }),
        T2,
      ),
    ]);
    const invalidStore = new CanonicalTransactionStore(invalidRoot);

    await expect(
      inbox(invalidStore, admin(invalidStore)).list(),
    ).rejects.toMatchObject({ code: "REVIEW_INBOX_PROJECTION_INVALID" });
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await createRoot();
  await writeKnowledge(root, {
    createdAt: T0,
    detail: "Review the untrusted candidate.",
    id: PROPOSED_ID,
    origin: { model: "test-model", type: "distilled" },
    relatedIds: [ACTIVE_ID],
    rule: "Validate inbox cursor binding",
    severity: "must",
    status: "proposed",
  });
  await writeKnowledge(root, {
    createdAt: T1,
    id: STALE_ID,
    rule: "Keep stale inbox entries visible",
    severity: "should",
    status: "stale",
  });
  await writeKnowledge(root, {
    createdAt: T0,
    id: ACTIVE_ID,
    origin: { type: "manual" },
    rule: "Validate inbox cursor binding",
    severity: "should",
    status: "active",
  });
  await writeKnowledge(root, {
    createdAt: T2,
    id: REJECTED_ID,
    rule: "Rejected entries stay hidden",
    status: "rejected",
  });
  await writeKnowledge(root, {
    createdAt: T2,
    id: DEPRECATED_ID,
    rule: "Deprecated entries stay hidden",
    status: "deprecated",
  });
  await writeRecords(root, [
    canonicalRecord(
      "EvidenceCreated",
      evidence({
        evidenceId: PROPOSED_EVIDENCE_ID,
        knowledgeId: PROPOSED_ID,
        provider: "greptile",
        trust: "untrusted",
        url: "https://github.com/owner/repository/pull/1#discussion_r1",
      }),
      T0,
    ),
    canonicalRecord(
      "EvidenceCreated",
      evidence({
        evidenceId: STALE_EVIDENCE_ID,
        knowledgeId: STALE_ID,
        provider: "human",
        trust: "trusted",
      }),
      T1,
    ),
    canonicalRecord(
      "EvidenceCreated",
      evidence({
        evidenceId: REVISION_EVIDENCE_ID,
        knowledgeId: ACTIVE_ID,
        provider: "human",
        trust: "trusted",
      }),
      T2,
    ),
    canonicalRecord("KnowledgeRevisionProposal", revisionProposal(), T2),
    canonicalRecord(
      "KnowledgeRevisionProposal",
      revisionProposal({
        proposalId: RESOLVED_PROPOSAL_ID,
        status: "approved",
      }),
      T3,
    ),
  ]);
  const store = new CanonicalTransactionStore(root);
  const reviewAdmin = admin(store);
  return {
    admin: reviewAdmin,
    root,
    service: inbox(store, reviewAdmin),
    store,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rkm-review-inbox-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "events"), { recursive: true });
  await mkdir(join(root, "knowledge"), { recursive: true });
  return root;
}

function admin(store: CanonicalTransactionStore): AdminPlaneService {
  return new AdminPlaneService({
    repo: REPO,
    repoId: REPO_ID,
    repository: store,
  });
}

function inbox(
  store: CanonicalTransactionStore,
  details: ReviewInboxDetailReader,
): ReviewInboxService {
  return new ReviewInboxService({
    details,
    repo: REPO,
    repoId: REPO_ID,
    repository: store,
  });
}

interface KnowledgeInput {
  readonly createdAt: string;
  readonly detail?: string;
  readonly id: string;
  readonly origin?: Readonly<Record<string, unknown>>;
  readonly relatedIds?: readonly string[];
  readonly rule: string;
  readonly severity?: Severity;
  readonly status: KnowledgeStatus;
}

async function writeKnowledge(
  root: string,
  input: KnowledgeInput,
): Promise<void> {
  const path = `knowledge/${input.id}.md`;
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: "architecture",
        created_at: input.createdAt,
        id: input.id,
        origin: input.origin ?? { type: "distilled" },
        related_ids: input.relatedIds ?? [],
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: ["src/**"],
        severity: input.severity ?? "should",
        status: input.status,
        updated_at: input.createdAt,
      },
      input.detail ?? "Review inbox fixture detail.\n",
    ),
  );
}

function evidence(input: {
  readonly evidenceId: string;
  readonly knowledgeId: string;
  readonly provider: "greptile" | "human";
  readonly trust: "trusted" | "untrusted";
  readonly url?: string;
}): KnowledgeEvidence {
  const actor = {
    actor_id: `actor-${input.evidenceId}`,
    actor_kind:
      input.provider === "human" ? ("user" as const) : ("bot" as const),
    comment_id: `comment-${input.evidenceId}`,
    login: input.provider === "human" ? "alice" : "greptile-apps[bot]",
    provider: input.provider,
    trust: input.trust,
  };
  return {
    actors: [actor],
    comment_ids: [actor.comment_id],
    content_fingerprint: HASH_A,
    eligible_for_count: true,
    evidence_id: input.evidenceId,
    knowledge_id: input.knowledgeId,
    observed_at: T2,
    occurrence_key: `${input.knowledgeId}:${input.evidenceId}`,
    originator: actor,
    pr_number: 1,
    repo_id: REPO_ID,
    sources: [input.provider],
    state_fingerprint: HASH_B,
    status: "active",
    thread_id: `thread-${input.evidenceId}`,
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

function revisionProposal(
  overrides: {
    readonly evidenceIds?: readonly string[];
    readonly proposalId?: string;
    readonly status?: KnowledgeRevisionProposal["status"];
  } = {},
): KnowledgeRevisionProposal {
  return {
    created_at: T2,
    evidence_ids: [...(overrides.evidenceIds ?? [REVISION_EVIDENCE_ID])],
    knowledge_id: ACTIVE_ID,
    patch: {
      detail: "Apply the proposed revision detail.",
      rule: "Validate inbox cursor updates",
      scope: ["src/review/**"],
      severity: "consider",
    },
    proposal_id: overrides.proposalId ?? PROPOSAL_ID,
    repo_id: REPO_ID,
    status: overrides.status ?? "pending",
    updated_at: T2,
  };
}

async function writeRecords(
  root: string,
  records: readonly CanonicalJsonlRecord[],
): Promise<void> {
  await writeFile(
    join(root, "events", "review-inbox.jsonl"),
    Buffer.concat(
      records.map((record) => serializeCanonicalJsonlRecord(record)),
    ),
  );
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  recordedAt: string,
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

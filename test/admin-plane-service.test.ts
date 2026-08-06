import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdminPlaneService,
  CanonicalTransactionStore,
  KnowledgeReadService,
  createDomainId,
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type AdminTerminal,
  type CanonicalJsonlRecord,
  type KnowledgeEvidence,
  type KnowledgeRevisionProposal,
  type KnowledgeStatus,
} from "../src/index.js";

const NOW = "2026-08-06T01:00:00.000Z";
const CREATED_AT = "2026-08-06T00:00:00.000Z";
const REPO = "owner/repository";
const REPO_ID = "repo-admin";
const PROPOSED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STALE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ACTIVE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ADDED_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const EVIDENCE_ID = "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROPOSAL_ID = "proposal-admin-1";
const SEED_TRANSACTION_ID = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("AdminPlaneService review views", () => {
  it("lists proposed, stale, and pending revisions with complete approval context", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ answers: ["cancel"] });
    const admin = service(fixture.store, terminal);

    const queue = await admin.listReviewQueue();
    const review = await admin.getKnowledgeReview(PROPOSED_ID);
    const cancelled = await admin.approve(PROPOSED_ID);

    expect(queue.knowledge.map((item) => [item.id, item.status])).toEqual([
      [PROPOSED_ID, "proposed"],
      [STALE_ID, "stale"],
    ]);
    expect(queue.revision_proposals).toEqual([
      {
        knowledge_id: ACTIVE_ID,
        proposal_id: PROPOSAL_ID,
        updated_at: CREATED_AT,
      },
    ]);
    expect(review).toMatchObject({
      etag: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evidence: [
        {
          actors: [
            expect.objectContaining({
              login: "greptile-apps[bot]",
              provider: "greptile",
              trust: "untrusted",
            }),
          ],
          url: "https://github.com/owner/repository/pull/1#discussion_r1",
        },
      ],
      id: PROPOSED_ID,
      origin: { model: "test-model", provider: "anthropic", type: "distilled" },
      possible_matches: [expect.objectContaining({ id: ACTIVE_ID })],
      related_ids: [ACTIVE_ID],
      revision: 1,
      severity: "must",
      status: "proposed",
    });
    expect(cancelled).toEqual({ confirmed: false });
    const screen = terminal.output.join("");
    expect(screen).toContain("Rule:");
    expect(screen).toContain("Severity:");
    expect(screen).toContain("Scope:");
    expect(screen).toContain("discussion_r1");
    expect(screen).toContain("Actor trust:");
    expect(screen).toContain("Origin:");
    expect(screen).toContain("Related IDs:");
    expect(screen).toContain("Possible matches:");
    expect(screen).not.toContain("\u001b");
    expect(screen).not.toContain("\u009b");
    expect(screen).not.toContain("\u202e");
    expect(screen).toContain("\\u001b[2J");
    expect(screen).toContain("\\u009b31m");
    expect(screen).toContain("\\u202e");
  });
});

describe("AdminPlaneService TTY boundary", () => {
  it.each([
    { inputIsTTY: false, outputIsTTY: true },
    { inputIsTTY: true, outputIsTTY: false },
    { inputIsTTY: false, outputIsTTY: false },
  ])("rejects non-interactive input/output %#", async (terminalState) => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({
      answers: [`approve ${PROPOSED_ID}`],
      ...terminalState,
    });

    await expect(
      service(fixture.store, terminal).approve(PROPOSED_ID),
    ).rejects.toMatchObject({
      code: "TTY_REQUIRED",
    });
    expect(terminal.output).toEqual([]);
    expect(statusOf(await fixture.store.readSnapshot(), PROPOSED_ID)).toBe(
      "proposed",
    );
  });

  it("does not mutate on an inexact confirmation phrase", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ answers: ["yes"] });

    const result = await service(fixture.store, terminal).approve(PROPOSED_ID);

    expect(result).toEqual({ confirmed: false });
    expect(statusOf(await fixture.store.readSnapshot(), PROPOSED_ID)).toBe(
      "proposed",
    );
  });

  it("guards every admin mutation before reading confirmation input", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ inputIsTTY: false, outputIsTTY: true });
    const admin = service(fixture.store, terminal);
    const mutations = [
      () => admin.approve(PROPOSED_ID),
      () => admin.reject(PROPOSED_ID),
      () => admin.edit(PROPOSED_ID, { rule: "Blocked edit" }),
      () => admin.approveRevision(PROPOSAL_ID),
      () =>
        admin.addActive({
          category: "test",
          detail: "Blocked add",
          rule: "Blocked add",
          scope: [],
          severity: "should",
        }),
    ];

    for (const mutate of mutations) {
      await expect(mutate()).rejects.toMatchObject({ code: "TTY_REQUIRED" });
    }
    expect(terminal.output).toEqual([]);
    expect(statusOf(await fixture.store.readSnapshot(), PROPOSED_ID)).toBe(
      "proposed",
    );
  });
});

describe("AdminPlaneService knowledge mutations", () => {
  it("approves a reviewed proposed rule and marks human activation", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({
      answers: [`approve ${PROPOSED_ID}`],
    });

    const result = await service(fixture.store, terminal).approve(PROPOSED_ID);

    expect(result).toMatchObject({
      confirmed: true,
      value: {
        frontmatter: {
          activation: { origin: "human", pinned: false },
          status: "active",
        },
        revision: 2,
      },
    });
    await expect(
      readService(fixture.store).getKnowledge({ id: PROPOSED_ID }),
    ).resolves.toMatchObject({
      knowledge: { id: PROPOSED_ID, revision: 2 },
    });
  });

  it.each(["approve", "edit"] as const)(
    "detects exact-byte CAS conflicts for %s after the confirmation screen",
    async (action) => {
      const fixture = await createFixture();
      const expected =
        action === "approve" ? `approve ${PROPOSED_ID}` : `edit ${PROPOSED_ID}`;
      const terminal = new FakeTerminal({
        answers: [expected],
        beforeRead: async () => directHumanEdit(fixture.root, PROPOSED_ID),
      });
      const admin = service(fixture.store, terminal);
      const mutation =
        action === "approve"
          ? admin.approve(PROPOSED_ID)
          : admin.edit(PROPOSED_ID, { rule: "Admin tool edit" });

      await expect(mutation).rejects.toMatchObject({
        code: "KNOWLEDGE_CONFLICT",
        current: { frontmatter: { rule: "Human direct edit" }, revision: 1 },
      });
      const persisted = parseKnowledgeDocument(
        `knowledge/${PROPOSED_ID}.md`,
        await knowledgeBytes(fixture.root, PROPOSED_ID),
      );
      expect(persisted.frontmatter.rule).toBe("Human direct edit");
      expect(persisted.revision).toBe(1);
    },
  );

  it("edits active knowledge only after displaying the patch", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ answers: [`edit ${ACTIVE_ID}`] });

    const result = await service(fixture.store, terminal).edit(ACTIVE_ID, {
      detail: "Human-approved detail",
      rule: "Human-approved active rule",
      scope: ["src/admin/**"],
      severity: "should",
    });

    expect(result).toMatchObject({
      confirmed: true,
      value: {
        body: expect.stringContaining("Human-approved detail"),
        frontmatter: {
          rule: "Human-approved active rule",
          scope: ["src/admin/**"],
          severity: "should",
          status: "active",
        },
        revision: 2,
      },
    });
    expect(terminal.output.join("")).toContain(
      '"rule":"Human-approved active rule"',
    );
  });

  it("rejects a proposed rule and excludes it from ordinary reads", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ answers: [`reject ${PROPOSED_ID}`] });
    const admin = service(fixture.store, terminal);

    const result = await admin.reject(PROPOSED_ID);
    const search = await readService(fixture.store).searchKnowledge({
      query: "Approve secure updates",
    });

    expect(result).toMatchObject({
      confirmed: true,
      value: { frontmatter: { status: "rejected" }, revision: 2 },
    });
    expect(search.results.map((item) => item.id)).not.toContain(PROPOSED_ID);
    await expect(
      readService(fixture.store).getKnowledge({ id: PROPOSED_ID }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
  });

  it("adds active manual knowledge only through the confirmed TTY flow", async () => {
    const fixture = await createFixture();
    const terminal = new FakeTerminal({ answers: ["add --active"] });
    const admin = service(fixture.store, terminal, {
      nextKnowledgeId: () => ADDED_ID,
    });

    const result = await admin.addActive({
      category: "architecture",
      detail: "A manually curated rule",
      related_ids: [ACTIVE_ID],
      rule: "Keep admin mutations explicit",
      scope: ["src/admin/**"],
      severity: "must",
    });

    expect(result).toMatchObject({
      confirmed: true,
      value: {
        frontmatter: {
          activation: { origin: "human", pinned: false },
          id: ADDED_ID,
          origin: { type: "manual" },
          related_ids: [ACTIVE_ID],
          status: "active",
        },
        revision: 1,
      },
    });
    await expect(
      readService(fixture.store).getKnowledge({ id: ADDED_ID }),
    ).resolves.toMatchObject({
      knowledge: { id: ADDED_ID },
    });
  });
});

describe("AdminPlaneService revision proposals", () => {
  it("keeps active Markdown unchanged until approve-revision and commits both artifacts", async () => {
    const fixture = await createFixture();
    const before = await knowledgeBytes(fixture.root, ACTIVE_ID);
    const terminal = new FakeTerminal({
      answers: [`approve-revision ${PROPOSAL_ID}`],
    });
    const admin = service(fixture.store, terminal);
    const review = await admin.getRevisionProposalReview(PROPOSAL_ID);

    expect(await knowledgeBytes(fixture.root, ACTIVE_ID)).toEqual(before);
    expect(review.proposal.status).toBe("pending");
    const result = await admin.approveRevision(PROPOSAL_ID);

    expect(result).toMatchObject({
      confirmed: true,
      value: {
        body: expect.stringContaining("Approved revision detail"),
        frontmatter: {
          rule: "Approved revision rule",
          scope: ["src/revised/**"],
          severity: "must",
          status: "active",
        },
        revision: 2,
      },
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.revisionProposals).toEqual([
      expect.objectContaining({ proposal_id: PROPOSAL_ID, status: "approved" }),
    ]);
    const approvalRecord = snapshot.records.find(
      ({ record }) =>
        record.record_type === "KnowledgeRevisionProposalApproved",
    );
    expect(approvalRecord).toBeDefined();
  });

  it("rejects a proposal payload changed after the confirmation screen", async () => {
    const fixture = await createFixture();
    const before = await knowledgeBytes(fixture.root, ACTIVE_ID);
    const terminal = new FakeTerminal({
      answers: [`approve-revision ${PROPOSAL_ID}`],
      beforeRead: async () => replaceProposal(fixture.store),
    });

    await expect(
      service(fixture.store, terminal).approveRevision(PROPOSAL_ID),
    ).rejects.toMatchObject({ code: "REVISION_PROPOSAL_CHANGED" });

    expect(await knowledgeBytes(fixture.root, ACTIVE_ID)).toEqual(before);
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.revisionProposals).toEqual([
      expect.objectContaining({
        patch: { rule: "Unreviewed replacement" },
        proposal_id: PROPOSAL_ID,
        status: "pending",
      }),
    ]);
  });

  it("recovers the Markdown and proposal event together after prepared", async () => {
    const fixture = await createFixture();
    let failed = false;
    const crashingStore = new CanonicalTransactionStore(fixture.root, {
      faultInjector(point) {
        if (!failed && point === "after_prepared") {
          failed = true;
          throw new Error("simulated admin crash");
        }
      },
    });
    const terminal = new FakeTerminal({
      answers: [`approve-revision ${PROPOSAL_ID}`],
    });

    await expect(
      service(crashingStore, terminal).approveRevision(PROPOSAL_ID),
    ).rejects.toThrow("simulated admin crash");

    const recovered = await new CanonicalTransactionStore(
      fixture.root,
    ).readSnapshot();
    expect(
      recovered.domain.knowledge.find((item) => item.id === ACTIVE_ID),
    ).toMatchObject({ revision: 2, rule: "Approved revision rule" });
    expect(recovered.domain.revisionProposals).toEqual([
      expect.objectContaining({ proposal_id: PROPOSAL_ID, status: "approved" }),
    ]);
  });
});

class FakeTerminal implements AdminTerminal {
  readonly inputIsTTY: boolean;
  readonly output: string[] = [];
  readonly outputIsTTY: boolean;

  private readonly answers: string[];
  private readonly beforeRead: (() => Promise<void>) | undefined;

  constructor(options: {
    readonly answers?: readonly string[];
    readonly beforeRead?: () => Promise<void>;
    readonly inputIsTTY?: boolean;
    readonly outputIsTTY?: boolean;
  }) {
    this.answers = [...(options.answers ?? [])];
    this.beforeRead = options.beforeRead;
    this.inputIsTTY = options.inputIsTTY ?? true;
    this.outputIsTTY = options.outputIsTTY ?? true;
  }

  async readLine(): Promise<string> {
    await this.beforeRead?.();
    return this.answers.shift() ?? "";
  }

  write(value: string): void {
    this.output.push(value);
  }
}

interface Fixture {
  readonly root: string;
  readonly store: CanonicalTransactionStore;
}

interface KnowledgeInput {
  readonly activation?: Readonly<Record<string, unknown>>;
  readonly category?: "security" | "test";
  readonly detail?: string;
  readonly id: string;
  readonly origin?: Readonly<Record<string, unknown>>;
  readonly relatedIds?: readonly string[];
  readonly rule: string;
  readonly scope?: readonly string[];
  readonly severity?: "must" | "should";
  readonly status: KnowledgeStatus;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rkm-admin-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "knowledge"), { recursive: true });
  await writeKnowledge(root, {
    detail: "Untrusted \u001b[2J \u009b31m \u202e detail",
    id: PROPOSED_ID,
    origin: { model: "test-model", provider: "anthropic", type: "distilled" },
    relatedIds: [ACTIVE_ID],
    rule: "Approve secure updates",
    severity: "must",
    status: "proposed",
  });
  await writeKnowledge(root, {
    id: STALE_ID,
    rule: "Review stale knowledge",
    status: "stale",
  });
  await writeKnowledge(root, {
    activation: { origin: "human", pinned: false },
    id: ACTIVE_ID,
    origin: { type: "manual" },
    rule: "Approve secure updates",
    status: "active",
  });

  const store = new CanonicalTransactionStore(root);
  const records = [
    canonicalRecord("EvidenceCreated", evidence()),
    canonicalRecord("KnowledgeRevisionProposal", proposal()),
  ];
  await store.commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath: "events/seed.jsonl",
    })),
    createdAt: CREATED_AT,
    fileWrites: [],
    transactionId: SEED_TRANSACTION_ID,
  });
  return { root, store };
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
        activation: input.activation ?? { origin: "automatic", pinned: false },
        category: input.category ?? "security",
        created_at: CREATED_AT,
        id: input.id,
        origin: input.origin ?? { type: "distilled" },
        related_ids: input.relatedIds ?? [],
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: input.scope ?? ["src/**"],
        severity: input.severity ?? "should",
        status: input.status,
        updated_at: CREATED_AT,
      },
      input.detail ?? "Admin review detail",
    ),
  );
}

function evidence(): KnowledgeEvidence {
  const actor = {
    actor_id: "actor-greptile",
    actor_kind: "bot" as const,
    comment_id: "comment-admin-1",
    login: "greptile-apps[bot]",
    provider: "greptile" as const,
    trust: "untrusted" as const,
  };
  return {
    actors: [actor],
    author_association: "NONE",
    comment_ids: [actor.comment_id],
    content_fingerprint: HASH_A,
    eligible_for_count: true,
    evidence_id: EVIDENCE_ID,
    knowledge_id: PROPOSED_ID,
    observed_at: CREATED_AT,
    occurrence_key: `${PROPOSED_ID}:thread-admin`,
    originator: actor,
    path: "src/admin.ts",
    pr_number: 1,
    repo_id: REPO_ID,
    sources: ["greptile"],
    state_fingerprint: HASH_B,
    status: "active",
    thread_id: "thread-admin",
    url: "https://github.com/owner/repository/pull/1#discussion_r1",
  };
}

function proposal(): KnowledgeRevisionProposal {
  return {
    created_at: CREATED_AT,
    evidence_ids: [],
    knowledge_id: ACTIVE_ID,
    patch: {
      detail: "Approved revision detail",
      rule: "Approved revision rule",
      scope: ["src/revised/**"],
      severity: "must",
    },
    proposal_id: PROPOSAL_ID,
    repo_id: REPO_ID,
    status: "pending",
    updated_at: CREATED_AT,
  };
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    record_id: createDomainId("event", 10_000),
    record_type: recordType,
    recorded_at: CREATED_AT,
    schema_version: 1,
    transaction_id: SEED_TRANSACTION_ID,
  };
}

async function replaceProposal(
  store: CanonicalTransactionStore,
): Promise<void> {
  const transactionId = createDomainId("transaction", 30_000);
  const record: CanonicalJsonlRecord<KnowledgeRevisionProposal> = {
    payload: {
      ...proposal(),
      patch: { rule: "Unreviewed replacement" },
      updated_at: "2026-08-06T00:30:00.000Z",
    },
    record_id: createDomainId("event", 30_000),
    record_type: "KnowledgeRevisionProposal",
    recorded_at: "2026-08-06T00:30:00.000Z",
    schema_version: 1,
    transaction_id: transactionId,
  };
  await store.commit({
    appendRecords: [{ record, targetPath: "events/proposal-race.jsonl" }],
    createdAt: record.recorded_at,
    fileWrites: [],
    transactionId,
  });
}

function service(
  store: CanonicalTransactionStore,
  terminal: FakeTerminal,
  overrides: Partial<ConstructorParameters<typeof AdminPlaneService>[0]> = {},
): AdminPlaneService {
  return new AdminPlaneService({
    now: () => new Date(NOW),
    repo: REPO,
    repoId: REPO_ID,
    repository: store,
    terminal,
    ...overrides,
  });
}

function readService(store: CanonicalTransactionStore): KnowledgeReadService {
  return new KnowledgeReadService({
    repo: REPO,
    repoId: REPO_ID,
    repository: store,
  });
}

async function directHumanEdit(root: string, id: string): Promise<void> {
  const path = `knowledge/${id}.md`;
  const current = parseKnowledgeDocument(
    path,
    await readFile(join(root, path)),
  );
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      { ...current.frontmatter, rule: "Human direct edit" },
      current.body,
    ),
  );
}

async function knowledgeBytes(root: string, id: string): Promise<Buffer> {
  return readFile(join(root, "knowledge", `${id}.md`));
}

function statusOf(
  snapshot: Awaited<ReturnType<CanonicalTransactionStore["readSnapshot"]>>,
  id: string,
): KnowledgeStatus | undefined {
  return snapshot.domain.knowledge.find((item) => item.id === id)?.status;
}

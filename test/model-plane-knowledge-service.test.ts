import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanonicalTransactionStore,
  IngestPrMutationError,
  IngestPrMutationService,
  KnowledgeConflictError,
  ModelPlaneKnowledgeService,
  RepoKnowledgeConfigSchema,
  parseKnowledgeBodyCodeExample,
  renderKnowledgeBodyWithCodeExample,
  type GeneratedCodeExample,
  type IngestPullRequestResult,
} from "../src/index.js";

const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROPOSAL_ID = "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRANSACTION_1 = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRANSACTION_2 = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TRANSACTION_3 = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const NOW = new Date("2026-08-06T00:00:00.000Z");
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ModelPlaneKnowledgeService", () => {
  it("creates only proposed knowledge with manual provenance", async () => {
    const fixture = await createFixture();

    const result = await fixture.service.addKnowledge({
      category: "architecture",
      detail: "Use a single server factory for every protocol era.",
      rule: "Build MCP servers from one factory",
      scope: ["src/**"],
      severity: "must",
    });

    expect(result).toMatchObject({
      id: KNOWLEDGE_ID,
      origin: "manual",
      repo: REPOSITORY,
      revision: 1,
      status: "proposed",
    });
    expect(result.etag).toMatch(/^[a-f0-9]{64}$/u);
    const document = await fixture.store.readKnowledge(
      `knowledge/${KNOWLEDGE_ID}.md`,
    );
    expect(document.frontmatter).toMatchObject({
      category: "architecture",
      origin: { type: "manual" },
      revision: 1,
      status: "proposed",
    });
    expect(document.frontmatter).not.toHaveProperty("activation");
    expect(document.body).toContain("Use a single server factory");
  });

  it("records update requests as pending proposals without rewriting Markdown", async () => {
    const fixture = await createFixture();
    const added = await addKnowledge(fixture.service);
    const before = await fixture.store.readKnowledge(
      `knowledge/${KNOWLEDGE_ID}.md`,
    );

    const result = await fixture.service.updateKnowledge({
      expected_etag: added.etag,
      expected_revision: added.revision,
      id: added.id,
      patch: {
        detail: "Proposed replacement detail",
        rule: "Proposed replacement rule",
        severity: "should",
      },
    });

    expect(result).toEqual({
      current_etag: before.etag,
      current_revision: 1,
      knowledge_id: KNOWLEDGE_ID,
      proposal_id: PROPOSAL_ID,
      repo: REPOSITORY,
      status: "pending",
    });
    const after = await fixture.store.readKnowledge(before.path);
    expect(after).toEqual(before);
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.revisionProposals).toEqual([
      expect.objectContaining({
        evidence_ids: [],
        knowledge_id: KNOWLEDGE_ID,
        patch: {
          detail: "Proposed replacement detail",
          rule: "Proposed replacement rule",
          severity: "should",
        },
        proposal_id: PROPOSAL_ID,
        status: "pending",
      }),
    ]);
  });

  it("cannot rewrite active knowledge and requires both current CAS values", async () => {
    const fixture = await createFixture();
    const added = await addKnowledge(fixture.service);
    const active = await fixture.store.updateKnowledge({
      expectedEtag: added.etag,
      expectedRevision: added.revision,
      patch: { frontmatter: { status: "active" } },
      targetPath: `knowledge/${KNOWLEDGE_ID}.md`,
      transactionId: TRANSACTION_2,
    });

    await expect(
      fixture.service.updateKnowledge({
        expected_etag: added.etag,
        expected_revision: added.revision,
        id: added.id,
        patch: { rule: "Attempted stale overwrite" },
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_CONFLICT",
      current: expect.objectContaining({
        etag: active.etag,
        revision: 2,
      }),
    } satisfies Partial<KnowledgeConflictError>);

    await fixture.service.updateKnowledge({
      expected_etag: active.etag,
      expected_revision: active.revision,
      id: added.id,
      patch: { rule: "Human-review-required replacement" },
    });
    const unchanged = await fixture.store.readKnowledge(active.path);
    expect(unchanged.etag).toBe(active.etag);
    expect(unchanged.frontmatter.status).toBe("active");
    expect(unchanged.frontmatter.rule).toBe(
      "Build MCP servers from one factory",
    );
  });

  it("protects hand-edited example bodies with byte ETag CAS and removes examples via proposals", async () => {
    const fixture = await createFixture();
    const example: GeneratedCodeExample = {
      content: "const result = await invoke();",
      evidence_comment_ids: ["comment-example"],
      generated_example: true,
      language: "typescript",
    };
    const added = await fixture.service.addKnowledge({
      category: "error-handling",
      detail: renderKnowledgeBodyWithCodeExample(
        "Surface backend errors to the UI layer.",
        example,
      ),
      rule: "Report backend errors",
      scope: ["src/**"],
      severity: "should",
    });
    const path = `knowledge/${KNOWLEDGE_ID}.md`;
    const absolutePath = join(fixture.root, path);
    const original = await readFile(absolutePath, "utf8");
    await writeFile(
      absolutePath,
      original.replace(
        "const result = await invoke();",
        "await invoke(); // edited by hand",
      ),
    );

    await expect(
      fixture.service.updateKnowledge({
        expected_etag: added.etag,
        expected_revision: added.revision,
        id: added.id,
        patch: { detail: "Attempted stale example rewrite" },
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_CONFLICT" });

    const edited = await fixture.store.readKnowledge(path);
    expect(parseKnowledgeBodyCodeExample(edited.body).code_example).toEqual({
      ...example,
      content: "await invoke(); // edited by hand",
    });

    const result = await fixture.service.updateKnowledge({
      expected_etag: edited.etag,
      expected_revision: edited.revision,
      id: added.id,
      patch: { detail: "Surface backend errors to the UI layer." },
    });
    expect(result.status).toBe("pending");
    const untouched = await fixture.store.readKnowledge(path);
    expect(untouched.etag).toBe(edited.etag);
    const proposal = (await fixture.store.readSnapshot()).domain
      .revisionProposals[0]!;
    expect(proposal.patch.detail).not.toContain("generated_example");
    expect(
      parseKnowledgeBodyCodeExample(proposal.patch.detail!).code_example,
    ).toBeNull();
  });
});

describe("IngestPrMutationService", () => {
  it("keeps jobs pending and never calls a provider without explicit opt-in", async () => {
    const ingester = vi.fn(async () => ingestResult(2));
    const provider = {
      run: vi.fn(async () => ({ distilled: 2, pending: 0 })),
    };
    const service = new IngestPrMutationService({
      config: RepoKnowledgeConfigSchema.parse({}),
      ingester: {
        ingest: ingester,
        resolveRepoId: vi.fn(async () => REPOSITORY_ID),
      },
      providerRunner: provider,
      repo: REPOSITORY,
    });

    const result = await service.ingestPullRequest({ pr_number: 42 });

    expect(result).toMatchObject({ distilled: 0, pending: 2 });
    expect(ingester).toHaveBeenCalledWith({
      pr_number: 42,
      repo: REPOSITORY,
    });
    expect(provider.run).not.toHaveBeenCalled();
  });

  it("updates the summary after an explicitly allowed provider pipeline", async () => {
    const initial = ingestResult(3);
    const provider = {
      run: vi.fn(async () => ({ distilled: 2, pending: 1 })),
    };
    const service = new IngestPrMutationService({
      config: RepoKnowledgeConfigSchema.parse({
        llm: {
          allowCloudTransmission: true,
          mode: "anthropic",
          model: "test-model",
        },
      }),
      ingester: {
        ingest: vi.fn(async () => initial),
        resolveRepoId: vi.fn(async () => REPOSITORY_ID),
      },
      providerRunner: provider,
      repo: REPOSITORY,
    });

    const result = await service.ingestPullRequest({ pr_number: 42 });

    expect(result).toMatchObject({ distilled: 2, pending: 1 });
    expect(provider.run).toHaveBeenCalledWith({
      ingest: initial,
      pr_number: 42,
    });
  });

  it("fails closed when provider transmission is allowed without a runner", async () => {
    const service = new IngestPrMutationService({
      config: RepoKnowledgeConfigSchema.parse({
        llm: {
          allowCloudTransmission: true,
          mode: "anthropic",
          model: null,
        },
      }),
      ingester: {
        ingest: vi.fn(async () => ingestResult(1)),
        resolveRepoId: vi.fn(async () => REPOSITORY_ID),
      },
      repo: REPOSITORY,
    });

    await expect(
      service.ingestPullRequest({ pr_number: 42 }),
    ).rejects.toMatchObject({
      code: "PROVIDER_PIPELINE_MISSING",
    } satisfies Partial<IngestPrMutationError>);
  });
});

interface Fixture {
  readonly root: string;
  readonly service: ModelPlaneKnowledgeService;
  readonly store: CanonicalTransactionStore;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "repo-knowledge-model-plane-"));
  temporaryRepositories.push(root);
  const store = new CanonicalTransactionStore(root);
  const transactionIds = [TRANSACTION_1, TRANSACTION_3];
  return {
    root,
    service: new ModelPlaneKnowledgeService({
      nextEventId: () => EVENT_ID,
      nextKnowledgeId: () => KNOWLEDGE_ID,
      nextProposalId: () => PROPOSAL_ID,
      nextTransactionId: () => transactionIds.shift()!,
      now: () => NOW,
      repo: REPOSITORY,
      repoId: REPOSITORY_ID,
      repository: store,
    }),
    store,
  };
}

function addKnowledge(service: ModelPlaneKnowledgeService) {
  return service.addKnowledge({
    category: "architecture",
    detail: "Use a single server factory for every protocol era.",
    rule: "Build MCP servers from one factory",
    scope: ["src/**"],
    severity: "must",
  });
}

function ingestResult(pending: number): IngestPullRequestResult {
  return {
    changed_threads: 0,
    distilled: 0,
    jobs_created: pending,
    new_threads: pending,
    pending,
    repo_id: REPOSITORY_ID,
    snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    unchanged: 0,
    warnings: [],
  };
}

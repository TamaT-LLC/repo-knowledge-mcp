import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  ModelPlaneKnowledgeService,
  RepoKnowledgeDoctor,
  RepositoryRegistry,
  applyKnowledgeDocumentPatch,
  createDomainId,
  initializeStorage,
  type CanonicalJsonlRecord,
  type DoctorCheck,
  type DoctorReport,
  type GhCommandResult,
  type GhRunnerLike,
  type KnowledgeEvidence,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const NOW = "2026-08-06T00:00:00.000Z";
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("RepoKnowledgeDoctor", () => {
  it("reports a healthy environment entirely as pass without changing canonical bytes", async () => {
    const fixture = await createFixture();
    const before = await canonicalBytes(fixture.storageRoot);

    const result = await fixture.doctor().run({ repo: REPOSITORY });

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({
      fail: 0,
      pass: result.checks.length,
      warn: 0,
    });
    expect(check(result, "runtime.node").status).toBe("pass");
    expect(check(result, "github.graphql").status).toBe("pass");
    expect(check(result, "canonical.files").status).toBe("pass");
    expect(check(result, "sqlite.projection").status).toBe("pass");
    expect(await canonicalBytes(fixture.storageRoot)).toEqual(before);
  });

  it.each([
    {
      expected: {
        auth: "warn",
        cli: "fail",
        graphql: "warn",
      },
      mode: "missing" as const,
    },
    {
      expected: {
        auth: "fail",
        cli: "pass",
        graphql: "warn",
      },
      mode: "unauthenticated" as const,
    },
    {
      expected: {
        auth: "pass",
        cli: "pass",
        graphql: "fail",
      },
      mode: "graphql" as const,
    },
  ])("distinguishes GitHub failure mode $mode", async ({ expected, mode }) => {
    const fixture = await createFixture();

    const result = await fixture.doctor({ gh: new FakeGhRunner(mode) }).run({
      repo: REPOSITORY,
    });

    expect(result.ok).toBe(false);
    expect(check(result, "github.cli").status).toBe(expected.cli);
    expect(check(result, "github.auth").status).toBe(expected.auth);
    expect(check(result, "github.graphql").status).toBe(expected.graphql);
  });

  it("detects provider and host-assisted consent contradictions without provider calls", async () => {
    const provider = await createFixture({
      llm: {
        allowCloudTransmission: true,
        mode: "anthropic",
        model: null,
      },
    });
    const providerGh = new FakeGhRunner();

    const providerResult = await provider
      .doctor({ environment: {}, gh: providerGh })
      .run({ repo: REPOSITORY });

    expect(check(providerResult, "config.provider_transmission")).toMatchObject(
      {
        status: "fail",
        remedy: expect.stringContaining("llm.model"),
      },
    );
    expect(providerGh.calls.every((args) => args[0] !== "anthropic")).toBe(
      true,
    );

    const host = await createFixture({
      hostAssistedDistillation: {
        allowReviewContentTransmission: false,
        enabled: true,
      },
    });
    const hostResult = await host.doctor().run({ repo: REPOSITORY });
    expect(
      check(hostResult, "config.host_assisted_transmission"),
    ).toMatchObject({ status: "warn" });
  });

  it("reports invalid knowledge, JSONL, and duplicate IDs with target paths", async () => {
    const invalid = await createFixture();
    await writeFile(
      invalid.knowledgePath,
      "---\nid: [unterminated\n---\ninvalid\n",
    );
    const invalidBefore = await canonicalBytes(invalid.storageRoot);

    const invalidResult = await invalid.doctor().run({ repo: REPOSITORY });

    expect(check(invalidResult, "canonical.files")).toMatchObject({
      path: invalid.knowledgePath,
      status: "fail",
    });
    expect(await canonicalBytes(invalid.storageRoot)).toEqual(invalidBefore);

    const duplicate = await createFixture();
    const duplicatePath = join(
      duplicate.repositoryRoot,
      "knowledge",
      "zz-duplicate.md",
    );
    await writeFile(duplicatePath, await readFile(duplicate.knowledgePath), {
      mode: 0o600,
    });

    const duplicateResult = await duplicate.doctor().run({ repo: REPOSITORY });

    expect(check(duplicateResult, "canonical.files")).toMatchObject({
      path: duplicatePath,
      status: "fail",
    });
    expect(check(duplicateResult, "canonical.files").details).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("duplicate knowledge id"),
      }),
    );

    const corrupt = await createFixture();
    const corruptPath = join(corrupt.repositoryRoot, "events", "broken.jsonl");
    await mkdir(join(corrupt.repositoryRoot, "events"), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(corruptPath, "{broken json}\n", { mode: 0o600 });
    const corruptBefore = await canonicalBytes(corrupt.storageRoot);

    const corruptResult = await corrupt.doctor().run({ repo: REPOSITORY });

    expect(check(corruptResult, "canonical.files")).toMatchObject({
      path: corruptPath,
      status: "fail",
    });
    expect(await canonicalBytes(corrupt.storageRoot)).toEqual(corruptBefore);
  });

  it("reports orphan evidence at the canonical event path", async () => {
    const fixture = await createFixture();
    const orphanKnowledgeId = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const evidence = orphanEvidence(orphanKnowledgeId);
    const transactionId = "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const targetPath = "events/evidence.jsonl";
    const record: CanonicalJsonlRecord<KnowledgeEvidence> = {
      payload: evidence,
      record_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      record_type: "EvidenceCreated",
      recorded_at: NOW,
      schema_version: 1,
      transaction_id: transactionId,
    };
    await fixture.store.commit({
      appendRecords: [{ record, targetPath }],
      createdAt: NOW,
      fileWrites: [],
      transactionId,
    });

    const result = await fixture.doctor().run({ repo: REPOSITORY });

    expect(check(result, "canonical.orphan_evidence")).toMatchObject({
      path: join(fixture.repositoryRoot, targetPath),
      status: "fail",
    });
    expect(check(result, "canonical.orphan_evidence").details).toEqual(
      expect.objectContaining({
        orphaned: [
          expect.objectContaining({ knowledge_id: orphanKnowledgeId }),
        ],
      }),
    );
  });

  it("distinguishes dirty projection from optional derived metadata drift", async () => {
    const dirty = await createFixture();
    await writeFile(
      dirty.knowledgePath,
      `${await readFile(dirty.knowledgePath, "utf8")}Direct human edit.\n`,
    );

    const dirtyResult = await dirty.doctor().run({ repo: REPOSITORY });

    expect(check(dirtyResult, "sqlite.projection")).toMatchObject({
      path: join(dirty.repositoryRoot, "index.sqlite"),
      remedy: expect.stringContaining("reindex"),
      status: "fail",
    });

    const derived = await createFixture();
    const document = await derived.store.readKnowledge(
      relative(derived.repositoryRoot, derived.knowledgePath),
    );
    await writeFile(
      derived.knowledgePath,
      applyKnowledgeDocumentPatch(document, {
        frontmatter: {
          applied_count: 99,
          evidence_count: 99,
          sources: ["other"],
          updated_at: "2026-08-06T01:00:00.000Z",
          violation_count: 99,
        },
      }),
    );
    await derived.store.reindex();

    const derivedResult = await derived.doctor().run({ repo: REPOSITORY });

    expect(check(derivedResult, "canonical.derived_counts")).toMatchObject({
      remedy: expect.stringContaining("reconcile"),
      status: "warn",
    });
    expect(check(derivedResult, "sqlite.projection").status).toBe("pass");
  });

  it("reports unresolved transactions and unsupported network storage without repairing either", async () => {
    const fixture = await createFixture();
    const transactionPath = join(
      fixture.repositoryRoot,
      "transactions",
      "txn_stuck",
    );
    await mkdir(transactionPath, { mode: 0o700 });
    const before = await canonicalBytes(fixture.storageRoot);

    const result = await fixture
      .doctor({ filesystemType: 0x6969 })
      .run({ repo: REPOSITORY });

    expect(check(result, "storage.local_filesystem")).toMatchObject({
      status: "fail",
      details: { filesystem: "NFS" },
    });
    expect(check(result, "canonical.transactions")).toMatchObject({
      path: join(fixture.repositoryRoot, "transactions"),
      remedy: expect.stringContaining("reindex"),
      status: "fail",
    });
    expect(await canonicalBytes(fixture.storageRoot)).toEqual(before);
  });
});

interface Fixture {
  readonly doctor: (overrides?: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly filesystemType?: number;
    readonly gh?: GhRunnerLike;
  }) => RepoKnowledgeDoctor;
  readonly knowledgePath: string;
  readonly repositoryRoot: string;
  readonly storageRoot: string;
  readonly store: CanonicalTransactionStore;
}

async function createFixture(
  config: Record<string, unknown> = {},
): Promise<Fixture> {
  const parent = await temporaryDirectory();
  const storageRoot = join(parent, "storage");
  await initializeStorage(storageRoot, {
    ...config,
    defaultRepo: REPOSITORY,
  });
  const registered = await new RepositoryRegistry(storageRoot).register({
    currentName: REPOSITORY,
    repoId: REPOSITORY_ID,
  });
  const store = new CanonicalTransactionStore(registered.absolutePath);
  const added = await new ModelPlaneKnowledgeService({
    repo: REPOSITORY,
    repoId: REPOSITORY_ID,
    repository: store,
  }).addKnowledge({
    category: "architecture",
    detail: "Doctor fixture detail",
    rule: "Doctor fixture rule",
    scope: ["src/**"],
    severity: "must",
  });
  const knowledgePath = join(
    registered.absolutePath,
    "knowledge",
    `${added.id}.md`,
  );
  return {
    doctor(overrides = {}) {
      return new RepoKnowledgeDoctor({
        environment: overrides.environment ?? {
          ANTHROPIC_API_KEY: "fixture-key",
        },
        filesystemTypeReader: async () =>
          overrides.filesystemType ?? 0x0000_ef53,
        ghRunner: overrides.gh ?? new FakeGhRunner(),
        nodeVersion: "24.4.0",
        platform: "linux",
        storageRoot,
      });
    },
    knowledgePath,
    repositoryRoot: registered.absolutePath,
    storageRoot,
    store,
  };
}

class FakeGhRunner implements GhRunnerLike {
  readonly calls: string[][] = [];

  constructor(
    private readonly mode:
      "graphql" | "healthy" | "missing" | "unauthenticated" = "healthy",
  ) {}

  async run(args: readonly string[]): Promise<GhCommandResult> {
    this.calls.push([...args]);
    if (args[0] === "--version") {
      if (this.mode === "missing") throw codedError("GH_NOT_FOUND");
      return { stderr: "", stdout: "gh version fixture\n" };
    }
    if (args[0] === "auth") {
      if (this.mode === "unauthenticated") {
        throw codedError("GH_EXIT_NON_ZERO");
      }
      return { stderr: "", stdout: "authenticated\n" };
    }
    const query = args.find((value) => value.startsWith("query=")) ?? "";
    if (query.includes("RepoKnowledgeDoctor")) {
      if (this.mode === "graphql") throw codedError("GH_TIMEOUT");
      return {
        stderr: "",
        stdout: JSON.stringify({ data: { viewer: { login: "fixture" } } }),
      };
    }
    if (query.includes("ResolveRepository")) {
      return {
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              id: REPOSITORY_ID,
              nameWithOwner: REPOSITORY,
            },
          },
        }),
      };
    }
    throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
  }
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function check(report: DoctorReport, id: string): DoctorCheck {
  const matches = report.checks.filter((item) => item.id === id);
  if (matches.length !== 1) {
    throw new Error(`expected one ${id} check, received ${matches.length}`);
  }
  return matches[0]!;
}

function orphanEvidence(knowledgeId: string): KnowledgeEvidence {
  const actor = {
    actor_kind: "user" as const,
    comment_id: "comment-doctor",
    login: "reviewer",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  return {
    actors: [actor],
    comment_ids: [actor.comment_id],
    content_fingerprint: SHA_A,
    eligible_for_count: true,
    evidence_id: createDomainId("evidence", Date.parse(NOW)),
    knowledge_id: knowledgeId,
    observed_at: NOW,
    occurrence_key: `${knowledgeId}:thread-doctor`,
    originator: actor,
    pr_number: 1,
    repo_id: REPOSITORY_ID,
    sources: ["human"],
    state_fingerprint: SHA_B,
    status: "active",
    thread_id: "thread-doctor",
  };
}

async function canonicalBytes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await visit(root, root, result);
  return result;
}

async function visit(
  root: string,
  directory: string,
  result: Record<string, string>,
): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path, result);
      continue;
    }
    const relativePath = relative(root, path).split("\\").join("/");
    if (
      relativePath === "config.json" ||
      relativePath === "repositories.json" ||
      relativePath.includes("index.sqlite") ||
      relativePath.includes("/transactions/") ||
      relativePath.endsWith(".jsonl") ||
      relativePath.endsWith(".md")
    ) {
      result[relativePath] = (await readFile(path)).toString("base64");
    }
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-doctor-"));
  temporaryDirectories.push(path);
  return path;
}

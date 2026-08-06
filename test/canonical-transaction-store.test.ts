import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  type CanonicalCommitPoint,
  type CanonicalJsonlRecord,
  type CanonicalTransactionRequest,
} from "../src/index.js";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

const prePreparedKillPoints: readonly CanonicalCommitPoint[] = [
  "after_staged_payloads",
  "after_manifest_temp",
];

const recoverableKillPoints: readonly CanonicalCommitPoint[] = [
  "after_prepared",
  "after_file_write",
  "after_append_write",
  "after_committed_marker_temp",
  "after_committed",
  "after_projection",
];

describe("M1-A canonical transaction recovery", () => {
  it.each(prePreparedKillPoints)(
    "leaves the old canonical state when killed at %s",
    async (point) => {
      const repository = await createRepository();
      await seedOldState(repository);

      await expectKilledCommit(repository, transactionRequest(), point);

      const store = new CanonicalTransactionStore(repository);
      await store.recover();

      expect(
        await readFile(join(repository, "knowledge", "rule.md"), "utf8"),
      ).toBe(knowledgeMarkdown("old rule", 1));
      await expect(
        readFile(join(repository, "events", "evidence.jsonl"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await transactionEntries(repository)).toEqual([]);
    },
  );

  it.each(recoverableKillPoints)(
    "converges after a real process kill at %s (acceptance tests 13, 14, 25, 53)",
    async (point) => {
      const repository = await createRepository();
      await seedOldState(repository);

      await expectKilledCommit(repository, transactionRequest(), point);

      const store = new CanonicalTransactionStore(repository);
      const recovered = await store.readSnapshot();

      expect(
        await readFile(join(repository, "knowledge", "rule.md"), "utf8"),
      ).toBe(knowledgeMarkdown("new rule", 2));
      expect(recovered.checkpointTransactionId).toBe("txn_acceptance_25");
      expect(recovered.records).toHaveLength(1);
      expect(recovered.records[0]).toMatchObject({
        targetPath: "events/evidence.jsonl",
        record: { record_id: "evt_acceptance_25" },
      });
      expect(await readCanonicalLines(repository)).toHaveLength(1);
      expect(await transactionEntries(repository)).toEqual([]);
    },
  );
});

describe("acceptance test 26", () => {
  it("fails closed when a prepared append payload is missing", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    let crashed = false;
    const store = new CanonicalTransactionStore(repository, {
      faultInjector(point) {
        if (!crashed && point === "after_prepared") {
          crashed = true;
          throw new Error("simulated crash");
        }
      },
    });

    await expect(store.commit(transactionRequest())).rejects.toThrow(
      "simulated crash",
    );
    await unlink(
      join(
        repository,
        "transactions",
        "txn_acceptance_25",
        "staged",
        "appends",
        "0001.jsonl",
      ),
    );

    const restarted = new CanonicalTransactionStore(repository);
    await expect(restarted.recover()).rejects.toMatchObject({
      code: "UNRECOVERABLE_TRANSACTION",
      transactionId: "txn_acceptance_25",
    });
    await expect(restarted.readSnapshot()).rejects.toMatchObject({
      code: "UNRECOVERABLE_TRANSACTION",
    });
    expect(await transactionEntries(repository)).toEqual(["txn_acceptance_25"]);
  });
});

describe("acceptance tests 44-46", () => {
  it("archives and repairs a partial final JSONL line before replaying it", async () => {
    const repository = await createRepository();
    await seedOldState(repository);

    await expectKilledCommit(
      repository,
      transactionRequest(),
      "before_append_write",
      true,
    );

    const partial = await readFile(
      join(repository, "events", "evidence.jsonl"),
    );
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.at(-1)).not.toBe(0x0a);

    const restarted = new CanonicalTransactionStore(repository);
    await restarted.recover();

    expect(await readCanonicalLines(repository)).toEqual([
      expect.objectContaining({ record_id: "evt_acceptance_25" }),
    ]);
    expect(
      await readFile(
        join(repository, "events", "evidence.jsonl.corrupt"),
        "utf8",
      ),
    ).toBe(partial.toString("utf8"));
  });

  it("rejects an existing record ID whose complete line has different bytes", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    const conflictingRecord = {
      ...evidenceRecord(),
      payload: { knowledge_id: "kn_other" },
    };
    await mkdir(join(repository, "events"), { recursive: true });
    await writeFile(
      join(repository, "events", "evidence.jsonl"),
      `${JSON.stringify(conflictingRecord)}\n`,
    );
    let crashed = false;
    const store = new CanonicalTransactionStore(repository, {
      faultInjector(point) {
        if (!crashed && point === "after_prepared") {
          crashed = true;
          throw new Error("simulated crash");
        }
      },
    });
    await expect(store.commit(transactionRequest())).rejects.toThrow(
      "simulated crash",
    );

    await expect(
      new CanonicalTransactionStore(repository).recover(),
    ).rejects.toMatchObject({ code: "RECORD_ID_CONFLICT" });
  });

  it("does not apply a staged append whose bytes fail line_sha256", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    let crashed = false;
    const store = new CanonicalTransactionStore(repository, {
      faultInjector(point) {
        if (!crashed && point === "after_prepared") {
          crashed = true;
          throw new Error("simulated crash");
        }
      },
    });
    await expect(store.commit(transactionRequest())).rejects.toThrow(
      "simulated crash",
    );
    const stagedPath = join(
      repository,
      "transactions",
      "txn_acceptance_25",
      "staged",
      "appends",
      "0001.jsonl",
    );
    await writeFile(stagedPath, `${JSON.stringify(evidenceRecord())} \n`);

    await expect(
      new CanonicalTransactionStore(repository).recover(),
    ).rejects.toMatchObject({ code: "UNRECOVERABLE_TRANSACTION" });
    await expect(
      readFile(join(repository, "events", "evidence.jsonl")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not require a staged payload after the exact record was appended", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    let crashed = false;
    const store = new CanonicalTransactionStore(repository, {
      faultInjector(point) {
        if (!crashed && point === "after_append_write") {
          crashed = true;
          throw new Error("simulated crash");
        }
      },
    });
    await expect(store.commit(transactionRequest())).rejects.toThrow(
      "simulated crash",
    );
    await unlink(
      join(
        repository,
        "transactions",
        "txn_acceptance_25",
        "staged",
        "appends",
        "0001.jsonl",
      ),
    );

    const restarted = new CanonicalTransactionStore(repository);
    await restarted.recover();

    expect(await readCanonicalLines(repository)).toHaveLength(1);
    expect(await transactionEntries(repository)).toEqual([]);
  });
});

describe("M1-A ETag, read isolation, and reindex", () => {
  it("rejects an update after a direct Markdown edit (acceptance test 15)", async () => {
    const repository = await createRepository();
    const knowledgePath = join(repository, "knowledge", "kn_1.md");
    await writeFile(knowledgePath, knowledgeMarkdown("first rule", 1));
    const store = new CanonicalTransactionStore(repository);
    const read = await store.readKnowledge("knowledge/kn_1.md");

    await writeFile(knowledgePath, knowledgeMarkdown("human edit", 1));

    await expect(
      store.updateKnowledge({
        transactionId: "txn_conflicting_update",
        targetPath: "knowledge/kn_1.md",
        expectedRevision: read.revision,
        expectedEtag: read.etag,
        patch: { frontmatter: { rule: "tool edit" } },
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_CONFLICT",
      current: { frontmatter: { rule: "human edit" } },
    });
    expect(await readFile(knowledgePath, "utf8")).toContain(
      'rule: "human edit"',
    );
  });

  it("increments revision and returns the exact-byte ETag after an update", async () => {
    const repository = await createRepository();
    const knowledgePath = join(repository, "knowledge", "kn_1.md");
    await writeFile(knowledgePath, knowledgeMarkdown("first rule", 1));
    const store = new CanonicalTransactionStore(repository);
    const before = await store.readKnowledge("knowledge/kn_1.md");

    const after = await store.updateKnowledge({
      transactionId: "txn_successful_update",
      targetPath: "knowledge/kn_1.md",
      expectedRevision: before.revision,
      expectedEtag: before.etag,
      patch: { frontmatter: { rule: "updated rule" } },
    });

    const persisted = await readFile(knowledgePath);
    expect(after.revision).toBe(2);
    expect(after.frontmatter.rule).toBe("updated rule");
    expect(after.etag).toBe(sha256(persisted));
    expect((await store.readSnapshot()).knowledge[0]).toEqual(after);
  });

  it("serializes readers behind an in-flight canonical commit", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    let releaseCommit!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let fileWriteReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      fileWriteReached = resolve;
    });
    const writer = new CanonicalTransactionStore(repository, {
      async faultInjector(point) {
        if (point === "after_file_write") {
          fileWriteReached();
          await blocked;
        }
      },
    });
    const commit = writer.commit(transactionRequest());
    await reached;

    let readSettled = false;
    const read = new CanonicalTransactionStore(repository)
      .readSnapshot()
      .finally(() => {
        readSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readSettled).toBe(false);

    releaseCommit();
    await commit;
    const snapshot = await read;
    expect(snapshot.records).toHaveLength(1);
    expect(
      await readFile(join(repository, "knowledge", "rule.md"), "utf8"),
    ).toBe(knowledgeMarkdown("new rule", 2));
  });

  it("rebuilds only the derived SQLite index", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    const store = new CanonicalTransactionStore(repository);
    await store.commit(transactionRequest());
    const canonicalBefore = await canonicalHashes(repository);

    await unlink(join(repository, "index.sqlite"));
    const rebuilt = await store.reindex();

    expect(rebuilt.records).toHaveLength(1);
    expect(await canonicalHashes(repository)).toEqual(canonicalBefore);
  });

  it("records an evidence append even after an unrelated Markdown edit", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    await writeFile(
      join(repository, "knowledge", "rule.md"),
      knowledgeMarkdown("human edit outside a transaction", 1),
    );

    const request = transactionRequest();
    await new CanonicalTransactionStore(repository).commit({
      ...request,
      fileWrites: [],
    });

    expect(await readCanonicalLines(repository)).toHaveLength(1);
    expect(
      await readFile(join(repository, "knowledge", "rule.md"), "utf8"),
    ).toBe(knowledgeMarkdown("human edit outside a transaction", 1));
  });

  it("reprojects a same-size direct edit before serving a read", async () => {
    const repository = await createRepository();
    const knowledgePath = join(repository, "knowledge", "kn_1.md");
    const first = knowledgeMarkdown("allow foo", 1);
    const second = knowledgeMarkdown("deny! foo", 1);
    expect(Buffer.byteLength(second)).toBe(Buffer.byteLength(first));
    await writeFile(knowledgePath, first);
    const store = new CanonicalTransactionStore(repository);
    expect((await store.readSnapshot()).knowledge[0]?.frontmatter.rule).toBe(
      "allow foo",
    );

    await writeFile(knowledgePath, second);

    expect((await store.readSnapshot()).knowledge[0]?.frontmatter.rule).toBe(
      "deny! foo",
    );
  });

  it("rejects traversal and symlink escapes for canonical targets", async () => {
    const repository = await createRepository();
    await seedOldState(repository);
    const outside = await mkdtemp(join(tmpdir(), "rkm-outside-"));
    temporaryRepositories.push(outside);
    await symlink(outside, join(repository, "linked"));
    const request = transactionRequest();

    await expect(
      new CanonicalTransactionStore(repository).commit({
        ...request,
        fileWrites: [],
        appendRecords: [
          { ...request.appendRecords[0]!, targetPath: "linked/log.jsonl" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CANONICAL_PATH" });
    await expect(
      new CanonicalTransactionStore(repository).commit({
        ...request,
        fileWrites: [
          { ...request.fileWrites[0]!, targetPath: "../outside.md" },
        ],
        appendRecords: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CANONICAL_PATH" });
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-transaction-"));
  temporaryRepositories.push(repository);
  await mkdir(join(repository, "knowledge"), { recursive: true });
  return repository;
}

async function seedOldState(repository: string): Promise<void> {
  await writeFile(
    join(repository, "knowledge", "rule.md"),
    knowledgeMarkdown("old rule", 1),
  );
}

function transactionRequest(): CanonicalTransactionRequest {
  return {
    transactionId: "txn_acceptance_25",
    createdAt: "2026-08-06T00:00:00.000Z",
    fileWrites: [
      {
        targetPath: "knowledge/rule.md",
        expectedSha256: sha256(knowledgeMarkdown("old rule", 1)),
        content: knowledgeMarkdown("new rule", 2),
      },
    ],
    appendRecords: [
      {
        targetPath: "events/evidence.jsonl",
        record: evidenceRecord(),
      },
    ],
  };
}

function evidenceRecord(): CanonicalJsonlRecord<{ knowledge_id: string }> {
  return {
    schema_version: 1,
    record_id: "evt_acceptance_25",
    record_type: "EvidenceCreated",
    transaction_id: "txn_acceptance_25",
    recorded_at: "2026-08-06T00:00:00.000Z",
    payload: { knowledge_id: "kn_1" },
  };
}

async function expectKilledCommit(
  repository: string,
  request: CanonicalTransactionRequest,
  point: CanonicalCommitPoint,
  writePartialLine = false,
): Promise<void> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "index.js")).href;
  const script = `
    import { appendFileSync, mkdirSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { CanonicalTransactionStore } from ${JSON.stringify(moduleUrl)};
    const repository = process.env.RKM_TEST_REPOSITORY;
    const request = JSON.parse(process.env.RKM_TEST_REQUEST);
    const killPoint = process.env.RKM_TEST_KILL_POINT;
    const writePartial = process.env.RKM_TEST_PARTIAL === "1";
    const store = new CanonicalTransactionStore(repository, {
      faultInjector(point, context) {
        if (point !== killPoint) return;
        if (writePartial && point === "before_append_write") {
          const target = join(repository, context.targetPath);
          mkdirSync(dirname(target), { recursive: true });
          const line = Buffer.from(context.lineBytes);
          appendFileSync(target, line.subarray(0, Math.max(1, Math.floor(line.length / 2))));
        }
        process.kill(process.pid, "SIGKILL");
      },
    });
    await store.commit(request);
  `;

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          RKM_TEST_KILL_POINT: point,
          RKM_TEST_PARTIAL: writePartialLine ? "1" : "0",
          RKM_TEST_REPOSITORY: repository,
          RKM_TEST_REQUEST: JSON.stringify(request),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });

  expect(result, result.stderr).toMatchObject({
    code: null,
    signal: "SIGKILL",
  });
}

async function transactionEntries(repository: string): Promise<string[]> {
  try {
    return (await readdir(join(repository, "transactions"))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readCanonicalLines(
  repository: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(
    join(repository, "events", "evidence.jsonl"),
    "utf8",
  );
  return content
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function canonicalHashes(
  repository: string,
): Promise<Record<string, string>> {
  const paths = ["knowledge/rule.md", "events/evidence.jsonl"];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        sha256(await readFile(join(repository, path))),
      ]),
    ),
  );
}

function knowledgeMarkdown(rule: string, revision: number): string {
  return [
    "---",
    "schema_version: 1",
    "id: kn_1",
    "repo_id: repo_1",
    `rule: ${JSON.stringify(rule)}`,
    "status: active",
    `revision: ${revision}`,
    "---",
    "Body",
    "",
  ].join("\n");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

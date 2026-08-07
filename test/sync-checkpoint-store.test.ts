import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SYNC_CHECKPOINT_SCHEMA_VERSION,
  SYNC_CURSOR_VERSION,
  SyncCheckpointStore,
  type SyncCheckpoint,
} from "../src/index.js";

const REPO_ID = "R_repo_node";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SyncCheckpointStore", () => {
  it("returns null when no checkpoint has been persisted", async () => {
    const store = new SyncCheckpointStore(await createRepository());

    await expect(store.read()).resolves.toBeNull();
  });

  it("round-trips a versioned checkpoint as one canonical JSON line", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    const checkpoint = checkpointAt(7, "2026-08-06T00:01:00.000Z");

    await store.write(checkpoint);

    await expect(store.read()).resolves.toEqual(checkpoint);
    const bytes = await readFile(
      join(repository, "sync", "checkpoint.json"),
      "utf8",
    );
    expect(bytes.endsWith("\n")).toBe(true);
    expect(JSON.parse(bytes)).toEqual(checkpoint);
  });

  it("atomically replaces the previous checkpoint", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    await store.write(checkpointAt(7, "2026-08-06T00:01:00.000Z"));

    const advanced = checkpointAt(9, "2026-08-06T00:02:00.000Z");
    await store.write(advanced);

    await expect(store.read()).resolves.toEqual(advanced);
  });

  it("recovers from a temporary file left behind by a crashed writer", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    await store.write(checkpointAt(7, "2026-08-06T00:01:00.000Z"));
    await writeFile(
      join(repository, "sync", "checkpoint.json.tmp"),
      "partial write",
    );

    const advanced = checkpointAt(9, "2026-08-06T00:02:00.000Z");
    await store.write(advanced);

    await expect(store.read()).resolves.toEqual(advanced);
  });

  it("fails closed on a checkpoint that is not valid JSON", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    await store.write(checkpointAt(7, "2026-08-06T00:01:00.000Z"));
    await writeFile(join(repository, "sync", "checkpoint.json"), "{corrupt");

    await expect(store.read()).rejects.toMatchObject({
      code: "SYNC_CHECKPOINT_INVALID",
    });
  });

  it("rejects an unsupported checkpoint schema version", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    const future = { ...checkpointAt(7, "2026-08-06T00:01:00.000Z") };
    await mkdir(join(repository, "sync"), { recursive: true });
    await writeFile(
      join(repository, "sync", "checkpoint.json"),
      `${JSON.stringify({ ...future, schema_version: 2 })}\n`,
    );

    await expect(store.read()).rejects.toMatchObject({
      code: "SYNC_CHECKPOINT_VERSION_UNSUPPORTED",
    });
  });

  it("rejects a checkpoint whose cursor violates the schema", async () => {
    const repository = await createRepository();
    const store = new SyncCheckpointStore(repository);
    const invalid = checkpointAt(7, "2026-08-06T00:01:00.000Z");
    await mkdir(join(repository, "sync"), { recursive: true });
    await writeFile(
      join(repository, "sync", "checkpoint.json"),
      `${JSON.stringify({
        ...invalid,
        cursor: { ...invalid.cursor, last_pr_number: 0 },
      })}\n`,
    );

    await expect(store.read()).rejects.toMatchObject({
      code: "SYNC_CHECKPOINT_INVALID",
    });
  });
});

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-sync-checkpoint-"));
  temporaryRepositories.push(repository);
  return repository;
}

function checkpointAt(prNumber: number, updatedAt: string): SyncCheckpoint {
  return {
    cursor: {
      last_pr_number: prNumber,
      last_updated_at: updatedAt,
      repo_id: REPO_ID,
      version: SYNC_CURSOR_VERSION,
    },
    schema_version: SYNC_CHECKPOINT_SCHEMA_VERSION,
    updated_at: "2026-08-06T00:05:00.000Z",
  };
}

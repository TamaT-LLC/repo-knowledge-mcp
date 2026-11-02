import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SYNC_STATUS_SCHEMA_VERSION,
  SyncStatusStore,
  type SyncRunRecord,
} from "../src/experimental.js";

const REPO_ID = "R_repo_node";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SyncStatusStore", () => {
  it("returns null before any run was recorded", async () => {
    await expect(
      new SyncStatusStore(await createRepository()).read(),
    ).resolves.toBeNull();
  });

  it("persists a versioned record under sync/status.json", async () => {
    const repository = await createRepository();
    const store = new SyncStatusStore(repository);

    await store.recordRun(run("succeeded", 1));

    expect(store.statusPath).toBe(join(repository, "sync", "status.json"));
    expect(JSON.parse(await readFile(store.statusPath, "utf8"))).toEqual({
      consecutive_failures: 0,
      last_attempt_finished_at: at(1, 30),
      last_attempt_started_at: at(1, 0),
      last_error_code: null,
      last_has_more: false,
      last_outcome: "succeeded",
      last_success_at: at(1, 30),
      repo_id: REPO_ID,
      schema_version: SYNC_STATUS_SCHEMA_VERSION,
    });
  });

  it("counts consecutive failures and resets them on success", async () => {
    const store = new SyncStatusStore(await createRepository());

    await store.recordRun(run("succeeded", 1));
    await store.recordRun(run("partial_failure", 2));
    const failed = await store.recordRun(run("failed", 3));
    const healed = await store.recordRun(run("succeeded", 4));

    expect(failed).toMatchObject({
      consecutive_failures: 2,
      last_outcome: "failed",
      last_success_at: at(1, 30),
    });
    expect(healed).toMatchObject({
      consecutive_failures: 0,
      last_success_at: at(4, 30),
    });
  });

  it("replaces an unreadable previous record instead of failing the run", async () => {
    const repository = await createRepository();
    const store = new SyncStatusStore(repository);
    await mkdir(join(repository, "sync"), { recursive: true });
    await writeFile(store.statusPath, "{not json");

    await expect(store.read()).rejects.toMatchObject({
      code: "SYNC_STATUS_INVALID",
    });
    await expect(store.recordRun(run("failed", 1))).resolves.toMatchObject({
      consecutive_failures: 1,
      last_success_at: null,
    });
  });

  it("rejects an unsupported schema version", async () => {
    const repository = await createRepository();
    const store = new SyncStatusStore(repository);
    await mkdir(join(repository, "sync"), { recursive: true });
    await writeFile(store.statusPath, JSON.stringify({ schema_version: 2 }));

    await expect(store.read()).rejects.toMatchObject({
      code: "SYNC_STATUS_VERSION_UNSUPPORTED",
    });
  });
});

function run(outcome: SyncRunRecord["outcome"], hour: number): SyncRunRecord {
  return {
    error_code:
      outcome === "succeeded"
        ? null
        : outcome === "partial_failure"
          ? "SYNC_PARTIAL_FAILURE"
          : "GH_EXIT_NON_ZERO",
    finished_at: at(hour, 30),
    has_more: outcome === "failed" ? null : outcome !== "succeeded",
    outcome,
    repo_id: REPO_ID,
    started_at: at(hour, 0),
  };
}

function at(hour: number, second: number): string {
  return new Date(Date.UTC(2026, 7, 5, hour, 0, second)).toISOString();
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rkm-sync-status-"));
  temporaryRepositories.push(repository);
  return repository;
}

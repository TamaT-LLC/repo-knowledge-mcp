import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SetupStateStore, type SetupState } from "../src/experimental.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("setup state store", () => {
  it("returns null before setup and durably writes a private checkpoint", async () => {
    const repositoryRoot = await temporaryDirectory();
    const store = new SetupStateStore(repositoryRoot);

    await expect(store.read()).resolves.toBeNull();
    await expect(store.write(state())).resolves.toEqual(state());

    expect(await store.read()).toEqual(state());
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(state());
  });

  it("accepts an idempotent rewrite and keeps one valid document", async () => {
    const repositoryRoot = await temporaryDirectory();
    const store = new SetupStateStore(repositoryRoot);
    await store.write(state());

    await Promise.all([store.write(state()), store.write(state())]);

    expect(await store.read()).toEqual(state());
    expect(
      (await readFile(store.path, "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("fails closed for invalid state and a symlinked target", async () => {
    const invalidRoot = await temporaryDirectory();
    const invalid = new SetupStateStore(invalidRoot);
    await writeFile(invalid.path, "{}\n", { mode: 0o600 });
    await expect(invalid.read()).rejects.toMatchObject({
      code: "SETUP_STATE_INVALID",
    });

    const symlinkRoot = await temporaryDirectory();
    const outside = join(symlinkRoot, "outside.json");
    const repositoryRoot = join(symlinkRoot, "repository");
    await mkdir(repositoryRoot, { mode: 0o700 });
    await writeFile(outside, "outside\n", { mode: 0o600 });
    const linked = new SetupStateStore(repositoryRoot);
    await symlink(outside, linked.path);

    await expect(linked.write(state())).rejects.toMatchObject({
      code: "SETUP_STATE_PATH_UNSAFE",
    });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });
});

function state(): SetupState {
  return {
    created_at: "2026-08-09T00:00:00.000Z",
    initial_since: "2026-05-11T00:00:00.000Z",
    phase: "configured",
    repo_id: "R_repository",
    repository: "owner/repository",
    schema_version: 1,
    updated_at: "2026-08-09T00:00:00.000Z",
    workspace_path: "/work/repository",
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-setup-state-"));
  temporaryDirectories.push(path);
  return path;
}

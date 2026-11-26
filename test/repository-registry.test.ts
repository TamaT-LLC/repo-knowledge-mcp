import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RepositoryRegistry,
  repositoryStorageId,
} from "../src/experimental.js";

const temporaryRegistries: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRegistries
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repository registry", () => {
  it("keeps two concurrent first registrations under the global lock", async () => {
    const root = await createRegistryRoot();
    const first = new RepositoryRegistry(root);
    const second = new RepositoryRegistry(root);

    const [a, b] = await Promise.all([
      first.register({ repoId: "R_repo_a", currentName: "owner/a" }),
      second.register({ repoId: "R_repo_b", currentName: "owner/b" }),
    ]);

    expect(a.path).toBe(`repos/${repositoryStorageId("R_repo_a")}`);
    expect(b.path).toBe(`repos/${repositoryStorageId("R_repo_b")}`);
    const persisted = JSON.parse(
      await readFile(join(root, "repositories.json"), "utf8"),
    ) as { repositories: Record<string, unknown> };
    expect(Object.keys(persisted.repositories).sort()).toEqual([
      "R_repo_a",
      "R_repo_b",
    ]);
  });

  it("preserves the stable path and old name across a rename", async () => {
    const root = await createRegistryRoot();
    const registry = new RepositoryRegistry(root);
    const before = await registry.register({
      repoId: "R_stable",
      currentName: "old-owner/repo",
    });
    const after = await registry.register({
      repoId: "R_stable",
      currentName: "new-owner/repo",
    });

    expect(after.path).toBe(before.path);
    expect(after.aliases).toEqual(["old-owner/repo"]);
    await expect(
      registry.resolveByName("old-owner/repo"),
    ).resolves.toMatchObject({
      repoId: "R_stable",
      currentName: "new-owner/repo",
    });
    await expect(registry.resolveById("R_stable")).resolves.toEqual(after);
  });

  it("uses 32 lowercase hex characters for storage IDs", () => {
    expect(repositoryStorageId("R_kgDOExample")).toMatch(/^[a-f0-9]{32}$/u);
    expect(repositoryStorageId("R_kgDOExample")).toBe(
      repositoryStorageId("R_kgDOExample"),
    );
  });

  it("does not resolve inherited object properties as repository IDs", async () => {
    const registry = new RepositoryRegistry(await createRegistryRoot());
    await registry.register({
      repoId: "R_existing",
      currentName: "owner/existing",
    });

    await expect(registry.resolveById("toString")).resolves.toBeNull();
    await expect(registry.resolveById("__proto__")).resolves.toBeNull();

    const reserved = await registry.register({
      repoId: "toString",
      currentName: "owner/reserved",
    });
    await expect(registry.resolveById("toString")).resolves.toEqual(reserved);
  });

  it("looks names up read-only, ignoring case only when nothing matches exactly", async () => {
    const root = await createRegistryRoot();
    const missing = join(root, "missing");
    // A registry that does not exist yet reads as empty and is not created.
    expect(
      await new RepositoryRegistry(missing).findByNameReadOnly("acme/widget"),
    ).toBeNull();
    await expect(
      readFile(join(missing, "repositories.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const registry = new RepositoryRegistry(root);
    await registry.register({
      aliases: ["acme/Widget"],
      currentName: "acme/gadget",
      repoId: "R_renamed",
    });
    await registry.register({ currentName: "acme/widget", repoId: "R_new" });

    expect(await registry.findByNameReadOnly("acme/widget")).toMatchObject({
      repoId: "R_new",
    });
    expect(await registry.findByNameReadOnly("acme/Widget")).toMatchObject({
      repoId: "R_renamed",
    });
    expect(await registry.findByNameReadOnly("ACME/GADGET")).toMatchObject({
      repoId: "R_renamed",
    });
    await expect(
      registry.findByNameReadOnly("ACME/WIDGET"),
    ).rejects.toMatchObject({ code: "REPOSITORY_NAME_AMBIGUOUS" });
    await expect(registry.findByNameReadOnly("bad")).rejects.toMatchObject({
      code: "INVALID_REPOSITORY_REGISTRY",
    });
  });
});

async function createRegistryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rkm-registry-"));
  temporaryRegistries.push(root);
  return root;
}

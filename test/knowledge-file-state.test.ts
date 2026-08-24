import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildKnowledgeProjection,
  computeKnowledgeFileState,
  ensureProjectionCurrent,
  isProjectionCurrent,
  readKnowledgeSnapshot,
} from "../src/experimental.js";

const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("knowledge_file_state", () => {
  it("hashes every knowledge/*.md before invoking the projection builder", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "knowledge", "z.md"), "z-rule\n");
    await writeFile(join(repository, "knowledge", "a.md"), "a-rule\n");
    await writeFile(
      join(repository, "knowledge", "ignored.txt"),
      "not knowledge\n",
    );

    const projection = await buildKnowledgeProjection(
      repository,
      (files, completeState) => {
        expect(completeState.files).toEqual([
          {
            path: "knowledge/a.md",
            sha256: sha256("a-rule\n"),
          },
          {
            path: "knowledge/z.md",
            sha256: sha256("z-rule\n"),
          },
        ]);
        expect(files).toEqual([
          { path: "knowledge/a.md", content: "a-rule\n" },
          { path: "knowledge/z.md", content: "z-rule\n" },
        ]);

        return files.map(({ content }) => content.trim());
      },
    );

    expect(projection.value).toEqual(["a-rule", "z-rule"]);
    expect(projection.knowledgeFileState.stateSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      await isProjectionCurrent(repository, projection.knowledgeFileState),
    ).toBe(true);
  });

  it("treats a missing knowledge directory as an empty, stable state", async () => {
    const repository = await createRepository({
      createKnowledgeDirectory: false,
    });

    const snapshot = await readKnowledgeSnapshot(repository);

    expect(snapshot.files).toEqual([]);
    expect(snapshot.state.files).toEqual([]);
    await expect(
      ensureProjectionCurrent(repository, snapshot.state),
    ).resolves.toEqual(snapshot.state);
  });
});

describe("acceptance test 63", () => {
  it("invalidates a projection after a same-size edit with the same mtime", async () => {
    const repository = await createRepository();
    const knowledgePath = join(repository, "knowledge", "rule.md");
    const fixedTime = new Date("2020-01-02T03:04:05.000Z");
    await writeFile(knowledgePath, "allow: foo\n");
    await utimes(knowledgePath, fixedTime, fixedTime);

    const expected = await computeKnowledgeFileState(repository);
    const before = await stat(knowledgePath);

    await writeFile(knowledgePath, "deny!: foo\n");
    await utimes(knowledgePath, fixedTime, fixedTime);
    const after = await stat(knowledgePath);

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await isProjectionCurrent(repository, expected)).toBe(false);
    await expect(
      ensureProjectionCurrent(repository, expected),
    ).rejects.toMatchObject({
      code: "PROJECTION_STALE",
      expected,
    });
  });
});

async function createRepository(
  options: { createKnowledgeDirectory?: boolean } = {},
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "repo-knowledge-mcp-"));
  temporaryRepositories.push(repository);

  if (options.createKnowledgeDirectory !== false) {
    await mkdir(join(repository, "knowledge"));
  }

  return repository;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

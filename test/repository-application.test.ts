import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  DefaultRepositoryApplicationFactory,
  parseDistillationPrompt,
  parseRepoKnowledgeConfig,
  type RepositoryResolution,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("DefaultRepositoryApplicationFactory", () => {
  it("shares one repo-bound graph between the MCP and CLI resolvers", async () => {
    const root = await temporaryDirectory();
    const repository = resolution(root);
    const factory = new DefaultRepositoryApplicationFactory({
      config: parseRepoKnowledgeConfig({}),
      prompt: parseDistillationPrompt(
        "---\nprompt_version: distill-v1\n---\nExtract durable rules.",
      ),
      repositoryContext: { language: "TypeScript" },
    });

    const mcpOperations = await factory.create({
      repository,
      repositoryStore: new CanonicalTransactionStore(root),
    });
    const cliOperations = await factory.create({
      repository,
      repositoryStore: new CanonicalTransactionStore(root),
    });

    expect(cliOperations).toBe(mcpOperations);
    expect(cliOperations.ingestPullRequest).toBe(
      mcpOperations.ingestPullRequest,
    );
    expect(cliOperations.distill).toBe(mcpOperations.distill);
  });

  it("fails closed if a cached repository identity changes", async () => {
    const root = await temporaryDirectory();
    const factory = new DefaultRepositoryApplicationFactory({
      config: parseRepoKnowledgeConfig({}),
      prompt: parseDistillationPrompt(
        "---\nprompt_version: distill-v1\n---\nExtract durable rules.",
      ),
    });
    const repository = resolution(root);
    await factory.create({
      repository,
      repositoryStore: new CanonicalTransactionStore(root),
    });

    await expect(
      factory.create({
        repository: { ...repository, currentName: "owner/renamed" },
        repositoryStore: new CanonicalTransactionStore(root),
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_IDENTITY_CHANGED" });
  });
});

function resolution(root: string): RepositoryResolution {
  return {
    absolutePath: root,
    aliases: [],
    currentName: "owner/repository",
    path: "repos/R_repository",
    repoId: "R_repository",
    source: "tool-repo",
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-repository-application-"));
  temporaryDirectories.push(path);
  return path;
}

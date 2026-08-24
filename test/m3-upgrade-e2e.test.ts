import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  KnowledgeReadService,
  RepositoryRegistry,
  initializeStorage,
  repositoryStorageId,
  serializeKnowledgeDocument,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const REPO_ID = "R_m2_upgrade_repository";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NOW = "2026-08-08T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("M2 to M3 local-store upgrade E2E", () => {
  it("loads an M2 config, registry, and active rule without rewriting canonical bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rkm-m3-upgrade-e2e-"));
    temporaryDirectories.push(root);
    const storageRoot = join(root, "home");
    const workspaceRoot = join(root, "workspace");
    const repositoryPath = join(
      storageRoot,
      "repos",
      repositoryStorageId(REPO_ID),
    );
    const knowledgePath = join(
      repositoryPath,
      "knowledge",
      `${KNOWLEDGE_ID}.md`,
    );
    const configPath = join(storageRoot, "config.json");
    const registryPath = join(storageRoot, "repositories.json");

    await mkdir(join(repositoryPath, "knowledge"), {
      mode: 0o700,
      recursive: true,
    });
    await mkdir(workspaceRoot, { recursive: true });
    await chmod(storageRoot, 0o700);

    const m2Config = `${JSON.stringify(
      {
        defaultRepo: REPOSITORY,
        ingest: { excludeAuthors: [], includeOutdated: true },
        llm: {
          allowCloudTransmission: false,
          mode: "disabled",
          model: null,
        },
        repoPolicies: {},
        repos: [REPOSITORY],
        trust: {
          aiReviewers: { "greptile-apps[bot]": "greptile" },
          externalContributors: "raw-only",
          sourceAliases: {},
          trustedActorIds: [],
          trustedLogins: ["alice"],
        },
        workspaceMappings: { [workspaceRoot]: REPOSITORY },
      },
      null,
      2,
    )}\n`;
    const m2Registry = `${JSON.stringify(
      {
        repositories: {
          [REPO_ID]: {
            aliases: [],
            currentName: REPOSITORY,
            path: `repos/${repositoryStorageId(REPO_ID)}`,
          },
        },
      },
      null,
      2,
    )}\n`;
    const m2Knowledge = serializeKnowledgeDocument(
      `knowledge/${KNOWLEDGE_ID}.md`,
      {
        category: "architecture",
        created_at: NOW,
        id: KNOWLEDGE_ID,
        repo_id: REPO_ID,
        revision: 1,
        rule: "Keep legacy boundaries explicit",
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status: "active",
        updated_at: NOW,
      },
      "M2 canonical knowledge remains readable after the M3 update.\n",
    );

    await writeFile(configPath, m2Config, { mode: 0o600 });
    await writeFile(registryPath, m2Registry, { mode: 0o600 });
    await writeFile(knowledgePath, m2Knowledge, { mode: 0o600 });
    const canonicalBefore = await readCanonicalBytes({
      configPath,
      knowledgePath,
      registryPath,
    });

    const initialized = await initializeStorage(storageRoot);
    expect(initialized.config).toMatchObject({
      hostAssistedDistillation: {
        allowReviewContentTransmission: false,
        enabled: false,
        includeDiffHunk: false,
      },
      trust: {
        autoActivateTrustedHuman: false,
        trustedLogins: ["alice"],
      },
    });
    expect(initialized.config.trustedHumanAutoActivationEligibility).toBe(
      undefined,
    );

    const resolved = await new RepositoryRegistry(storageRoot).resolveByName(
      REPOSITORY,
    );
    expect(resolved).toMatchObject({
      absolutePath: repositoryPath,
      currentName: REPOSITORY,
      repoId: REPO_ID,
    });

    const result = await new KnowledgeReadService({
      repo: REPOSITORY,
      repoId: REPO_ID,
      repository: new CanonicalTransactionStore(repositoryPath),
    }).getRules({ filePaths: ["src/legacy.ts"] });
    expect(result).toMatchObject({
      matched_count: 1,
      readiness: { state: "ready" },
      rules: [
        {
          id: KNOWLEDGE_ID,
          rule: "Keep legacy boundaries explicit",
        },
      ],
    });

    const canonicalAfter = await readCanonicalBytes({
      configPath,
      knowledgePath,
      registryPath,
    });
    expect(canonicalAfter).toEqual(canonicalBefore);
    await expect(
      access(join(workspaceRoot, ".repo-knowledge")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function readCanonicalBytes(paths: {
  readonly configPath: string;
  readonly knowledgePath: string;
  readonly registryPath: string;
}): Promise<{
  readonly config: Buffer;
  readonly knowledge: Buffer;
  readonly registry: Buffer;
}> {
  const [config, knowledge, registry] = await Promise.all([
    readFile(paths.configPath),
    readFile(paths.knowledgePath),
    readFile(paths.registryPath),
  ]);
  return { config, knowledge, registry };
}

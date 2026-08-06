import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RepoKnowledgeConfigError,
  computeOutputSchemaDigest,
  computePromptDigest,
  computeTrustPolicyDigest,
  initializeStorage,
  loadRepoKnowledgeConfig,
  parseRepoKnowledgeConfig,
  resolveRepositoryPolicy,
  SqliteCanonicalProjection,
} from "../src/index.js";
import { rm } from "node:fs/promises";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repo knowledge config", () => {
  it("applies safe defaults to an empty config", () => {
    expect(parseRepoKnowledgeConfig({})).toEqual({
      hostAssistedDistillation: {
        allowReviewContentTransmission: false,
        enabled: false,
        includeDiffHunk: false,
        maxCharactersPerJob: 30_000,
      },
      ingest: { excludeAuthors: [], includeOutdated: true },
      llm: {
        allowCloudTransmission: false,
        mode: "disabled",
        model: null,
      },
      repoPolicies: {},
      repos: [],
      trust: {
        aiReviewers: {},
        autoActivateTrustedHuman: false,
        externalContributors: "raw-only",
        sourceAliases: {},
        trustedActorIds: [],
        trustedLogins: [],
      },
      workspaceMappings: {},
    });
  });

  it("applies nested defaults to a minimal user-authored config", () => {
    expect(
      parseRepoKnowledgeConfig({
        hostAssistedDistillation: { enabled: true },
        llm: { mode: "anthropic" },
        trust: { trustedLogins: ["zoe", "alice", "zoe"] },
      }),
    ).toMatchObject({
      hostAssistedDistillation: {
        allowReviewContentTransmission: false,
        enabled: true,
      },
      llm: {
        allowCloudTransmission: false,
        mode: "anthropic",
        model: null,
      },
      trust: {
        autoActivateTrustedHuman: false,
        trustedLogins: ["alice", "zoe"],
      },
    });
  });

  it.each([
    { llm: { mode: "openai" } },
    { repoPolicies: { "tamat/private": { unknown: true } } },
    { hostAssistedDistillation: { maxCharactersPerJob: 0 } },
    { repos: ["missing-owner"] },
    { unexpected: true },
  ])("rejects invalid config %#", (value) => {
    expect(() => parseRepoKnowledgeConfig(value)).toThrow(
      RepoKnowledgeConfigError,
    );
  });

  it("resolves repository cloud policy without weakening defaults", () => {
    const config = parseRepoKnowledgeConfig({
      llm: { allowCloudTransmission: true, mode: "anthropic" },
      repoPolicies: {
        "tamat/private": { allowCloudTransmission: false },
      },
    });

    expect(resolveRepositoryPolicy(config, "tamat/public")).toEqual({
      allowCloudTransmission: true,
    });
    expect(resolveRepositoryPolicy(config, "tamat/private")).toEqual({
      allowCloudTransmission: false,
    });
    expect(() => resolveRepositoryPolicy(config, "../private")).toThrow();
  });
});

describe("configuration digests", () => {
  it("keeps trust digest stable across set and object ordering", () => {
    const first = parseRepoKnowledgeConfig({
      trust: {
        aiReviewers: {
          "greptile-apps[bot]": "greptile",
          "cursor[bot]": "bugbot",
        },
        trustedActorIds: ["actor-z", "actor-a", "actor-z"],
        trustedLogins: ["zoe", "alice", "zoe"],
      },
    });
    const second = parseRepoKnowledgeConfig({
      trust: {
        aiReviewers: {
          "cursor[bot]": "bugbot",
          "greptile-apps[bot]": "greptile",
        },
        trustedActorIds: ["actor-a", "actor-z"],
        trustedLogins: ["alice", "zoe"],
      },
    });

    expect(computeTrustPolicyDigest(first.trust)).toBe(
      computeTrustPolicyDigest(second.trust),
    );
    expect(computeTrustPolicyDigest(first.trust)).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
  });

  it("hashes exact prompt bytes and canonical schema JSON", () => {
    expect(computePromptDigest("prompt\n")).not.toBe(
      computePromptDigest("prompt\r\n"),
    );
    expect(computeOutputSchemaDigest({ z: 1, a: true })).toBe(
      computeOutputSchemaDigest({ a: true, z: 1 }),
    );
  });
});

describe("private storage initialization", () => {
  it("rejects broad or implicit storage roots before changing permissions", async () => {
    await expect(initializeStorage("")).rejects.toMatchObject({
      code: "CONFIG_PATH_UNSAFE",
    });
    await expect(initializeStorage("/")).rejects.toMatchObject({
      code: "CONFIG_PATH_UNSAFE",
    });
  });

  it("creates an atomic config with 700 and 600 permissions", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "store");
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);

    const initialized = await initializeStorage(root, {
      defaultRepo: "tamat/repo-knowledge-mcp",
      repos: ["tamat/repo-knowledge-mcp"],
    });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(initialized.configPath)).mode & 0o777).toBe(0o600);
    expect(initialized.config.defaultRepo).toBe("tamat/repo-knowledge-mcp");
    expect(JSON.parse(await readFile(initialized.configPath, "utf8"))).toEqual(
      initialized.config,
    );
  });

  it("does not overwrite an existing config during reinitialization", async () => {
    const root = join(await temporaryDirectory(), "store");
    const first = await initializeStorage(root, {
      defaultRepo: "tamat/first",
    });
    const firstBytes = await readFile(first.configPath);

    const second = await initializeStorage(root, {
      defaultRepo: "tamat/second",
    });

    expect(second.config.defaultRepo).toBe("tamat/first");
    expect(await readFile(second.configPath)).toEqual(firstBytes);
    expect((await stat(second.configPath)).mode & 0o777).toBe(0o600);
  });

  it("creates and tightens the derived SQLite projection to mode 600", async () => {
    const repositoryRoot = join(await temporaryDirectory(), "repository");
    await mkdir(repositoryRoot, { mode: 0o700 });
    const projection = new SqliteCanonicalProjection(repositoryRoot);

    await projection.rebuild();
    expect((await stat(projection.databasePath)).mode & 0o777).toBe(0o600);

    await chmod(projection.databasePath, 0o644);
    await projection.ensureCurrent();
    expect((await stat(projection.databasePath)).mode & 0o777).toBe(0o600);
  });

  it("reports invalid JSON and invalid UTF-8 as config errors", async () => {
    const parent = await temporaryDirectory();
    const invalidJson = join(parent, "invalid.json");
    const invalidUtf8 = join(parent, "invalid-utf8.json");
    await writeFile(invalidJson, "{", { mode: 0o600 });
    await writeFile(invalidUtf8, Buffer.from([0xff]), { mode: 0o600 });

    await expect(loadRepoKnowledgeConfig(invalidJson)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(loadRepoKnowledgeConfig(invalidUtf8)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects a symlinked config path", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "store");
    const outside = join(parent, "outside.json");
    await mkdir(root, { mode: 0o700 });
    await writeFile(outside, "{}\n", { mode: 0o600 });
    await symlink(outside, join(root, "config.json"));

    await expect(initializeStorage(root)).rejects.toMatchObject({
      code: "CONFIG_PATH_UNSAFE",
    });
    expect(await readFile(outside, "utf8")).toBe("{}\n");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "repo-knowledge-config-"));
  temporaryDirectories.push(path);
  return path;
}

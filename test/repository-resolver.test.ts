import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GitRemoteError,
  RESOLVE_REPOSITORY_GRAPHQL,
  RepositoryRegistry,
  RepositoryResolutionError,
  RepositoryResolver,
  parseRepoKnowledgeConfig,
  resolveAllowedWorkspacePath,
  type GhRunnerLike,
  type GitRemoteReader,
} from "../src/experimental.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("RepositoryResolver precedence", () => {
  it("prefers a tool repo without evaluating lower-priority workspace input", async () => {
    const fixture = await createFixture();
    const gitRemoteReader = {
      readOrigin: vi.fn<GitRemoteReader["readOrigin"]>(),
    };
    const resolver = fixture.resolver({
      config: {
        defaultRepo: "default/repo",
        workspaceMappings: { [fixture.workspace]: "mapped/repo" },
      },
      gitRemoteReader,
      startupRepo: "startup/repo",
    });

    const result = await resolver.resolve({
      repo: "tool/repo",
      workspacePath: "/outside/not-evaluated",
    });

    expect(result).toMatchObject({
      currentName: "tool/repo",
      repoId: "R_tool_repo",
      source: "tool-repo",
    });
    expect(gitRemoteReader.readOrigin).not.toHaveBeenCalled();
  });

  it("prefers a tool workspace remote over startup and config values", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      allowedWorkspaceRoots: [fixture.allowedRoot],
      config: {
        defaultRepo: "default/repo",
        workspaceMappings: { [fixture.workspace]: "mapped/repo" },
      },
      gitRemoteReader: remoteReader("git@github.com:workspace/from-origin.git"),
      startupRepo: "startup/repo",
    });

    const result = await resolver.resolve({ workspacePath: fixture.workspace });

    expect(result).toMatchObject({
      currentName: "workspace/from-origin",
      repoId: "R_workspace_from-origin",
      source: "tool-workspace",
      workspacePath: await realpath(fixture.workspace),
    });
  });

  it("uses startup repo before startup workspace and mappings", async () => {
    const fixture = await createFixture();
    const gitRemoteReader = remoteReader("git@github.com:ignored/remote.git");
    const resolver = fixture.resolver({
      config: { workspaceMappings: { [fixture.workspace]: "mapped/repo" } },
      gitRemoteReader,
      startupRepo: "startup/repo",
      startupWorkspace: fixture.workspace,
    });

    const result = await resolver.resolve();

    expect(result).toMatchObject({
      currentName: "startup/repo",
      source: "startup-repo",
    });
    expect(gitRemoteReader.readOrigin).not.toHaveBeenCalled();
  });

  it("resolves a startup workspace remote", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      config: { defaultRepo: "default/repo" },
      gitRemoteReader: remoteReader("https://github.com/startup/workspace.git"),
      startupWorkspace: fixture.workspace,
    });

    const result = await resolver.resolve();

    expect(result).toMatchObject({
      currentName: "startup/workspace",
      source: "startup-workspace",
    });
  });

  it("uses the most specific workspace mapping when no remote route wins", async () => {
    const fixture = await createFixture();
    const nested = join(fixture.workspace, "packages", "api");
    await mkdir(nested, { recursive: true });
    const resolver = fixture.resolver({
      config: {
        defaultRepo: "default/repo",
        workspaceMappings: {
          [fixture.allowedRoot]: "broad/repo",
          [fixture.workspace]: "mapped/repo",
        },
      },
      cwd: nested,
    });

    const result = await resolver.resolve();

    expect(result).toMatchObject({
      currentName: "mapped/repo",
      source: "config-workspace-mapping",
      workspacePath: await realpath(nested),
    });
  });

  it("falls back from an unavailable tool remote to its workspace mapping", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      config: { workspaceMappings: { [fixture.workspace]: "mapped/repo" } },
      gitRemoteReader: failingRemoteReader(),
    });

    const result = await resolver.resolve({ workspacePath: fixture.workspace });

    expect(result).toMatchObject({
      currentName: "mapped/repo",
      source: "config-workspace-mapping",
    });
  });

  it("uses defaultRepo last", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      config: { defaultRepo: "default/repo" },
      cwd: fixture.allowedRoot,
    });

    const result = await resolver.resolve();

    expect(result).toMatchObject({
      currentName: "default/repo",
      source: "config-default-repo",
    });
  });

  it("does not let a stale lower-priority mapping block a tool workspace", async () => {
    const fixture = await createFixture();
    const missingRoot = join(fixture.allowedRoot, "missing");
    const resolver = fixture.resolver({
      allowedWorkspaceRoots: [fixture.allowedRoot],
      config: { workspaceMappings: { [missingRoot]: "stale/repo" } },
      gitRemoteReader: remoteReader("git@github.com:tool/workspace.git"),
    });

    const result = await resolver.resolve({ workspacePath: fixture.workspace });

    expect(result).toMatchObject({
      currentName: "tool/workspace",
      source: "tool-workspace",
    });
  });

  it("skips a stale mapping and continues to defaultRepo", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      config: {
        defaultRepo: "default/repo",
        workspaceMappings: {
          [join(fixture.allowedRoot, "missing")]: "stale/repo",
        },
      },
      cwd: fixture.workspace,
    });

    const result = await resolver.resolve();

    expect(result).toMatchObject({
      currentName: "default/repo",
      source: "config-default-repo",
    });
  });
});

describe("RepositoryResolver identity and diagnostics", () => {
  it("sends GraphQL string variables as individual gh argv values", async () => {
    const fixture = await createFixture();
    let receivedArgs: readonly string[] = [];
    const resolver = fixture.resolver({
      ghRunner: {
        async run(args) {
          receivedArgs = [...args];
          return {
            stderr: "",
            stdout: JSON.stringify({
              data: {
                repository: {
                  id: "R_numeric",
                  nameWithOwner: "123/456",
                },
              },
            }),
          };
        },
      },
    });

    await resolver.resolve({ repo: "123/456" });

    expect(receivedArgs).toEqual([
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_REPOSITORY_GRAPHQL}`,
      "-f",
      "owner=123",
      "-f",
      "name=456",
    ]);
  });

  it("keeps a stable storage path and records the previous name on rename", async () => {
    const fixture = await createFixture();
    const identities = new Map([
      ["old-owner/repo", { id: "R_stable", nameWithOwner: "old-owner/repo" }],
      ["new-owner/repo", { id: "R_stable", nameWithOwner: "new-owner/repo" }],
    ]);
    const resolver = fixture.resolver({ ghRunner: fakeGhRunner(identities) });

    const before = await resolver.resolve({ repo: "old-owner/repo" });
    const after = await resolver.resolve({ repo: "new-owner/repo" });

    expect(after.absolutePath).toBe(before.absolutePath);
    expect(after.path).toBe(before.path);
    expect(after.aliases).toEqual(["old-owner/repo"]);
    expect(after.currentName).toBe("new-owner/repo");
  });

  it("records a requested alias when GitHub returns a renamed canonical name", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      ghRunner: fakeGhRunner(
        new Map([
          [
            "old-owner/repo",
            { id: "R_redirected", nameWithOwner: "new-owner/repo" },
          ],
        ]),
      ),
    });

    const result = await resolver.resolve({ repo: "old-owner/repo" });

    expect(result).toMatchObject({
      aliases: ["old-owner/repo"],
      currentName: "new-owner/repo",
      repoId: "R_redirected",
    });
  });

  it.each([
    "missing-slash",
    "owner-/repo",
    "owner/..",
    "owner/repo/extra",
    "../owner/repo",
    "owner/repo name",
  ])("rejects invalid repository input %s before calling gh", async (repo) => {
    const fixture = await createFixture();
    const ghRunner = { run: vi.fn<GhRunnerLike["run"]>() };
    const resolver = fixture.resolver({ ghRunner });

    await expect(resolver.resolve({ repo })).rejects.toMatchObject({
      code: "INVALID_REPOSITORY_NAME",
    });
    expect(ghRunner.run).not.toHaveBeenCalled();
  });

  it("rejects GraphQL partial data when errors are present", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      ghRunner: {
        run: async () => ({
          stderr: "",
          stdout: JSON.stringify({
            data: {
              repository: { id: "R_partial", nameWithOwner: "owner/repo" },
            },
            errors: [{ message: "field failed" }],
          }),
        }),
      },
    });

    await expect(
      resolver.resolve({ repo: "owner/repo" }),
    ).rejects.toMatchObject({ code: "GITHUB_GRAPHQL_ERROR" });
  });

  it("classifies a null-data GraphQL error without accepting partial state", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      ghRunner: {
        run: async () => ({
          stderr: "",
          stdout: JSON.stringify({
            data: null,
            errors: [{ message: "repository lookup failed" }],
          }),
        }),
      },
    });

    await expect(
      resolver.resolve({ repo: "owner/repo" }),
    ).rejects.toMatchObject({ code: "GITHUB_GRAPHQL_ERROR" });
  });

  it("returns candidates and configuration guidance when unresolved", async () => {
    const fixture = await createFixture();
    const resolver = fixture.resolver({
      config: { repos: ["candidate/one", "candidate/two"] },
      cwd: fixture.allowedRoot,
    });

    const error = await captureResolutionError(resolver.resolve());
    expect(error).toMatchObject({
      candidates: ["candidate/one", "candidate/two"],
      code: "REPOSITORY_UNRESOLVED",
    });
    expect(error.guidance).toHaveLength(3);
    expect(error.message).toContain("Candidates: candidate/one, candidate/two");
    expect(error.message).toContain("defaultRepo");
  });
});

describe("workspace path confinement", () => {
  it("accepts a real directory nested under an allowed root", async () => {
    const fixture = await createFixture();

    await expect(
      resolveAllowedWorkspacePath(fixture.workspace, [fixture.allowedRoot]),
    ).resolves.toBe(await realpath(fixture.workspace));
  });

  it("rejects paths outside allowed roots", async () => {
    const fixture = await createFixture();
    const outside = await temporaryDirectory("rkm-outside-");

    await expect(
      resolveAllowedWorkspacePath(outside, [fixture.allowedRoot]),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });

  it("rejects a missing outside path before attempting filesystem discovery", async () => {
    const fixture = await createFixture();
    const outside = join(
      await temporaryDirectory("rkm-outside-"),
      "does-not-exist",
    );

    await expect(
      resolveAllowedWorkspacePath(outside, [fixture.allowedRoot]),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });

  it("rejects symlink escapes after realpath", async () => {
    const fixture = await createFixture();
    const outside = await temporaryDirectory("rkm-outside-");
    const escaped = join(fixture.allowedRoot, "escaped");
    await symlink(outside, escaped);

    await expect(
      resolveAllowedWorkspacePath(escaped, [fixture.allowedRoot]),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });

  it("rejects an explicit dot-dot segment even when it resolves inside root", async () => {
    const fixture = await createFixture();
    const withDotDot = `${fixture.workspace}/child/../child`;
    await mkdir(join(fixture.workspace, "child"));

    await expect(
      resolveAllowedWorkspacePath(withDotDot, [fixture.allowedRoot]),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });
});

interface Fixture {
  readonly allowedRoot: string;
  readonly registry: RepositoryRegistry;
  resolver(overrides?: ResolverOverrides): RepositoryResolver;
  readonly workspace: string;
}

interface ResolverOverrides {
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly config?: Record<string, unknown>;
  readonly cwd?: string;
  readonly ghRunner?: GhRunnerLike;
  readonly gitRemoteReader?: GitRemoteReader;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("rkm-resolver-");
  const allowedRoot = join(root, "workspaces");
  const workspace = join(allowedRoot, "repo");
  await mkdir(workspace, { recursive: true });
  const registry = new RepositoryRegistry(join(root, "registry"));
  return {
    allowedRoot,
    registry,
    resolver(overrides = {}) {
      return new RepositoryResolver({
        allowedWorkspaceRoots: overrides.allowedWorkspaceRoots ?? [],
        config: parseRepoKnowledgeConfig(overrides.config ?? {}),
        cwd: overrides.cwd ?? root,
        ghRunner: overrides.ghRunner ?? fakeGhRunner(),
        ...(overrides.gitRemoteReader === undefined
          ? {}
          : { gitRemoteReader: overrides.gitRemoteReader }),
        registry,
        ...(overrides.startupRepo === undefined
          ? {}
          : { startupRepo: overrides.startupRepo }),
        ...(overrides.startupWorkspace === undefined
          ? {}
          : { startupWorkspace: overrides.startupWorkspace }),
      });
    },
    workspace,
  };
}

function fakeGhRunner(
  identities: ReadonlyMap<
    string,
    { id: string; nameWithOwner: string }
  > = new Map(),
): GhRunnerLike {
  return {
    async run(args) {
      const owner = args.find((arg) => arg.startsWith("owner="))?.slice(6);
      const name = args.find((arg) => arg.startsWith("name="))?.slice(5);
      if (owner === undefined || name === undefined) {
        throw new Error("missing GraphQL variables");
      }
      const requested = `${owner}/${name}`;
      const identity = identities.get(requested) ?? {
        id: `R_${owner}_${name}`,
        nameWithOwner: requested,
      };
      return {
        stderr: "",
        stdout: JSON.stringify({ data: { repository: identity } }),
      };
    },
  };
}

function remoteReader(remote: string): GitRemoteReader {
  return { readOrigin: vi.fn(async () => remote) };
}

function failingRemoteReader(): GitRemoteReader {
  return {
    readOrigin: vi.fn(async () => {
      throw new GitRemoteError("GIT_REMOTE_UNAVAILABLE", "origin is missing");
    }),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function captureResolutionError(
  promise: Promise<unknown>,
): Promise<RepositoryResolutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RepositoryResolutionError) return error;
    throw error;
  }
  throw new Error("Expected repository resolution to fail");
}

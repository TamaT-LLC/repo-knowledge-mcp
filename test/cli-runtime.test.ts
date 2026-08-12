import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  REPO_KNOWLEDGE_CLI_HELP,
  SetupStateStore,
  captureCanonicalStateReadOnly,
  loadRepoKnowledgeConfig,
  reduceDomainRecords,
  runDefaultRepoKnowledgeCli,
  type GhCommandResult,
  type GhRunnerLike,
  type RepoKnowledgeCliIo,
} from "../src/index.js";
import { WireClient, readTools } from "./support/mcp-test-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("default CLI runtime", () => {
  it("publishes both command aliases through the built CLI entry", async () => {
    const manifest = JSON.parse(
      await readFile("package.json", "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.bin).toEqual({
      "repo-knowledge": "./dist/bin.js",
      "repo-knowledge-mcp": "./dist/bin.js",
    });

    const storageRoot = join(await temporaryDirectory(), "not-created");
    const result = await execa(process.execPath, ["dist/bin.js", "--help"], {
      env: { ...process.env, REPO_KNOWLEDGE_HOME: storageRoot },
    });
    expect(result.stdout).toBe(REPO_KNOWLEDGE_CLI_HELP.trimEnd());
    expect(result.stderr).toBe("");
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps help and bootstrap output side-effect free", async () => {
    const parent = await temporaryDirectory();
    const storageRoot = join(parent, "not-created");
    const help = output({ stdinIsTTY: true, stdoutIsTTY: true });

    await expect(
      runDefaultRepoKnowledgeCli({ argv: [], io: help.io, storageRoot }),
    ).resolves.toBe(0);
    expect(help.stdout()).toBe(REPO_KNOWLEDGE_CLI_HELP);
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const bootstrap = output({ stdinIsTTY: false, stdoutIsTTY: false });
    await expect(
      runDefaultRepoKnowledgeCli({
        argv: ["export", "owner/repository", "--bootstrap"],
        io: bootstrap.io,
        storageRoot,
      }),
    ).resolves.toBe(0);
    expect(bootstrap.stdout()).toBe(
      `${REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION}\n`,
    );
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs doctor without initializing missing storage", async () => {
    const parent = await temporaryDirectory();
    const storageRoot = join(parent, "not-created");
    const captured = output({ stdinIsTTY: true, stdoutIsTTY: true });

    await expect(
      runDefaultRepoKnowledgeCli({
        argv: ["doctor", "owner/repository"],
        ghRunner: new HealthyGhRunner(),
        io: captured.io,
        storageRoot,
      }),
    ).resolves.toBe(1);

    expect(JSON.parse(captured.stdout())).toMatchObject({
      ok: false,
      summary: { fail: expect.any(Number) },
    });
    expect(captured.stderr()).toBe("");
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the real MCP stdio server for an argument-free pipe", async () => {
    const storageRoot = join(await temporaryDirectory(), "storage");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new WireClient(clientTransport);
    const captured = output({ stdinIsTTY: false, stdoutIsTTY: false });
    await client.start();
    try {
      await expect(
        runDefaultRepoKnowledgeCli({
          argv: [],
          io: captured.io,
          storageRoot,
          transport: serverTransport,
        }),
      ).resolves.toBe(0);
      const initialized = await client.request("initialize", {
        capabilities: {},
        clientInfo: { name: "cli-runtime-test", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      });
      expect(initialized).not.toHaveProperty("error");
      await client.notify("notifications/initialized", {});

      const tools = readTools(await client.request("tools/list", {}));
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "add_knowledge",
        "get_knowledge",
        "get_rules",
        "ingest_pr",
        "prepare_distillation",
        "record_outcome",
        "search_knowledge",
        "stats",
        "submit_distillation",
        "sync_repo",
        "update_knowledge",
      ]);
      expect(captured.stdout()).toBe("");
      expect(captured.stderr()).toBe("");
    } finally {
      await client.close();
    }
  });

  it("initializes a workspace from its remote without transmitting review content", async () => {
    const parent = await temporaryDirectory();
    const storageRoot = join(parent, "storage");
    const workspacePath = join(parent, "workspace");
    await mkdir(workspacePath, { mode: 0o700 });
    const canonicalWorkspacePath = await realpath(workspacePath);
    const confirmationIds: string[] = [];
    const captured = output(
      { stdinIsTTY: true, stdoutIsTTY: true },
      async (request) => {
        confirmationIds.push(request.id);
        return request.id === "trust.U_reviewer";
      },
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider transmission must remain off"));

    try {
      const exitCode = await runDefaultRepoKnowledgeCli({
        argv: ["setup", "--json"],
        clock: () => new Date("2026-08-09T00:00:00.000Z"),
        cwd: workspacePath,
        ghRunner: new SetupGhRunner(),
        gitRemoteReader: {
          readOrigin: async () => "https://github.com/owner/repository.git",
        },
        io: captured.io,
        storageRoot,
      });
      expect(exitCode, captured.stderr()).toBe(0);

      const result = JSON.parse(captured.stdout()) as {
        repository: { storage_path: string; workspace_path: string };
        state_path: string;
      };
      expect(result.repository.workspace_path).toBe(canonicalWorkspacePath);
      const config = await loadRepoKnowledgeConfig(
        join(storageRoot, "config.json"),
      );
      expect(config).toMatchObject({
        defaultRepo: "owner/repository",
        hostAssistedDistillation: {
          allowReviewContentTransmission: false,
          enabled: false,
        },
        llm: { allowCloudTransmission: false, mode: "disabled" },
        repos: ["owner/repository"],
        trust: {
          autoActivateTrustedHuman: false,
          trustedActorIds: ["U_reviewer"],
          trustedLogins: ["alice"],
        },
        workspaceMappings: {
          [canonicalWorkspacePath]: "owner/repository",
        },
      });
      const capture = await captureCanonicalStateReadOnly(
        result.repository.storage_path,
      );
      const domain = reduceDomainRecords(
        capture.records.map((entry) => entry.record),
      );
      expect(domain.comments).toHaveLength(1);
      expect(domain.comments[0]).toMatchObject({
        actor: { actor_id: "U_reviewer", login: "alice" },
        body: "Prefer the repository helper.",
        diff_hunk: "@@ -1 +1 @@",
      });
      expect(domain.distillJobs.length).toBeGreaterThanOrEqual(1);
      expect(
        await new SetupStateStore(result.repository.storage_path).read(),
      ).toMatchObject({ phase: "complete" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(confirmationIds).toEqual([
        "transmission.provider",
        "transmission.host-assisted",
        "trust.U_reviewer",
      ]);
      await expect(
        access(join(workspacePath, ".repo-knowledge")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const rerun = output(
        { stdinIsTTY: true, stdoutIsTTY: true },
        async (request) => {
          confirmationIds.push(request.id);
          return false;
        },
      );
      await expect(
        runDefaultRepoKnowledgeCli({
          argv: ["setup", "--json"],
          clock: () => new Date("2026-08-09T00:00:00.000Z"),
          cwd: workspacePath,
          ghRunner: new SetupGhRunner(),
          gitRemoteReader: {
            readOrigin: async () => "https://github.com/owner/repository.git",
          },
          io: rerun.io,
          storageRoot,
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(rerun.stdout())).toMatchObject({ resumed: true });
      const rerunCapture = await captureCanonicalStateReadOnly(
        result.repository.storage_path,
      );
      expect(rerunCapture.canonicalDigest).toBe(capture.canonicalDigest);
      expect(rerunCapture.records).toHaveLength(capture.records.length);
      expect(confirmationIds).toHaveLength(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects a repository and workspace identity mismatch before registry mutation", async () => {
    const parent = await temporaryDirectory();
    const storageRoot = join(parent, "storage");
    const workspacePath = join(parent, "workspace");
    await mkdir(workspacePath, { mode: 0o700 });
    const captured = output(
      { stdinIsTTY: true, stdoutIsTTY: true },
      async () => false,
    );

    await expect(
      runDefaultRepoKnowledgeCli({
        argv: ["setup", "other/repository"],
        cwd: workspacePath,
        ghRunner: new MismatchSetupGhRunner(),
        gitRemoteReader: {
          readOrigin: async () => "https://github.com/owner/repository.git",
        },
        io: captured.io,
        storageRoot,
      }),
    ).resolves.toBe(1);

    expect(captured.stderr()).toContain("SETUP_REPOSITORY_MISMATCH");
    expect(
      await loadRepoKnowledgeConfig(join(storageRoot, "config.json")),
    ).toMatchObject({ repos: [], workspaceMappings: {} });
    await expect(
      access(join(storageRoot, "repositories.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class HealthyGhRunner implements GhRunnerLike {
  async run(args: readonly string[]): Promise<GhCommandResult> {
    if (args[0] === "--version") {
      return { stderr: "", stdout: "gh version fixture\n" };
    }
    if (args[0] === "auth") {
      return { stderr: "", stdout: "authenticated\n" };
    }
    const query = args.find((value) => value.startsWith("query=")) ?? "";
    if (query.includes("RepoKnowledgeDoctor")) {
      return {
        stderr: "",
        stdout: JSON.stringify({ data: { viewer: { login: "fixture" } } }),
      };
    }
    if (query.includes("ResolveRepository")) {
      return {
        stderr: "",
        stdout: JSON.stringify({
          data: {
            repository: {
              id: "R_repository",
              nameWithOwner: "owner/repository",
            },
          },
        }),
      };
    }
    throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
  }
}

class SetupGhRunner implements GhRunnerLike {
  async run(args: readonly string[]): Promise<GhCommandResult> {
    if (args[0] === "--version") {
      return { stderr: "", stdout: "gh version fixture\n" };
    }
    if (args[0] === "auth") {
      return { stderr: "", stdout: "authenticated\n" };
    }
    const query = args.find((value) => value.startsWith("query=")) ?? "";
    if (query.includes("RepoKnowledgeDoctor")) {
      return response({ viewer: { login: "fixture" } });
    }
    if (query.includes("ResolveRepository")) {
      return response({
        repository: {
          id: "R_repository",
          nameWithOwner: "owner/repository",
        },
      });
    }
    if (query.includes("ListUpdatedPullRequests")) {
      return response({
        repository: {
          id: "R_repository",
          nameWithOwner: "owner/repository",
          pullRequests: {
            nodes: [
              {
                id: "PR_node",
                number: 7,
                updatedAt: "2026-08-08T00:00:00.000Z",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      });
    }
    if (query.includes("FetchPullRequestSnapshot")) {
      return response({
        repository: {
          id: "R_repository",
          nameWithOwner: "owner/repository",
          pullRequest: {
            baseRefOid: "base-oid",
            headRefOid: "head-oid",
            id: "PR_node",
            mergedAt: null,
            number: 7,
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [
                      {
                        author: {
                          __typename: "User",
                          id: "U_reviewer",
                          login: "alice",
                        },
                        authorAssociation: "MEMBER",
                        body: "Prefer the repository helper.",
                        createdAt: "2026-08-08T00:00:00.000Z",
                        diffHunk: "@@ -1 +1 @@",
                        id: "C_review",
                        updatedAt: "2026-08-08T00:00:00.000Z",
                        url: "https://github.com/owner/repository/pull/7#discussion_r1",
                      },
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                  id: "thread-1",
                  isOutdated: false,
                  isResolved: true,
                  path: "src/index.ts",
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
            reviews: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
            title: "Guided setup fixture",
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
        },
      });
    }
    if (query.includes("ValidatePullRequestSnapshot")) {
      return response({
        nodes: [
          {
            __typename: "PullRequestReviewThread",
            comments: { totalCount: 1 },
            id: "thread-1",
            isOutdated: false,
            isResolved: true,
            path: "src/index.ts",
          },
        ],
        repository: {
          id: "R_repository",
          pullRequest: {
            baseRefOid: "base-oid",
            headRefOid: "head-oid",
            id: "PR_node",
            mergedAt: null,
            number: 7,
            reviewThreads: { totalCount: 1 },
            reviews: { totalCount: 0 },
            title: "Guided setup fixture",
            updatedAt: "2026-08-08T00:00:00.000Z",
          },
        },
      });
    }
    throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
  }
}

class MismatchSetupGhRunner implements GhRunnerLike {
  async run(args: readonly string[]): Promise<GhCommandResult> {
    const query = args.find((value) => value.startsWith("query=")) ?? "";
    if (!query.includes("ResolveRepository")) {
      throw new Error(`unexpected gh arguments: ${args.join(" ")}`);
    }
    const owner = args.find((value) => value.startsWith("owner="));
    const name = args.find((value) => value.startsWith("name="));
    const repository = `${owner?.slice("owner=".length)}/${name?.slice("name=".length)}`;
    return response({
      repository: {
        id: repository === "other/repository" ? "R_other" : "R_repository",
        nameWithOwner: repository,
      },
    });
  }
}

function response(data: unknown): GhCommandResult {
  return { stderr: "", stdout: JSON.stringify({ data }) };
}

function output(
  tty: {
    readonly stdinIsTTY: boolean;
    readonly stdoutIsTTY: boolean;
  },
  confirm?: NonNullable<RepoKnowledgeCliIo["confirm"]>,
  input: NonNullable<RepoKnowledgeCliIo["input"]> = async () => "claude-test",
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RepoKnowledgeCliIo = {
    ...tty,
    ...(confirm === undefined ? {} : { confirm, input }),
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  return {
    io,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-cli-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

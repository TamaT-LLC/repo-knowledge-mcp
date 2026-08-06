import { describe, expect, it, vi } from "vitest";

import {
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  REPO_KNOWLEDGE_CLI_EXIT,
  REPO_KNOWLEDGE_CLI_HELP,
  parseRepoKnowledgeCliArguments,
  runRepoKnowledgeCli,
  type CliRepositoryOperations,
  type CliRepositoryOperationsResolver,
  type KnowledgeMutationOperations,
  type KnowledgeMutationServiceResolver,
  type RepoKnowledgeCliIo,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("repo-knowledge CLI", () => {
  it("shows help for an argument-free TTY and serves an argument-free pipe", async () => {
    const tty = fixture([], { stdinIsTTY: true, stdoutIsTTY: true });
    await expect(runRepoKnowledgeCli(tty.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.success,
    );
    expect(tty.stdout()).toBe(REPO_KNOWLEDGE_CLI_HELP);
    expect(tty.serve).not.toHaveBeenCalled();
    expect(tty.resolveMutation).not.toHaveBeenCalled();

    const pipe = fixture([], { stdinIsTTY: false, stdoutIsTTY: false });
    await expect(runRepoKnowledgeCli(pipe.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.success,
    );
    expect(pipe.serve).toHaveBeenCalledWith({});
    expect(pipe.stdout()).toBe("");
    expect(pipe.stderr()).toBe("");
  });

  it("keeps successful serve stdout reserved for JSON-RPC", async () => {
    const current = fixture(["serve", "--repo", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.serve).toHaveBeenCalledWith({ startupRepo: REPOSITORY });
    expect(current.stdout()).toBe("");
    expect(current.stderr()).toBe("");
  });

  it("routes ingest through the same mutation service resolver as MCP", async () => {
    const current = fixture(["ingest", REPOSITORY, "42"]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.resolveMutation).toHaveBeenCalledWith({ repo: REPOSITORY });
    expect(current.ingestPullRequest).toHaveBeenCalledWith({ pr_number: 42 });
    expect(JSON.parse(current.stdout())).toMatchObject({
      jobs_created: 1,
      pending: 1,
      repo_id: "R_repository",
    });
  });

  it("routes maintenance commands and validates their selectors", async () => {
    const distill = fixture(["distill", "--workspace", "/work/repo"]);
    await expect(runRepoKnowledgeCli(distill.options)).resolves.toBe(0);
    expect(distill.resolveOperations).toHaveBeenCalledWith({
      workspacePath: "/work/repo",
    });
    expect(distill.operations.distill).toHaveBeenCalledOnce();

    const list = fixture(["list", REPOSITORY, "--status", "proposed"]);
    await expect(runRepoKnowledgeCli(list.options)).resolves.toBe(0);
    expect(list.operations.listKnowledge).toHaveBeenCalledWith({
      status: "proposed",
    });

    const reindex = fixture(["reindex", REPOSITORY]);
    await expect(runRepoKnowledgeCli(reindex.options)).resolves.toBe(0);
    expect(reindex.operations.reindex).toHaveBeenCalledOnce();

    const redistill = fixture([
      "redistill",
      REPOSITORY,
      "--author",
      "greptile-apps[bot]",
    ]);
    await expect(runRepoKnowledgeCli(redistill.options)).resolves.toBe(0);
    expect(redistill.operations.redistill).toHaveBeenCalledWith({
      author: "greptile-apps[bot]",
      selector: "author",
    });

    const selectorCases = [
      { argv: ["--all"], request: { selector: "all" } },
      { argv: ["--failed"], request: { selector: "failed" } },
      {
        argv: ["--prompt-version", "distill-v2"],
        request: {
          prompt_version: "distill-v2",
          selector: "prompt-version",
        },
      },
    ] as const;
    for (const selectorCase of selectorCases) {
      const current = fixture(["redistill", REPOSITORY, ...selectorCase.argv]);
      await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);
      expect(current.operations.redistill).toHaveBeenCalledWith(
        selectorCase.request,
      );
    }

    const reconcile = fixture([
      "reconcile",
      REPOSITORY,
      "--write-derived-metadata",
    ]);
    await expect(runRepoKnowledgeCli(reconcile.options)).resolves.toBe(0);
    expect(
      reconcile.operations.reconcileDerivedMetadata,
    ).toHaveBeenCalledOnce();
  });

  it("prints only the specified bootstrap line without resolving knowledge", async () => {
    const current = fixture(["export", REPOSITORY, "--bootstrap"]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.stdout()).toBe(`${REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION}\n`);
    expect(current.resolveMutation).not.toHaveBeenCalled();
    expect(current.resolveOperations).not.toHaveBeenCalled();
    expect(current.stdout()).not.toContain("canonical fixture rule");
  });

  it("rejects admin commands without a real input and output TTY", async () => {
    const current = fixture(["approve", KNOWLEDGE_ID, "--repo", REPOSITORY], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
    });

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(1);

    expect(current.stderr()).toContain("CLI_TTY_REQUIRED");
    expect(current.resolveOperations).not.toHaveBeenCalled();
    expect(current.operations.admin.approve).not.toHaveBeenCalled();
  });

  it("routes TTY-only approve, edit, approve-revision, and add --active", async () => {
    const approve = fixture(["approve", KNOWLEDGE_ID, "--repo", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    await expect(runRepoKnowledgeCli(approve.options)).resolves.toBe(0);
    expect(approve.operations.admin.approve).toHaveBeenCalledWith(KNOWLEDGE_ID);

    const edit = fixture(
      [
        "edit",
        KNOWLEDGE_ID,
        "--repo",
        REPOSITORY,
        "--rule",
        "Updated rule",
        "--scope",
        "src/**",
        "--scope",
        "test/**",
      ],
      { stdinIsTTY: true, stdoutIsTTY: true },
    );
    await expect(runRepoKnowledgeCli(edit.options)).resolves.toBe(0);
    expect(edit.operations.admin.edit).toHaveBeenCalledWith(KNOWLEDGE_ID, {
      rule: "Updated rule",
      scope: ["src/**", "test/**"],
    });

    const revision = fixture(
      ["approve-revision", "proposal_1", "--repo", REPOSITORY],
      { stdinIsTTY: true, stdoutIsTTY: true },
    );
    await expect(runRepoKnowledgeCli(revision.options)).resolves.toBe(0);
    expect(revision.operations.admin.approveRevision).toHaveBeenCalledWith(
      "proposal_1",
    );

    const add = fixture(
      [
        "add",
        "--active",
        "--repo",
        REPOSITORY,
        "--category",
        "architecture",
        "--detail",
        "Human-authored detail",
        "--rule",
        "Human-authored rule",
        "--severity",
        "must",
        "--scope",
        "src/**",
      ],
      { stdinIsTTY: true, stdoutIsTTY: true },
    );
    await expect(runRepoKnowledgeCli(add.options)).resolves.toBe(0);
    expect(add.operations.admin.addActive).toHaveBeenCalledWith({
      category: "architecture",
      detail: "Human-authored detail",
      rule: "Human-authored rule",
      scope: ["src/**"],
      severity: "must",
    });
  });

  it.each([
    [["sync", REPOSITORY], "CLI_COMMAND_UNAVAILABLE_IN_M1"],
    [["record_outcome"], "CLI_COMMAND_UNAVAILABLE_IN_M1"],
    [["stats"], "CLI_COMMAND_UNAVAILABLE_IN_M1"],
    [
      ["ingest", REPOSITORY, "42", "--since", "yesterday"],
      "CLI_COMMAND_UNAVAILABLE_IN_M1",
    ],
    [
      ["ingest", REPOSITORY, "42", "--since=yesterday"],
      "CLI_COMMAND_UNAVAILABLE_IN_M1",
    ],
    [["list", REPOSITORY, "--status", "unknown"], "CLI_ARGUMENT_INVALID"],
    [["redistill", REPOSITORY, "--all", "--failed"], "CLI_ARGUMENT_INVALID"],
    [["reconcile", REPOSITORY], "CLI_ARGUMENT_INVALID"],
    [["serve", "--repo", "not-a-repository"], "CLI_ARGUMENT_INVALID"],
  ])("returns a usage error for %j", async (argv, code) => {
    const current = fixture(argv as string[]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(2);

    expect(current.stderr()).toContain(code);
    expect(current.stdout()).toBe("");
  });

  it("keeps deferred v0.2 commands out of help and parser output", () => {
    expect(REPO_KNOWLEDGE_CLI_HELP).not.toContain("sync [");
    expect(REPO_KNOWLEDGE_CLI_HELP).not.toContain("record_outcome ");
    expect(REPO_KNOWLEDGE_CLI_HELP).not.toContain("stats ");
    expect(parseRepoKnowledgeCliArguments([], false)).toEqual({
      kind: "serve",
      selection: {},
    });
  });
});

function fixture(
  argv: readonly string[],
  tty: { readonly stdinIsTTY: boolean; readonly stdoutIsTTY: boolean } = {
    stdinIsTTY: false,
    stdoutIsTTY: false,
  },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RepoKnowledgeCliIo = {
    ...tty,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  const ingestPullRequest = vi.fn<
    KnowledgeMutationOperations["ingestPullRequest"]
  >(async () => ({
    changed_threads: 0,
    distilled: 0,
    jobs_created: 1,
    new_threads: 1,
    pending: 1,
    repo_id: "R_repository",
    snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    unchanged: 0,
    warnings: [],
  }));
  const unavailable = async (): Promise<never> => {
    throw new Error("not used by CLI fixture");
  };
  const mutationOperations: KnowledgeMutationOperations = {
    addKnowledge: unavailable,
    ingestPullRequest,
    prepareDistillation: unavailable,
    submitExtract: unavailable,
    submitFinalize: unavailable,
    updateKnowledge: unavailable,
  };
  const resolveMutation = vi.fn<KnowledgeMutationServiceResolver["resolve"]>(
    async () => mutationOperations,
  );
  const mutationServiceResolver: KnowledgeMutationServiceResolver = {
    resolve: resolveMutation,
  };
  const operations: CliRepositoryOperations = {
    admin: {
      addActive: vi.fn(async () => ({ confirmed: false as const })),
      approve: vi.fn(async () => ({ confirmed: false as const })),
      approveRevision: vi.fn(async () => ({ confirmed: false as const })),
      edit: vi.fn(async () => ({ confirmed: false as const })),
      reject: vi.fn(async () => ({ confirmed: false as const })),
    },
    distill: vi.fn(async () => ({ distilled: 0, pending: 1 })),
    listKnowledge: vi.fn(async () => ({
      knowledge: [
        {
          applied_count: 0,
          evidence_count: 0,
          id: KNOWLEDGE_ID,
          revision: 1,
          rule: "canonical fixture rule",
          severity: "must",
          status: "proposed" as const,
          violation_count: 0,
        },
      ],
      repo: REPOSITORY,
      revision_proposals: [],
    })),
    reconcileDerivedMetadata: vi.fn(async () => ({
      repo: REPOSITORY,
      transaction_id: null,
      unchanged: 0,
      written: 0,
    })),
    redistill: vi.fn(async () => ({
      created_jobs: 0,
      reclassified_comments: 0,
      reset_jobs: 0,
      selected_threads: 0,
      unchanged: 0,
    })),
    reindex: vi.fn(async () => ({
      evidence: 0,
      jobs: 0,
      knowledge: 0,
      repo: REPOSITORY,
      submissions: 0,
    })),
  };
  const resolveOperations = vi.fn<CliRepositoryOperationsResolver["resolve"]>(
    async () => operations,
  );
  const operationsResolver: CliRepositoryOperationsResolver = {
    resolve: resolveOperations,
  };
  const serve = vi.fn(async () => undefined);
  return {
    ingestPullRequest,
    operations,
    options: {
      argv,
      io,
      mutationServiceResolver,
      operationsResolver,
      serve,
    },
    resolveMutation,
    resolveOperations,
    serve,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

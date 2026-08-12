import { describe, expect, it, vi } from "vitest";

import {
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  REPO_KNOWLEDGE_CLI_EXIT,
  REPO_KNOWLEDGE_CLI_HELP,
  RepoKnowledgeCliError,
  StatsReadError,
  parseRepoKnowledgeCliArguments,
  runRepoKnowledgeCli,
  type CliRepositoryOperations,
  type CliRepositoryOperationsResolver,
  type GuidedSetupResult,
  type KnowledgeMutationOperations,
  type KnowledgeMutationServiceResolver,
  type RepoKnowledgeDoctorLike,
  type RepoKnowledgeCliIo,
  type RepositoryStats,
  type ReviewInboxItem,
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
      { argv: ["--outdated"], request: { selector: "outdated" } },
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

    const doctor = fixture(["doctor", REPOSITORY]);
    await expect(runRepoKnowledgeCli(doctor.options)).resolves.toBe(0);
    expect(doctor.doctorRun).toHaveBeenCalledWith({ repo: REPOSITORY });
    expect(JSON.parse(doctor.stdout())).toMatchObject({ ok: true });
  });

  it("routes setup with an explicit repository, workspace, and initial window", async () => {
    const current = fixture(
      [
        "setup",
        REPOSITORY,
        "--workspace",
        "/work/repo",
        "--since",
        "2026-08-01T00:00:00.000Z",
      ],
      { stdinIsTTY: true, stdoutIsTTY: true },
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.setup).toHaveBeenCalledWith(
      {
        repo: REPOSITORY,
        since: "2026-08-01T00:00:00.000Z",
        workspacePath: "/work/repo",
      },
      { confirm: expect.any(Function), input: expect.any(Function) },
    );
    expect(current.stdout()).toContain("Setup complete");
    expect(current.stdout()).toContain(`Repository  ${REPOSITORY}`);
    expect(current.stdout()).toContain(
      "2 found · 2 imported · 0 unchanged · 2 job(s) queued",
    );
    expect(current.stdout()).toContain("provider off · host-assisted off");
    expect(current.stdout()).toContain(
      "no model transmission route is enabled",
    );
    expect(current.stdout()).toContain(
      `repo-knowledge setup ${REPOSITORY} --json`,
    );
  });

  it("keeps setup machine-readable with explicit --json and no progress events", async () => {
    const current = fixture(["setup", REPOSITORY, "--json"], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    const activity = vi.fn();
    current.options.io.activity = activity;

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(JSON.parse(current.stdout())).toMatchObject({
      repository: { name: REPOSITORY },
      transmission: { host_assisted: false, provider: false },
    });
    expect(current.stdout().trim().split("\n")).toHaveLength(1);
    expect(current.setup).toHaveBeenCalledWith(
      { repo: REPOSITORY },
      { confirm: expect.any(Function), input: expect.any(Function) },
    );
    expect(activity).not.toHaveBeenCalled();
  });

  it("parses all-history setup and rejects setup without a real TTY", async () => {
    expect(
      parseRepoKnowledgeCliArguments(
        ["setup", "--repo", REPOSITORY, "--all-history"],
        true,
      ),
    ).toEqual({
      kind: "setup",
      request: { allHistory: true, repo: REPOSITORY },
    });

    const current = fixture(["setup", REPOSITORY]);
    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(1);
    expect(current.stderr()).toContain("CLI_TTY_REQUIRED");
    expect(current.setup).not.toHaveBeenCalled();
  });

  it("returns failure when doctor reports a failed check", async () => {
    const current = fixture(["doctor", "--workspace", "/work/repo"]);
    current.doctorRun.mockResolvedValueOnce({
      checks: [
        {
          id: "github.auth",
          message: "not authenticated",
          status: "fail",
        },
      ],
      ok: false,
      summary: { fail: 1, pass: 0, warn: 0 },
    });

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(1);

    expect(current.doctorRun).toHaveBeenCalledWith({
      workspacePath: "/work/repo",
    });
    expect(JSON.parse(current.stdout())).toMatchObject({ ok: false });
    expect(current.stderr()).toBe("");
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

  it.each([
    { stdinIsTTY: false, stdoutIsTTY: true },
    { stdinIsTTY: true, stdoutIsTTY: false },
    { stdinIsTTY: false, stdoutIsTTY: false },
  ])("rejects review without real input and output TTY %#", async (tty) => {
    const current = fixture(["review", REPOSITORY], tty);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(1);

    expect(current.stderr()).toContain("CLI_TTY_REQUIRED");
    expect(current.resolveOperations).not.toHaveBeenCalled();
    expect(current.operations.reviewInbox).not.toHaveBeenCalled();
  });

  it("reviews multiple knowledge and revision items in one session", async () => {
    const current = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    const knowledge = knowledgeInboxItem();
    const revision = revisionInboxItem();
    const skipped = knowledgeInboxItem({
      id: "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      rule: "Leave this item pending",
    });
    vi.mocked(current.operations.reviewInbox)
      .mockResolvedValueOnce(inboxPage([knowledge, revision, skipped]))
      .mockResolvedValueOnce(inboxPage([revision, skipped]))
      .mockResolvedValueOnce(inboxPage([skipped]))
      .mockResolvedValueOnce(inboxPage([skipped]));
    vi.mocked(current.options.io.input!)
      .mockResolvedValueOnce("approve")
      .mockResolvedValueOnce("reject")
      .mockResolvedValueOnce("skip");
    vi.mocked(
      current.operations.admin.approveReviewedKnowledge,
    ).mockResolvedValueOnce(undefined as never);
    vi.mocked(
      current.operations.admin.rejectReviewedRevision,
    ).mockResolvedValueOnce(undefined as never);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(
      current.operations.admin.approveReviewedKnowledge,
    ).toHaveBeenCalledWith({
      etag: knowledge.etag,
      id: knowledge.knowledge_id,
      revision: knowledge.revision,
    });
    expect(
      current.operations.admin.rejectReviewedRevision,
    ).toHaveBeenCalledWith({
      knowledge: {
        etag: revision.etag,
        id: revision.knowledge_id,
        revision: revision.revision,
      },
      proposalEtag: revision.proposal_etag,
      proposalId: revision.proposal_id,
    });
    expect(current.stdout()).toContain("Review inbox · 3 pending");
    expect(current.stdout()).toContain("Candidate rule");
    expect(current.stdout()).toContain("Revision proposal");
    expect(current.stdout()).toContain("Leave this item pending");
    expect(current.stdout()).toContain("discussion_r1");
    expect(current.stdout()).toContain("trusted");
    expect(current.stdout()).toContain("Possible active match");
    expect(current.stdout()).toContain("1 skipped");
  });

  it("neutralizes terminal controls in review content", async () => {
    const current = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    vi.mocked(current.operations.reviewInbox).mockResolvedValueOnce(
      inboxPage([
        knowledgeInboxItem({
          rule: "Unsafe\u001b[31m\nInjected\u202e rule",
        }),
      ]),
    );
    vi.mocked(current.options.io.input!).mockResolvedValueOnce("quit");

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.stdout()).not.toContain("\u001b");
    expect(current.stdout()).not.toContain("\u202e");
    expect(current.stdout()).toContain(
      String.raw`Unsafe\u001b[31m\nInjected\u202e rule`,
    );
  });

  it("edits a candidate, displays its refreshed generation, and approves it", async () => {
    const current = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    const initial = knowledgeInboxItem();
    const edited = knowledgeInboxItem({
      etag: "d".repeat(64),
      revision: 2,
      rule: "Human edited rule",
    });
    vi.mocked(current.operations.reviewInbox)
      .mockResolvedValueOnce(inboxPage([initial]))
      .mockResolvedValueOnce(inboxPage([edited]))
      .mockResolvedValueOnce(inboxPage([]));
    vi.mocked(current.options.io.input!)
      .mockResolvedValueOnce("edit")
      .mockResolvedValueOnce("rule")
      .mockResolvedValueOnce("Human edited rule")
      .mockResolvedValueOnce("approve");
    vi.mocked(
      current.operations.admin.editReviewedKnowledge,
    ).mockResolvedValueOnce(undefined as never);
    vi.mocked(
      current.operations.admin.approveReviewedKnowledge,
    ).mockResolvedValueOnce(undefined as never);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.operations.admin.editReviewedKnowledge).toHaveBeenCalledWith(
      {
        etag: initial.etag,
        id: initial.knowledge_id,
        revision: 1,
      },
      { rule: "Human edited rule" },
    );
    expect(
      current.operations.admin.approveReviewedKnowledge,
    ).toHaveBeenLastCalledWith({
      etag: edited.etag,
      id: edited.knowledge_id,
      revision: 2,
    });
    expect(current.stdout()).toContain("Human edited rule");
    expect(current.stdout()).toContain("1 resolved, 1 edit(s)");
  });

  it("reloads only the conflicting item before accepting a later decision", async () => {
    const current = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    const initial = knowledgeInboxItem();
    const latest = knowledgeInboxItem({
      etag: "e".repeat(64),
      revision: 2,
      rule: "Concurrent human edit",
    });
    const unrelated = knowledgeInboxItem({
      id: "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      rule: "Unrelated newly ordered item",
    });
    vi.mocked(current.operations.reviewInbox)
      .mockResolvedValueOnce(inboxPage([initial]))
      .mockResolvedValueOnce(inboxPage([unrelated, latest]))
      .mockResolvedValueOnce(inboxPage([]));
    vi.mocked(current.options.io.input!)
      .mockResolvedValueOnce("approve")
      .mockResolvedValueOnce("approve");
    vi.mocked(current.operations.admin.approveReviewedKnowledge)
      .mockRejectedValueOnce(
        Object.assign(new Error("knowledge changed"), {
          code: "KNOWLEDGE_CONFLICT",
        }),
      )
      .mockResolvedValueOnce(undefined as never);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.stderr()).toContain("REVIEW_ITEM_CHANGED");
    expect(current.stdout()).toContain("Concurrent human edit");
    expect(current.stdout()).not.toContain("Unrelated newly ordered item");
    expect(
      current.operations.admin.approveReviewedKnowledge,
    ).toHaveBeenLastCalledWith({
      etag: latest.etag,
      id: latest.knowledge_id,
      revision: 2,
    });
  });

  it("handles empty, EOF, interrupt, and mid-session failure safely", async () => {
    const empty = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    await expect(runRepoKnowledgeCli(empty.options)).resolves.toBe(0);
    expect(empty.stdout()).toBe("Review inbox is empty.\n");
    expect(empty.options.io.input).not.toHaveBeenCalled();

    for (const inputCase of [
      {
        code: "CLI_INPUT_ENDED" as const,
        expectedExit: 0,
        message: "input ended",
      },
      {
        code: "CLI_INPUT_INTERRUPTED" as const,
        expectedExit: 130,
        message: "input interrupted",
      },
    ]) {
      const current = fixture(["review", REPOSITORY], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
      });
      vi.mocked(current.operations.reviewInbox).mockResolvedValueOnce(
        inboxPage([knowledgeInboxItem()]),
      );
      vi.mocked(current.options.io.input!).mockRejectedValueOnce(
        new RepoKnowledgeCliError(
          inputCase.code,
          inputCase.message,
          inputCase.expectedExit,
        ),
      );
      await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
        inputCase.expectedExit,
      );
      expect(current.stdout()).toContain("Review session paused");
      expect(
        current.operations.admin.approveReviewedKnowledge,
      ).not.toHaveBeenCalled();
    }

    const failed = fixture(["review", REPOSITORY], {
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    vi.mocked(failed.operations.reviewInbox).mockResolvedValueOnce(
      inboxPage([knowledgeInboxItem()]),
    );
    vi.mocked(failed.options.io.input!).mockResolvedValueOnce("approve");
    vi.mocked(
      failed.operations.admin.approveReviewedKnowledge,
    ).mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(runRepoKnowledgeCli(failed.options)).resolves.toBe(1);
    expect(failed.stderr()).toContain("disk unavailable");
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
    [["record_outcome"], "CLI_COMMAND_UNAVAILABLE"],
    [["stats", REPOSITORY, "--bucket", "hour"], "CLI_ARGUMENT_INVALID"],
    [["stats", REPOSITORY, "--since", "yesterday"], "CLI_ARGUMENT_INVALID"],
    [["stats", REPOSITORY, "--until=2026-08-01"], "CLI_ARGUMENT_INVALID"],
    [["stats", REPOSITORY, "extra"], "CLI_ARGUMENT_INVALID"],
    [
      ["ingest", REPOSITORY, "42", "--since", "yesterday"],
      "CLI_ARGUMENT_INVALID",
    ],
    [["ingest", REPOSITORY, "42", "--since=yesterday"], "CLI_ARGUMENT_INVALID"],
    [["sync", REPOSITORY, "--since", "yesterday"], "CLI_ARGUMENT_INVALID"],
    [["sync", REPOSITORY, "extra"], "CLI_ARGUMENT_INVALID"],
    [
      [
        "setup",
        REPOSITORY,
        "--since",
        "2026-08-01T00:00:00.000Z",
        "--all-history",
      ],
      "CLI_ARGUMENT_INVALID",
    ],
    [["setup", REPOSITORY, "--since", "yesterday"], "CLI_ARGUMENT_INVALID"],
    [["sync", REPOSITORY, "--workspace", "/work/repo"], "CLI_ARGUMENT_INVALID"],
    [["list", REPOSITORY, "--status", "unknown"], "CLI_ARGUMENT_INVALID"],
    [["review", REPOSITORY, "--yes"], "CLI_ARGUMENT_INVALID"],
    [["redistill", REPOSITORY, "--all", "--failed"], "CLI_ARGUMENT_INVALID"],
    [["reconcile", REPOSITORY], "CLI_ARGUMENT_INVALID"],
    [["serve", "--repo", "not-a-repository"], "CLI_ARGUMENT_INVALID"],
  ])("returns a usage error for %j", async (argv, code) => {
    const current = fixture(argv as string[]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(2);

    expect(current.stderr()).toContain(code);
    expect(current.stdout()).toBe("");
  });

  it("documents sync and stats while keeping deferred commands out of help", () => {
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain(
      "setup [repo] [--json] [--since <iso> | --all-history]",
    );
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain("sync [repo] [--since <iso>]");
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain(
      "stats [repo] [--bucket <mode>] [--since <iso>] [--until <iso>]",
    );
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain("review [repo]");
    expect(REPO_KNOWLEDGE_CLI_HELP).not.toContain("\n  record_outcome");
    expect(parseRepoKnowledgeCliArguments([], false)).toEqual({
      kind: "serve",
      selection: {},
    });
  });

  it("routes sync through the same mutation service resolver as MCP", async () => {
    const current = fixture([
      "sync",
      REPOSITORY,
      "--since",
      "2026-08-01T00:00:00.000Z",
    ]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.resolveMutation).toHaveBeenCalledWith({ repo: REPOSITORY });
    expect(current.syncRepo).toHaveBeenCalledWith({
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(JSON.parse(current.stdout())).toEqual({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 1,
      jobs_created: 1,
      next_cursor: null,
      unchanged: 1,
    });
    expect(current.stderr()).toBe("");
  });

  it("omits since from the sync request when the flag is absent", async () => {
    const current = fixture(["sync", "--workspace", "/work/repo"]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.resolveMutation).toHaveBeenCalledWith({
      workspacePath: "/work/repo",
    });
    expect(current.syncRepo).toHaveBeenCalledWith({});
  });

  it.each([
    ["sync", ["sync", REPOSITORY]],
    ["stats", ["stats", REPOSITORY]],
    ["doctor", ["doctor", REPOSITORY]],
  ])(
    "keeps %s machine output free of interactive progress",
    async (_name, argv) => {
      const current = fixture(argv);
      const activity = vi.fn();
      current.options.io.activity = activity;

      await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

      expect(() => JSON.parse(current.stdout())).not.toThrow();
      expect(activity).not.toHaveBeenCalled();
    },
  );

  it("exits non-zero with an operator diagnostic on a partial sync failure", async () => {
    const current = fixture(["sync", REPOSITORY]);
    current.syncRepo.mockResolvedValueOnce({
      discovered: 3,
      failed: 1,
      failures: [{ message: "ingest fixture failure", pr_number: 2 }],
      ingested: 1,
      jobs_created: 1,
      next_cursor: null,
      unchanged: 0,
    });

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );

    expect(JSON.parse(current.stdout())).toMatchObject({
      failed: 1,
      failures: [{ message: "ingest fixture failure", pr_number: 2 }],
    });
    expect(current.stderr()).toContain("SYNC_PARTIAL_FAILURE");
    expect(current.stderr()).toContain("PR #2");
    expect(current.stderr()).toContain("last contiguous");
  });

  it("routes stats through the CLI operations resolver with a parsed window", async () => {
    const current = fixture([
      "stats",
      REPOSITORY,
      "--bucket",
      "day",
      "--since",
      "2026-08-01T00:00:00.000Z",
      "--until",
      "2026-08-02T00:00:00.000Z",
    ]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.resolveOperations).toHaveBeenCalledWith({
      repo: REPOSITORY,
    });
    expect(current.operations.stats).toHaveBeenCalledWith({
      bucket: "day",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
    });
    expect(JSON.parse(current.stdout())).toEqual(zeroStats());
    expect(current.stderr()).toBe("");
  });

  it("omits absent stats options and accepts a workspace selection", async () => {
    const current = fixture(["stats", "--workspace", "/work/repo"]);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.resolveOperations).toHaveBeenCalledWith({
      workspacePath: "/work/repo",
    });
    expect(current.operations.stats).toHaveBeenCalledWith({});
  });

  it("maps stats window rejections to usage exits", async () => {
    const current = fixture([
      "stats",
      REPOSITORY,
      "--bucket",
      "day",
      "--since",
      "2026-08-01T00:00:00.000Z",
    ]);
    vi.mocked(current.operations.stats).mockRejectedValueOnce(
      new StatsReadError(
        "STATS_WINDOW_REQUIRED",
        'bucket "day" requires both since and until',
      ),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.usage,
    );

    expect(current.stdout()).toBe("");
    expect(current.stderr()).toContain("STATS_WINDOW_REQUIRED");
  });

  it("keeps stats canonical read failures on the failure exit code", async () => {
    const current = fixture(["stats", REPOSITORY]);
    vi.mocked(current.operations.stats).mockRejectedValueOnce(
      new StatsReadError(
        "STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
        "stored sync checkpoint belongs to another repository",
      ),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );

    expect(current.stdout()).toBe("");
    expect(current.stderr()).toContain(
      "STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
    );
  });

  it("propagates sync service error codes to stderr with a failure exit", async () => {
    const current = fixture(["sync", REPOSITORY]);
    current.syncRepo.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "SYNC_SINCE_BEYOND_CHECKPOINT: --since is not strictly older",
        ),
        { code: "SYNC_SINCE_BEYOND_CHECKPOINT" },
      ),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );

    expect(current.stdout()).toBe("");
    expect(current.stderr()).toContain("SYNC_SINCE_BEYOND_CHECKPOINT");
  });
});

type KnowledgeInboxItem = Extract<ReviewInboxItem, { kind: "knowledge" }>;
type RevisionInboxItem = Extract<
  ReviewInboxItem,
  { kind: "revision_proposal" }
>;

function knowledgeInboxItem(
  overrides: {
    readonly etag?: string;
    readonly id?: string;
    readonly revision?: number;
    readonly rule?: string;
  } = {},
): KnowledgeInboxItem {
  const id = overrides.id ?? KNOWLEDGE_ID;
  const actor = {
    actor_id: "U_reviewer",
    actor_kind: "user" as const,
    comment_id: "comment-review-1",
    login: "alice",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  return {
    category: "architecture",
    created_at: "2026-08-09T00:00:00.000Z",
    detail: "Review this candidate detail.",
    etag: overrides.etag ?? "a".repeat(64),
    evidence: [
      {
        actors: [actor],
        comment_ids: [actor.comment_id],
        evidence_id: "ev_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        observed_at: "2026-08-09T00:00:00.000Z",
        originator: actor,
        sources: ["human"],
        status: "active",
        url: "https://github.com/owner/repository/pull/1#discussion_r1",
      },
    ],
    item_id: id,
    kind: "knowledge",
    knowledge_id: id,
    knowledge_status: "proposed",
    origin: { type: "distilled" },
    possible_matches: [
      {
        etag: "f".repeat(64),
        id: "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY",
        revision: 1,
        rule: "Possible active match",
        scope: ["src/**"],
        severity: "should",
        status: "active",
      },
    ],
    proposal_etag: null,
    proposal_id: null,
    proposal_patch: null,
    related_ids: [],
    revision: overrides.revision ?? 1,
    rule: overrides.rule ?? "Review this candidate",
    scope: ["src/**"],
    severity: "should",
    sources: ["human"],
    status: "proposed",
    trust_classes: ["trusted"],
    updated_at: "2026-08-09T00:00:00.000Z",
  };
}

function revisionInboxItem(): RevisionInboxItem {
  return {
    category: "architecture",
    created_at: "2026-08-09T00:01:00.000Z",
    detail: "Review this revision detail.",
    etag: "b".repeat(64),
    evidence: [],
    item_id: "proposal-cli-review",
    kind: "revision_proposal",
    knowledge_id: "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    knowledge_status: "active",
    origin: { type: "manual" },
    possible_matches: [],
    proposal_etag: "c".repeat(64),
    proposal_id: "proposal-cli-review",
    proposal_patch: { rule: "Review this revision" },
    related_ids: [],
    revision: 1,
    rule: "Review this revision",
    scope: ["src/**"],
    severity: "should",
    sources: [],
    status: "pending",
    trust_classes: [],
    updated_at: "2026-08-09T00:01:00.000Z",
  };
}

function inboxPage(items: readonly ReviewInboxItem[]) {
  return {
    items: [...items],
    next_cursor: null,
    repo: REPOSITORY,
    total_count: items.length,
  };
}

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
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => "claude-test"),
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
  const syncRepo = vi.fn<KnowledgeMutationOperations["syncRepo"]>(async () => ({
    discovered: 2,
    failed: 0,
    failures: [],
    ingested: 1,
    jobs_created: 1,
    next_cursor: null,
    unchanged: 1,
  }));
  const unavailable = async (): Promise<never> => {
    throw new Error("not used by CLI fixture");
  };
  const mutationOperations: KnowledgeMutationOperations = {
    addKnowledge: unavailable,
    ingestPullRequest,
    prepareDistillation: unavailable,
    recordOutcome: unavailable,
    submitExtract: unavailable,
    submitFinalize: unavailable,
    syncRepo,
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
      approveReviewedKnowledge: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
      approveReviewedRevision: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
      approveRevision: vi.fn(async () => ({ confirmed: false as const })),
      edit: vi.fn(async () => ({ confirmed: false as const })),
      editReviewedKnowledge: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
      editReviewedRevision: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
      reject: vi.fn(async () => ({ confirmed: false as const })),
      rejectReviewedKnowledge: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
      rejectReviewedRevision: vi.fn(async () => {
        throw new Error("not used by CLI fixture");
      }),
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
    reviewInbox: vi.fn(async () => ({
      items: [],
      next_cursor: null,
      repo: REPOSITORY,
      total_count: 0,
    })),
    reindex: vi.fn(async () => ({
      evidence: 0,
      jobs: 0,
      knowledge: 0,
      repo: REPOSITORY,
      submissions: 0,
    })),
    stats: vi.fn(async () => zeroStats()),
  };
  const resolveOperations = vi.fn<CliRepositoryOperationsResolver["resolve"]>(
    async () => operations,
  );
  const operationsResolver: CliRepositoryOperationsResolver = {
    resolve: resolveOperations,
  };
  const serve = vi.fn(async () => undefined);
  const doctorRun = vi.fn<RepoKnowledgeDoctorLike["run"]>(async () => ({
    checks: [],
    ok: true,
    summary: { fail: 0, pass: 0, warn: 0 },
  }));
  const setup = vi.fn(async () => setupResult());
  return {
    doctorRun,
    ingestPullRequest,
    operations,
    options: {
      argv,
      doctor: { run: doctorRun },
      io,
      mutationServiceResolver,
      operationsResolver,
      serve,
      setup,
    },
    resolveMutation,
    resolveOperations,
    serve,
    setup,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
    syncRepo,
  };
}

function setupResult(): GuidedSetupResult {
  return {
    config_path: "/storage/config.json",
    doctor: { fail: 0, pass: 6, warn: 0 },
    initial_sync: {
      scope: { mode: "since", since: "2026-05-11T00:00:00.000Z" },
      summary: {
        discovered: 2,
        failed: 0,
        failures: [],
        ingested: 2,
        jobs_created: 2,
        next_cursor: null,
        unchanged: 0,
      },
    },
    repository: {
      id: "R_repository",
      name: REPOSITORY,
      storage_path: "/storage/repos/R_repository",
      workspace_path: "/work/repo",
    },
    resumed: false,
    state_path: "/storage/repos/R_repository/setup-state.json",
    storage_root: "/storage",
    transmission: { host_assisted: false, provider: false },
    trust: { candidates: 0, selected: [] },
  };
}

function zeroStats(): RepositoryStats {
  return {
    buckets: null,
    canonical_digest: "a".repeat(64),
    evidence: {
      by_source: { bugbot: 0, devin: 0, greptile: 0, human: 0, other: 0 },
      by_status: { active: 0, superseded: 0, withdrawn: 0 },
      eligible_for_count: 0,
      total: 0,
    },
    jobs: {
      by_state: {
        awaiting_finalize: 0,
        done: 0,
        failed: 0,
        pending: 0,
        processing: 0,
        skipped: 0,
      },
      total: 0,
    },
    knowledge: {
      by_category: {
        architecture: 0,
        docs: 0,
        "error-handling": 0,
        naming: 0,
        other: 0,
        perf: 0,
        security: 0,
        style: 0,
        test: 0,
      },
      by_severity: { consider: 0, must: 0, should: 0 },
      by_status: {
        active: 0,
        deprecated: 0,
        proposed: 0,
        rejected: 0,
        stale: 0,
      },
      total: 0,
    },
    operations: {
      failed_jobs: 0,
      last_sync_checkpoint_at: null,
      pending_jobs: 0,
    },
    outcomes: {
      by_type: {
        applied: 0,
        false_positive: 0,
        not_applicable: 0,
        violated: 0,
      },
      total: 0,
    },
    repo: REPOSITORY,
    stats_schema_version: 1,
    sync: { last_checkpoint: null },
    window: { bucket: "total", since: null, timezone: "UTC", until: null },
  };
}

import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPO_KNOWLEDGE_CLI_HELP, runRepoKnowledgeCli } from "../src/cli.js";
import { parseRepoKnowledgeCliArguments } from "../src/cli-args.js";
import type {
  RepoKnowledgeCliIo,
  RunRepoKnowledgeCliOptions,
} from "../src/cli-types.js";
import { ConversationAdminService } from "../src/conversation-admin-service.js";
import { CONVERSATION_CONFIG_FILE_NAME } from "../src/conversation-config.js";
import { ConversationStore } from "../src/conversation-store.js";
import { inspectConversationStore } from "../src/doctor/checks-conversations.js";
import { DoctorReportBuilder } from "../src/doctor/report-builder.js";

const parse = (argv: readonly string[]) =>
  parseRepoKnowledgeCliArguments(argv, false);

describe("conversations argument parsing", () => {
  it.each([
    [["conversations", "status"], { kind: "conversations-status" }],
    [["conversations", "status", "--json"], { kind: "conversations-status" }],
    [
      ["conversations", "purge", "--session", "abc"],
      {
        criteria: { session_id: "abc" },
        kind: "conversations-purge",
        yes: false,
      },
    ],
    [
      ["conversations", "purge", "--before=2026-01-01T00:00:00Z", "--yes"],
      {
        criteria: { before: "2026-01-01T00:00:00Z" },
        kind: "conversations-purge",
        yes: true,
      },
    ],
    [
      ["conversations", "purge", "--before", "9999-12-31T23:59:59.999Z"],
      {
        criteria: { before: "9999-12-31T23:59:59.999Z" },
        kind: "conversations-purge",
        yes: false,
      },
    ],
    [
      ["conversations", "purge", "--source", "codex"],
      {
        criteria: { source: "codex" },
        kind: "conversations-purge",
        yes: false,
      },
    ],
    [
      ["conversations", "purge", "--project", "octo/app"],
      {
        criteria: { name_with_owner: "octo/app" },
        kind: "conversations-purge",
        yes: false,
      },
    ],
    [
      ["conversations", "purge", "--project", "/Users/alice//repo/"],
      {
        criteria: { project_path_prefix: "/Users/alice/repo" },
        kind: "conversations-purge",
        yes: false,
      },
    ],
    [
      ["conversations", "purge", "--resume", "--yes"],
      { criteria: null, kind: "conversations-purge", yes: true },
    ],
    [
      ["conversations", "reset-key"],
      { kind: "conversations-reset-key", restart: false, yes: false },
    ],
    [
      ["conversations", "reset-key", "--yes", "--restart"],
      { kind: "conversations-reset-key", restart: true, yes: true },
    ],
  ])("parses %j", (argv, expected) => {
    expect(parse(argv)).toEqual(expected);
  });

  it.each([
    [["conversations"], /requires one of status, purge, or reset-key/u],
    [["conversations", "bogus"], /requires one of status/u],
    [["conversations", "status", "extra"], /expects 0 positional/u],
    [["conversations", "purge"], /exactly one of --session/u],
    [
      ["conversations", "purge", "--resume", "--source", "codex"],
      /or --resume/u,
    ],
    [
      ["conversations", "purge", "--source", "codex", "--session", "x"],
      /exactly one of --session/u,
    ],
    [["conversations", "purge", "--source", "other"], /source is invalid/u],
    [["conversations", "purge", "--before", "yesterday"], /before is invalid/u],
    [
      ["conversations", "purge", "--before", "9999-12-31T23:59:59-01:00"],
      /years 1970-9999/u,
    ],
    [
      ["conversations", "purge", "--before", "1960-01-01T00:00:00Z"],
      /years 1970-9999/u,
    ],
    [
      ["conversations", "purge", "--before", "1969-12-31T23:59:59.999Z"],
      /years 1970-9999/u,
    ],
    [
      ["conversations", "purge", "--project", "repo"],
      /owner\/name repository or an absolute path/u,
    ],
    [
      ["conversations", "purge", "--project", "/a\0b"],
      /project path is invalid/u,
    ],
    [
      ["conversations", "purge", "--session", "x", "pos"],
      /expects 0 positional/u,
    ],
    [["conversations", "reset-key", "--restart=1"], /does not accept a value/u],
    [["conversations", "reset-key", "x"], /expects 0 positional/u],
  ])("rejects %j", (argv, message) => {
    expect(() => parse(argv)).toThrow(message);
  });

  it("documents the commands without suggesting purge for re-masking", () => {
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain("conversations status");
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain("conversations purge");
    expect(REPO_KNOWLEDGE_CLI_HELP).toContain(
      "conversations reset-key [--yes] [--restart]",
    );
    expect(REPO_KNOWLEDGE_CLI_HELP).not.toMatch(/re-?mask/iu);
  });
});

function harness(
  argv: readonly string[],
  options: {
    readonly answer?: boolean;
    readonly conversations?: RunRepoKnowledgeCliOptions["conversations"];
    readonly tty?: boolean;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const confirm = vi.fn(async () => options.answer ?? false);
  const io: RepoKnowledgeCliIo = {
    confirm,
    stdinIsTTY: options.tty ?? false,
    stdoutIsTTY: options.tty ?? false,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    confirm,
    run: () =>
      runRepoKnowledgeCli({
        argv,
        ...(options.conversations === undefined
          ? {}
          : { conversations: options.conversations }),
        doctor: { run: unused },
        io,
        mutationServiceResolver: { resolve: unused },
        operationsResolver: { resolve: unused },
        serve: unused,
        setup: unused,
      }),
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

function fakeConversations() {
  return {
    purge: vi.fn(async () => ({
      expired: 0,
      filter_added: true,
      filters: 1,
      removed_episodes: 0,
      removed_tombstones: 0,
      removed_utterances: 2,
      resumed_from: null,
    })),
    resetKey: vi.fn(async () => ({
      discarded: [],
      key_id: "0123456789abcdef",
      restarted: false,
      resumed_after_stage: null,
    })),
    status: vi.fn(
      async () => ({ config: { present: false }, ok: true }) as never,
    ),
  };
}

describe("conversations command dispatch", () => {
  it("prints status as JSON", async () => {
    const conversations = fakeConversations();
    const current = harness(["conversations", "status"], { conversations });

    expect(await current.run()).toBe(0);
    expect(JSON.parse(current.stdout())).toEqual({
      config: { present: false },
      ok: true,
    });
  });

  it("runs purge and reset-key with --yes without prompting", async () => {
    const conversations = fakeConversations();
    const purge = harness(
      ["conversations", "purge", "--source", "codex", "--yes"],
      { conversations },
    );
    const reset = harness(
      ["conversations", "reset-key", "--yes", "--restart"],
      {
        conversations,
      },
    );

    expect(await purge.run()).toBe(0);
    expect(await reset.run()).toBe(0);
    expect(conversations.purge).toHaveBeenCalledWith({ source: "codex" });
    expect(conversations.resetKey).toHaveBeenCalledWith({ restart: true });
    expect(JSON.parse(purge.stdout())).toMatchObject({ removed_utterances: 2 });
    expect(purge.confirm).not.toHaveBeenCalled();
  });

  it("names the condition, or the resume, in the purge prompt", async () => {
    const conversations = fakeConversations();
    const named = harness(
      ["conversations", "purge", "--project", "/work/acme"],
      { conversations, tty: true },
    );
    const resume = harness(["conversations", "purge", "--resume"], {
      conversations,
      tty: true,
    });

    await named.run();
    await resume.run();

    expect(named.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("project_path_prefix=/work/acme"),
      }),
    );
    expect(resume.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("No condition is added"),
      }),
    );
  });

  it("asks in a terminal and does nothing when declined", async () => {
    const conversations = fakeConversations();
    const declined = harness(["conversations", "purge", "--session", "s"], {
      conversations,
      tty: true,
    });
    const declinedReset = harness(["conversations", "reset-key"], {
      conversations,
      tty: true,
    });

    expect(await declined.run()).toBe(0);
    expect(await declinedReset.run()).toBe(0);
    expect(JSON.parse(declined.stdout())).toEqual({ confirmed: false });
    expect(JSON.parse(declinedReset.stdout())).toEqual({ confirmed: false });
    expect(conversations.purge).not.toHaveBeenCalled();
    expect(conversations.resetKey).not.toHaveBeenCalled();
    expect(declined.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultValue: false,
        id: "conversations.purge",
      }),
    );

    const accepted = harness(["conversations", "reset-key"], {
      answer: true,
      conversations,
      tty: true,
    });
    expect(await accepted.run()).toBe(0);
    expect(conversations.resetKey).toHaveBeenCalledWith({ restart: false });
  });

  it("refuses destructive commands without a terminal or --yes", async () => {
    const conversations = fakeConversations();
    const current = harness(["conversations", "reset-key"], { conversations });

    expect(await current.run()).toBe(2);
    expect(current.stderr()).toMatch(/^CLI_TTY_REQUIRED: .*--yes/u);
    expect(conversations.resetKey).not.toHaveBeenCalled();
  });

  it("reports an unavailable runtime and store errors by code", async () => {
    const missing = harness(["conversations", "status"]);
    expect(await missing.run()).toBe(1);
    expect(missing.stderr()).toMatch(/^CLI_COMMAND_UNAVAILABLE/u);

    const conversations = fakeConversations();
    conversations.purge.mockRejectedValueOnce(
      Object.assign(new Error("CONVERSATION_RESET_PENDING: finish it"), {
        code: "CONVERSATION_RESET_PENDING",
      }),
    );
    const pending = harness(
      ["conversations", "purge", "--source", "codex", "--yes"],
      {
        conversations,
      },
    );
    expect(await pending.run()).toBe(1);
    expect(pending.stderr()).toMatch(/^CONVERSATION_RESET_PENDING/u);
  });
});

describe("conversation admin service and doctor", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rk-conv-cli-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("summarizes settings without printing dictionary terms", async () => {
    await writeFile(
      join(root, CONVERSATION_CONFIG_FILE_NAME),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        sources: { codex: { enabled: true } },
        redactTerms: ["Tanaka", "Acme"],
        excludeProjects: ["octo/private"],
        retentionDays: 90,
      }),
      { mode: 0o600 },
    );
    const service = new ConversationAdminService(root);

    const status = await service.status();

    expect(status.config).toEqual({
      assistant_context: { enabled: true, maxCharacters: 500 },
      enabled: true,
      exclude_projects: 1,
      present: true,
      private: true,
      redact_terms: 2,
      retention_days: 90,
      sources: { claude_code: false, codex: true },
    });
    expect(JSON.stringify(status)).not.toMatch(/tanaka|acme|octo\/private/iu);
    expect(status).toMatchObject({ data_directory: { present: false } });
  });

  it("reports loose config permissions without changing them", async () => {
    const path = join(root, CONVERSATION_CONFIG_FILE_NAME);
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }), {
      mode: 0o644,
    });
    await chmod(path, 0o644);

    const status = await new ConversationAdminService(root).status();

    expect(status.config).toMatchObject({ private: false });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it("exits 1 from status when the config is invalid", async () => {
    await writeFile(
      join(root, CONVERSATION_CONFIG_FILE_NAME),
      JSON.stringify({ schemaVersion: 2 }),
      { mode: 0o600 },
    );
    const current = harness(["conversations", "status"], {
      conversations: new ConversationAdminService(root),
    });

    expect(await current.run()).toBe(1);
    expect(JSON.parse(current.stdout()).config).toEqual({
      error: "CONVERSATION_CONFIG_INVALID",
      present: true,
    });
  });

  it("prints a store error code once on stderr", async () => {
    const current = harness(
      ["conversations", "purge", "--project", "/x", "--yes"],
      { conversations: new ConversationAdminService(root) },
    );
    await new ConversationStore(root).saveUtterances(
      [
        {
          assistant_context: null,
          detector_version: "d",
          flags: [],
          human_confidence: "high",
          human_reasons: [],
          project: {
            kind: "unresolved",
            name_with_owner: null,
            raw_path: null,
            repo_id: null,
          },
          session_id: "s",
          session_kind: "real",
          signals: [],
          source: "codex",
          source_message_id: null,
          source_origin: "history",
          text: "t",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      (
        await import("../src/conversation-config.js")
      ).disabledConversationConfig(),
    );
    await rm(join(root, "conversations", "local.key"));

    expect(await current.run()).toBe(1);
    expect(current.stderr()).toMatch(/^CONVERSATION_KEY_MISSING: stored/u);
  });

  it("still reports the data area when the config is invalid", async () => {
    await writeFile(
      join(root, CONVERSATION_CONFIG_FILE_NAME),
      JSON.stringify({ schemaVersion: 1, typo: true }),
      { mode: 0o600 },
    );
    const service = new ConversationAdminService(root);

    const status = await service.status();

    expect(status.config).toEqual({
      error: "CONVERSATION_CONFIG_INVALID",
      present: true,
    });
    expect(status).toMatchObject({ data_directory: { present: false } });
  });

  it("reports a filesystem error as data_error", async () => {
    const spy = vi
      .spyOn(ConversationStore.prototype, "status")
      .mockRejectedValueOnce(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        }),
      );
    try {
      expect(await new ConversationAdminService(root).status()).toMatchObject({
        data_error: { code: "EACCES", file: null },
      });
      spy.mockRejectedValueOnce(new Error("no code"));
      await expect(new ConversationAdminService(root).status()).rejects.toThrow(
        "no code",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("purges and resets keys through the store", async () => {
    const service = new ConversationAdminService(root);

    await expect(service.purge({ source: "codex" })).resolves.toMatchObject({
      filter_added: true,
    });
    const reset = await service.resetKey({ restart: false });

    expect(await service.status()).toMatchObject({
      key: { key_id: reset.key_id, state: "present" },
      purge: { filters: 1 },
    });
  });

  it("reports an unreadable data area next to the config summary", async () => {
    await new ConversationStore(root).purge({ source: "codex" });
    await rm(join(root, "conversations", "purge-filters.json"));
    await symlink(
      "/dev/null",
      join(root, "conversations", "purge-filters.json"),
    );
    const service = new ConversationAdminService(root);

    expect(await service.status()).toEqual({
      config: expect.objectContaining({ present: false }),
      data_error: {
        code: "CONVERSATION_DATA_PATH_UNSAFE",
        file: null,
        message: expect.stringContaining("purge-filters.json"),
      },
    });
    const current = harness(["conversations", "status"], {
      conversations: service,
    });
    expect(await current.run()).toBe(1);
    expect(JSON.parse(current.stdout())).toHaveProperty("data_error");
  });

  it("passes, warns with the restart remedy, or fails in doctor", async () => {
    const check = async () => {
      const report = new DoctorReportBuilder();
      await inspectConversationStore(report, root);
      return report.build().checks[0]!;
    };

    expect(await check()).toMatchObject({
      id: "conversations.store",
      message: "Conversation data area has not been created yet.",
      status: "pass",
    });
    expect(await readdir(root)).toEqual([]);

    const store = new ConversationStore(root, {
      checkpoint: (name) => {
        if (name === "reset-key:renamed") throw new Error("crash");
      },
    });
    await expect(store.resetKey()).rejects.toThrow("crash");
    expect(await check()).toMatchObject({
      remedy: "repo-knowledge conversations reset-key",
      status: "warn",
    });
    await writeFile(
      join(root, "conversations", "purge-progress.json"),
      JSON.stringify({
        schema_version: 1,
        stage: "ids_recorded",
        utterance_ids: [],
      }),
    );
    expect(await check()).toMatchObject({
      details: {
        warnings: [
          "CONVERSATION_RESET_PENDING",
          "CONVERSATION_PURGE_INCOMPLETE",
        ],
      },
      remedy:
        "repo-knowledge conversations reset-key; then repo-knowledge conversations purge --resume",
    });
    await rm(join(root, "conversations", "purge-progress.json"));
    await rm(join(root, "conversations", "local.key"));
    expect(await check()).toMatchObject({
      details: { warnings: ["CONVERSATION_RESET_KEY_UNRECOVERABLE"] },
      remedy: "repo-knowledge conversations reset-key --restart",
      status: "warn",
    });

    await new ConversationStore(root).resetKey({ restart: true });
    expect(await check()).toMatchObject({
      message: "Conversation data area is consistent.",
      status: "pass",
    });

    await writeFile(join(root, "conversations", "reset-pending.json"), "{");
    expect(await check()).toMatchObject({
      details: { warnings: ["CONVERSATION_RESET_KEY_UNRECOVERABLE"] },
      remedy: "repo-knowledge conversations reset-key --restart",
      status: "warn",
    });
    await rm(join(root, "conversations", "reset-pending.json"));
    await writeFile(join(root, "conversations", "utterances.jsonl"), "x\n");
    expect(await check()).toMatchObject({
      remedy: expect.stringContaining("Repair or remove the damaged record"),
      status: "warn",
    });
    await rm(join(root, "conversations", "utterances.jsonl"));
    await writeFile(join(root, "conversations", "purge-progress.json"), "{");
    expect(await check()).toMatchObject({
      remedy: expect.stringContaining("not --resume"),
      status: "warn",
    });
    await rm(join(root, "conversations", "purge-progress.json"));
    await writeFile(join(root, "conversations", "purge-filters.json"), "{");
    expect(await check()).toMatchObject({
      remedy: expect.stringContaining("do not delete the file"),
      status: "warn",
    });
    await rm(join(root, "conversations"), { recursive: true });
    await writeFile(join(root, "conversations"), "");
    expect(await check()).toMatchObject({
      remedy: expect.stringContaining("real private directory"),
      status: "fail",
    });
    await rm(join(root, "conversations"));
    await new ConversationStore(root).resetKey();
    await chmod(join(root, "conversations", "local.key"), 0o644);
    expect(await check()).toMatchObject({ status: "warn" });
  });
});

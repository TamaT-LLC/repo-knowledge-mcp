import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { execa } from "execa";
import { GlobalStore } from "../src/global-store.js";
import { createDomainId } from "../src/ids.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  type JsonRpcFrame as JsonRpcReply,
  runJsonRpcOverStdio,
} from "./helpers/stdio-jsonrpc-client.js";
import {
  CanonicalTransactionStore,
  KnowledgeReadService,
  GetKnowledgeOutputSchema,
  GetRulesOutputSchema,
  RecordOutcomeOutputSchema,
  RepositoryRegistry,
  SearchKnowledgeOutputSchema,
  StatsOutputSchema,
  deriveOutcomeEventId,
  serializeKnowledgeDocument,
  type KnowledgeStatus,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const REPO_ID = "R_outcome_e2e_repository";
const OTHER_REPO_ID = "R_other_repository";
const ACTIVE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FOREIGN_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const UNKNOWN_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAY";
const EVENT_KEY = "codex:issue-117:stdio-result";
const EVENT_ID = deriveOutcomeEventId({
  eventKey: EVENT_KEY,
  knowledgeId: ACTIVE_ID,
  repoId: REPO_ID,
});
const CREATED_AT = "2026-08-06T00:00:00.000Z";
const OUTCOME_AT = "2026-08-07T00:00:00.000Z";
const E2E_TIMEOUT_MS = 120_000;

interface OutcomeEnvironment {
  readonly repositoryRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly storageRoot: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("record_outcome MCP E2E over a real stdio server and canonical store", () => {
  it("records get_rules ids, replays retries, and projects updated counters", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createOutcomeEnvironment();
    const violatedRequest = {
      at: OUTCOME_AT,
      context: { file_paths: ["src/feature/a.ts"], pr_number: 7 },
      event_key: EVENT_KEY,
      knowledge_id: ACTIVE_ID,
      note: "agent violated the rule",
      outcome: "violated",
      repo: REPOSITORY,
      result_observed: true,
    };
    // 1. get_rules hands out the id the agent will report an outcome for.
    const before = await runServe(environment, [
      request(2, "tools/list", {}),
      callTool(3, "get_rules", {
        file_paths: ["src/feature/a.ts"],
        repo: REPOSITORY,
      }),
      callTool(4, "stats", { repo: REPOSITORY }),
    ]);
    const toolNames = listedToolNames(replyById(before, 2));
    expect(toolNames).toContain("record_outcome");
    expect(toolNames).toContain("get_rules");
    const rules = GetRulesOutputSchema.parse(structuredContent(before, 3));
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0]).toMatchObject({
      id: ACTIVE_ID,
      violation_count: 0,
    });
    // Retrieval is read-only: receiving a rule is never an applied outcome.
    expect(
      StatsOutputSchema.parse(structuredContent(before, 4)).outcomes,
    ).toEqual({
      by_type: {
        applied: 0,
        false_positive: 0,
        not_applicable: 0,
        violated: 0,
      },
      total: 0,
    });

    // 2. The first record appends one canonical event and bumps the counter.
    const first = await runServe(environment, [
      callTool(5, "record_outcome", violatedRequest),
    ]);
    const recorded = RecordOutcomeOutputSchema.parse(
      structuredContent(first, 5),
    );
    expect(recorded.ok).toBe(true);
    expect(recorded.result).toEqual({
      applied_count: 0,
      event_id: EVENT_ID,
      knowledge_id: ACTIVE_ID,
      outcome: "violated",
      replayed: false,
      violation_count: 1,
    });

    // 3. A fresh MCP session retries and misuses the derived event_id.
    const retried = await runServe(environment, [
      callTool(6, "record_outcome", violatedRequest),
      callTool(7, "record_outcome", {
        ...violatedRequest,
        outcome: "applied",
      }),
      callTool(8, "record_outcome", {
        ...violatedRequest,
        event_key: `${EVENT_KEY}:unknown`,
        knowledge_id: UNKNOWN_ID,
      }),
      callTool(9, "record_outcome", {
        ...violatedRequest,
        event_key: `${EVENT_KEY}:foreign`,
        knowledge_id: FOREIGN_ID,
      }),
    ]);
    // The identical payload replays the stable original result.
    const replayed = RecordOutcomeOutputSchema.parse(
      structuredContent(retried, 6),
    );
    expect(replayed.ok).toBe(true);
    expect(replayed.result).toEqual({
      ...recorded.result,
      replayed: true,
    });
    expect(replayed.summary.counts).toMatchObject({ recorded_events: 0 });
    // Reusing the derived event_id for a different payload fails closed, and
    // unknown or cross-repository ids never append events.
    expect(errorCode(retried, 7)).toBe("IDEMPOTENCY_CONFLICT");
    expect(errorCode(retried, 8)).toBe("KNOWLEDGE_NOT_FOUND");
    expect(errorCode(retried, 9)).toBe("KNOWLEDGE_REPOSITORY_MISMATCH");

    // 4. Both read tools serve the updated canonical projection.
    const after = await runServe(environment, [
      callTool(10, "search_knowledge", {
        query: "outcome",
        repo: REPOSITORY,
      }),
      callTool(11, "get_knowledge", { id: ACTIVE_ID, repo: REPOSITORY }),
      callTool(12, "stats", { repo: REPOSITORY }),
    ]);
    const search = SearchKnowledgeOutputSchema.parse(
      structuredContent(after, 10),
    );
    expect(search.results).toHaveLength(1);
    expect(search.results[0]).toMatchObject({
      applied_count: 0,
      id: ACTIVE_ID,
      violation_count: 1,
    });
    const knowledge = GetKnowledgeOutputSchema.parse(
      structuredContent(after, 11),
    );
    expect(knowledge.knowledge).toMatchObject({
      applied_count: 0,
      id: ACTIVE_ID,
      violation_count: 1,
    });
    expect(
      StatsOutputSchema.parse(structuredContent(after, 12)).outcomes,
    ).toEqual({
      by_type: {
        applied: 0,
        false_positive: 0,
        not_applicable: 0,
        violated: 1,
      },
      total: 1,
    });
  });
});

describe("personal rules over CLI and MCP", () => {
  it("adds via TTY, reindexes, records outcomes and enforces caller permissions", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createOutcomeEnvironment();
    const global = new GlobalStore(environment.storageRoot);
    const tool = async (name: string, args: Record<string, unknown>) =>
      structuredContent(
        await runServe(
          environment,
          [callTool(2, name, args)],
          ["--repo", REPOSITORY, "--allow-always-return-changes"],
        ),
        2,
      );
    const setAlwaysReturn = (knowledge_id: string, enabled: boolean) =>
      tool("set_global_always_return", { knowledge_id, enabled });
    const before = await runServe(environment, [
      request(2, "tools/list", {}),
      callTool(3, "get_rules", { repo: REPOSITORY, file_paths: ["src/x.ts"] }),
    ]);
    expect(listedToolNames(replyById(before, 2))).not.toContain(
      "set_global_always_return",
    );
    expect(structuredContent(before, 3)).not.toHaveProperty(
      "global_matched_count",
    );
    expect(await global.exists()).toBe(false);
    await global.initialize();
    await writeKnowledge(
      global.reference.absolutePath,
      UNKNOWN_ID,
      "proposed",
      "rk:global",
    );
    const empty = await runServe(environment, [
      callTool(2, "get_rules", { repo: REPOSITORY, file_paths: ["src/x.ts"] }),
    ]);
    expect(structuredContent(empty, 2)).toEqual(structuredContent(before, 3));
    const listed = await runServe(
      environment,
      [request(2, "tools/list", {})],
      ["--allow-always-return-changes"],
    );
    expect(listedToolNames(replyById(listed, 2))).toContain(
      "set_global_always_return",
    );

    // Run the actual admin CLI in a controlling terminal and wait for confirmation.
    const output = await execa(
      "python3",
      [
        "-c",
        `import errno, os, pty, signal, sys

def on_timeout(_signum, _frame):
    raise TimeoutError("Timed out waiting for admin confirmation or CLI exit.")

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

data = bytearray()
sent = False
reaped = False
signal.signal(signal.SIGALRM, on_timeout)
signal.alarm(30)
try:
    while True:
        try:
            chunk = os.read(master, 8192)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        data.extend(chunk)
        if not sent and b"admin> " in data:
            os.write(master, b"add --active\\n")
            sent = True
    _, status = os.waitpid(pid, 0)
    reaped = True
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    signal.alarm(0)
    os.close(master)
    if not reaped:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    sys.stdout.buffer.write(data)`,
        process.execPath,
        "dist/bin.js",
        "add",
        "--global",
        "--rule",
        "Validate schema",
        "--detail",
        "Validate fields",
        "--severity",
        "must",
        "--category",
        "test",
        "--scope",
        "src/**",
      ],
      { env: environment.env },
    );
    expect(output.stdout).toContain('"confirmed":true');
    const original = (await global.store.readSnapshot()).domain.knowledge.find(
      (rule) => rule.status === "active",
    )!;
    const id = original.id;
    expect((await runCli(environment, "reindex", "--global")).exitCode).toBe(0);
    expect(
      (await global.store.readSnapshot()).domain.knowledge.find(
        (rule) => rule.id === id,
      ),
    ).toEqual(original);
    expect((await stat(global.reference.absolutePath)).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(join(global.reference.absolutePath, "knowledge", `${id}.md`)))
        .mode & 0o777,
    ).toBe(0o600);
    expect(
      (await runCli(environment, "always-return", "add", id)).exitCode,
    ).toBe(0);
    expect(await setAlwaysReturn(id, false)).toMatchObject({
      state: "rejected",
      reason: "set_by_cli",
    });
    expect(await setAlwaysReturn(ACTIVE_ID, true)).toMatchObject({
      reason: "not_global",
    });
    expect(
      (await runCli(environment, "always-return", "remove", id)).exitCode,
    ).toBe(0);
    expect(await setAlwaysReturn(id, true)).toMatchObject({
      state: "changed",
      set_by: "mcp",
    });
    expect(await setAlwaysReturn(id, true)).toMatchObject({
      state: "unchanged",
    });
    // MCP may clear what MCP set, then set it again for the CLI checks below.
    expect(await setAlwaysReturn(id, false)).toMatchObject({
      state: "changed",
      always_return: false,
    });
    expect(await setAlwaysReturn(id, true)).toMatchObject({
      state: "changed",
      set_by: "mcp",
    });
    expect(
      JSON.parse((await runCli(environment, "always-return", "list")).stdout),
    ).toMatchObject([
      {
        actor: "mcp",
        knowledge_id: id,
        caller_repo_id: REPO_ID,
        recorded_at: expect.any(String),
      },
    ]);
    expect(
      GetRulesOutputSchema.parse(await tool("get_rules", {})).rules,
    ).toContainEqual(
      expect.objectContaining({
        id,
        always_return_set_by: "mcp",
        match_reasons: [{ type: "global_store", via: "always" }],
      }),
    );
    const otherRepo = "owner/another";
    const otherRules = GetRulesOutputSchema.parse(
      await tool("get_rules", { repo: otherRepo }),
    );
    expect(otherRules).toMatchObject({
      repo: otherRepo,
      matched_count: 0,
      rules: [{ id }],
    });
    const globalCount = (await global.store.readSnapshot()).domain.knowledge
      .length;
    const proposal = await tool("add_knowledge", {
      repo: otherRepo,
      rule: "Separate rule",
      detail: "Repository-only",
      category: "test",
      severity: "should",
      scope: [],
    });
    expect(proposal).toMatchObject({
      ok: true,
      result: { repo: otherRepo, status: "proposed" },
    });
    expect(
      await tool("update_knowledge", {
        repo: otherRepo,
        id,
        expected_etag: original.etag,
        expected_revision: original.revision,
        patch: { rule: "Replacement" },
      }),
    ).toMatchObject({ ok: false });
    expect((await global.store.readSnapshot()).domain.knowledge).toHaveLength(
      globalCount,
    );
    const outcome = {
      knowledge_id: id,
      event_key: "work-1",
      result_observed: true,
      at: OUTCOME_AT,
      outcome: "applied",
      context: { task_id: "task" },
      note: "Validated the schema",
    };
    expect(await tool("record_outcome", outcome)).toMatchObject({
      ok: true,
      result: { replayed: false, applied_count: 1 },
    });
    expect(await tool("record_outcome", outcome)).toMatchObject({
      ok: true,
      result: { replayed: true, applied_count: 1 },
    });
    const events = await readFile(
      join(global.reference.absolutePath, "events", "outcomes.jsonl"),
      "utf8",
    );
    expect(JSON.parse(events.trim()).payload).toMatchObject({
      repo_id: "rk:global",
      context: { caller_repo_id: REPO_ID },
    });
    expect(
      GetKnowledgeOutputSchema.parse(await tool("get_knowledge", { id }))
        .knowledge,
    ).toMatchObject({ applied_count: 1, id });
    expect(
      await tool("record_outcome", { ...outcome, repo: otherRepo }),
    ).toMatchObject({
      ok: true,
      result: { replayed: false, applied_count: 2 },
    });
    // The CLI clears an MCP-set rule: exit 0 alone would also hide "unchanged".
    const removed = await runCli(environment, "always-return", "remove", id);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      state: "changed",
      always_return: false,
      reserved_count: 0,
    });
    expect(
      JSON.parse((await runCli(environment, "always-return", "list")).stdout),
    ).toEqual([]);
    expect(
      GetRulesOutputSchema.parse(await tool("get_rules", {})).rules.map(
        (rule) => rule.id,
      ),
    ).not.toContain(id);
    expect(
      (
        await stat(
          join(global.reference.absolutePath, "events", "always_return.jsonl"),
        )
      ).mode & 0o777,
    ).toBe(0o600);
  });

  it("keeps local counts and readiness, reserves both quotas, and serves only conversation aggregates", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const env = await createOutcomeEnvironment();
    const global = new GlobalStore(env.storageRoot);
    await global.initialize();
    const ids = Array.from({ length: 11 }, () => createDomainId("knowledge"));
    const [conversationId, inactive] = ids.slice(-2) as [string, string];
    for (const id of ids)
      await writeKnowledge(
        global.reference.absolutePath,
        id,
        id === inactive ? "proposed" : "active",
        "rk:global",
        id === conversationId
          ? {
              scope: ["docs/**"],
              rule: "Prefer pnpm",
              origin: { type: "distilled", source: "conversation" },
              unexpected: "utterance-private",
            }
          : { rule: "Validate schema" },
      );
    const timestamp = CREATED_AT;
    const evidence = {
      knowledge_id: conversationId,
      evidence_id: createDomainId("evidence"),
      utterance_id: "utt-private",
      excerpt: "confidential-snippet",
      status: "active",
      polarity: "supports",
      session_key: "s1",
      project_key: "p1",
      observed_at: timestamp,
    };
    const transactionId = createDomainId("transaction");
    await global.store.commit({
      createdAt: timestamp,
      transactionId,
      fileWrites: [],
      appendRecords: [
        evidence,
        {
          ...evidence,
          evidence_id: createDomainId("evidence"),
          session_key: "invalid-session",
          project_key: "invalid-project",
          observed_at: "2026-01-01",
        },
      ].map((payload) => ({
        targetPath: "events/conversation_evidence.jsonl",
        record: {
          schema_version: 1,
          record_type: "ConversationEvidenceCreated",
          recorded_at: timestamp,
          record_id: createDomainId("event"),
          transaction_id: transactionId,
          payload,
        },
      })),
    });
    const simultaneous = await Promise.all(
      ids.slice(0, 4).map((id) => runCli(env, "always-return", "add", id)),
    );
    expect(simultaneous.map((r) => r.exitCode).sort()).toEqual([0, 0, 0, 1]);
    expect(simultaneous.find((r) => r.exitCode === 1)?.stdout).toContain(
      "limit_reached",
    );
    const base = await runServe(
      env,
      [
        callTool(2, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["src/main.ts"],
          limit: 3,
        }),
        callTool(3, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["src/main.ts"],
          limit: 6,
        }),
        callTool(4, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["src/main.ts"],
          limit: 20,
        }),
        callTool(5, "get_knowledge", { repo: REPOSITORY, id: conversationId }),
        callTool(6, "set_global_always_return", {
          knowledge_id: inactive,
          enabled: true,
        }),
        callTool(7, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["other"],
          task: "schema",
          limit: 5,
        }),
        callTool(8, "set_global_always_return", {
          knowledge_id: ids[4],
          enabled: true,
        }),
        callTool(9, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["src/main.ts"],
          limit: 1,
        }),
        callTool(10, "get_rules", {
          repo: REPOSITORY,
          file_paths: ["src/main.ts"],
          limit: 2,
        }),
      ],
      ["--repo", REPOSITORY, "--allow-always-return-changes"],
    );
    const rules = (n: number) =>
      GetRulesOutputSchema.parse(structuredContent(base, n));
    expect(rules(2)).toMatchObject({
      matched_count: 1,
      truncated: true,
      global_matched_count: 9,
      global_truncated: true,
    });
    expect(rules(2).rules).toHaveLength(3);
    expect(rules(2).rules.map((r) => r.match_reasons)).toEqual(
      Array(3).fill([{ type: "global_store", via: "always" }]),
    );
    expect(rules(3).rules.map((r) => r.match_reasons[0])).toEqual([
      { type: "scope", file_path: "src/main.ts", pattern: "src/**" },
      ...Array(3).fill({ type: "global_store", via: "always" }),
      ...Array(2).fill({ type: "global_store", via: "scope" }),
    ]);
    expect(rules(3)).toMatchObject({
      matched_count: 1,
      truncated: false,
      readiness: rules(2).readiness,
    });
    expect(rules(4).rules).toHaveLength(9);
    expect(rules(4).rules.map((r) => r.id)).not.toContain(conversationId);
    expect(rules(7).rules).toHaveLength(5);
    expect(rules(7).rules.slice(3)).toHaveLength(2);
    expect(
      rules(7)
        .rules.slice(3)
        .every((r) =>
          r.match_reasons.some(
            (reason) => reason.type === "global_store" && reason.via === "task",
          ),
        ),
    ).toBe(true);
    expect(structuredContent(base, 6)).toMatchObject({ reason: "not_active" });
    // The limit holds over MCP too, and a limit below the reserved slots
    // returns only always-return rules.
    expect(structuredContent(base, 8)).toMatchObject({
      state: "rejected",
      reason: "limit_reached",
      reserved_count: 3,
    });
    for (const [n, limit] of [
      [9, 1],
      [10, 2],
    ] as const) {
      expect(rules(n).rules).toHaveLength(limit);
      expect(rules(n).rules.map((r) => r.match_reasons)).toEqual(
        Array(limit).fill([{ type: "global_store", via: "always" }]),
      );
    }
    const detail = GetKnowledgeOutputSchema.parse(structuredContent(base, 5));
    expect(detail).toMatchObject({
      evidence: [],
      conversation_summary: {
        period: { from: timestamp, to: timestamp },
        session_count: 1,
        project_count: 1,
        has_conflict: false,
      },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /utt-private|confidential-snippet|utterance-private|Record outcome E2E fixture detail/,
    );
  });
});

describe("global matches across repeated reads", () => {
  it("reserves configured slots while inactive and validates events before committing", async () => {
    const { storageRoot } = await createOutcomeEnvironment();
    const global = new GlobalStore(storageRoot);
    await global.initialize();
    const ids = Array.from({ length: 4 }, () => createDomainId("knowledge"));
    const setStatus = (id: string, status: KnowledgeStatus) =>
      writeKnowledge(global.reference.absolutePath, id, status, "rk:global");
    const set = (id: string, enabled: boolean) =>
      global.setAlwaysReturn(id, enabled, { actor: "cli" });
    for (const id of ids) await setStatus(id, "active");
    const first = ids[0]!,
      fourth = ids[3]!;
    await expect(
      global.setAlwaysReturn(first, true, { actor: "mcp", caller_repo_id: "" }),
    ).rejects.toThrow();
    for (const id of ids.slice(0, 3)) await set(id, true);
    await setStatus(first, "stale");
    expect(await set(fourth, true)).toMatchObject({
      reason: "limit_reached",
      always_return_count: 2,
    });
    await setStatus(first, "active");
    expect(await set(first, true)).toMatchObject({
      state: "unchanged",
      always_return_count: 3,
    });
    await setStatus(first, "stale");
    expect(await set(first, false)).toMatchObject({
      state: "changed",
      always_return_count: 2,
    });
    expect(await set(fourth, true)).toMatchObject({
      state: "changed",
      always_return_count: 3,
    });
    await setStatus(first, "active");
    expect(
      (await global.listAlwaysReturn()).map((e) => e.knowledge_id),
    ).toEqual(ids.slice(1));
  });

  it("requires a real global directory and private entries under its configured root", async () => {
    const environment = await createOutcomeEnvironment();
    const global = new GlobalStore(environment.storageRoot);
    const other = join(environment.storageRoot, "elsewhere");
    await symlink(other, global.reference.absolutePath, "dir");
    await expect(global.exists()).rejects.toThrow("symbolic link");
    const replies = await runServe(environment, [
      callTool(2, "get_rules", { repo: REPOSITORY, file_paths: ["src/x.ts"] }),
      callTool(3, "record_outcome", {
        repo: REPOSITORY,
        knowledge_id: UNKNOWN_ID,
        event_key: "work-1",
        result_observed: true,
        at: OUTCOME_AT,
        outcome: "applied",
        note: "Validated the schema",
        context: { task_id: "task" },
      }),
    ]);
    // A broken global store must not replace the repository's NOT_FOUND.
    expect(errorCode(replies, 3)).toBe("KNOWLEDGE_NOT_FOUND");
    await expect(
      new KnowledgeReadService({
        repo: REPOSITORY,
        repoId: REPO_ID,
        repository: new CanonicalTransactionStore(environment.repositoryRoot),
        globalStore: global,
      }).getKnowledge({ id: UNKNOWN_ID }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
    expect(replyById(replies, 2).result).toMatchObject({
      structuredContent: {
        global_read_failed: true,
        matched_count: 1,
        truncated: false,
        rules: [{ id: ACTIVE_ID }],
      },
      content: [
        { text: expect.stringContaining("Global rules could not be read.") },
      ],
    });
    await rm(global.reference.absolutePath);
    await mkdir(other, { mode: 0o700 });
    await symlink(other, global.reference.absolutePath, "dir");
    await expect(global.readRules()).rejects.toThrow("directly inside");
    await expect(global.reindex()).rejects.toThrow("directly inside");
    await rm(global.reference.absolutePath);
    await mkdir(global.reference.absolutePath, { mode: 0o700 });
    await symlink(
      other,
      join(global.reference.absolutePath, "knowledge"),
      "dir",
    );
    await expect(global.reindex()).rejects.toThrow("symbolic links");
    // The broad-directory guard runs where permissions change, not on reads.
    await expect(new GlobalStore("/").exists()).resolves.toBe(false);
    await expect(new GlobalStore("/").initialize()).rejects.toThrow(
      "broad directory",
    );
  });
  it("reserves matched slots even with a full repository, and sees manual changes", async () => {
    const { storageRoot, repositoryRoot } = await createOutcomeEnvironment();
    const globalStore = new GlobalStore(storageRoot);
    const writeGlobalRule = (
      id: string,
      status: KnowledgeStatus,
      fields?: Record<string, unknown>,
    ) =>
      writeKnowledge(
        globalStore.reference.absolutePath,
        id,
        status,
        globalStore.reference.repoId,
        fields,
      );
    const localStore = new CanonicalTransactionStore(repositoryRoot);
    const service = new KnowledgeReadService({
      repo: REPOSITORY,
      repoId: REPO_ID,
      repository: localStore,
      globalStore,
    });
    const localIds = Array.from({ length: 6 }, () =>
      createDomainId("knowledge"),
    );
    for (const id of localIds)
      await writeKnowledge(repositoryRoot, id, "active", REPO_ID);
    const input = { filePaths: ["src/a.ts"], limit: 5 };
    const baseline = await service.getRules(input);
    await globalStore.initialize();
    const [always, low, high] = Array.from({ length: 3 }, () =>
      createDomainId("knowledge"),
    ) as [string, string, string];
    for (const [id, severity] of [
      [always, "must"],
      [low, "consider"],
      [high, "should"],
    ] as const)
      await writeGlobalRule(id, "active", { severity, scope: ["docs/**"] });
    const noMatch = await service.getRules(input);
    expect(noMatch).toEqual({
      ...baseline,
      global_matched_count: 0,
      global_truncated: false,
    });
    // An empty-scope global rule never matches files, only a task.
    await writeGlobalRule(high, "active", { scope: [] });
    expect(await service.getRules(input)).toEqual({
      ...baseline,
      global_matched_count: 0,
      global_truncated: false,
    });
    const byTask = await service.getRules({ ...input, task: "stdio outcome" });
    expect(
      byTask.rules.find((rule) => rule.id === high)?.match_reasons,
    ).toEqual([
      { type: "global_store", via: "task", score: expect.any(Number) },
    ]);
    // An ID the repository already owns is not listed again from global.
    await writeGlobalRule(localIds[0]!, "active");
    expect(
      (await service.getRules({ ...input, limit: 20 })).rules.filter(
        (rule) => rule.id === localIds[0],
      ),
    ).toHaveLength(1);
    await rm(
      join(
        globalStore.reference.absolutePath,
        "knowledge",
        `${localIds[0]}.md`,
      ),
    );
    await globalStore.setAlwaysReturn(always, true, { actor: "cli" });
    for (const [id, severity] of [
      [low, "consider"],
      [high, "should"],
    ] as const)
      await writeGlobalRule(id, "active", { severity });
    const result = await service.getRules(input);
    expect(result.rules.map((rule) => rule.id)).toEqual([
      ...baseline.rules.slice(0, 2).map((rule) => rule.id),
      always,
      high,
      low,
    ]);
    expect(result).toMatchObject({
      matched_count: 7,
      truncated: true,
      global_matched_count: 3,
      global_truncated: false,
      readiness: baseline.readiness,
    });
    await writeGlobalRule(always, "deprecated");
    expect(
      (await service.getRules(input)).rules.map((rule) => rule.id),
    ).not.toContain(always);
    expect(await globalStore.listAlwaysReturn()).toMatchObject([
      { knowledge_id: always, actor: "cli" },
    ]);
  });
});

describe("global store review follow-ups", () => {
  it("serializes simultaneous always-return changes and lists every reservation", async () => {
    const { storageRoot } = await createOutcomeEnvironment();
    const global = new GlobalStore(storageRoot);
    await global.initialize();
    const ids = Array.from({ length: 4 }, () => createDomainId("knowledge"));
    for (const id of ids)
      await writeKnowledge(
        global.reference.absolutePath,
        id,
        "active",
        "rk:global",
      );
    // All four start before any finishes, so the lock decides the winner.
    const results = await Promise.all(
      ids.map((id) => global.setAlwaysReturn(id, true, { actor: "cli" })),
    );
    expect(results.map((r) => r.state).sort()).toEqual([
      "changed",
      "changed",
      "changed",
      "rejected",
    ]);
    const rejected = results.find((r) => r.state === "rejected")!;
    expect(rejected).toMatchObject({
      reason: "limit_reached",
      always_return_count: 3,
      reserved_count: 3,
    });
    const reserved = results
      .filter((r) => r.state === "changed")
      .map((r) => r.knowledge_id);
    await writeKnowledge(
      global.reference.absolutePath,
      reserved[0]!,
      "stale",
      "rk:global",
    );
    // An inactive rule keeps its slot; the counts and the list say so.
    expect(
      await global.setAlwaysReturn(rejected.knowledge_id, true, {
        actor: "cli",
      }),
    ).toMatchObject({
      reason: "limit_reached",
      always_return_count: 2,
      reserved_count: 3,
    });
    // Lock order, not Promise.all order, decides the list order.
    expect(
      new Map(
        (await global.listAlwaysReturn()).map((e) => [
          e.knowledge_id,
          e.status,
        ]),
      ),
    ).toEqual(
      new Map([
        [reserved[0], "stale"],
        [reserved[1], "active"],
        [reserved[2], "active"],
      ]),
    );
  });

  it("orders always-return rules by severity, then recency, then ID", async () => {
    const { storageRoot, repositoryRoot } = await createOutcomeEnvironment();
    const global = new GlobalStore(storageRoot);
    await global.initialize();
    const [newestShould, ...musts] = Array.from({ length: 3 }, () =>
      createDomainId("knowledge"),
    ) as [string, string, string];
    await writeKnowledge(
      global.reference.absolutePath,
      newestShould,
      "active",
      "rk:global",
      { severity: "should", updated_at: "2026-04-01T00:00:00.000Z" },
    );
    for (const id of musts)
      await writeKnowledge(
        global.reference.absolutePath,
        id,
        "active",
        "rk:global",
        {
          severity: "must",
          updated_at: "2026-02-01T00:00:00.000Z",
        },
      );
    for (const id of [newestShould, ...musts])
      await global.setAlwaysReturn(id, true, { actor: "cli" });
    const result = await new KnowledgeReadService({
      repo: REPOSITORY,
      repoId: REPO_ID,
      repository: new CanonicalTransactionStore(repositoryRoot),
      globalStore: global,
    }).getRules({ filePaths: ["docs/none.md"], limit: 10 });
    expect(result.rules.map((rule) => rule.id)).toEqual([
      ...[...musts].sort(),
      newestShould,
    ]);
  });

  it("keeps repository rules when global events are corrupt", async () => {
    const { storageRoot, repositoryRoot } = await createOutcomeEnvironment();
    const global = new GlobalStore(storageRoot);
    await global.initialize();
    const globalId = createDomainId("knowledge");
    await writeKnowledge(
      global.reference.absolutePath,
      globalId,
      "active",
      "rk:global",
    );
    const service = new KnowledgeReadService({
      repo: REPOSITORY,
      repoId: REPO_ID,
      repository: new CanonicalTransactionStore(repositoryRoot),
      globalStore: global,
    });
    const input = { filePaths: ["src/x.ts"], limit: 10 };
    expect(
      (await service.getRules(input)).rules.map((rule) => rule.id),
    ).toEqual([ACTIVE_ID, globalId]);
    await writeFile(
      join(global.reference.absolutePath, "events", "always_return.jsonl"),
      "{not json\n",
      { mode: 0o600 },
    );
    const failed = await service.getRules(input);
    expect(failed).toMatchObject({
      global_read_failed: true,
      matched_count: 1,
      rules: [{ id: ACTIVE_ID }],
    });
    expect(failed.rules).toHaveLength(1);
  });

  it("runs doctor from inside the storage root without failing the global store", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createOutcomeEnvironment();
    const doctor = async () =>
      JSON.parse(
        (
          await execa(
            process.execPath,
            [join(process.cwd(), "dist/bin.js"), "doctor"],
            {
              cwd: environment.storageRoot,
              env: environment.env,
              reject: false,
            },
          )
        ).stdout,
      ) as { checks: { id: string; status: string; message: string }[] };
    const check = async () =>
      (await doctor()).checks.find((item) => item.id === "global.store");
    expect(await check()).toMatchObject({
      status: "pass",
      message: expect.stringContaining("not been created"),
    });
    await new GlobalStore(environment.storageRoot).initialize();
    expect(await check()).toMatchObject({
      status: "pass",
      message: expect.stringContaining("is present"),
    });
  });

  it("refuses add --global without a terminal before creating the store", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createOutcomeEnvironment();
    const result = await runCli(
      environment,
      "add",
      "--global",
      "--category",
      "test",
      "--detail",
      "Validate fields",
      "--rule",
      "Validate schema",
      "--severity",
      "must",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("CLI_TTY_REQUIRED");
    expect(result.stderr).not.toContain("TTY_REQUIRED: TTY_REQUIRED");
    expect(await new GlobalStore(environment.storageRoot).exists()).toBe(false);
  });
});

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { id, jsonrpc: "2.0", method, params };
}

function callTool(
  id: number,
  name: string,
  toolArguments: Record<string, unknown>,
): Record<string, unknown> {
  return request(id, "tools/call", { arguments: toolArguments, name });
}

function runCli(environment: OutcomeEnvironment, ...args: string[]) {
  return execa(process.execPath, ["dist/bin.js", ...args], {
    env: environment.env,
    reject: false,
  });
}

/** Drives the packaged stdio server with a newline-delimited JSON-RPC client. */
async function runServe(
  environment: OutcomeEnvironment,
  calls: readonly Record<string, unknown>[],
  flags: string[] = [],
): Promise<JsonRpcReply[]> {
  const messages = [
    request(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "record-outcome-e2e", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    }),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    ...calls,
  ];
  const { replies, stderr } = await runJsonRpcOverStdio({
    args: ["dist/bin.js", "serve", ...flags],
    command: process.execPath,
    cwd: process.cwd(),
    env: environment.env,
    messages,
  });
  expect(stderr).toBe("");
  // Every stdout frame must remain valid JSON-RPC while outcomes are recorded.
  expect(replies.every((reply) => "id" in reply || "method" in reply)).toBe(
    true,
  );
  return replies;
}

function listedToolNames(reply: JsonRpcReply): string[] {
  const result = reply.result as { readonly tools?: unknown };
  if (!Array.isArray(result.tools)) throw new TypeError("tools/list failed");
  return result.tools.map((tool) => {
    const name = (tool as { readonly name?: unknown }).name;
    if (typeof name !== "string") throw new TypeError("tool has no name");
    return name;
  });
}

function replyById(replies: readonly JsonRpcReply[], id: number): JsonRpcReply {
  const reply = replies.find((candidate) => candidate.id === id);
  expect(reply, `missing JSON-RPC reply ${String(id)}`).toBeDefined();
  expect(reply).not.toHaveProperty("error");
  return reply!;
}

function structuredContent(
  replies: readonly JsonRpcReply[],
  id: number,
): unknown {
  const result = replyById(replies, id).result as {
    readonly structuredContent?: unknown;
  };
  return result.structuredContent;
}

function errorCode(replies: readonly JsonRpcReply[], id: number): string {
  const result = replyById(replies, id).result as {
    readonly isError?: boolean;
  };
  expect(result.isError).toBe(true);
  const parsed = RecordOutcomeOutputSchema.parse(
    structuredContent(replies, id),
  );
  expect(parsed.ok).toBe(false);
  return parsed.error!.code;
}

async function createOutcomeEnvironment(): Promise<OutcomeEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "rkm-outcome-e2e-"));
  temporaryDirectories.push(root);
  const storageRoot = join(root, "home");
  const binDirectory = join(root, "bin");
  await mkdir(storageRoot, { mode: 0o700, recursive: true });
  await mkdir(binDirectory, { recursive: true });
  const ghPath = join(binDirectory, "gh");
  await writeFile(ghPath, fakeGhSource(), "utf8");
  await chmod(ghPath, 0o755);

  // Seed one active rule (and one foreign rule) directly into the canonical
  // store the registry binds to this repository id.
  const registered = await new RepositoryRegistry(storageRoot).register({
    currentName: REPOSITORY,
    repoId: REPO_ID,
  });
  await mkdir(join(registered.absolutePath, "knowledge"), { recursive: true });
  await writeKnowledge(registered.absolutePath, ACTIVE_ID, "active", REPO_ID);
  await writeKnowledge(
    registered.absolutePath,
    FOREIGN_ID,
    "active",
    OTHER_REPO_ID,
  );

  return {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      REPO_KNOWLEDGE_HOME: storageRoot,
    },
    storageRoot,
    repositoryRoot: registered.absolutePath,
  };
}

async function writeKnowledge(
  repositoryRoot: string,
  id: string,
  status: KnowledgeStatus,
  repoId: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const path = `knowledge/${id}.md`;
  await writeFile(
    join(repositoryRoot, path),
    serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: "style",
        created_at: CREATED_AT,
        id,
        origin: { type: "distilled" },
        related_ids: [],
        repo_id: repoId,
        revision: 1,
        rule: `Guard the stdio outcome flow for ${id}`,
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status,
        updated_at: CREATED_AT,
        ...fields,
      },
      "Record outcome E2E fixture detail",
    ),
  );
}

/** Deterministic `gh` stand-in: answers only repository resolution. */
function fakeGhSource(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "graphql") {
  process.stderr.write("fake gh: unsupported invocation\\n");
  process.exit(1);
}
const query = args.find((value) => value.startsWith("query=")) ?? "";
if (!query.includes("query ResolveRepository")) {
  process.stderr.write("fake gh: unsupported query\\n");
  process.exit(1);
}
const data = {
  repository: {
    id: args.includes("name=another") ? "R_other_caller" : ${JSON.stringify(REPO_ID)},
    nameWithOwner: args.includes("name=another") ? "owner/another" : ${JSON.stringify(REPOSITORY)},
  },
};
process.stdout.write(JSON.stringify({ data }) + "\\n");
`;
}

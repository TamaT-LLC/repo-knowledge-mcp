import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AddKnowledgeOutputSchema,
  DistillJobCoordinatorError,
  FileLockTimeoutError,
  IngestPrOutputSchema,
  KnowledgeConflictError,
  PrepareDistillationOutputSchema,
  RecordOutcomeError,
  RecordOutcomeOutputSchema,
  RequestIntegrityError,
  RepositoryResolutionError,
  SubmitDistillationError,
  SubmitDistillationOutputSchema,
  SyncCursorError,
  SyncRepoError,
  SyncRepoOutputSchema,
  UpdateKnowledgeOutputSchema,
  serveRepoKnowledgeStdio,
  type KnowledgeMutationOperations,
  type KnowledgeMutationServiceResolver,
  type KnowledgeReadServiceResolver,
} from "../src/experimental.js";
import {
  WireClient,
  asRecord,
  callTool,
  modernParameters,
  readTools,
  toolResult,
  toolStructuredContent,
  toolText,
  type McpParameters,
} from "./support/mcp-test-client.js";

const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVENT_KEY = "codex:issue-117:tool-result";
const OUTCOME_AT = "2026-08-07T00:00:00.000Z";
const REPOSITORY = "owner/repository";
const RAW_HASH = "a".repeat(64);
const PREFIXED_HASH = `sha256:${RAW_HASH}`;
const handles: Array<{ close(): Promise<void> }> = [];
const clients: WireClient[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
});

describe("MCP mutation tools", () => {
  it("lists and calls all mutation tools with structured results", async () => {
    const fixture = createMutationFixture();
    const connection = await connect(fixture.resolver, "legacy", {
      startupRepo: "startup/repository",
      startupWorkspace: "/workspace/startup",
    });
    const tools = readTools(
      await connection.client.request("tools/list", {}),
    ).filter((tool) =>
      [
        "ingest_pr",
        "sync_repo",
        "prepare_distillation",
        "submit_distillation",
        "add_knowledge",
        "update_knowledge",
        "record_outcome",
      ].includes(tool.name),
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "ingest_pr",
      "sync_repo",
      "prepare_distillation",
      "submit_distillation",
      "add_knowledge",
      "update_knowledge",
      "record_outcome",
    ]);
    expect(
      Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
    ).toEqual({
      add_knowledge: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      ingest_pr: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      prepare_distillation: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      record_outcome: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      submit_distillation: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      sync_repo: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      update_knowledge: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
    });

    const ingest = await callTool(connection.client, "ingest_pr", {
      pr_number: 42,
      repo: REPOSITORY,
    });
    expect(
      IngestPrOutputSchema.safeParse(toolStructuredContent(ingest)).success,
    ).toBe(true);
    expect(toolText(ingest)).toContain("**1** distilled");
    expect(toolText(ingest)).toContain("Retryable: **yes**");
    expect(toolStructuredContent(ingest)).toMatchObject({
      summary: {
        counts: { distilled: 1, pending: 0 },
        next_action: expect.any(String),
        retryable: true,
      },
    });
    expect(fixture.ingestPullRequest).toHaveBeenCalledWith({ pr_number: 42 });
    expect(fixture.resolve).toHaveBeenLastCalledWith({
      repo: REPOSITORY,
      startupRepo: "startup/repository",
      startupWorkspace: "/workspace/startup",
    });

    const sync = await callTool(connection.client, "sync_repo", {
      repo: REPOSITORY,
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(
      SyncRepoOutputSchema.safeParse(toolStructuredContent(sync)).success,
    ).toBe(true);
    expect(toolText(sync)).toContain("**2** updated pull request(s)");
    expect(toolStructuredContent(sync)).toMatchObject({
      result: {
        discovered: 2,
        failed: 0,
        ingested: 1,
        next_cursor: {
          last_pr_number: 42,
          repo_id: "R_repository",
          version: 1,
        },
        unchanged: 1,
      },
      summary: {
        counts: { discovered: 2, failed: 0, ingested: 1, unchanged: 1 },
        next_action: expect.stringContaining("prepare_distillation"),
        retryable: true,
      },
    });
    expect(fixture.syncRepo).toHaveBeenCalledWith({
      since: "2026-08-01T00:00:00.000Z",
    });

    const prepare = await callTool(connection.client, "prepare_distillation", {
      limit: 2,
      workspace_path: "/workspace/tool",
    });
    expect(
      PrepareDistillationOutputSchema.safeParse(toolStructuredContent(prepare))
        .success,
    ).toBe(true);
    expect(toolText(prepare)).toContain("Review content was not returned");
    expect(JSON.stringify(toolStructuredContent(prepare))).not.toContain(
      "SECRET_REVIEW_BODY",
    );
    expect(toolStructuredContent(prepare)).toMatchObject({
      summary: {
        counts: { pending_jobs: 1, review_content_items: 0 },
        next_action: expect.stringContaining("prepare_distillation"),
        retryable: true,
      },
    });
    expect(fixture.prepareDistillation).toHaveBeenCalledWith({ limit: 2 });

    const extractRequest = {
      candidates: [],
      job_id: JOB_ID,
      lease_generation: 1,
      lease_token: "lease-token",
      phase: "extract",
      request_schema_version: 1,
      skip_reason: "typo",
      submission_id: "submission-extract",
      thread_fingerprint: PREFIXED_HASH,
    } as const;
    const extract = await callTool(
      connection.client,
      "submit_distillation",
      extractRequest,
    );
    expect(
      SubmitDistillationOutputSchema.safeParse(toolStructuredContent(extract))
        .success,
    ).toBe(true);
    expect(toolText(extract)).toContain("no finalize call is required");
    expect(fixture.submitExtract).toHaveBeenCalledWith(extractRequest);

    const finalizeRequest = {
      candidate_set_sha256: RAW_HASH,
      decisions: [
        {
          candidate_id: "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          relation: "different",
        },
      ],
      finalize_token: "finalize-token",
      job_id: JOB_ID,
      lease_generation: 2,
      lease_token: "renewed-lease-token",
      phase: "finalize",
      request_schema_version: 1,
      submission_id: "submission-finalize",
    } as const;
    const finalize = await callTool(
      connection.client,
      "submit_distillation",
      finalizeRequest,
    );
    expect(
      SubmitDistillationOutputSchema.safeParse(toolStructuredContent(finalize))
        .success,
    ).toBe(true);
    expect(toolText(finalize)).toContain(
      "Created **0** active rule(s) and **1** proposed rule",
    );
    expect(toolStructuredContent(finalize)).toMatchObject({
      summary: {
        counts: { created_proposed: 1 },
        next_action: expect.stringContaining("admin CLI"),
        retryable: true,
      },
    });
    expect(fixture.submitFinalize).toHaveBeenCalledWith(finalizeRequest);

    const addRequest = {
      category: "architecture",
      detail: "Keep authorization in application services.",
      rule: "Do not authorize from MCP annotations",
      scope: ["src/**"],
      severity: "must",
    } as const;
    const add = await callTool(connection.client, "add_knowledge", addRequest);
    expect(
      AddKnowledgeOutputSchema.safeParse(toolStructuredContent(add)).success,
    ).toBe(true);
    expect(toolText(add)).toContain("human must approve");
    expect(toolStructuredContent(add)).toMatchObject({
      summary: {
        counts: { created_proposed: 1 },
        retryable: false,
      },
    });
    expect(fixture.addKnowledge).toHaveBeenCalledWith(addRequest);

    const updateRequest = {
      expected_etag: RAW_HASH,
      expected_revision: 3,
      id: KNOWLEDGE_ID,
      patch: { rule: "Proposed replacement" },
    } as const;
    const update = await callTool(
      connection.client,
      "update_knowledge",
      updateRequest,
    );
    expect(
      UpdateKnowledgeOutputSchema.safeParse(toolStructuredContent(update))
        .success,
    ).toBe(true);
    expect(toolText(update)).toContain("Canonical knowledge was not modified");
    expect(toolStructuredContent(update)).toMatchObject({
      summary: {
        counts: { revision_proposals: 1 },
        retryable: false,
      },
    });
    expect(fixture.updateKnowledge).toHaveBeenCalledWith(updateRequest);

    const outcomeRequest = {
      at: OUTCOME_AT,
      context: { file_paths: ["src/index.ts"], pr_number: 42 },
      event_id: EVENT_ID,
      knowledge_id: KNOWLEDGE_ID,
      note: "guarded the input",
      outcome: "applied",
      result_observed: true,
    } as const;
    const outcome = await callTool(connection.client, "record_outcome", {
      ...outcomeRequest,
      repo: REPOSITORY,
    });
    expect(
      RecordOutcomeOutputSchema.safeParse(toolStructuredContent(outcome))
        .success,
    ).toBe(true);
    expect(toolText(outcome)).toContain(`Recorded \`applied\``);
    expect(toolStructuredContent(outcome)).toMatchObject({
      result: {
        applied_count: 1,
        event_id: EVENT_ID,
        knowledge_id: KNOWLEDGE_ID,
        outcome: "applied",
        replayed: false,
        violation_count: 0,
      },
      summary: {
        counts: { applied_count: 1, recorded_events: 1, violation_count: 0 },
        retryable: true,
      },
    });
    expect(fixture.recordOutcome).toHaveBeenCalledWith(outcomeRequest);
  });

  it("returns only safe finding metadata for a sensitive host payload", async () => {
    const fixture = createMutationFixture();
    fixture.prepareDistillation.mockResolvedValueOnce({
      blocked_jobs: [
        {
          job: {
            job_id: JOB_ID,
            lease_generation: 0,
            state: "pending",
            thread_id: "thread-1",
            updated_at: "2026-08-06T00:00:00.000Z",
          },
          reason: "sensitive_content_detected",
          sensitive_content_findings: [
            { kind: "github_token", path: "$.comments[0].body" },
          ],
        },
      ],
      jobs: [],
      state: "prepared",
    });
    const connection = await connect(fixture.resolver);

    const response = await callTool(connection.client, "prepare_distillation", {
      repo: REPOSITORY,
    });

    expect(
      PrepareDistillationOutputSchema.safeParse(toolStructuredContent(response))
        .success,
    ).toBe(true);
    expect(toolStructuredContent(response)).toMatchObject({
      ok: true,
      result: {
        blocked_jobs: [
          {
            reason: "sensitive_content_detected",
            sensitive_content_findings: [
              { kind: "github_token", path: "$.comments[0].body" },
            ],
          },
        ],
      },
      summary: {
        next_action: expect.stringContaining("Remove or redact"),
        retryable: true,
      },
    });
  });

  it("returns the stable original result when the same event_id is retried", async () => {
    const fixture = createMutationFixture();
    fixture.recordOutcome.mockResolvedValueOnce({
      applied_count: 1,
      event_id: EVENT_ID,
      knowledge_id: KNOWLEDGE_ID,
      outcome: "applied",
      replayed: true,
      violation_count: 0,
    });
    const connection = await connect(fixture.resolver);

    const replay = await callTool(connection.client, "record_outcome", {
      at: OUTCOME_AT,
      context: { task_id: "retry-test" },
      event_id: EVENT_ID,
      knowledge_id: KNOWLEDGE_ID,
      note: "observed the original successful result",
      outcome: "applied",
      repo: REPOSITORY,
      result_observed: true,
    });

    expect(toolResult(replay)).not.toHaveProperty("isError", true);
    expect(toolText(replay)).toContain("no counter changed");
    expect(toolStructuredContent(replay)).toMatchObject({
      ok: true,
      result: { applied_count: 1, replayed: true },
      summary: {
        counts: { applied_count: 1, recorded_events: 0, violation_count: 0 },
        retryable: true,
      },
    });
  });

  it("forwards the fail-closed host event_key contract", async () => {
    const fixture = createMutationFixture();
    const connection = await connect(fixture.resolver);
    const outcomeRequest = {
      at: OUTCOME_AT,
      context: { file_paths: ["src/index.ts"], task_id: "issue-117" },
      event_key: EVENT_KEY,
      knowledge_id: KNOWLEDGE_ID,
      note: "typecheck completed after applying the rule",
      outcome: "applied",
      result_observed: true,
    } as const;

    const response = await callTool(connection.client, "record_outcome", {
      ...outcomeRequest,
      repo: REPOSITORY,
    });

    expect(toolResult(response)).not.toHaveProperty("isError", true);
    expect(fixture.recordOutcome).toHaveBeenCalledWith(outcomeRequest);
  });

  it("rejects either identity path when no observable result is attested", async () => {
    const fixture = createMutationFixture();
    const connection = await connect(fixture.resolver);

    for (const identity of [{ event_key: EVENT_KEY }, { event_id: EVENT_ID }]) {
      const response = await callTool(connection.client, "record_outcome", {
        at: OUTCOME_AT,
        ...identity,
        knowledge_id: KNOWLEDGE_ID,
        outcome: "applied",
        repo: REPOSITORY,
      });
      expect(toolResult(response)).toMatchObject({ isError: true });
    }
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.recordOutcome).not.toHaveBeenCalled();
  });

  it("maps outcome idempotency conflicts and knowledge binding failures to operator errors", async () => {
    const fixture = createMutationFixture();
    fixture.recordOutcome
      .mockRejectedValueOnce(
        new RecordOutcomeError(
          "IDEMPOTENCY_CONFLICT",
          `event ${EVENT_ID} is already bound to a different outcome payload`,
        ),
      )
      .mockRejectedValueOnce(
        new RecordOutcomeError(
          "KNOWLEDGE_NOT_FOUND",
          `knowledge ${KNOWLEDGE_ID} was not found in this repository`,
        ),
      )
      .mockRejectedValueOnce(
        new RecordOutcomeError(
          "KNOWLEDGE_REPOSITORY_MISMATCH",
          `knowledge ${KNOWLEDGE_ID} belongs to repository R_other, not R_repository`,
        ),
      )
      .mockRejectedValueOnce(
        new RecordOutcomeError(
          "KNOWLEDGE_NOT_ACTIVE",
          `knowledge ${KNOWLEDGE_ID} is proposed; outcomes require active knowledge`,
        ),
      );
    const connection = await connect(fixture.resolver);
    const call = async () =>
      callTool(connection.client, "record_outcome", {
        at: OUTCOME_AT,
        context: { task_id: "binding-failure-test" },
        event_id: EVENT_ID,
        knowledge_id: KNOWLEDGE_ID,
        note: "observed a rule violation",
        outcome: "violated",
        repo: REPOSITORY,
        result_observed: true,
      });

    const conflict = await call();
    expect(toolResult(conflict)).toMatchObject({ isError: true });
    expect(
      RecordOutcomeOutputSchema.safeParse(toolStructuredContent(conflict))
        .success,
    ).toBe(true);
    expect(toolStructuredContent(conflict)).toMatchObject({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        next_action: expect.stringContaining("new event_id"),
        retryable: false,
      },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: {
        code: "KNOWLEDGE_NOT_FOUND",
        next_action: expect.stringContaining("get_rules"),
        retryable: false,
      },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: {
        code: "KNOWLEDGE_REPOSITORY_MISMATCH",
        next_action: expect.stringContaining("get_rules"),
        retryable: false,
      },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: {
        code: "KNOWLEDGE_NOT_ACTIVE",
        next_action: expect.stringContaining("active knowledge ids"),
        retryable: false,
      },
      ok: false,
    });
  });

  it("keeps approval and status changes unreachable from MCP schemas", async () => {
    const fixture = createMutationFixture();
    const connection = await connect(fixture.resolver);
    const tools = readTools(await connection.client.request("tools/list", {}));
    const add = tools.find((tool) => tool.name === "add_knowledge")!;
    const update = tools.find((tool) => tool.name === "update_knowledge")!;
    const record = tools.find((tool) => tool.name === "record_outcome")!;
    const addProperties = asRecord(asRecord(add.inputSchema).properties);
    const updateProperties = asRecord(asRecord(update.inputSchema).properties);
    const patchProperties = asRecord(
      asRecord(updateProperties.patch).properties,
    );
    const recordProperties = asRecord(asRecord(record.inputSchema).properties);

    expect(addProperties).not.toHaveProperty("status");
    expect(addProperties).not.toHaveProperty("activation");
    expect(updateProperties).not.toHaveProperty("status");
    expect(patchProperties).not.toHaveProperty("status");
    expect(patchProperties).not.toHaveProperty("activation");
    // record_outcome only appends events: no knowledge field is writable.
    for (const field of [
      "status",
      "activation",
      "rule",
      "detail",
      "scope",
      "severity",
      "patch",
    ]) {
      expect(recordProperties).not.toHaveProperty(field);
    }
    expect(asRecord(update.inputSchema).required).toEqual(
      expect.arrayContaining([
        "expected_etag",
        "expected_revision",
        "id",
        "patch",
      ]),
    );

    const rejected = await callTool(connection.client, "add_knowledge", {
      category: "architecture",
      detail: "Attempted elevation",
      rule: "Attempted elevation",
      scope: [],
      severity: "must",
      status: "active",
    });
    expect(toolResult(rejected)).toMatchObject({ isError: true });

    const escalated = await callTool(connection.client, "record_outcome", {
      at: OUTCOME_AT,
      event_id: EVENT_ID,
      knowledge_id: KNOWLEDGE_ID,
      outcome: "applied",
      status: "active",
    });
    expect(toolResult(escalated)).toMatchObject({ isError: true });

    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.addKnowledge).not.toHaveBeenCalled();
    expect(fixture.recordOutcome).not.toHaveBeenCalled();
  });

  it("maps conflicts, stale leases, idempotency, source changes, and resolution failures to structured errors", async () => {
    const fixture = createMutationFixture();
    fixture.updateKnowledge.mockRejectedValueOnce(
      new KnowledgeConflictError({
        body: "Current body",
        etag: "b".repeat(64),
        frontmatter: {
          id: KNOWLEDGE_ID,
          repo_id: "R_repository",
          revision: 4,
          schema_version: 1,
        },
        path: `knowledge/${KNOWLEDGE_ID}.md`,
        revision: 4,
      }),
    );
    fixture.submitExtract.mockRejectedValueOnce(
      new DistillJobCoordinatorError(
        "STALE_LEASE",
        "another worker owns the current generation",
      ),
    );
    fixture.submitExtract.mockRejectedValueOnce(
      new RequestIntegrityError(
        "IDEMPOTENCY_KEY_REUSED",
        "submission_id belongs to another request",
      ),
    );
    fixture.submitFinalize.mockRejectedValueOnce(
      new SubmitDistillationError(
        "DISTILLATION_SOURCE_CHANGED",
        "review content changed after extract",
      ),
    );
    const connection = await connect(fixture.resolver);

    const conflict = await callTool(connection.client, "update_knowledge", {
      expected_etag: RAW_HASH,
      expected_revision: 3,
      id: KNOWLEDGE_ID,
      patch: { rule: "stale edit" },
    });
    expect(toolResult(conflict)).toMatchObject({ isError: true });
    expect(
      UpdateKnowledgeOutputSchema.safeParse(toolStructuredContent(conflict))
        .success,
    ).toBe(true);
    expect(toolStructuredContent(conflict)).toMatchObject({
      error: {
        code: "KNOWLEDGE_CONFLICT",
        details: {
          current_etag: "b".repeat(64),
          current_revision: 4,
        },
        retryable: true,
      },
      ok: false,
    });

    const stale = await callTool(connection.client, "submit_distillation", {
      candidates: [],
      job_id: JOB_ID,
      lease_generation: 1,
      lease_token: "stale-token",
      phase: "extract",
      request_schema_version: 1,
      skip_reason: "typo",
      submission_id: "stale-submission",
      thread_fingerprint: PREFIXED_HASH,
    });
    expect(toolStructuredContent(stale)).toMatchObject({
      error: {
        code: "STALE_LEASE",
        next_action: expect.stringContaining("prepare_distillation"),
        retryable: true,
      },
      ok: false,
    });

    const reused = await callTool(connection.client, "submit_distillation", {
      candidates: [],
      job_id: JOB_ID,
      lease_generation: 1,
      lease_token: "lease-token",
      phase: "extract",
      request_schema_version: 1,
      skip_reason: "typo",
      submission_id: "reused-submission",
      thread_fingerprint: PREFIXED_HASH,
    });
    expect(toolStructuredContent(reused)).toMatchObject({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        next_action: expect.stringContaining("new submission_id"),
        retryable: false,
      },
      ok: false,
    });

    const sourceChanged = await callTool(
      connection.client,
      "submit_distillation",
      {
        candidate_set_sha256: RAW_HASH,
        decisions: [
          {
            candidate_id: "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            relation: "different",
          },
        ],
        finalize_token: "finalize-token",
        job_id: JOB_ID,
        lease_generation: 1,
        lease_token: "lease-token",
        phase: "finalize",
        request_schema_version: 1,
        submission_id: "source-changed-submission",
      },
    );
    expect(toolStructuredContent(sourceChanged)).toMatchObject({
      error: {
        code: "DISTILLATION_SOURCE_CHANGED",
        next_action: expect.stringContaining("prepare_distillation"),
        retryable: true,
      },
      ok: false,
    });

    const unresolved = await connect({
      async resolve() {
        throw new RepositoryResolutionError(
          "REPOSITORY_UNRESOLVED",
          "select a repository",
          { guidance: ["Pass repo"] },
        );
      },
    });
    const resolution = await callTool(unresolved.client, "add_knowledge", {
      category: "architecture",
      detail: "Needs a repo",
      rule: "Needs a repo",
      scope: [],
      severity: "must",
    });
    expect(toolStructuredContent(resolution)).toMatchObject({
      error: {
        code: "REPOSITORY_UNRESOLVED",
        details: { guidance: ["Pass repo"] },
        next_action: "Pass repo",
        retryable: false,
      },
      ok: false,
      summary: {
        counts: { failed_operations: 1 },
        next_action: "Pass repo",
        retryable: false,
      },
    });
  });

  it("maps sync boundary, checkpoint, and lock errors to structured sync_repo errors", async () => {
    const fixture = createMutationFixture();
    fixture.syncRepo
      .mockRejectedValueOnce(
        new SyncRepoError(
          "SYNC_SINCE_BEYOND_CHECKPOINT",
          "--since 2026-08-05T00:00:00.000Z is not strictly older than the stored checkpoint boundary",
        ),
      )
      .mockRejectedValueOnce(
        new SyncCursorError(
          "SYNC_BOUNDARY_CONFLICT",
          "cursor and --since are mutually exclusive boundaries",
        ),
      )
      .mockRejectedValueOnce(
        new SyncRepoError(
          "SYNC_REPOSITORY_MISMATCH",
          "ingester is bound to another repository",
        ),
      )
      .mockRejectedValueOnce(new FileLockTimeoutError("/repo/.sync.lock"));
    const connection = await connect(fixture.resolver);
    const call = async () =>
      callTool(connection.client, "sync_repo", { repo: REPOSITORY });

    const beyond = await call();
    expect(toolResult(beyond)).toMatchObject({ isError: true });
    expect(
      SyncRepoOutputSchema.safeParse(toolStructuredContent(beyond)).success,
    ).toBe(true);
    expect(toolStructuredContent(beyond)).toMatchObject({
      error: {
        code: "SYNC_SINCE_BEYOND_CHECKPOINT",
        next_action: expect.stringContaining("stored checkpoint"),
        retryable: false,
      },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: {
        code: "SYNC_BOUNDARY_CONFLICT",
        next_action: expect.stringContaining("never both"),
        retryable: false,
      },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: { code: "SYNC_REPOSITORY_MISMATCH", retryable: false },
      ok: false,
    });

    expect(toolStructuredContent(await call())).toMatchObject({
      error: {
        code: "LOCK_TIMEOUT",
        next_action: expect.stringContaining("sync lock"),
        retryable: true,
      },
      ok: false,
    });
  });

  it("calls mutation tools over the 2026-07-28 protocol era", async () => {
    const fixture = createMutationFixture();
    const connection = await connect(fixture.resolver, "modern");
    const response = await callTool(
      connection.client,
      "add_knowledge",
      {
        category: "architecture",
        detail: "Modern protocol mutation",
        rule: "Use the same factory",
        scope: [],
        severity: "should",
      },
      connection.parameters,
    );

    expect(
      AddKnowledgeOutputSchema.safeParse(toolStructuredContent(response))
        .success,
    ).toBe(true);
    expect(fixture.addKnowledge).toHaveBeenCalledOnce();
  });
});

interface ConnectOptions {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

interface Connection {
  readonly client: WireClient;
  readonly parameters: McpParameters;
}

async function connect(
  mutationServiceResolver: KnowledgeMutationServiceResolver,
  era: "legacy" | "modern" = "legacy",
  options: ConnectOptions = {},
): Promise<Connection> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new WireClient(clientTransport);
  clients.push(client);
  await client.start();
  const handle = serveRepoKnowledgeStdio({
    logger: { error: vi.fn() },
    mutationServiceResolver,
    readServiceResolver: unavailableReadResolver(),
    ...(options.startupRepo === undefined
      ? {}
      : { startupRepo: options.startupRepo }),
    ...(options.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: options.startupWorkspace }),
    transport: serverTransport,
  });
  handles.push(handle);

  if (era === "legacy") {
    await client.request("initialize", {
      capabilities: {},
      clientInfo: { name: "mutation-test", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    });
    await client.notify("notifications/initialized", {});
    return { client, parameters: (params) => params };
  }

  const parameters = modernParameters();
  await client.request("server/discover", parameters({}));
  return { client, parameters };
}

function unavailableReadResolver(): KnowledgeReadServiceResolver {
  return {
    async resolve() {
      throw new Error("read operation is unavailable in mutation-tool tests");
    },
  };
}

function createMutationFixture(): {
  readonly addKnowledge: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["addKnowledge"]>
  >;
  readonly ingestPullRequest: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["ingestPullRequest"]>
  >;
  readonly prepareDistillation: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["prepareDistillation"]>
  >;
  readonly recordOutcome: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["recordOutcome"]>
  >;
  readonly resolve: ReturnType<
    typeof vi.fn<KnowledgeMutationServiceResolver["resolve"]>
  >;
  readonly resolver: KnowledgeMutationServiceResolver;
  readonly submitExtract: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["submitExtract"]>
  >;
  readonly submitFinalize: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["submitFinalize"]>
  >;
  readonly syncRepo: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["syncRepo"]>
  >;
  readonly updateKnowledge: ReturnType<
    typeof vi.fn<KnowledgeMutationOperations["updateKnowledge"]>
  >;
} {
  const ingestPullRequest = vi.fn<
    KnowledgeMutationOperations["ingestPullRequest"]
  >(async () => ({
    changed_threads: 0,
    distilled: 1,
    jobs_created: 1,
    new_threads: 1,
    pending: 0,
    repo_id: "R_repository",
    snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    unchanged: 0,
    warnings: [],
  }));
  const prepareDistillation = vi.fn<
    KnowledgeMutationOperations["prepareDistillation"]
  >(async () => ({
    instructions: ["Enable both host-assisted settings to expose content."],
    jobs: [
      {
        job_id: JOB_ID,
        lease_generation: 0,
        state: "pending",
        thread_id: "thread-1",
        updated_at: "2026-08-06T00:00:00.000Z",
      },
    ],
    missing_settings: [
      "hostAssistedDistillation.enabled",
      "hostAssistedDistillation.allowReviewContentTransmission",
    ],
    required_settings: {
      "hostAssistedDistillation.allowReviewContentTransmission": true,
      "hostAssistedDistillation.enabled": true,
    },
    state: "disabled",
  }));
  const submitExtract = vi.fn<KnowledgeMutationOperations["submitExtract"]>(
    async () => ({
      skip_reason: "typo",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    }),
  );
  const submitFinalize = vi.fn<KnowledgeMutationOperations["submitFinalize"]>(
    async () => ({
      accepted: true,
      created_active: [],
      created_proposed: [KNOWLEDGE_ID],
      merged_evidence: [],
      revision_proposals: [],
    }),
  );
  const addKnowledge = vi.fn<KnowledgeMutationOperations["addKnowledge"]>(
    async () => ({
      etag: RAW_HASH,
      id: KNOWLEDGE_ID,
      origin: "manual",
      repo: REPOSITORY,
      revision: 1,
      status: "proposed",
    }),
  );
  const updateKnowledge = vi.fn<KnowledgeMutationOperations["updateKnowledge"]>(
    async () => ({
      current_etag: RAW_HASH,
      current_revision: 3,
      knowledge_id: KNOWLEDGE_ID,
      proposal_id: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repo: REPOSITORY,
      status: "pending",
    }),
  );
  const recordOutcome = vi.fn<KnowledgeMutationOperations["recordOutcome"]>(
    async () => ({
      applied_count: 1,
      event_id: EVENT_ID,
      knowledge_id: KNOWLEDGE_ID,
      outcome: "applied",
      replayed: false,
      violation_count: 0,
    }),
  );
  const syncRepo = vi.fn<KnowledgeMutationOperations["syncRepo"]>(async () => ({
    discovered: 2,
    failed: 0,
    failures: [],
    ingested: 1,
    jobs_created: 1,
    next_cursor: {
      last_pr_number: 42,
      last_updated_at: "2026-08-06T00:00:00.000Z",
      repo_id: "R_repository",
      version: 1,
    },
    unchanged: 1,
  }));
  const operations: KnowledgeMutationOperations = {
    addKnowledge,
    ingestPullRequest,
    prepareDistillation,
    recordOutcome,
    submitExtract,
    submitFinalize,
    syncRepo,
    updateKnowledge,
  };
  const resolve = vi.fn<KnowledgeMutationServiceResolver["resolve"]>(
    async () => operations,
  );
  return {
    addKnowledge,
    ingestPullRequest,
    prepareDistillation,
    recordOutcome,
    resolve,
    resolver: { resolve },
    submitExtract,
    submitFinalize,
    syncRepo,
    updateKnowledge,
  };
}

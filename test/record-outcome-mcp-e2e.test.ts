import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  GetKnowledgeOutputSchema,
  GetRulesOutputSchema,
  RecordOutcomeOutputSchema,
  RepositoryRegistry,
  SearchKnowledgeOutputSchema,
  StatsOutputSchema,
  deriveOutcomeEventId,
  serializeKnowledgeDocument,
  type KnowledgeStatus,
} from "../src/index.js";

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

interface JsonRpcReply {
  readonly error?: unknown;
  readonly id?: number;
  readonly result?: unknown;
}

interface OutcomeEnvironment {
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

/** Drives the packaged stdio server with a newline-delimited JSON-RPC client. */
async function runServe(
  environment: OutcomeEnvironment,
  calls: readonly Record<string, unknown>[],
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
  const result = await execa(process.execPath, ["dist/bin.js", "serve"], {
    cwd: process.cwd(),
    env: environment.env,
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    reject: false,
  });
  expect(result.stderr).toBe("");
  const replies = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcReply);
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
  };
}

async function writeKnowledge(
  repositoryRoot: string,
  id: string,
  status: KnowledgeStatus,
  repoId: string,
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
    id: ${JSON.stringify(REPO_ID)},
    nameWithOwner: ${JSON.stringify(REPOSITORY)},
  },
};
process.stdout.write(JSON.stringify({ data }) + "\\n");
`;
}

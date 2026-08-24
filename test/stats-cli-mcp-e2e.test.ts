import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  StatsOutputSchema,
  SyncCheckpointStore,
  createDomainId,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistillJob,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const REPO_ID = "R_stats_e2e_repository";
const NOW = "2026-08-05T00:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const WINDOW = {
  bucket: "day",
  since: "2026-08-01T00:00:00.000Z",
  until: "2026-08-03T00:00:00.000Z",
} as const;
const E2E_TIMEOUT_MS = 120_000;

interface JsonRpcReply {
  readonly error?: unknown;
  readonly id?: number;
  readonly result?: unknown;
}

interface StatsEnvironment {
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

describe("stats CLI and MCP E2E over a real CLI process and stdio client", () => {
  it("returns one identical versioned aggregation from CLI and MCP without touching canonical data", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createStatsEnvironment();

    // 1. An empty just-resolved repository is a normal zero-stats success.
    const empty = await runCliStats(environment, []);
    expect(empty.exitCode).toBe(0);
    expect(empty.stderr).toBe("");
    const emptyStats = StatsOutputSchema.parse(JSON.parse(empty.stdout));
    expect(emptyStats).toMatchObject({
      evidence: { total: 0 },
      jobs: { total: 0 },
      knowledge: { total: 0 },
      outcomes: { total: 0 },
      repo: REPOSITORY,
      stats_schema_version: 1,
      sync: { last_checkpoint: null },
      window: { bucket: "total", since: null, timezone: "UTC", until: null },
    });

    // 2. Fixed canonical fixture written directly into the resolved store.
    const repositoryDir = await repositoryDirectory(environment);
    await writeFixedFixture(repositoryDir);
    const digestBefore = await readCanonicalDigest(repositoryDir);

    // 3. The CLI prints exactly one machine-readable JSON document.
    const cli = await runCliStats(environment, [
      "--bucket",
      WINDOW.bucket,
      "--since",
      WINDOW.since,
      "--until",
      WINDOW.until,
    ]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe("");
    expect(cli.stdout.trim().split("\n")).toHaveLength(1);
    const cliStats = StatsOutputSchema.parse(JSON.parse(cli.stdout));
    expect(cliStats).toMatchObject({
      evidence: { total: 3 },
      knowledge: { total: 2 },
      outcomes: { total: 2 },
      stats_schema_version: 1,
      sync: { last_checkpoint: { last_pr_number: 41 } },
      window: { ...WINDOW, timezone: "UTC" },
    });
    expect(cliStats.buckets?.map((bucket) => bucket.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);

    // 4. The real stdio client lists and calls the same read-only tool.
    const replies = await runMcpStats(environment, {
      repo: REPOSITORY,
      ...WINDOW,
    });
    const listReply = replies.find((reply) => reply.id === 2);
    const toolNames = readToolNames(listReply);
    expect(toolNames).toContain("stats");
    const statsTool = readTools(listReply).find(
      (tool) => asRecord(tool).name === "stats",
    );
    expect(asRecord(asRecord(statsTool).annotations)).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
    const callReply = replies.find((reply) => reply.id === 3);
    expect(callReply).toBeDefined();
    expect(callReply).not.toHaveProperty("error");
    const result = callReply!.result as {
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
    };
    expect(result.isError).not.toBe(true);
    const mcpStats = StatsOutputSchema.parse(result.structuredContent);

    // Identical schema version and identical aggregates across surfaces.
    expect(mcpStats).toEqual(cliStats);

    // 5. Both read paths left the canonical state byte-identical.
    await expect(readCanonicalDigest(repositoryDir)).resolves.toBe(
      digestBefore,
    );

    // 6. A window with no observations is normal zero stats, while
    //    point-in-time sections keep reporting the current state.
    const outside = await runCliStats(environment, [
      "--since",
      "2020-01-01T00:00:00.000Z",
      "--until",
      "2021-01-01T00:00:00.000Z",
    ]);
    expect(outside.exitCode).toBe(0);
    const outsideStats = StatsOutputSchema.parse(JSON.parse(outside.stdout));
    expect(outsideStats.evidence.total).toBe(0);
    expect(outsideStats.outcomes.total).toBe(0);
    expect(outsideStats.knowledge.total).toBe(2);
    expect(outsideStats.jobs.total).toBe(2);
  });

  it("rejects an invalid window as a usage error without partial output", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createStatsEnvironment();

    const rejected = await runCliStats(environment, [
      "--bucket",
      "day",
      "--since",
      WINDOW.since,
    ]);

    expect(rejected.exitCode).toBe(2);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("STATS_WINDOW_REQUIRED");
  });
});

async function createStatsEnvironment(): Promise<StatsEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "rkm-stats-e2e-"));
  temporaryDirectories.push(root);
  const storageRoot = join(root, "home");
  const binDirectory = join(root, "bin");
  await mkdir(storageRoot, { mode: 0o700, recursive: true });
  await mkdir(binDirectory, { recursive: true });
  const ghPath = join(binDirectory, "gh");
  await writeFile(ghPath, fakeGhSource(), "utf8");
  await chmod(ghPath, 0o755);
  return {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      REPO_KNOWLEDGE_HOME: storageRoot,
    },
    storageRoot,
  };
}

async function runCliStats(
  environment: StatsEnvironment,
  extraArguments: readonly string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const result = await execa(
    process.execPath,
    ["dist/bin.js", "stats", REPOSITORY, ...extraArguments],
    { cwd: process.cwd(), env: environment.env, reject: false },
  );
  return {
    exitCode: result.exitCode ?? -1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/** Drives the packaged stdio server with a newline-delimited JSON-RPC client. */
async function runMcpStats(
  environment: StatsEnvironment,
  toolArguments: Record<string, unknown>,
): Promise<JsonRpcReply[]> {
  const messages = [
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "stats-e2e", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: toolArguments, name: "stats" },
    },
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
  // Every stdout frame must remain valid JSON-RPC while stats runs.
  expect(replies.every((reply) => "id" in reply || "method" in reply)).toBe(
    true,
  );
  return replies;
}

async function repositoryDirectory(
  environment: StatsEnvironment,
): Promise<string> {
  const reposRoot = join(environment.storageRoot, "repos");
  const entries = await readdir(reposRoot);
  expect(entries).toHaveLength(1);
  return join(reposRoot, entries[0]!);
}

async function readCanonicalDigest(repositoryDir: string): Promise<string> {
  const snapshot = await new CanonicalTransactionStore(
    repositoryDir,
  ).readSnapshot();
  return snapshot.canonicalDigest;
}

async function writeFixedFixture(repositoryDir: string): Promise<void> {
  const knowledgeId = await writeKnowledge(repositoryDir, {
    rule: "Active security must rule",
    status: "active",
  });
  await writeKnowledge(repositoryDir, {
    rule: "Proposed style rule",
    status: "proposed",
  });
  const records: readonly CanonicalJsonlRecord[] = [
    canonicalRecord(
      "EvidenceCreated",
      evidence(knowledgeId, "2026-08-01T09:00:00.000Z", "human", "thread-1"),
    ),
    canonicalRecord(
      "EvidenceCreated",
      evidence(knowledgeId, "2026-08-02T09:00:00.000Z", "devin", "thread-2"),
    ),
    canonicalRecord(
      "EvidenceCreated",
      evidence(knowledgeId, "2026-08-02T10:00:00.000Z", "greptile", "thread-3"),
    ),
    canonicalRecord(
      "OutcomeRecorded",
      outcome(knowledgeId, "applied", "2026-08-01T10:00:00.000Z"),
    ),
    canonicalRecord(
      "OutcomeRecorded",
      outcome(knowledgeId, "violated", "2026-08-02T10:00:00.000Z"),
    ),
    canonicalRecord("DistillJob", job("pending")),
    canonicalRecord("DistillJob", job("failed")),
  ];
  await mkdir(join(repositoryDir, "events"), { recursive: true });
  await writeFile(
    join(repositoryDir, "events", "stats-e2e.jsonl"),
    Buffer.concat(
      records.map((record) => serializeCanonicalJsonlRecord(record)),
    ),
  );
  await new SyncCheckpointStore(repositoryDir).write({
    cursor: {
      last_pr_number: 41,
      last_updated_at: "2026-08-04T10:00:00.000Z",
      repo_id: REPO_ID,
      version: 1,
    },
    schema_version: 1,
    updated_at: "2026-08-04T10:00:05.000Z",
  });
}

async function writeKnowledge(
  repositoryDir: string,
  input: { readonly rule: string; readonly status: "active" | "proposed" },
): Promise<string> {
  const id = createDomainId("knowledge");
  const relativePath = `knowledge/${id}.md`;
  await mkdir(join(repositoryDir, "knowledge"), { recursive: true });
  await writeFile(
    join(repositoryDir, relativePath),
    serializeKnowledgeDocument(
      relativePath,
      {
        category: "security",
        created_at: NOW,
        id,
        repo_id: REPO_ID,
        revision: 1,
        rule: input.rule,
        schema_version: 1,
        scope: ["src/**"],
        severity: "must",
        status: input.status,
        updated_at: NOW,
      },
      "Stats E2E detail.\n",
    ),
  );
  return id;
}

function evidence(
  knowledgeId: string,
  observedAt: string,
  source: "devin" | "greptile" | "human",
  threadId: string,
): KnowledgeEvidence {
  const actor = {
    actor_kind: "user" as const,
    comment_id: `comment-${threadId}`,
    login: "alice",
    provider: source,
    trust: "trusted" as const,
  };
  return {
    actors: [actor],
    comment_ids: [actor.comment_id],
    content_fingerprint: HASH_A,
    eligible_for_count: true,
    evidence_id: createDomainId("evidence"),
    knowledge_id: knowledgeId,
    observed_at: observedAt,
    occurrence_key: `${knowledgeId}:${threadId}`,
    originator: actor,
    pr_number: 1,
    repo_id: REPO_ID,
    sources: [source],
    state_fingerprint: HASH_B,
    status: "active",
    thread_id: threadId,
  };
}

function outcome(
  knowledgeId: string,
  value: KnowledgeOutcome["outcome"],
  at: string,
): KnowledgeOutcome {
  return { at, knowledge_id: knowledgeId, outcome: value, repo_id: REPO_ID };
}

function job(state: "failed" | "pending"): DistillJob {
  const jobId = createDomainId("job");
  return {
    attempts: state === "pending" ? 0 : 1,
    distillation_key: HASH_A,
    job_id: jobId,
    ...(state === "failed" ? { last_error: "distillation failed" } : {}),
    lease_generation: 0,
    repo_id: REPO_ID,
    state,
    thread_id: `thread-${jobId}`,
    updated_at: NOW,
    validation_failures: 0,
  };
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    recorded_at: NOW,
    record_id: createDomainId("event"),
    record_type: recordType,
    schema_version: 1,
    transaction_id: createDomainId("transaction"),
  };
}

function readTools(reply: JsonRpcReply | undefined): readonly unknown[] {
  const tools = asRecord(reply?.result).tools;
  if (!Array.isArray(tools)) throw new TypeError("tools/list failed");
  return tools;
}

function readToolNames(reply: JsonRpcReply | undefined): readonly string[] {
  return readTools(reply).map((tool) => String(asRecord(tool).name));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

/**
 * Deterministic `gh` stand-in: stats only needs repository resolution, so any
 * other GraphQL operation fails the test loudly instead of hitting the
 * network.
 */
function fakeGhSource(): string {
  const fixture = { repoId: REPO_ID, repository: REPOSITORY };
  return `#!/usr/bin/env node
const FIXTURE = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "graphql") {
  process.stderr.write("fake gh: unsupported invocation\\n");
  process.exit(1);
}
let query = "";
for (let index = 2; index < args.length; index += 1) {
  const flag = args[index];
  if (flag !== "-f" && flag !== "-F") continue;
  const pair = args[index + 1] ?? "";
  index += 1;
  const equals = pair.indexOf("=");
  if (pair.slice(0, equals) === "query") query = pair.slice(equals + 1);
}
if (!query.includes("query ResolveRepository")) {
  process.stderr.write("fake gh: unsupported query\\n");
  process.exit(1);
}
const data = {
  repository: { id: FIXTURE.repoId, nameWithOwner: FIXTURE.repository },
};
process.stdout.write(JSON.stringify({ data }) + "\\n");
`;
}

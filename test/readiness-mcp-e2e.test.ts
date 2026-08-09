import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  GetRulesOutputSchema,
  RepositoryRegistry,
  SyncCheckpointStore,
  createDomainId,
  serializeCanonicalJsonlRecord,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistillJob,
  type KnowledgeStatus,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const REPO_ID = "R_readiness_e2e_repository";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = "2026-08-09T00:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;
const temporaryDirectories: string[] = [];

interface ReadinessEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly repositoryRoot: string;
}

type ParsedGetRulesOutput = ReturnType<(typeof GetRulesOutputSchema)["parse"]>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repository readiness MCP E2E", () => {
  it(
    "distinguishes setup, learning, normal mismatch, and synchronized empty states",
    { timeout: 120_000 },
    async () => {
      const environment = await createEnvironment();

      const initial = await getRules(environment);
      expect(initial.output).toMatchObject({
        matched_count: 0,
        readiness: {
          next_action: expect.stringContaining(
            `repo-knowledge setup ${REPOSITORY}`,
          ),
          state: "setup_required",
        },
        rules: [],
      });
      expect(initial.summary).toContain("Readiness: **setup_required**");

      await writeJobs(environment.repositoryRoot, [pendingJob()]);
      const learning = await getRules(environment);
      expect(learning.output.readiness).toMatchObject({
        next_action: expect.stringContaining(
          `repo-knowledge distill ${REPOSITORY}`,
        ),
        state: "learning",
      });
      expect(learning.output.readiness.next_action).toContain("llm.mode");
      expect(learning.output.readiness.next_action).toContain(
        "hostAssistedDistillation.enabled",
      );

      await writeKnowledge(environment.repositoryRoot, "active");
      const mismatch = await getRules(environment);
      expect(mismatch.output).toMatchObject({
        matched_count: 0,
        readiness: { state: "ready" },
        rules: [],
      });

      await writeJobs(environment.repositoryRoot, []);
      await writeKnowledge(environment.repositoryRoot, "rejected");
      await new SyncCheckpointStore(environment.repositoryRoot).write({
        cursor: {
          last_pr_number: 7,
          last_updated_at: NOW,
          repo_id: REPO_ID,
          version: 1,
        },
        schema_version: 1,
        updated_at: NOW,
      });
      const empty = await getRules(environment);
      expect(empty.output).toMatchObject({
        matched_count: 0,
        readiness: {
          next_action: expect.stringContaining(
            `repo-knowledge sync ${REPOSITORY}`,
          ),
          state: "empty",
        },
        rules: [],
      });
    },
  );
});

async function createEnvironment(): Promise<ReadinessEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "rkm-readiness-e2e-"));
  temporaryDirectories.push(root);
  const storageRoot = join(root, "home");
  const binDirectory = join(root, "bin");
  await mkdir(storageRoot, { mode: 0o700, recursive: true });
  await mkdir(binDirectory, { recursive: true });
  const ghPath = join(binDirectory, "gh");
  await writeFile(ghPath, fakeGhSource(), "utf8");
  await chmod(ghPath, 0o755);
  const repository = await new RepositoryRegistry(storageRoot).register({
    currentName: REPOSITORY,
    repoId: REPO_ID,
  });
  await mkdir(join(repository.absolutePath, "events"), { recursive: true });
  await mkdir(join(repository.absolutePath, "knowledge"), { recursive: true });
  return {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      REPO_KNOWLEDGE_HOME: storageRoot,
    },
    repositoryRoot: repository.absolutePath,
  };
}

async function getRules(environment: ReadinessEnvironment): Promise<{
  readonly output: ParsedGetRulesOutput;
  readonly summary: string;
}> {
  const messages = [
    request(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "readiness-e2e", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    }),
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    request(2, "tools/call", {
      arguments: {
        file_paths: ["frontend/view.ts"],
        repo: REPOSITORY,
        task: "render a frontend view",
      },
      name: "get_rules",
    }),
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
  const reply = replies.find((candidate) => candidate.id === 2);
  expect(reply).toBeDefined();
  expect(reply).not.toHaveProperty("error");
  const toolResult = reply!.result as {
    readonly content?: readonly {
      readonly text?: unknown;
      readonly type?: unknown;
    }[];
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
  };
  expect(toolResult.isError).not.toBe(true);
  const text = toolResult.content?.find((item) => item.type === "text")?.text;
  expect(typeof text).toBe("string");
  return {
    output: GetRulesOutputSchema.parse(toolResult.structuredContent),
    summary: text as string,
  };
}

interface JsonRpcReply {
  readonly error?: unknown;
  readonly id?: number;
  readonly result?: unknown;
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return { id, jsonrpc: "2.0", method, params };
}

async function writeJobs(
  repositoryRoot: string,
  jobs: readonly DistillJob[],
): Promise<void> {
  await writeFile(
    join(repositoryRoot, "events", "readiness.jsonl"),
    Buffer.concat(
      jobs.map((job) =>
        serializeCanonicalJsonlRecord(canonicalRecord("DistillJob", job)),
      ),
    ),
  );
}

async function writeKnowledge(
  repositoryRoot: string,
  status: KnowledgeStatus,
): Promise<void> {
  const path = `knowledge/${KNOWLEDGE_ID}.md`;
  await writeFile(
    join(repositoryRoot, path),
    serializeKnowledgeDocument(
      path,
      {
        category: "architecture",
        created_at: NOW,
        id: KNOWLEDGE_ID,
        repo_id: REPO_ID,
        revision: 1,
        rule: "Keep backend boundaries explicit",
        schema_version: 1,
        scope: ["backend/**"],
        severity: "should",
        status,
        updated_at: NOW,
      },
      "Readiness E2E fixture detail.\n",
    ),
  );
}

function pendingJob(): DistillJob {
  const jobId = createDomainId("job");
  return {
    attempts: 0,
    distillation_key: HASH,
    job_id: jobId,
    lease_generation: 0,
    repo_id: REPO_ID,
    state: "pending",
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

function fakeGhSource(): string {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "graphql") process.exit(1);
const query = args.find((value) => value.startsWith("query=")) ?? "";
if (!query.includes("query ResolveRepository")) process.exit(1);
process.stdout.write(JSON.stringify({
  data: { repository: { id: ${JSON.stringify(REPO_ID)}, nameWithOwner: ${JSON.stringify(REPOSITORY)} } },
}) + "\\n");
`;
}

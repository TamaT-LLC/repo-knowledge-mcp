import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GetKnowledgeOutputSchema,
  GetRulesOutputSchema,
  REPO_KNOWLEDGE_SERVER_INSTRUCTIONS,
  SearchKnowledgeOutputSchema,
  serveRepoKnowledgeStdio,
  type KnowledgeMutationServiceResolver,
  type KnowledgeReadOperations,
  type KnowledgeReadServiceResolver,
} from "../src/index.js";
import {
  WireClient,
  asRecord,
  callTool,
  modernParameters,
  readTools,
  toolResult,
  toolStructuredContent,
  toolText,
  type JsonRpcReply,
  type McpParameters,
} from "./support/mcp-test-client.js";

const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY = "owner/repository";
const handles: Array<{ close(): Promise<void> }> = [];
const clients: WireClient[] = [];
const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(
    temporaryHomes
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repo-knowledge MCP read server", () => {
  it("lists and calls all read tools over a 2025-era initialize connection", async () => {
    const fixture = createReadFixture();
    const connection = await connect("legacy", fixture.resolver, {
      startupRepo: "startup/repository",
      startupWorkspace: "/workspace/startup",
    });

    expect(connection.initializeResult).toMatchObject({
      instructions: REPO_KNOWLEDGE_SERVER_INSTRUCTIONS,
      serverInfo: { name: "repo-knowledge", version: "0.1.0" },
    });

    const listed = await connection.client.request("tools/list", {});
    const tools = readTools(listed).filter((tool) =>
      ["get_rules", "search_knowledge", "get_knowledge"].includes(tool.name),
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "get_rules",
      "search_knowledge",
      "get_knowledge",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      });
      expect(tool.inputSchema).toMatchObject({
        additionalProperties: false,
        type: "object",
      });
      expect(tool.outputSchema).toMatchObject({
        additionalProperties: false,
        type: "object",
      });
    }

    const rulesCall = await callTool(connection.client, "get_rules", {
      file_paths: ["src/index.ts"],
      limit: 5,
      repo: REPOSITORY,
      task: "add a safe MCP entry",
    });
    const rules = toolStructuredContent(rulesCall);
    expect(GetRulesOutputSchema.safeParse(rules).success).toBe(true);
    expect(toolText(rulesCall)).toContain("Found **1** active rule");
    expect(toolText(rulesCall)).not.toContain("Always validate schemas");
    expect(fixture.getRules).toHaveBeenCalledWith({
      filePaths: ["src/index.ts"],
      limit: 5,
      task: "add a safe MCP entry",
    });
    expect(fixture.resolve).toHaveBeenLastCalledWith({
      repo: REPOSITORY,
      startupRepo: "startup/repository",
      startupWorkspace: "/workspace/startup",
    });

    const searchCall = await callTool(connection.client, "search_knowledge", {
      category: "architecture",
      limit: 3,
      query: "MCP server",
      workspace_path: "/workspace/tool",
    });
    const search = toolStructuredContent(searchCall);
    expect(SearchKnowledgeOutputSchema.safeParse(search).success).toBe(true);
    expect(toolText(searchCall)).toContain("Found **1** active result");
    expect(toolText(searchCall)).not.toContain("Detailed implementation data");
    expect(fixture.searchKnowledge).toHaveBeenCalledWith({
      category: "architecture",
      limit: 3,
      query: "MCP server",
    });
    expect(fixture.resolve).toHaveBeenLastCalledWith({
      startupRepo: "startup/repository",
      startupWorkspace: "/workspace/startup",
      workspacePath: "/workspace/tool",
    });

    const knowledgeCall = await callTool(connection.client, "get_knowledge", {
      evidence_limit: 7,
      id: KNOWLEDGE_ID,
    });
    const knowledge = toolStructuredContent(knowledgeCall);
    expect(GetKnowledgeOutputSchema.safeParse(knowledge).success).toBe(true);
    expect(toolText(knowledgeCall)).toContain(`Loaded \`${KNOWLEDGE_ID}\``);
    expect(toolText(knowledgeCall)).not.toContain(
      "Detailed implementation data",
    );
    expect(fixture.getKnowledge).toHaveBeenCalledWith({
      evidenceLimit: 7,
      id: KNOWLEDGE_ID,
    });
  });

  it("serves the same registrations and calls over a 2026-07-28 connection", async () => {
    const legacyFixture = createReadFixture();
    const modernFixture = createReadFixture();
    const legacy = await connect("legacy", legacyFixture.resolver);
    const modern = await connect("modern", modernFixture.resolver);

    const legacyTools = readTools(
      await legacy.client.request("tools/list", {}),
    );
    const modernTools = readTools(
      await modern.client.request("tools/list", modern.parameters({})),
    );
    expect(modernTools).toEqual(legacyTools);

    const response = await callTool(
      modern.client,
      "get_rules",
      { file_paths: ["src/mcp-server.ts"] },
      modern.parameters,
    );
    expect(
      GetRulesOutputSchema.safeParse(toolStructuredContent(response)).success,
    ).toBe(true);
    expect(modernFixture.getRules).toHaveBeenCalledWith({
      filePaths: ["src/mcp-server.ts"],
    });
  });

  it("keeps status out of read schemas and does not treat annotations as authorization", async () => {
    const fixture = createReadFixture();
    const connection = await connect("legacy", fixture.resolver);
    const tools = readTools(await connection.client.request("tools/list", {}));

    for (const name of ["get_rules", "search_knowledge"] as const) {
      const tool = tools.find((candidate) => candidate.name === name);
      const properties = asRecord(asRecord(tool?.inputSchema).properties);
      expect(properties).not.toHaveProperty("status");
    }

    const rejected = await callTool(connection.client, "search_knowledge", {
      query: "rules",
      status: "proposed",
    });
    expect(toolResult(rejected)).toMatchObject({ isError: true });
    expect(fixture.resolve).not.toHaveBeenCalled();

    const accepted = await callTool(connection.client, "search_knowledge", {
      query: "rules",
    });
    expect(toolResult(accepted)).not.toHaveProperty("isError", true);
    expect(fixture.resolve).toHaveBeenCalledOnce();
  });

  it("writes pino logs to stderr without contaminating stdout", async () => {
    const result = await execa(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { createStderrLogger } from "./dist/mcp-server.js"; createStderrLogger().info("stderr-only-marker");',
      ],
      { cwd: process.cwd() },
    );

    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      msg: "stderr-only-marker",
      name: "repo-knowledge",
    });
  });

  it("starts the packaged stdio bin with JSON-RPC-only stdout", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "rkm-stdio-bin-"));
    temporaryHomes.push(storageRoot);
    const messages = [
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "stdio-bin-test", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { pr_number: 1, repo: REPOSITORY },
          name: "ingest_pr",
        },
      },
    ];
    const result = await execa(process.execPath, ["dist/stdio-bin.js"], {
      cwd: process.cwd(),
      env: { ...process.env, REPO_KNOWLEDGE_HOME: storageRoot },
      input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    });

    expect(result.stderr).toBe("");
    const replies = result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JsonRpcReply);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "repo-knowledge" } },
    });
    expect(readTools(replies[1]!).map((tool) => tool.name)).toEqual([
      "get_rules",
      "search_knowledge",
      "get_knowledge",
      "ingest_pr",
      "sync_repo",
      "prepare_distillation",
      "submit_distillation",
      "add_knowledge",
      "update_knowledge",
    ]);
    expect(replies[2]).toMatchObject({
      id: 3,
      result: {
        isError: true,
        structuredContent: {
          error: { code: "MUTATION_RUNTIME_UNAVAILABLE" },
          ok: false,
        },
      },
    });
  });
});

interface ConnectOptions {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

interface Connection {
  readonly client: WireClient;
  readonly initializeResult?: Record<string, unknown>;
  readonly parameters: McpParameters;
}

async function connect(
  era: "legacy" | "modern",
  resolver: KnowledgeReadServiceResolver,
  options: ConnectOptions = {},
): Promise<Connection> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new WireClient(clientTransport);
  clients.push(client);
  await client.start();

  const errors: Error[] = [];
  const handle = serveRepoKnowledgeStdio({
    logger: {
      error(bindings) {
        const error = asRecord(bindings).err;
        errors.push(error instanceof Error ? error : new Error(String(error)));
      },
    },
    mutationServiceResolver: unavailableMutationResolver(),
    readServiceResolver: resolver,
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
    const response = await client.request("initialize", {
      capabilities: {},
      clientInfo: { name: "repo-knowledge-test", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    });
    await client.notify("notifications/initialized", {});
    expect(errors).toEqual([]);
    return {
      client,
      initializeResult: asRecord(response.result),
      parameters: (params) => params,
    };
  }

  const parameters = modernParameters();
  const discovery = await client.request("server/discover", parameters({}));
  expect(discovery).not.toHaveProperty("error");
  expect(asRecord(discovery.result).supportedVersions).toContain("2026-07-28");
  expect(errors).toEqual([]);
  return { client, parameters };
}

function unavailableMutationResolver(): KnowledgeMutationServiceResolver {
  const unavailable = async (): Promise<never> => {
    throw new Error("mutation operation is unavailable in read-server tests");
  };
  return {
    async resolve() {
      return {
        addKnowledge: unavailable,
        ingestPullRequest: unavailable,
        prepareDistillation: unavailable,
        submitExtract: unavailable,
        submitFinalize: unavailable,
        syncRepo: unavailable,
        updateKnowledge: unavailable,
      };
    },
  };
}

function createReadFixture(): {
  readonly getKnowledge: ReturnType<
    typeof vi.fn<KnowledgeReadOperations["getKnowledge"]>
  >;
  readonly getRules: ReturnType<
    typeof vi.fn<KnowledgeReadOperations["getRules"]>
  >;
  readonly resolve: ReturnType<
    typeof vi.fn<KnowledgeReadServiceResolver["resolve"]>
  >;
  readonly resolver: KnowledgeReadServiceResolver;
  readonly searchKnowledge: ReturnType<
    typeof vi.fn<KnowledgeReadOperations["searchKnowledge"]>
  >;
} {
  const getRules = vi.fn<KnowledgeReadOperations["getRules"]>(async () => ({
    matched_count: 1,
    repo: REPOSITORY,
    rules: [
      {
        evidence_count: 2,
        id: KNOWLEDGE_ID,
        match_reasons: [{ type: "global" }],
        rule: "Always validate schemas",
        severity: "must",
        violation_count: 1,
      },
    ],
    truncated: false,
  }));
  const searchKnowledge = vi.fn<KnowledgeReadOperations["searchKnowledge"]>(
    async (request) => ({
      mode: "fts",
      query: request.query,
      repo: REPOSITORY,
      results: [
        {
          applied_count: 3,
          category: "architecture",
          detail: "Detailed implementation data",
          etag: "etag-value",
          evidence_count: 2,
          id: KNOWLEDGE_ID,
          revision: 4,
          rule: "Always validate schemas",
          scope: ["src/**"],
          score: 1.25,
          severity: "must",
          sources: ["human"],
          violation_count: 1,
        },
      ],
    }),
  );
  const getKnowledge = vi.fn<KnowledgeReadOperations["getKnowledge"]>(
    async (request) => ({
      evidence: [],
      knowledge: {
        applied_count: 3,
        detail: "Detailed implementation data",
        etag: "etag-value",
        evidence_count: 2,
        frontmatter: {
          category: "architecture",
          id: request.id,
          repo_id: "R_repository",
          revision: 4,
          schema_version: 1,
          status: "active",
        },
        id: request.id,
        revision: 4,
        sources: ["human"],
        violation_count: 1,
      },
      next_cursor: null,
      repo: REPOSITORY,
    }),
  );
  const operations: KnowledgeReadOperations = {
    getKnowledge,
    getRules,
    searchKnowledge,
  };
  const resolve = vi.fn<KnowledgeReadServiceResolver["resolve"]>(
    async () => operations,
  );
  return {
    getKnowledge,
    getRules,
    resolve,
    resolver: { resolve },
    searchKnowledge,
  };
}

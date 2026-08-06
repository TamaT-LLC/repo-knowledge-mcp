import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GetKnowledgeOutputSchema,
  GetRulesOutputSchema,
  REPO_KNOWLEDGE_SERVER_INSTRUCTIONS,
  SearchKnowledgeOutputSchema,
  serveRepoKnowledgeStdio,
  type KnowledgeReadOperations,
  type KnowledgeReadServiceResolver,
} from "../src/index.js";

const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY = "owner/repository";
const handles: Array<{ close(): Promise<void> }> = [];
const clients: WireClient[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
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
    const tools = readTools(listed);
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
});

interface ConnectOptions {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

interface Connection {
  readonly client: WireClient;
  readonly initializeResult?: Record<string, unknown>;
  readonly parameters: (
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
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

function modernParameters(): Connection["parameters"] {
  return (params) => ({
    ...params,
    _meta: {
      [CLIENT_CAPABILITIES_META_KEY]: {},
      [CLIENT_INFO_META_KEY]: {
        name: "repo-knowledge-modern-test",
        version: "1.0.0",
      },
      [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    },
  });
}

async function callTool(
  client: WireClient,
  name: string,
  toolArguments: Record<string, unknown>,
  parameters: Connection["parameters"] = (params) => params,
): Promise<JsonRpcReply> {
  return client.request(
    "tools/call",
    parameters({ arguments: toolArguments, name }),
  );
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

interface JsonRpcReply {
  readonly error?: unknown;
  readonly id: number | string;
  readonly result?: unknown;
}

class WireClient {
  private nextId = 0;
  private readonly pending = new Map<
    number | string,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (reply: JsonRpcReply) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly transport: InMemoryTransport) {
    this.transport.onmessage = (message) => {
      const reply = message as JsonRpcReply;
      if (!("id" in reply)) return;
      const pending = this.pending.get(reply.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      pending.resolve(reply);
    };
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP test client closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.transport.send({
      jsonrpc: "2.0",
      method,
      params,
    } as JSONRPCMessage);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcReply> {
    const id = ++this.nextId;
    const response = new Promise<JsonRpcReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 2_000);
      this.pending.set(id, { reject, resolve, timer });
    });
    await this.transport.send({
      id,
      jsonrpc: "2.0",
      method,
      params,
    } as JSONRPCMessage);
    return response;
  }
}

interface ListedTool {
  readonly annotations: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
  readonly name: string;
  readonly outputSchema: Record<string, unknown>;
}

function readTools(reply: JsonRpcReply): ListedTool[] {
  const tools = asRecord(reply.result).tools;
  if (!Array.isArray(tools))
    throw new TypeError("tools/list returned no tools");
  return tools.map((tool) => asRecord(tool) as unknown as ListedTool);
}

function toolResult(reply: JsonRpcReply): Record<string, unknown> {
  return asRecord(reply.result);
}

function toolStructuredContent(reply: JsonRpcReply): unknown {
  return toolResult(reply).structuredContent;
}

function toolText(reply: JsonRpcReply): string {
  const content = toolResult(reply).content;
  if (!Array.isArray(content)) throw new TypeError("tool returned no content");
  const first = asRecord(content[0]);
  if (typeof first.text !== "string") {
    throw new TypeError("tool returned no text content");
  }
  return first.text;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

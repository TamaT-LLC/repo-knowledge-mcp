import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";

export interface JsonRpcReply {
  readonly error?: unknown;
  readonly id: number | string;
  readonly result?: unknown;
}

export type McpParameters = (
  params: Record<string, unknown>,
) => Record<string, unknown>;

export class WireClient {
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

export interface ListedTool {
  readonly annotations: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
  readonly name: string;
  readonly outputSchema: Record<string, unknown>;
}

export function readTools(reply: JsonRpcReply): ListedTool[] {
  const tools = asRecord(reply.result).tools;
  if (!Array.isArray(tools)) {
    throw new TypeError("tools/list returned no tools");
  }
  return tools.map((tool) => asRecord(tool) as unknown as ListedTool);
}

export async function callTool(
  client: WireClient,
  name: string,
  toolArguments: Record<string, unknown>,
  parameters: McpParameters = (params) => params,
): Promise<JsonRpcReply> {
  return client.request(
    "tools/call",
    parameters({ arguments: toolArguments, name }),
  );
}

export function modernParameters(): McpParameters {
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

export function toolResult(reply: JsonRpcReply): Record<string, unknown> {
  return asRecord(reply.result);
}

export function toolStructuredContent(reply: JsonRpcReply): unknown {
  return toolResult(reply).structuredContent;
}

export function toolText(reply: JsonRpcReply): string {
  const content = toolResult(reply).content;
  if (!Array.isArray(content)) throw new TypeError("tool returned no content");
  const first = asRecord(content[0]);
  if (typeof first.text !== "string") {
    throw new TypeError("tool returned no text content");
  }
  return first.text;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

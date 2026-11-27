import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildServer, type BuildServerOptions } from "../src/mcp-server.js";

// The MCP SDK validates tool input and output through `~standard.validate`
// and builds its error text from the issues. These cases send invalid values
// through that entry point for every schema the server registers; under `npm
// run test:compiled` each call is also checked against the runtime parser, so
// the compiled path must report the same issues the SDK would show.

/** The tools `buildServer` registers, and their input and output schemas. */
function registeredTools(): {
  readonly count: number;
  readonly schemas: Array<readonly [string, z.ZodType]>;
} {
  const registerTool = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    buildServer({
      allowAlwaysReturnChanges: true,
      mutationServiceResolver:
        {} as BuildServerOptions["mutationServiceResolver"],
      readServiceResolver: {} as BuildServerOptions["readServiceResolver"],
    });
    const schemas = registerTool.mock.calls.flatMap(([name, config]) => {
      const { inputSchema, outputSchema } = config as unknown as {
        inputSchema?: z.ZodType;
        outputSchema?: z.ZodType;
      };
      return [
        ...(inputSchema ? [[`${name} input`, inputSchema] as const] : []),
        ...(outputSchema ? [[`${name} output`, outputSchema] as const] : []),
      ];
    });
    return { count: registerTool.mock.calls.length, schemas };
  } finally {
    registerTool.mockRestore();
  }
}

/** Every property name the schema lists, including those of union members. */
function propertyNames(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const record = json as Record<string, unknown>;
  const own = Object.keys(
    (record.properties as Record<string, unknown> | undefined) ?? {},
  );
  const members = ["oneOf", "anyOf", "allOf"].flatMap((key) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]) : [],
  );
  return [...new Set([...own, ...members.flatMap(propertyNames)])];
}

/** Values from the root down to each field that tool schemas mostly reject. */
function invalidValues(schema: z.ZodType): unknown[] {
  const fields = propertyNames(z.toJSONSchema(schema, { io: "input" }));
  const wrongType = (value: unknown) =>
    Object.fromEntries(fields.map((field) => [field, value]));
  return [
    null,
    "text",
    [],
    {},
    { unexpected_field: true },
    wrongType(12_345),
    wrongType([]),
    wrongType({ nested: null }),
  ];
}

const TOOLS = registeredTools();

describe("MCP tool schemas through ~standard.validate", () => {
  it("covers both schemas of every tool", () => {
    expect(TOOLS.count).toBeGreaterThan(0);
    expect(TOOLS.schemas).toHaveLength(2 * TOOLS.count);
  });

  it.each(TOOLS.schemas)(
    "%s reports what safeParse reports for invalid values",
    (_name, schema) => {
      let rejected = 0;
      for (const value of invalidValues(schema)) {
        const parsed = schema.safeParse(value);
        if (!parsed.success) rejected += 1;
        expect(schema["~standard"].validate(value)).toStrictEqual(
          parsed.success
            ? { value: parsed.data }
            : { issues: parsed.error.issues },
        );
      }
      expect(rejected).toBeGreaterThanOrEqual(6);
    },
  );
});

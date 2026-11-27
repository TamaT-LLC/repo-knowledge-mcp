import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AlwaysReturnResultSchema } from "../src/global-always-return.js";
import {
  AddKnowledgeInputSchema,
  AddKnowledgeOutputSchema,
  IngestPrInputSchema,
  IngestPrOutputSchema,
  PrepareDistillationInputSchema,
  PrepareDistillationOutputSchema,
  RecordOutcomeInputSchema,
  RecordOutcomeOutputSchema,
  SubmitDistillationInputSchema,
  SubmitDistillationOutputSchema,
  SyncRepoInputSchema,
  SyncRepoOutputSchema,
  UpdateKnowledgeInputSchema,
  UpdateKnowledgeOutputSchema,
} from "../src/mcp-mutation-schemas.js";
import {
  GetKnowledgeInputSchema,
  GetKnowledgeOutputSchema,
  GetRulesInputSchema,
  GetRulesOutputSchema,
  SearchKnowledgeInputSchema,
  SearchKnowledgeOutputSchema,
  StatsInputSchema,
  StatsOutputSchema,
} from "../src/mcp-server.js";

// The MCP SDK validates tool input and output through `~standard.validate`
// and builds its error text from the issues. These cases send invalid values
// through that entry point for every tool schema; under `npm run
// test:compiled` each call is also checked against the runtime parser, so the
// compiled path must report the same issues the SDK would show.
const TOOL_SCHEMAS = {
  AddKnowledgeInputSchema,
  AddKnowledgeOutputSchema,
  AlwaysReturnResultSchema,
  GetKnowledgeInputSchema,
  GetKnowledgeOutputSchema,
  GetRulesInputSchema,
  GetRulesOutputSchema,
  IngestPrInputSchema,
  IngestPrOutputSchema,
  PrepareDistillationInputSchema,
  PrepareDistillationOutputSchema,
  RecordOutcomeInputSchema,
  RecordOutcomeOutputSchema,
  SearchKnowledgeInputSchema,
  SearchKnowledgeOutputSchema,
  StatsInputSchema,
  StatsOutputSchema,
  SubmitDistillationInputSchema,
  SubmitDistillationOutputSchema,
  SyncRepoInputSchema,
  SyncRepoOutputSchema,
  UpdateKnowledgeInputSchema,
  UpdateKnowledgeOutputSchema,
} satisfies Record<string, z.ZodType>;

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
  return [...new Set([...own, ...members.flatMap(propertyNames)])].sort();
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

describe("MCP tool schemas through ~standard.validate", () => {
  it.each(Object.entries(TOOL_SCHEMAS))(
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

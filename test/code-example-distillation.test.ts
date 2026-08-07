import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  computeOutputSchemaDigest,
  computeThreadDistillationKey,
  loadDistillationPrompt,
  parseDistillationOutput,
} from "../src/index.js";

interface CodeExampleFixtureExpectation {
  readonly accepted: boolean;
  readonly code_example_present?: boolean;
  readonly validation_summary?: string;
}

interface CodeExampleFixtureCase {
  readonly allowed_comment_ids: readonly string[];
  readonly description: string;
  readonly expected: CodeExampleFixtureExpectation;
  readonly id: string;
  readonly output: unknown;
  readonly tags: readonly string[];
}

interface CodeExampleFixtureFile {
  readonly cases: readonly CodeExampleFixtureCase[];
}

const FIXTURE_PATH = join(
  process.cwd(),
  "test",
  "fixtures",
  "code-example-distillation.json",
);
const PROMPT_PATH = join(process.cwd(), "prompts", "distill.md");

async function loadFixtures(): Promise<readonly CodeExampleFixtureCase[]> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as CodeExampleFixtureFile;
  return parsed.cases;
}

describe("M2 code example fixtures", () => {
  it("covers grounded, conceptual, injection, and fictional-API scenarios", async () => {
    const cases = await loadFixtures();

    expect(cases.map((entry) => entry.id)).toEqual([
      "grounded-evidence",
      "no-concrete-grounding",
      "prompt-injection-forged-evidence",
      "fictional-api-coercion",
    ]);
    for (const entry of cases) {
      if (!entry.expected.accepted) {
        expect(() =>
          parseDistillationOutput(
            JSON.stringify(entry.output),
            entry.allowed_comment_ids,
          ),
        ).toThrow(
          expect.objectContaining({
            code: "DISTILLATION_OUTPUT_INVALID",
            ...(entry.expected.validation_summary === undefined
              ? {}
              : { validationSummary: entry.expected.validation_summary }),
          }),
        );
        continue;
      }
      const output = parseDistillationOutput(
        JSON.stringify(entry.output),
        entry.allowed_comment_ids,
      );
      expect(output.candidates.length).toBeGreaterThan(0);
      const example = output.candidates[0]!.code_example;
      if (entry.expected.code_example_present === true) {
        expect(example).toMatchObject({ generated_example: true });
        expect(example!.evidence_comment_ids.length).toBeGreaterThan(0);
        for (const commentId of example!.evidence_comment_ids) {
          expect(entry.allowed_comment_ids).toContain(commentId);
        }
      } else {
        expect(example).toBeUndefined();
      }
    }
  });

  it("pins the evidence-constrained code example contract into the prompt", async () => {
    const prompt = await loadDistillationPrompt(PROMPT_PATH);

    expect(prompt.promptVersion).toBe("distill-v2");
    expect(prompt.instructions).toContain(
      "Include `code_example` only when the supplied diff hunks or comment bodies contain the exact APIs, types, and package names the example uses.",
    );
    expect(prompt.instructions).toContain(
      "omit `code_example` entirely and keep `detail` conceptual",
    );
    expect(prompt.instructions).toContain(
      "Never invent function names, type names, or package names",
    );
    expect(prompt.instructions).toContain(
      "sets `generated_example` to true and cites the grounding comment IDs",
    );
  });

  it("binds the M2 schema change into the output schema digest and distillation key", () => {
    const schemaJson = JSON.stringify(DISTILLATION_OUTPUT_JSON_SCHEMA);
    const legacySchema = JSON.parse(schemaJson) as {
      properties: {
        candidates: { items: { properties: Record<string, unknown> } };
      };
    };
    delete legacySchema.properties.candidates.items.properties.code_example;
    const legacyDigest = computeOutputSchemaDigest(legacySchema);
    const digestOf = (outputSchemaDigest: string): string =>
      computeThreadDistillationKey({
        distillationInputDigest: `sha256:${"1".repeat(64)}`,
        outputSchemaDigest,
        promptDigest: `sha256:${"2".repeat(64)}`,
        trustPolicyDigest: `sha256:${"3".repeat(64)}`,
      });

    expect(DISTILLATION_OUTPUT_SCHEMA_VERSION).toBe("distill-output-v2");
    expect(schemaJson).toContain('"code_example"');
    expect(schemaJson).toContain('"generated_example"');
    expect(DISTILLATION_OUTPUT_SCHEMA_DIGEST).toBe(
      computeOutputSchemaDigest(DISTILLATION_OUTPUT_JSON_SCHEMA),
    );
    expect(legacyDigest).not.toBe(DISTILLATION_OUTPUT_SCHEMA_DIGEST);
    expect(digestOf(legacyDigest)).not.toBe(
      digestOf(DISTILLATION_OUTPUT_SCHEMA_DIGEST),
    );
  });
});

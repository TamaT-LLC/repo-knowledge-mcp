import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODE_EXAMPLE_GENERIC_TOKENS,
  CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH,
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  computeOutputSchemaDigest,
  computeThreadDistillationKey,
  evaluateCodeExampleGrounding,
  extractCodeExampleReferenceTokens,
  loadDistillationPrompt,
  parseDistillationOutput,
  type GeneratedCodeExample,
} from "../src/index.js";

interface CodeExampleFixtureComment {
  readonly body: string;
  readonly diff_hunk?: string;
  readonly id: string;
}

interface CodeExampleFixtureExpectation {
  readonly accepted: boolean;
  readonly code_example_present?: boolean;
  readonly validation_summary?: string;
}

interface CodeExampleFixtureCase {
  readonly comments: readonly CodeExampleFixtureComment[];
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

function sourceComments(comments: readonly CodeExampleFixtureComment[]): {
  readonly body: string;
  readonly diffHunk?: string;
  readonly id: string;
}[] {
  return comments.map((comment) => ({
    body: comment.body,
    ...(comment.diff_hunk === undefined ? {} : { diffHunk: comment.diff_hunk }),
    id: comment.id,
  }));
}

describe("M2 code example fixtures", () => {
  it("covers grounded, conceptual, injection, fictional-API, and fabricated-content scenarios", async () => {
    const cases = await loadFixtures();

    expect(cases.map((entry) => entry.id)).toEqual([
      "grounded-evidence",
      "no-concrete-grounding",
      "prompt-injection-forged-evidence",
      "fictional-api-coercion",
      "grounded-id-fabricated-content",
      "bracket-and-type-fabrication",
      "optional-chaining-and-compound-types",
    ]);
    for (const entry of cases) {
      if (!entry.expected.accepted) {
        expect(() =>
          parseDistillationOutput(
            JSON.stringify(entry.output),
            sourceComments(entry.comments),
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
        sourceComments(entry.comments),
      );
      expect(output.candidates.length).toBeGreaterThan(0);
      const example = output.candidates[0]!.code_example;
      if (entry.expected.code_example_present === true) {
        expect(example).toMatchObject({ generated_example: true });
        expect(example!.evidence_comment_ids.length).toBeGreaterThan(0);
        const commentIds = entry.comments.map((comment) => comment.id);
        for (const commentId of example!.evidence_comment_ids) {
          expect(commentIds).toContain(commentId);
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

  it("pins the deterministic grounding token rules", () => {
    expect(CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH).toBe(3);
    expect(CODE_EXAMPLE_GENERIC_TOKENS).toEqual([
      "abstract",
      "and",
      "any",
      "array",
      "assert",
      "async",
      "await",
      "bigint",
      "bool",
      "boolean",
      "box",
      "break",
      "case",
      "catch",
      "chan",
      "char",
      "class",
      "console",
      "const",
      "constructor",
      "continue",
      "crate",
      "date",
      "declare",
      "def",
      "default",
      "defer",
      "del",
      "delete",
      "double",
      "dyn",
      "elif",
      "else",
      "enum",
      "error",
      "export",
      "extends",
      "false",
      "finally",
      "float",
      "for",
      "from",
      "func",
      "function",
      "goto",
      "hashmap",
      "impl",
      "import",
      "infer",
      "instanceof",
      "int",
      "interface",
      "isize",
      "keyof",
      "lambda",
      "length",
      "let",
      "long",
      "loop",
      "map",
      "match",
      "mod",
      "module",
      "mut",
      "namespace",
      "never",
      "new",
      "nil",
      "none",
      "not",
      "null",
      "number",
      "object",
      "omit",
      "option",
      "override",
      "package",
      "partial",
      "pass",
      "pick",
      "print",
      "println",
      "private",
      "promise",
      "protected",
      "pub",
      "public",
      "raise",
      "range",
      "readonly",
      "record",
      "ref",
      "regexp",
      "require",
      "result",
      "return",
      "satisfies",
      "self",
      "set",
      "short",
      "static",
      "string",
      "struct",
      "super",
      "switch",
      "symbol",
      "then",
      "this",
      "throw",
      "trait",
      "true",
      "try",
      "type",
      "typeof",
      "undefined",
      "unknown",
      "use",
      "usize",
      "val",
      "var",
      "vec",
      "void",
      "when",
      "where",
      "while",
      "with",
      "yield",
    ]);

    const tokens = extractCodeExampleReferenceTokens(
      'import { fetchThing } from "@scope/pkg";\n' +
        "const local = new HttpClient();\n" +
        "local.send(fetchThing(id));",
    );

    // Every identifier token requires grounding; declared bindings, short
    // tokens, generic tokens, and validated module specifier interiors do not.
    expect(tokens.identifiers).toEqual(["HttpClient", "fetchThing", "send"]);
    expect(tokens.specifiers).toEqual(["@scope/pkg"]);

    // The exhaustive pass covers quoted bracket members, type annotations,
    // and string-literal words alike, while standard-library type names stay
    // excluded through the generic token list.
    const fabricated = extractCodeExampleReferenceTokens(
      'const value: FabricatedType = client["fabricatedApi"]();\n' +
        'const rows = ["apple"];\n' +
        "const typed = rows as Promise<Result>;",
    );
    expect(fabricated.identifiers).toEqual([
      "FabricatedType",
      "apple",
      "client",
      "fabricatedApi",
    ]);
    expect(fabricated.specifiers).toEqual([]);

    // Position-independent coverage: optional chaining, compound generics,
    // unions, and satisfies expressions all surface their reference names.
    const positionIndependent = extractCodeExampleReferenceTokens(
      "fabricatedApi?.();\n" +
        "client?.fabricatedMethod();\n" +
        "const cache: Map<string, FabricatedType> = loadCache();\n" +
        "let union: RealType | FabricatedType;\n" +
        "payload satisfies FabricatedType;",
    );
    expect(positionIndependent.identifiers).toEqual([
      "FabricatedType",
      "RealType",
      "client",
      "fabricatedApi",
      "fabricatedMethod",
      "loadCache",
      "payload",
    ]);

    const example: GeneratedCodeExample = {
      content: "local.send(fetchThing(id));",
      evidence_comment_ids: ["comment-1"],
      generated_example: true,
      language: "typescript",
    };
    expect(
      evaluateCodeExampleGrounding(example, [
        {
          body: "Route local.send through fetchThing so retries stay uniform.",
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
    expect(
      evaluateCodeExampleGrounding(example, [
        { body: "Please add retries here.", id: "comment-1" },
      ]),
    ).toEqual({
      grounded: false,
      ungrounded_tokens: ["fetchThing", "local", "send"],
    });
    expect(
      evaluateCodeExampleGrounding(
        {
          content: "const profile: ProfileForm = parseProfile(payload);",
          evidence_comment_ids: ["comment-1"],
          generated_example: true,
          language: "typescript",
        },
        [
          {
            body: "parseProfile should return the ProfileForm we validate from the payload.",
            id: "comment-1",
          },
        ],
      ),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
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

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODE_EXAMPLE_GENERIC_TOKENS,
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
    expect(CODE_EXAMPLE_GENERIC_TOKENS).toEqual([
      "_",
      "abstract",
      "and",
      "any",
      "array",
      "as",
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
      "do",
      "double",
      "dyn",
      "e",
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
      "go",
      "goto",
      "hashmap",
      "i",
      "id",
      "if",
      "impl",
      "import",
      "in",
      "infer",
      "instanceof",
      "int",
      "interface",
      "is",
      "isize",
      "j",
      "k",
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
      "n",
      "namespace",
      "never",
      "new",
      "nil",
      "none",
      "not",
      "null",
      "number",
      "object",
      "of",
      "omit",
      "option",
      "or",
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
      "x",
      "y",
      "yield",
      "z",
    ]);

    const tokens = extractCodeExampleReferenceTokens(
      'import { fetchThing } from "@scope/pkg";\n' +
        "const local = new HttpClient();\n" +
        "local.send(fetchThing(id));",
    );

    // Every identifier token requires grounding — declared names included;
    // only short tokens, generic tokens, and validated module specifier
    // interiors are exempt.
    expect(tokens.identifiers).toEqual([
      "HttpClient",
      "fetchThing",
      "local",
      "send",
    ]);
    expect(tokens.specifiers).toEqual(["@scope/pkg"]);

    // The exhaustive pass covers quoted bracket members, type annotations,
    // string-literal words, and declared bindings alike, while
    // standard-library type names stay excluded through the generic list.
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
      "rows",
      "typed",
      "value",
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
      "cache",
      "client",
      "fabricatedApi",
      "fabricatedMethod",
      "loadCache",
      "payload",
      "union",
    ]);

    // Declaring a fabricated name inside the example does not exempt it.
    const declaredBypass = extractCodeExampleReferenceTokens(
      "interface FabricatedService {}\n" +
        "type FabricatedPayload = Record<string, never>;\n" +
        "const fabricatedValue = new FabricatedService();",
    );
    expect(declaredBypass.identifiers).toEqual([
      "FabricatedPayload",
      "FabricatedService",
      "fabricatedValue",
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
            body: "parseProfile builds the profile as a ProfileForm we validate from the payload.",
            id: "comment-1",
          },
        ],
      ),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
  });

  it("rejects declared fabricated names and matches specifiers on exact boundaries", () => {
    const example = (content: string): GeneratedCodeExample => ({
      content,
      evidence_comment_ids: ["comment-1"],
      generated_example: true,
      language: "typescript",
    });

    // A declaration inside the example does not launder fabricated names.
    expect(
      evaluateCodeExampleGrounding(
        example(
          "interface FabricatedService {}\nconst svc = new FabricatedService();",
        ),
        [
          {
            body: "Wrap the svc wiring behind the documented factory.",
            id: "comment-1",
          },
        ],
      ),
    ).toEqual({
      grounded: false,
      ungrounded_tokens: ["FabricatedService"],
    });

    // Module specifiers match whole, boundary-delimited evidence strings.
    const specifierEvidence = [
      {
        body: 'Use helperThing from "@scope/pkg-utils" for this.',
        id: "comment-1",
      },
    ];
    expect(
      evaluateCodeExampleGrounding(
        example(
          'import { helperThing } from "@scope/pkg-utils";\nhelperThing();',
        ),
        specifierEvidence,
      ),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
    expect(
      evaluateCodeExampleGrounding(
        example('import { helperThing } from "@scope/pkg";\nhelperThing();'),
        specifierEvidence,
      ),
    ).toEqual({ grounded: false, ungrounded_tokens: ["@scope/pkg"] });
  });

  it("requires grounding for short names while idiomatic tokens stay exempt", () => {
    const example = (content: string): GeneratedCodeExample => ({
      content,
      evidence_comment_ids: ["comment-1"],
      generated_example: true,
      language: "typescript",
    });

    // Short API names have no length exemption.
    expect(
      evaluateCodeExampleGrounding(example("db().close();"), [
        { body: "Close the handle when done.", id: "comment-1" },
      ]),
    ).toEqual({ grounded: false, ungrounded_tokens: ["db"] });
    expect(
      evaluateCodeExampleGrounding(example("db().close();"), [
        { body: "Always close the db handle when done.", id: "comment-1" },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });

    // Short module specifiers require an exact grounded specifier too.
    expect(
      evaluateCodeExampleGrounding(example('import "ab";'), [
        { body: "Use the documented package here.", id: "comment-1" },
      ]),
    ).toEqual({ grounded: false, ungrounded_tokens: ["ab"] });
    expect(
      evaluateCodeExampleGrounding(example('import "ab";'), [
        { body: 'Depend on "ab" only for parsing.', id: "comment-1" },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });

    // Idiomatic loop variables are exempt through the frozen generic list.
    expect(
      evaluateCodeExampleGrounding(
        example(
          "for (let i = 0; i < items.length; i += 1) pushItem(items[i]);",
        ),
        [
          {
            body: "pushItem must run for every entry in items.",
            id: "comment-1",
          },
        ],
      ),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
  });

  it("verifies dynamic import specifiers and Unicode identifiers", () => {
    const example = (content: string): GeneratedCodeExample => ({
      content,
      evidence_comment_ids: ["comment-1"],
      generated_example: true,
      language: "typescript",
    });

    // Dynamic import specifiers are extracted whole, never as fragments.
    const dynamicTokens = extractCodeExampleReferenceTokens(
      'await import("@scope/fabricated");',
    );
    expect(dynamicTokens.identifiers).toEqual([]);
    expect(dynamicTokens.specifiers).toEqual(["@scope/fabricated"]);

    // Fragments of the package name in evidence do not ground the whole
    // specifier; only an exact boundary match does.
    const dynamicImport = example(
      'const mod = await import("@scope/fabricated");',
    );
    expect(
      evaluateCodeExampleGrounding(dynamicImport, [
        {
          body: "The scope of this loader is fabricated bundles from the documented mod registry.",
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: false, ungrounded_tokens: ["@scope/fabricated"] });
    expect(
      evaluateCodeExampleGrounding(dynamicImport, [
        {
          body: 'Lazy-load the mod bundle from "@scope/fabricated".',
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });

    // Template-literal imports are matched as whole specifiers too, with
    // backticks treated like quotes on both the content and evidence sides.
    const templateTokens = extractCodeExampleReferenceTokens(
      "await import(`@scope/fabricated`);",
    );
    expect(templateTokens.identifiers).toEqual([]);
    expect(templateTokens.specifiers).toEqual(["@scope/fabricated"]);

    const templateImport = example(
      "const mod = await import(`@scope/fabricated`);",
    );
    expect(
      evaluateCodeExampleGrounding(templateImport, [
        {
          body: "The scope of this loader is fabricated bundles from the documented mod registry.",
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: false, ungrounded_tokens: ["@scope/fabricated"] });
    expect(
      evaluateCodeExampleGrounding(templateImport, [
        {
          body: "Lazy-load the mod bundle from `@scope/fabricated`.",
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });

    // An interpolated template specifier is compared as one whole string
    // including the interpolation text, so it fails closed.
    expect(
      evaluateCodeExampleGrounding(
        example("const mod = await import(`@scope/${channel}/loader`);"),
        [
          {
            body: "The channel loader for scope modules is documented, and mod loading is lazy.",
            id: "comment-1",
          },
        ],
      ),
    ).toEqual({
      grounded: false,
      ungrounded_tokens: ["@scope/${channel}/loader"],
    });

    // Unicode identifiers are tokenized with the same rules on both sides,
    // and short non-ASCII tokens are never exempt.
    const unicodeExample = example("const Δx = réponse.envoyer();");
    expect(
      evaluateCodeExampleGrounding(unicodeExample, [
        {
          body: "Track Δx and send the réponse through envoyer().",
          id: "comment-1",
        },
      ]),
    ).toEqual({ grounded: true, ungrounded_tokens: [] });
    expect(
      evaluateCodeExampleGrounding(unicodeExample, [
        {
          body: "Send the result through the documented channel.",
          id: "comment-1",
        },
      ]),
    ).toEqual({
      grounded: false,
      ungrounded_tokens: ["envoyer", "réponse", "Δx"],
    });
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

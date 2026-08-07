import { sortAndDedupeStrings } from "./canonical.js";
import type { GeneratedCodeExample } from "./domain-schemas.js";

/**
 * Deterministic grounding contract for generated code examples (design doc
 * §12). A code example may only reference APIs, types, and packages that
 * appear in the body or diff hunk of the review comments it cites. Tokens are
 * extracted lexically from reference positions, so locally declared bindings
 * and generic language keywords never require grounding, while fabricated
 * function, type, and package names are rejected fail-closed.
 */

export const CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH = 3;

/**
 * Frozen cross-language keywords, ubiquitous builtins, and standard-library
 * type names that occur in reference or type positions but carry no
 * repository-specific meaning. This list is part of the grounding contract
 * and is pinned by tests; extending it is a spec change. Matching is
 * case-insensitive, so lowercase entries also cover `Promise`, `Result`, etc.
 */
export const CODE_EXAMPLE_GENERIC_TOKENS: readonly string[] = Object.freeze([
  "array",
  "assert",
  "await",
  "boolean",
  "box",
  "break",
  "case",
  "catch",
  "class",
  "console",
  "const",
  "constructor",
  "continue",
  "date",
  "def",
  "default",
  "delete",
  "elif",
  "else",
  "enum",
  "error",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "hashmap",
  "import",
  "instanceof",
  "interface",
  "lambda",
  "length",
  "let",
  "loop",
  "map",
  "match",
  "new",
  "number",
  "object",
  "omit",
  "option",
  "partial",
  "pick",
  "print",
  "println",
  "promise",
  "pub",
  "raise",
  "readonly",
  "record",
  "regexp",
  "require",
  "result",
  "return",
  "self",
  "set",
  "static",
  "string",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "trait",
  "try",
  "type",
  "typeof",
  "use",
  "val",
  "var",
  "vec",
  "void",
  "while",
  "with",
  "yield",
]);

const GENERIC_TOKEN_SET: ReadonlySet<string> = new Set(
  CODE_EXAMPLE_GENERIC_TOKENS,
);

const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
const TYPE_IDENTIFIER = "[A-Z][A-Za-z0-9_$]*";
const MODULE_SPECIFIER = "[A-Za-z_$@][A-Za-z0-9_$@:./-]*";
const IDENTIFIER_TOKEN_REGEX = new RegExp(IDENTIFIER, "gu");
const CALLED_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$])(${IDENTIFIER})\\s*\\(`,
  "gu",
);
const MEMBER_TOKEN_REGEX = new RegExp(`\\.\\s*(${IDENTIFIER})`, "gu");
const MEMBER_ROOT_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$.])(${IDENTIFIER})(?=\\s*\\.[A-Za-z_$])`,
  "gu",
);
const BRACKET_MEMBER_TOKEN_REGEX = new RegExp(
  `(?<=[A-Za-z0-9_$)\\]])\\[\\s*["'](${IDENTIFIER})["']\\s*\\]`,
  "gu",
);
const CONSTRUCTED_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$])new\\s+(${IDENTIFIER})`,
  "gu",
);
const ANNOTATED_TYPE_TOKEN_REGEX = new RegExp(
  `:\\s*(${TYPE_IDENTIFIER})`,
  "gu",
);
const ASSERTED_TYPE_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$])as\\s+(${TYPE_IDENTIFIER})`,
  "gu",
);
const GENERIC_TYPE_TOKEN_REGEX = new RegExp(`<\\s*(${TYPE_IDENTIFIER})`, "gu");
const EXTENDED_TYPE_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$])(?:extends|implements)\\s+(${TYPE_IDENTIFIER})`,
  "gu",
);
const MODULE_KEYWORD_TOKEN_REGEX = new RegExp(
  `(?<![A-Za-z0-9_$])(?:import|from|use)\\s+(${MODULE_SPECIFIER})`,
  "gu",
);
const QUOTED_MODULE_SPECIFIER_REGEX =
  /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/gu;
const DECLARED_TOKEN_REGEX = new RegExp(
  "(?<![A-Za-z0-9_$])(?:catch|class|const|def|enum|fn|for|fun|function|" +
    `interface|let|struct|trait|type|val|var)\\s+(${IDENTIFIER})`,
  "gu",
);

export interface CodeExampleEvidenceSource {
  readonly body: string;
  readonly diffHunk?: string;
  readonly id: string;
}

export interface CodeExampleReferenceTokens {
  /**
   * Identifier references: calls, member access (dotted and quoted-bracket),
   * `new`, capital-initial type references, and import names.
   */
  readonly identifiers: readonly string[];
  /** Module specifiers matched as substrings, e.g. `@scope/pkg`. */
  readonly specifiers: readonly string[];
}

export interface CodeExampleGroundingResult {
  readonly grounded: boolean;
  readonly ungrounded_tokens: readonly string[];
}

/**
 * Extracts reference-position tokens from example content: called
 * identifiers, member access segments and their roots, quoted bracket
 * members, constructed types, capital-initial type references, and
 * import/module references. Locally declared names, tokens shorter than the
 * minimum length, and generic tokens are excluded.
 */
export function extractCodeExampleReferenceTokens(
  content: string,
): CodeExampleReferenceTokens {
  const declared = new Set(
    captureAll(content, DECLARED_TOKEN_REGEX).map((token) =>
      token.toLowerCase(),
    ),
  );
  const identifiers = sortAndDedupeStrings(
    [
      ...captureAll(content, CALLED_TOKEN_REGEX),
      ...captureAll(content, MEMBER_TOKEN_REGEX),
      ...captureAll(content, MEMBER_ROOT_TOKEN_REGEX),
      ...captureAll(content, BRACKET_MEMBER_TOKEN_REGEX),
      ...captureAll(content, CONSTRUCTED_TOKEN_REGEX),
      ...captureAll(content, ANNOTATED_TYPE_TOKEN_REGEX),
      ...captureAll(content, ASSERTED_TYPE_TOKEN_REGEX),
      ...captureAll(content, GENERIC_TYPE_TOKEN_REGEX),
      ...captureAll(content, EXTENDED_TYPE_TOKEN_REGEX),
    ].filter(
      (token) =>
        token.length >= CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH &&
        !GENERIC_TOKEN_SET.has(token.toLowerCase()) &&
        !declared.has(token.toLowerCase()),
    ),
  );
  const specifiers = sortAndDedupeStrings(
    [
      ...captureAll(content, MODULE_KEYWORD_TOKEN_REGEX),
      ...captureAll(content, QUOTED_MODULE_SPECIFIER_REGEX),
    ].filter(
      (specifier) =>
        specifier.length >= CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH &&
        !GENERIC_TOKEN_SET.has(specifier.toLowerCase()),
    ),
  );
  return { identifiers, specifiers };
}

/**
 * Verifies that every reference token in the example content occurs in the
 * body or diff hunk of the comments the example cites. Matching is
 * case-insensitive; identifiers must match a whole evidence token and module
 * specifiers must occur as substrings. Missing cited comments leave the
 * evidence text empty, so unknown IDs fail closed.
 */
export function evaluateCodeExampleGrounding(
  example: GeneratedCodeExample,
  sources: readonly CodeExampleEvidenceSource[],
): CodeExampleGroundingResult {
  const cited = new Set(example.evidence_comment_ids);
  const evidenceText = sources
    .filter((source) => cited.has(source.id))
    .map((source) =>
      source.diffHunk === undefined
        ? source.body
        : `${source.body}\n${source.diffHunk}`,
    )
    .join("\n")
    .toLowerCase();
  const evidenceTokens = new Set(
    evidenceText.match(IDENTIFIER_TOKEN_REGEX) ?? [],
  );
  const tokens = extractCodeExampleReferenceTokens(example.content);
  const ungrounded = [
    ...tokens.identifiers.filter(
      (token) => !evidenceTokens.has(token.toLowerCase()),
    ),
    ...tokens.specifiers.filter(
      (specifier) => !evidenceText.includes(specifier.toLowerCase()),
    ),
  ];
  return {
    grounded: ungrounded.length === 0,
    ungrounded_tokens: sortAndDedupeStrings(ungrounded),
  };
}

function captureAll(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)].map((match) => match[1]!);
}

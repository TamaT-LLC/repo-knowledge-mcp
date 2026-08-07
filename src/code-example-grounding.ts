import { sortAndDedupeStrings } from "./canonical.js";
import type { GeneratedCodeExample } from "./domain-schemas.js";

/**
 * Deterministic grounding contract for generated code examples (design doc
 * §12). A code example may only reference names that appear in the body or
 * diff hunk of the review comments it cites. The contract is exhaustive
 * rather than positional: every identifier token in the content is a
 * candidate, and only deterministic exclusions (generic tokens, minimum
 * length, locally declared bindings, validated module specifiers) remove a
 * token from the requirement. Fabricated function, type, and package names
 * are therefore rejected fail-closed regardless of the syntax — optional
 * chaining, unions, generics, `satisfies`, and future constructs included.
 * False positives deliberately fall on the rejection side.
 */

export const CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH = 3;

/**
 * Frozen cross-language keywords, ubiquitous builtins, and standard-library
 * type names that carry no repository-specific meaning. This list is part of
 * the grounding contract and is pinned by tests; extending it is a spec
 * change. Matching is case-insensitive, so lowercase entries also cover
 * `Promise`, `Result`, etc.
 */
export const CODE_EXAMPLE_GENERIC_TOKENS: readonly string[] = Object.freeze([
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

const GENERIC_TOKEN_SET: ReadonlySet<string> = new Set(
  CODE_EXAMPLE_GENERIC_TOKENS,
);

const IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
const MODULE_SPECIFIER = "[A-Za-z_$@][A-Za-z0-9_$@:./-]*";
const IDENTIFIER_TOKEN_REGEX = new RegExp(IDENTIFIER, "gu");
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
   * Every identifier token in the content that survives the deterministic
   * exclusions: generic tokens, tokens below the minimum length, locally
   * declared names, and the interior of validated module specifiers.
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
 * Extracts every identifier token from the content, including tokens inside
 * string literals and comments (quoted bracket members and error messages are
 * data too). Excluded deterministically: tokens shorter than the minimum
 * length, generic tokens, names declared after a declaration keyword
 * (`catch|class|const|def|enum|fn|for|fun|function|interface|let|struct|`
 * `trait|type|val|var`), and the interior of quoted module specifiers, which
 * are validated separately as substrings. Function parameters, destructuring
 * bindings, and import-bound names are intentionally not excluded; they fail
 * closed toward requiring grounding.
 */
export function extractCodeExampleReferenceTokens(
  content: string,
): CodeExampleReferenceTokens {
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
  // Quoted module specifiers are validated as whole substrings; blank their
  // interiors so their fragments are not reported twice.
  const tokenizable = content.replaceAll(
    QUOTED_MODULE_SPECIFIER_REGEX,
    (match) => " ".repeat(match.length),
  );
  const declared = new Set(
    captureAll(tokenizable, DECLARED_TOKEN_REGEX).map((token) =>
      token.toLowerCase(),
    ),
  );
  const identifiers = sortAndDedupeStrings(
    (tokenizable.match(IDENTIFIER_TOKEN_REGEX) ?? []).filter(
      (token) =>
        token.length >= CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH &&
        !GENERIC_TOKEN_SET.has(token.toLowerCase()) &&
        !declared.has(token.toLowerCase()),
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

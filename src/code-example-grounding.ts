import { sortAndDedupeStrings } from "./canonical.js";
import type { GeneratedCodeExample } from "./domain-schemas.js";

/**
 * Deterministic grounding contract for generated code examples (design doc
 * §12). A code example may only reference names that appear in the body or
 * diff hunk of the review comments it cites. The contract is exhaustive
 * rather than positional: every identifier token in the content is a
 * candidate, and only deterministic exclusions (generic tokens, minimum
 * length, validated module specifiers) remove a token from the requirement.
 * Declaring a name inside the example does not exempt it — otherwise a
 * fabricated type or API could be laundered through `interface Fabricated {}`
 * followed by a use. Fabricated function, type, and package names are
 * therefore rejected fail-closed regardless of the syntax — optional
 * chaining, unions, generics, `satisfies`, declarations, and future
 * constructs included. False positives deliberately fall on the rejection
 * side.
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

const IDENTIFIER_START = "[\\p{L}\\p{Nl}_$]";
const IDENTIFIER_CONTINUE = "[\\p{L}\\p{Nl}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Pc}_$]";
const IDENTIFIER = `${IDENTIFIER_START}${IDENTIFIER_CONTINUE}*`;
const MODULE_SPECIFIER = "[A-Za-z_$@][A-Za-z0-9_$@:./-]*";
const IDENTIFIER_TOKEN_REGEX = new RegExp(IDENTIFIER, "gu");
const MODULE_KEYWORD_TOKEN_REGEX = new RegExp(
  `(?<!${IDENTIFIER_CONTINUE})(?:import|from|use)\\s+(${MODULE_SPECIFIER})`,
  "gu",
);
const QUOTED_MODULE_SPECIFIER_REGEX =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/gu;
const QUOTED_STRING_REGEX = /["']([^"'\n]+)["']/gu;
const SPECIFIER_RUN_REGEX = new RegExp(MODULE_SPECIFIER, "gu");
const QUOTED_EVIDENCE_STRING_REGEX = /["']([^"'\n]+)["']/gu;
const TRAILING_SPECIFIER_PUNCTUATION_REGEX = /[.:/-]+$/u;
const MAX_ASCII_CODE_POINT = 0x7f;

export interface CodeExampleEvidenceSource {
  readonly body: string;
  readonly diffHunk?: string;
  readonly id: string;
}

export interface CodeExampleReferenceTokens {
  /**
   * Every identifier token in the content that survives the deterministic
   * exclusions: generic tokens, tokens below the minimum length, and the
   * interior of validated module specifiers. Declared names are included.
   */
  readonly identifiers: readonly string[];
  /**
   * Module specifiers matched against evidence as whole, boundary-delimited
   * strings, e.g. `@scope/pkg`.
   */
  readonly specifiers: readonly string[];
}

export interface CodeExampleGroundingResult {
  readonly grounded: boolean;
  readonly ungrounded_tokens: readonly string[];
}

/**
 * Extracts every identifier token from the content — Unicode identifiers
 * included — and every module specifier. Tokens inside string literals and
 * comments count too (quoted bracket members and error messages are data).
 * Specifiers come from static and dynamic import positions (`from` /
 * `import` / `import(` / `require(`) plus any quoted string that is
 * specifier-shaped (starts with `@` or contains `/`); their interiors are
 * blanked from the identifier pass so package-name fragments cannot be
 * grounded word-by-word. Excluded deterministically: generic tokens and
 * ASCII-only tokens shorter than the minimum length (non-ASCII tokens always
 * require grounding). Declared names, function parameters, destructuring
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
      ...captureAll(content, QUOTED_STRING_REGEX).filter(isSpecifierShaped),
    ]
      .map((specifier) =>
        specifier.replace(TRAILING_SPECIFIER_PUNCTUATION_REGEX, ""),
      )
      .filter(
        (specifier) =>
          specifier.length >= CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH &&
          !GENERIC_TOKEN_SET.has(specifier.toLowerCase()),
      ),
  );
  // Quoted specifiers are validated as whole specifiers; blank their
  // interiors so their fragments are not reported or grounded separately.
  const tokenizable = content
    .replaceAll(QUOTED_MODULE_SPECIFIER_REGEX, (match) =>
      " ".repeat(match.length),
    )
    .replaceAll(QUOTED_STRING_REGEX, (match, value: string) =>
      isSpecifierShaped(value) ? " ".repeat(match.length) : match,
    );
  const identifiers = sortAndDedupeStrings(
    (tokenizable.match(IDENTIFIER_TOKEN_REGEX) ?? []).filter(
      (token) =>
        !isExemptShortToken(token) &&
        !GENERIC_TOKEN_SET.has(token.toLowerCase()),
    ),
  );
  return { identifiers, specifiers };
}

/**
 * Verifies that every reference token in the example content occurs in the
 * body or diff hunk of the comments the example cites. Identifiers match a
 * whole evidence token case-insensitively. Module specifiers match an
 * evidence specifier — a quoted string or a maximal specifier-pattern run,
 * with trailing `.`/`:`/`/`/`-` punctuation trimmed — as a whole,
 * case-sensitive string; substring containment is never sufficient. Missing
 * cited comments leave the evidence text empty, so unknown IDs fail closed.
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
    .join("\n");
  const evidenceTokens = new Set(
    evidenceText.toLowerCase().match(IDENTIFIER_TOKEN_REGEX) ?? [],
  );
  const evidenceSpecifiers = collectEvidenceSpecifiers(evidenceText);
  const tokens = extractCodeExampleReferenceTokens(example.content);
  const ungrounded = [
    ...tokens.identifiers.filter(
      (token) => !evidenceTokens.has(token.toLowerCase()),
    ),
    ...tokens.specifiers.filter(
      (specifier) => !evidenceSpecifiers.has(specifier),
    ),
  ];
  return {
    grounded: ungrounded.length === 0,
    ungrounded_tokens: sortAndDedupeStrings(ungrounded),
  };
}

/**
 * Collects every specifier-shaped string in the evidence text: quoted string
 * contents and maximal specifier-pattern runs, each also added with trailing
 * sentence punctuation trimmed so prose like `use @scope/pkg.` still grounds
 * the exact specifier without enabling prefix matches.
 */
function collectEvidenceSpecifiers(text: string): ReadonlySet<string> {
  const specifiers = new Set<string>();
  const add = (value: string): void => {
    if (value.length === 0) return;
    specifiers.add(value);
    const trimmed = value.replace(TRAILING_SPECIFIER_PUNCTUATION_REGEX, "");
    if (trimmed.length > 0) specifiers.add(trimmed);
  };
  for (const match of text.matchAll(QUOTED_EVIDENCE_STRING_REGEX)) {
    add(match[1]!);
  }
  for (const match of text.matchAll(SPECIFIER_RUN_REGEX)) {
    add(match[0]);
  }
  return specifiers;
}

/**
 * A quoted string is treated as a module specifier regardless of syntax
 * position when it starts with `@` or contains `/`. This keeps dynamic
 * imports and computed loaders on the whole-specifier match instead of
 * letting their path fragments be grounded word-by-word.
 */
function isSpecifierShaped(value: string): boolean {
  return value.startsWith("@") || value.includes("/");
}

/**
 * The minimum-length exemption exists for ubiquitous short ASCII idioms
 * (`id`, `db`, `fs`). Tokens containing any non-ASCII code point require
 * grounding regardless of length, so short Unicode names such as `Δx` cannot
 * bypass verification. Lengths are counted in code points.
 */
function isExemptShortToken(token: string): boolean {
  return (
    isAsciiOnly(token) &&
    codePointLength(token) < CODE_EXAMPLE_GROUNDING_MIN_TOKEN_LENGTH
  );
}

function isAsciiOnly(value: string): boolean {
  for (const character of value) {
    if (character.codePointAt(0)! > MAX_ASCII_CODE_POINT) return false;
  }
  return true;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function captureAll(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)].map((match) => match[1]!);
}

import { sortAndDedupeStrings } from "./canonical.js";
import type { GeneratedCodeExample } from "./domain-schemas.js";

/**
 * Deterministic grounding contract for generated code examples (design doc
 * §12). A code example may only reference names that appear in the body or
 * diff hunk of the review comments it cites. The contract is exhaustive
 * rather than positional: every identifier token in the content is a
 * candidate, and only deterministic exclusions (generic tokens, validated
 * module specifiers) remove a token from the requirement. There is no
 * length-based exemption: short names such as `db` require grounding, and
 * idiomatic loop variables are excluded only through the frozen generic
 * token list.
 * Declaring a name inside the example does not exempt it — otherwise a
 * fabricated type or API could be laundered through `interface Fabricated {}`
 * followed by a use. Fabricated function, type, and package names are
 * therefore rejected fail-closed regardless of the syntax — optional
 * chaining, unions, generics, `satisfies`, declarations, and future
 * constructs included. False positives deliberately fall on the rejection
 * side.
 */

/**
 * Frozen cross-language keywords, ubiquitous builtins, standard-library type
 * names, and idiomatic short names (loop variables, `id`, `_`) that carry no
 * repository-specific meaning. This list is the only exemption from
 * grounding and is pinned by tests; extending it is a spec change. API-like
 * short names such as `db` are deliberately absent. Matching is
 * case-insensitive, so lowercase entries also cover `Promise`, `Result`,
 * etc.
 */
export const CODE_EXAMPLE_GENERIC_TOKENS: readonly string[] = Object.freeze([
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
const SPECIFIER_RUN_REGEX = new RegExp(MODULE_SPECIFIER, "gu");

export interface CodeExampleEvidenceSource {
  readonly body: string;
  readonly diffHunk?: string;
  readonly id: string;
}

export interface CodeExampleReferenceTokens {
  /**
   * Every identifier token in the content that survives the deterministic
   * exclusions: generic tokens and the interior of validated module
   * specifiers. Declared names and short names are included.
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
 * specifier-shaped (starts with `@` or contains `/`); single quotes, double
 * quotes, and backticks all delimit specifiers, and a template literal with
 * `${...}` interpolation is matched as one whole string including the
 * interpolation text. Specifier interiors are blanked from the identifier
 * pass so package-name fragments cannot be grounded word-by-word. The only deterministic exclusion is the frozen
 * generic token list; there is no length-based exemption. Declared names,
 * function parameters, destructuring bindings, short names, and import-bound
 * names are intentionally not excluded; they fail closed toward requiring
 * grounding.
 */
export function extractCodeExampleReferenceTokens(
  content: string,
): CodeExampleReferenceTokens {
  const quotedStrings = extractQuotedStrings(content);
  const specifiers = sortAndDedupeStrings(
    [
      ...captureAll(content, MODULE_KEYWORD_TOKEN_REGEX),
      ...quotedStrings
        .filter(
          (quoted) =>
            hasModuleKeywordPrefix(content, quoted.start) ||
            isSpecifierShaped(quoted.value),
        )
        .map((quoted) => quoted.value),
    ]
      .map(trimTrailingSpecifierPunctuation)
      .filter(
        (specifier) =>
          specifier.length > 0 &&
          !GENERIC_TOKEN_SET.has(specifier.toLowerCase()),
      ),
  );
  // Quoted specifiers are validated as whole specifiers; blank their
  // interiors so their fragments are not reported or grounded separately.
  const tokenizable = blankQuotedSpecifiers(content, quotedStrings);
  const identifiers = sortAndDedupeStrings(
    (tokenizable.match(IDENTIFIER_TOKEN_REGEX) ?? []).filter(
      (token) => !GENERIC_TOKEN_SET.has(token.toLowerCase()),
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
    const trimmed = trimTrailingSpecifierPunctuation(value);
    if (trimmed.length > 0) specifiers.add(trimmed);
  };
  for (const quoted of extractQuotedStrings(text)) {
    add(quoted.value);
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

function captureAll(content: string, pattern: RegExp): string[] {
  return [...content.matchAll(pattern)].map((match) => match[1]!);
}

interface QuotedString {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

function extractQuotedStrings(content: string): QuotedString[] {
  const quoted: QuotedString[] = [];
  for (let start = 0; start < content.length; start += 1) {
    const delimiter = content[start];
    if (delimiter !== '"' && delimiter !== "'" && delimiter !== "`") continue;

    let end = start + 1;
    while (end < content.length && content[end] !== "\n") {
      if (content[end] === "\\" && end + 1 < content.length) {
        end += 2;
        continue;
      }
      if (content[end] === delimiter) break;
      end += 1;
    }
    if (end < content.length && content[end] === delimiter && end > start + 1) {
      quoted.push({
        end: end + 1,
        start,
        value: content.slice(start + 1, end),
      });
      start = end;
    }
  }
  return quoted;
}

function hasModuleKeywordPrefix(content: string, quoteStart: number): boolean {
  let cursor = skipWhitespaceBackward(content, quoteStart - 1);
  const hasParenthesis = content[cursor] === "(";
  if (hasParenthesis) cursor = skipWhitespaceBackward(content, cursor - 1);

  const keywordEnd = cursor + 1;
  while (cursor >= 0 && isAsciiWordCharacter(content[cursor]!)) cursor -= 1;
  const keyword = content.slice(cursor + 1, keywordEnd);
  if (
    cursor >= 0 &&
    (isAsciiWordCharacter(content[cursor]!) || content[cursor] === ".")
  ) {
    return false;
  }
  return (
    keyword === "import" ||
    (keyword === "require" && hasParenthesis) ||
    (keyword === "from" && !hasParenthesis)
  );
}

function skipWhitespaceBackward(content: string, start: number): number {
  let cursor = start;
  while (cursor >= 0 && content[cursor]!.trim().length === 0) cursor -= 1;
  return cursor;
}

function isAsciiWordCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_" ||
    character === "$"
  );
}

function blankQuotedSpecifiers(
  content: string,
  quotedStrings: readonly QuotedString[],
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const quoted of quotedStrings) {
    if (
      !hasModuleKeywordPrefix(content, quoted.start) &&
      !isSpecifierShaped(quoted.value)
    ) {
      continue;
    }
    parts.push(
      content.slice(cursor, quoted.start),
      " ".repeat(quoted.end - quoted.start),
    );
    cursor = quoted.end;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function trimTrailingSpecifierPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && ".:/-".includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

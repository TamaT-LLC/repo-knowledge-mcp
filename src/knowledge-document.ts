import { createHash } from "node:crypto";

import { parseDocument, stringify } from "yaml";

export interface KnowledgeFrontmatter extends Record<string, unknown> {
  readonly id: string;
  readonly repo_id: string;
  readonly revision: number;
  readonly schema_version: 1;
}

export interface KnowledgeDocument {
  readonly body: string;
  readonly etag: string;
  readonly frontmatter: KnowledgeFrontmatter;
  readonly path: string;
  readonly revision: number;
}

export interface KnowledgeDocumentPatch {
  readonly body?: string;
  readonly frontmatter?: Readonly<Record<string, unknown>>;
}

/** Raised when canonical Markdown cannot be projected safely. */
export class KnowledgeStoreInvalidError extends Error {
  readonly code = "KNOWLEDGE_STORE_INVALID";

  constructor(
    readonly path: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid knowledge document ${path}: ${reason}`, options);
    this.name = "KnowledgeStoreInvalidError";
  }
}

/** Computes an ETag from the exact file bytes, including formatting. */
export function computeByteSha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Parses a strict YAML-frontmatter knowledge document from its actual bytes. */
export function parseKnowledgeDocument(
  path: string,
  value: Uint8Array | string,
): KnowledgeDocument {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  let markdown: string;

  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new KnowledgeStoreInvalidError(path, "file is not valid UTF-8", {
      cause: error,
    });
  }

  let parsedFile: ParsedFrontmatter;

  try {
    parsedFile = parseYamlFrontmatter(markdown);
  } catch (error) {
    throw new KnowledgeStoreInvalidError(
      path,
      error instanceof Error ? error.message : "frontmatter parse failed",
      { cause: error },
    );
  }

  const frontmatter = validateFrontmatter(path, parsedFile.data);
  return {
    body: parsedFile.content,
    etag: computeByteSha256(bytes),
    frontmatter,
    path,
    revision: frontmatter.revision,
  };
}

/** Serializes frontmatter deterministically enough for tool-owned updates. */
export function serializeKnowledgeDocument(
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
): string {
  validateFrontmatter(path, frontmatter);

  try {
    return `---\n${stringifyYaml(frontmatter)}\n---\n${body}`;
  } catch (error) {
    throw new KnowledgeStoreInvalidError(
      path,
      error instanceof Error
        ? error.message
        : "frontmatter serialization failed",
      { cause: error },
    );
  }
}

/** Applies a tool-owned patch and increments revision exactly once. */
export function applyKnowledgeDocumentPatch(
  current: KnowledgeDocument,
  patch: KnowledgeDocumentPatch,
): string {
  if (patch.frontmatter && "revision" in patch.frontmatter) {
    throw new KnowledgeStoreInvalidError(
      current.path,
      "revision is managed by the canonical writer",
    );
  }

  const frontmatter = {
    ...current.frontmatter,
    ...patch.frontmatter,
    revision: current.revision + 1,
  };
  const body = patch.body ?? current.body;

  return serializeKnowledgeDocument(current.path, frontmatter, body);
}

function validateFrontmatter(
  path: string,
  value: unknown,
): KnowledgeFrontmatter {
  if (!isRecord(value)) {
    throw new KnowledgeStoreInvalidError(path, "frontmatter must be an object");
  }
  if (value.schema_version !== 1) {
    throw new KnowledgeStoreInvalidError(path, "schema_version must be 1");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new KnowledgeStoreInvalidError(path, "id must be a non-empty string");
  }
  if (typeof value.repo_id !== "string" || value.repo_id.length === 0) {
    throw new KnowledgeStoreInvalidError(
      path,
      "repo_id must be a non-empty string",
    );
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw new KnowledgeStoreInvalidError(
      path,
      "revision must be a positive safe integer",
    );
  }

  return value as KnowledgeFrontmatter;
}

function parseStrictYaml(source: string): object {
  const document = parseDocument(source, {
    merge: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) throw document.errors[0];
  const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isRecord(parsed)) throw new TypeError("frontmatter must be an object");
  return parsed;
}

interface ParsedFrontmatter {
  readonly content: string;
  readonly data: object;
}

/**
 * Splits only an exact YAML `---` block. Language suffixes are deliberately
 * rejected so untrusted Markdown can never select an executable parser.
 */
function parseYamlFrontmatter(markdown: string): ParsedFrontmatter {
  const openingEnd = markdown.startsWith("---\n")
    ? 4
    : markdown.startsWith("---\r\n")
      ? 5
      : -1;
  if (openingEnd === -1) {
    throw new TypeError("expected a YAML frontmatter block delimited by ---");
  }

  let lineStart = openingEnd;
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const contentEnd =
      lineEnd > lineStart && markdown.charCodeAt(lineEnd - 1) === 13
        ? lineEnd - 1
        : lineEnd;

    if (markdown.slice(lineStart, contentEnd) === "---") {
      return {
        content: newline === -1 ? "" : markdown.slice(newline + 1),
        data: parseStrictYaml(markdown.slice(openingEnd, lineStart)),
      };
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  throw new TypeError("frontmatter closing delimiter is missing");
}

function stringifyYaml(data: object): string {
  return stringify(data, { lineWidth: 0 }).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

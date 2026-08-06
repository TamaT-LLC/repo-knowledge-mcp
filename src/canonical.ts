import { createHash } from "node:crypto";

/**
 * Compares strings lexicographically as unsigned UTF-16 code units.
 *
 * ECMAScript relational string comparison is specified in terms of UTF-16 code
 * units and is independent of the host locale and ICU data.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns a new, code-unit-sorted array with duplicate strings removed. */
export function sortAndDedupeStrings(values: readonly string[]): string[] {
  const sorted = [...values].sort(compareCodeUnits);

  return sorted.filter(
    (value, index) =>
      index === 0 || compareCodeUnits(value, sorted[index - 1]!) !== 0,
  );
}

/**
 * Field names whose array values represent sets in the write-path payloads.
 * Both API snake_case and internal camelCase names are accepted at boundaries.
 */
export const SET_LIKE_STRING_ARRAY_FIELDS: ReadonlySet<string> = new Set([
  "candidateIds",
  "candidate_ids",
  "evidenceCommentIds",
  "evidence_comment_ids",
  "possibleMatchIds",
  "possible_match_ids",
  "scope",
  "sources",
  "trustedActorIds",
  "trustedLogins",
  "trusted_actor_ids",
  "trusted_logins",
]);

/**
 * Clones JSON-like input while sorting and deduplicating every declared set
 * field. Ordinary arrays retain their original order, as required by RFC 8785.
 */
export function normalizeSetArrays<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSetArrays(item)) as T;
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SET_LIKE_STRING_ARRAY_FIELDS.has(key)) {
      if (
        !Array.isArray(item) ||
        !item.every((entry) => typeof entry === "string")
      ) {
        throw new TypeError(`${key} must be an array of strings`);
      }
      normalized[key] = sortAndDedupeStrings(item);
      continue;
    }

    normalized[key] = normalizeSetArrays(item);
  }

  return normalized as T;
}

export interface NormalizableComment {
  readonly createdAt: string;
  readonly id: string;
}

/** Returns comments ordered deterministically by createdAt and then id. */
export function normalizeComments<T extends NormalizableComment>(
  comments: readonly T[],
): T[] {
  return [...comments].sort(
    (a, b) =>
      compareCodeUnits(a.createdAt, b.createdAt) ||
      compareCodeUnits(a.id, b.id),
  );
}

/** Serializes an I-JSON value according to RFC 8785 (JCS). */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("JCS does not support non-finite numbers");
      }
      return JSON.stringify(value);
    }
    case "string":
      assertWellFormedUnicode(value);
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`JCS does not support ${typeof value} values`);
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => canonicalizeJson(item)).join(",")}]`;
  }

  if (!isRecord(value)) {
    throw new TypeError("JCS only supports plain JSON objects");
  }

  const properties = Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => {
      assertWellFormedUnicode(key);
      return `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`;
    });

  return `{${properties.join(",")}}`;
}

/** Computes the lowercase hexadecimal SHA-256 digest of a JCS document. */
export function sha256Jcs(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex");
}

/** Normalizes declared set arrays before computing their JCS SHA-256 digest. */
export function sha256NormalizedJcs(value: unknown): string {
  return sha256Jcs(normalizeSetArrays(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JCS does not support lone UTF-16 surrogates");
      }
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS does not support lone UTF-16 surrogates");
    }
  }
}

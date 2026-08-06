import { canonicalizeJson } from "./canonical.js";
import { computeByteSha256 } from "./knowledge-document.js";

export interface CanonicalJsonlRecord<TPayload = unknown> {
  readonly payload: TPayload;
  readonly record_id: string;
  readonly record_type: string;
  readonly recorded_at: string;
  readonly schema_version: 1;
  readonly transaction_id: string;
}

export class CanonicalJsonlError extends Error {
  readonly code = "CANONICAL_LOG_CORRUPT";

  constructor(
    readonly path: string,
    readonly lineNumber: number,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid canonical JSONL at ${path}:${lineNumber}: ${reason}`,
      options,
    );
    this.name = "CanonicalJsonlError";
  }
}

/** Produces one complete canonical JSONL line, including its newline. */
export function serializeCanonicalJsonlRecord(
  record: CanonicalJsonlRecord,
): Buffer {
  validateCanonicalJsonlRecord("<record>", 1, record);
  return Buffer.from(`${canonicalizeJson(record)}\n`, "utf8");
}

/** Parses and validates one complete JSONL line without its trailing newline. */
export function parseCanonicalJsonlLine(
  path: string,
  lineNumber: number,
  line: string,
): CanonicalJsonlRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new CanonicalJsonlError(path, lineNumber, "invalid JSON", {
      cause: error,
    });
  }

  return validateCanonicalJsonlRecord(path, lineNumber, value);
}

export function canonicalJsonlLineSha256(line: Uint8Array): string {
  return computeByteSha256(line);
}

function validateCanonicalJsonlRecord(
  path: string,
  lineNumber: number,
  value: unknown,
): CanonicalJsonlRecord {
  if (!isRecord(value)) {
    throw new CanonicalJsonlError(path, lineNumber, "record must be an object");
  }
  if (value.schema_version !== 1) {
    throw new CanonicalJsonlError(path, lineNumber, "schema_version must be 1");
  }
  for (const key of [
    "record_id",
    "record_type",
    "transaction_id",
    "recorded_at",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new CanonicalJsonlError(
        path,
        lineNumber,
        `${key} must be a non-empty string`,
      );
    }
  }
  if (!("payload" in value)) {
    throw new CanonicalJsonlError(path, lineNumber, "payload is required");
  }

  return value as unknown as CanonicalJsonlRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { isAbsolute, normalize, sep } from "node:path";

export type CanonicalStoreErrorCode =
  | "CANONICAL_LOG_CORRUPT"
  | "CONFLICT"
  | "INVALID_CANONICAL_PATH"
  | "INVALID_TRANSACTION"
  | "RECORD_ID_CONFLICT"
  | "RECOVERY_CONFLICT"
  | "UNRECOVERABLE_TRANSACTION"
  | "UNSUPPORTED_PLATFORM";

export class CanonicalStoreError extends Error {
  constructor(
    readonly code: CanonicalStoreErrorCode,
    message: string,
    readonly transactionId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CanonicalStoreError";
  }
}

export function validateCanonicalPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    isAbsolute(path) ||
    normalize(path) !== path ||
    path === "." ||
    path.split("/").some((segment) => segment === "" || segment === "..") ||
    path === ".write.lock" ||
    path === "index.sqlite" ||
    path.startsWith("index.sqlite-")
  ) {
    throw new CanonicalStoreError(
      "INVALID_CANONICAL_PATH",
      `Invalid repository-relative path: ${path}`,
    );
  }
  if (path.startsWith("transactions/") && !/^transactions\/txn_/u.test(path)) {
    throw new CanonicalStoreError(
      "INVALID_CANONICAL_PATH",
      `Invalid transaction path: ${path}`,
    );
  }
}

export function validateCanonicalTargetPath(path: string): void {
  validateCanonicalPath(path);
  if (
    path === "transactions" ||
    path.startsWith("transactions/") ||
    path === ".write.lock" ||
    path.startsWith(".write.lock/") ||
    path === "index.sqlite" ||
    path.startsWith("index.sqlite-") ||
    path.startsWith("index.sqlite/")
  ) {
    throw new CanonicalStoreError(
      "INVALID_CANONICAL_PATH",
      `Canonical targets cannot use a reserved path: ${path}`,
    );
  }
}

export function validateKnowledgePath(path: string): void {
  validateCanonicalTargetPath(path);
  if (!/^knowledge\/[^/]+\.md$/u.test(path)) {
    throw new CanonicalStoreError(
      "INVALID_CANONICAL_PATH",
      `Knowledge path must match knowledge/*.md: ${path}`,
    );
  }
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function validateSha256OrNull(
  value: string | null,
  transactionId: string,
): void {
  if (value !== null && !isSha256(value)) {
    throw new CanonicalStoreError(
      "INVALID_TRANSACTION",
      `Invalid SHA-256 precondition: ${value}`,
      transactionId,
    );
  }
}

export function decodeUtf8(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CanonicalStoreError(
      "CANONICAL_LOG_CORRUPT",
      `${path} is not valid UTF-8`,
      undefined,
      { cause: error },
    );
  }
}

export function dirnameOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index < 0 ? "." : path.slice(0, index);
}

export function transactionStagedPath(
  transactionId: string,
  kind: "appends" | "files",
  name: string,
): string {
  return `transactions/${transactionId}/staged/${kind}/${name}`;
}

export function formatOrdinal(value: number): string {
  return value.toString().padStart(4, "0");
}

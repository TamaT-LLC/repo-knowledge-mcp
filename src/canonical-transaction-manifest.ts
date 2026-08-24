import { open, readFile, truncate } from "node:fs/promises";

import {
  canonicalJsonlLineSha256,
  parseCanonicalJsonlLine,
} from "./canonical-jsonl.js";
import { canonicalizeJson } from "./canonical.js";
import {
  CanonicalStoreError,
  decodeUtf8,
  dirnameOf,
  formatOrdinal,
  isSha256,
  transactionStagedPath,
  validateCanonicalPath,
  validateCanonicalTargetPath,
  validateSha256OrNull,
} from "./canonical-path-validation.js";
import type { CanonicalTransactionRequest } from "./canonical-transaction-store.js";
import {
  appendDurable,
  assertRegularFileOrMissing,
  fsyncDirectory,
} from "./durable-fs.js";

export interface ManifestPrecondition {
  readonly expected_sha256: string | null;
  readonly path: string;
}

export interface ManifestFileWrite {
  readonly new_sha256: string;
  readonly ordinal: number;
  readonly staged_path: string;
  readonly target_path: string;
}

export interface ManifestAppendRecord {
  readonly line_sha256: string;
  readonly ordinal: number;
  readonly record_id: string;
  readonly staged_path: string;
  readonly target_path: string;
}

export interface CanonicalTransactionManifest {
  readonly append_records: readonly ManifestAppendRecord[];
  readonly created_at: string;
  readonly file_writes: readonly ManifestFileWrite[];
  readonly preconditions: readonly ManifestPrecondition[];
  readonly schema_version: 1;
  readonly state: "prepared";
  readonly transaction_id: string;
}

export interface CommittedMarker {
  readonly committed_at: string;
  readonly manifest_sha256: string;
  readonly schema_version: 1;
  readonly transaction_id: string;
}

export interface ExistingRecord {
  readonly lineSha256: string;
}

export function validateRequest(request: CanonicalTransactionRequest): void {
  if (!/^txn_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.transactionId)) {
    throw new CanonicalStoreError(
      "INVALID_TRANSACTION",
      `Invalid transaction ID: ${request.transactionId}`,
      request.transactionId,
    );
  }
  if (
    typeof request.createdAt !== "string" ||
    request.createdAt.length === 0 ||
    Number.isNaN(Date.parse(request.createdAt))
  ) {
    throw new CanonicalStoreError(
      "INVALID_TRANSACTION",
      "createdAt must be a valid timestamp",
      request.transactionId,
    );
  }
  if (request.fileWrites.length === 0 && request.appendRecords.length === 0) {
    throw new CanonicalStoreError(
      "INVALID_TRANSACTION",
      "A canonical transaction must contain at least one operation",
      request.transactionId,
    );
  }
  const fileTargets = new Set<string>();
  for (const item of request.fileWrites) {
    validateCanonicalTargetPath(item.targetPath);
    if (item.targetPath.endsWith(".jsonl")) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Canonical JSONL must use appendRecords: ${item.targetPath}`,
        request.transactionId,
      );
    }
    validateSha256OrNull(item.expectedSha256, request.transactionId);
    if (fileTargets.has(item.targetPath)) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Duplicate file write target: ${item.targetPath}`,
        request.transactionId,
      );
    }
    fileTargets.add(item.targetPath);
  }

  const recordIds = new Set<string>();
  for (const item of request.appendRecords) {
    validateCanonicalTargetPath(item.targetPath);
    if (item.record.transaction_id !== request.transactionId) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Record ${item.record.record_id} is bound to a different transaction`,
        request.transactionId,
      );
    }
    if (!item.targetPath.endsWith(".jsonl")) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Append target must end in .jsonl: ${item.targetPath}`,
        request.transactionId,
      );
    }
    if (fileTargets.has(item.targetPath)) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `A path cannot be both a file write and append target: ${item.targetPath}`,
        request.transactionId,
      );
    }
    if (recordIds.has(item.record.record_id)) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Duplicate record ID: ${item.record.record_id}`,
        request.transactionId,
      );
    }
    recordIds.add(item.record.record_id);
  }
}

export function parseManifest(
  directoryTransactionId: string,
  bytes: Buffer,
): CanonicalTransactionManifest {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8("manifest.json", bytes)) as unknown;
  } catch (error) {
    throw new CanonicalStoreError(
      "UNRECOVERABLE_TRANSACTION",
      `Manifest for ${directoryTransactionId} is not valid JSON`,
      directoryTransactionId,
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw invalidManifest(directoryTransactionId, "manifest must be an object");
  }
  if (
    value.schema_version !== 1 ||
    value.state !== "prepared" ||
    value.transaction_id !== directoryTransactionId ||
    typeof value.created_at !== "string" ||
    !Array.isArray(value.preconditions) ||
    !Array.isArray(value.file_writes) ||
    !Array.isArray(value.append_records)
  ) {
    throw invalidManifest(directoryTransactionId, "invalid manifest envelope");
  }

  const preconditions = value.preconditions.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      !(
        item.expected_sha256 === null ||
        typeof item.expected_sha256 === "string"
      )
    ) {
      throw invalidManifest(
        directoryTransactionId,
        `invalid precondition ${index + 1}`,
      );
    }
    validateCanonicalTargetPath(item.path);
    validateSha256OrNull(item.expected_sha256, directoryTransactionId);
    return {
      expected_sha256: item.expected_sha256,
      path: item.path,
    };
  });
  const expectedByTarget = new Map(
    preconditions.map((item) => [item.path, item.expected_sha256]),
  );
  if (expectedByTarget.size !== preconditions.length) {
    throw invalidManifest(
      directoryTransactionId,
      "duplicate precondition path",
    );
  }

  const fileWrites = value.file_writes.map((item, index) => {
    const ordinal = index + 1;
    if (
      !isRecord(item) ||
      typeof item.target_path !== "string" ||
      typeof item.staged_path !== "string" ||
      typeof item.new_sha256 !== "string" ||
      item.ordinal !== ordinal
    ) {
      throw invalidManifest(
        directoryTransactionId,
        `invalid file write ${ordinal}`,
      );
    }
    validateCanonicalTargetPath(item.target_path);
    validateCanonicalPath(item.staged_path);
    if (
      item.staged_path !==
        transactionStagedPath(
          directoryTransactionId,
          "files",
          `${formatOrdinal(ordinal)}.new`,
        ) ||
      !isSha256(item.new_sha256) ||
      item.target_path.endsWith(".jsonl") ||
      !expectedByTarget.has(item.target_path)
    ) {
      throw invalidManifest(
        directoryTransactionId,
        `invalid file write binding ${ordinal}`,
      );
    }
    return {
      new_sha256: item.new_sha256,
      ordinal,
      staged_path: item.staged_path,
      target_path: item.target_path,
    };
  });
  if (
    new Set(fileWrites.map((item) => item.target_path)).size !==
    fileWrites.length
  ) {
    throw invalidManifest(
      directoryTransactionId,
      "duplicate file write target",
    );
  }
  if (fileWrites.length !== preconditions.length) {
    throw invalidManifest(
      directoryTransactionId,
      "file writes and preconditions must be one-to-one",
    );
  }

  const appendRecords = value.append_records.map((item, index) => {
    const ordinal = index + 1;
    if (
      !isRecord(item) ||
      typeof item.target_path !== "string" ||
      typeof item.staged_path !== "string" ||
      typeof item.record_id !== "string" ||
      typeof item.line_sha256 !== "string" ||
      item.ordinal !== ordinal
    ) {
      throw invalidManifest(
        directoryTransactionId,
        `invalid append record ${ordinal}`,
      );
    }
    validateCanonicalTargetPath(item.target_path);
    validateCanonicalPath(item.staged_path);
    if (
      item.staged_path !==
        transactionStagedPath(
          directoryTransactionId,
          "appends",
          `${formatOrdinal(ordinal)}.jsonl`,
        ) ||
      !item.target_path.endsWith(".jsonl") ||
      !isSha256(item.line_sha256) ||
      item.record_id.length === 0
    ) {
      throw invalidManifest(
        directoryTransactionId,
        `invalid append binding ${ordinal}`,
      );
    }
    return {
      line_sha256: item.line_sha256,
      ordinal,
      record_id: item.record_id,
      staged_path: item.staged_path,
      target_path: item.target_path,
    };
  });
  if (
    new Set(appendRecords.map((item) => item.record_id)).size !==
    appendRecords.length
  ) {
    throw invalidManifest(directoryTransactionId, "duplicate append record ID");
  }
  const fileTargetSet = new Set(fileWrites.map((item) => item.target_path));
  if (appendRecords.some((item) => fileTargetSet.has(item.target_path))) {
    throw invalidManifest(
      directoryTransactionId,
      "a path cannot be both a file write and append target",
    );
  }

  const manifest: CanonicalTransactionManifest = {
    append_records: appendRecords,
    created_at: value.created_at,
    file_writes: fileWrites,
    preconditions,
    schema_version: 1,
    state: "prepared",
    transaction_id: directoryTransactionId,
  };
  const canonicalBytes = Buffer.from(`${canonicalizeJson(manifest)}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw invalidManifest(
      directoryTransactionId,
      "manifest bytes are not canonical",
    );
  }
  return manifest;
}

export function parseCommittedMarker(
  transactionId: string,
  bytes: Buffer,
): CommittedMarker {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8("COMMITTED", bytes)) as unknown;
  } catch (error) {
    throw new CanonicalStoreError(
      "UNRECOVERABLE_TRANSACTION",
      `COMMITTED marker for ${transactionId} is invalid JSON`,
      transactionId,
      { cause: error },
    );
  }
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.transaction_id !== transactionId ||
    typeof value.manifest_sha256 !== "string" ||
    typeof value.committed_at !== "string"
  ) {
    throw new CanonicalStoreError(
      "UNRECOVERABLE_TRANSACTION",
      `COMMITTED marker for ${transactionId} is invalid`,
      transactionId,
    );
  }
  const marker = value as unknown as CommittedMarker;
  const canonicalBytes = Buffer.from(`${canonicalizeJson(marker)}\n`, "utf8");
  if (!bytes.equals(canonicalBytes)) {
    throw new CanonicalStoreError(
      "UNRECOVERABLE_TRANSACTION",
      `COMMITTED marker for ${transactionId} is not canonical`,
      transactionId,
    );
  }
  return marker;
}

export async function inspectJsonlTarget(
  displayPath: string,
  absolutePath: string,
  expectedRecordId: string,
  repairIncompleteTail: boolean,
): Promise<ExistingRecord | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (bytes.length === 0) return null;

  if (bytes.at(-1) !== 0x0a) {
    if (!repairIncompleteTail) {
      throw new CanonicalStoreError(
        "CANONICAL_LOG_CORRUPT",
        `${displayPath} has an incomplete final line`,
      );
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeLength = lastNewline + 1;
    const corruptBytes = bytes.subarray(completeLength);
    const corruptPath = `${absolutePath}.corrupt`;
    await assertRegularFileOrMissing(corruptPath, displayPath);
    await appendDurable(corruptPath, corruptBytes);
    await fsyncDirectory(dirnameOf(corruptPath));
    await truncate(absolutePath, completeLength);
    const handle = await open(absolutePath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    bytes = bytes.subarray(0, completeLength);
  }

  let start = 0;
  let lineNumber = 1;
  let found: ExistingRecord | null = null;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const lineBytes = bytes.subarray(start, index);
    if (lineBytes.length === 0) {
      throw new CanonicalStoreError(
        "CANONICAL_LOG_CORRUPT",
        `${displayPath}:${lineNumber} is empty`,
      );
    }
    const record = parseCanonicalJsonlLine(
      displayPath,
      lineNumber,
      decodeUtf8(displayPath, lineBytes),
    );
    if (record.record_id === expectedRecordId) {
      if (found !== null) {
        throw new CanonicalStoreError(
          "RECORD_ID_CONFLICT",
          `Record ${expectedRecordId} appears more than once in ${displayPath}`,
        );
      }
      found = {
        lineSha256: canonicalJsonlLineSha256(bytes.subarray(start, index + 1)),
      };
    }
    lineNumber += 1;
    start = index + 1;
  }
  return found;
}

function invalidManifest(
  transactionId: string,
  reason: string,
): CanonicalStoreError {
  return new CanonicalStoreError(
    "UNRECOVERABLE_TRANSACTION",
    `Invalid manifest for ${transactionId}: ${reason}`,
    transactionId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

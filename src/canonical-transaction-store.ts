import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import {
  canonicalJsonlLineSha256,
  parseCanonicalJsonlLine,
  serializeCanonicalJsonlRecord,
  type CanonicalJsonlRecord,
} from "./canonical-jsonl.js";
import { findCanonicalJsonlPaths } from "./canonical-files.js";
import { canonicalizeJson, compareCodeUnits } from "./canonical.js";
import {
  applyKnowledgeDocumentPatch,
  computeByteSha256,
  parseKnowledgeDocument,
  type KnowledgeDocument,
  type KnowledgeDocumentPatch,
} from "./knowledge-document.js";
import { withPosixFileLock } from "./posix-file-lock.js";
import {
  SqliteCanonicalProjection,
  type CanonicalKnowledgeReadView,
  type CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";
import type {
  ExhaustiveKnowledgeSearchRequest,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
} from "./knowledge-search.js";

export type CanonicalCommitPoint =
  | "after_staged_payloads"
  | "after_manifest_temp"
  | "after_prepared"
  | "after_file_write"
  | "before_append_write"
  | "after_append_write"
  | "after_committed_marker_temp"
  | "after_committed"
  | "after_projection";

export interface CanonicalFaultContext {
  readonly lineBytes?: Uint8Array;
  readonly repositoryRoot: string;
  readonly targetPath?: string;
  readonly transactionId: string;
}

export type CanonicalFaultInjector = (
  point: CanonicalCommitPoint,
  context: CanonicalFaultContext,
) => Promise<void> | void;

export interface CanonicalFileWriteRequest {
  readonly content: Uint8Array | string;
  readonly expectedSha256: string | null;
  readonly targetPath: string;
}

export interface CanonicalAppendRecordRequest {
  readonly record: CanonicalJsonlRecord;
  readonly targetPath: string;
}

export interface CanonicalTransactionRequest {
  readonly appendRecords: readonly CanonicalAppendRecordRequest[];
  readonly createdAt: string;
  readonly fileWrites: readonly CanonicalFileWriteRequest[];
  readonly transactionId: string;
}

export interface KnowledgeUpdateRequest {
  readonly expectedEtag: string;
  readonly expectedRevision: number;
  readonly patch: KnowledgeDocumentPatch;
  readonly targetPath: string;
  readonly transactionId: string;
}

interface ManifestPrecondition {
  readonly expected_sha256: string | null;
  readonly path: string;
}

interface ManifestFileWrite {
  readonly new_sha256: string;
  readonly ordinal: number;
  readonly staged_path: string;
  readonly target_path: string;
}

interface ManifestAppendRecord {
  readonly line_sha256: string;
  readonly ordinal: number;
  readonly record_id: string;
  readonly staged_path: string;
  readonly target_path: string;
}

interface CanonicalTransactionManifest {
  readonly append_records: readonly ManifestAppendRecord[];
  readonly created_at: string;
  readonly file_writes: readonly ManifestFileWrite[];
  readonly preconditions: readonly ManifestPrecondition[];
  readonly schema_version: 1;
  readonly state: "prepared";
  readonly transaction_id: string;
}

interface CommittedMarker {
  readonly committed_at: string;
  readonly manifest_sha256: string;
  readonly schema_version: 1;
  readonly transaction_id: string;
}

interface ExistingRecord {
  readonly lineSha256: string;
}

interface ExistingRecordLocation extends ExistingRecord {
  readonly targetPath: string;
}

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

export class KnowledgeConflictError extends Error {
  readonly code = "KNOWLEDGE_CONFLICT";

  constructor(readonly current: KnowledgeDocument) {
    super(`Knowledge document ${current.path} changed since it was read`);
    this.name = "KnowledgeConflictError";
  }
}

export interface CanonicalTransactionStoreOptions {
  readonly faultInjector?: CanonicalFaultInjector;
  readonly lockTimeoutMs?: number;
}

/**
 * POSIX local-filesystem canonical writer with a recoverable transaction
 * journal and a derived SQLite projection.
 */
export class CanonicalTransactionStore {
  readonly repositoryRoot: string;

  private readonly faultInjector: CanonicalFaultInjector | undefined;
  private readonly lockTimeoutMs: number;
  private readonly projection: SqliteCanonicalProjection;

  constructor(
    repositoryRoot: string,
    options: CanonicalTransactionStoreOptions = {},
  ) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new CanonicalStoreError(
        "UNSUPPORTED_PLATFORM",
        `M1 canonical storage supports macOS and Linux, not ${process.platform}`,
      );
    }
    this.repositoryRoot = resolve(repositoryRoot);
    this.faultInjector = options.faultInjector;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.projection = new SqliteCanonicalProjection(this.repositoryRoot);
  }

  async commit(request: CanonicalTransactionRequest): Promise<void> {
    await this.withRepoLock(async () => {
      await this.recoverLocked();
      await this.projection.ensureCurrent();
      await this.commitLocked(request);
    });
  }

  async recover(): Promise<void> {
    await this.withRepoLock(async () => this.recoverLocked());
  }

  async readSnapshot(): Promise<CanonicalProjectionSnapshot> {
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      return this.projection.ensureCurrent();
    });
  }

  async reindex(): Promise<CanonicalProjectionSnapshot> {
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      return this.projection.rebuild();
    });
  }

  async searchKnowledge(
    request: KnowledgeSearchRequest,
  ): Promise<KnowledgeSearchResult> {
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      return this.projection.searchKnowledge(request);
    });
  }

  async readKnowledgeView(
    searchRequest?: ExhaustiveKnowledgeSearchRequest,
  ): Promise<CanonicalKnowledgeReadView> {
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      return this.projection.readKnowledgeView(searchRequest);
    });
  }

  async readKnowledge(targetPath: string): Promise<KnowledgeDocument> {
    validateKnowledgePath(targetPath);
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      await this.projection.ensureCurrent();
      const absolutePath = await this.resolveCanonicalPath(targetPath);
      const bytes = await readFile(absolutePath);
      return parseKnowledgeDocument(targetPath, bytes);
    });
  }

  async updateKnowledge(
    request: KnowledgeUpdateRequest,
  ): Promise<KnowledgeDocument> {
    validateKnowledgePath(request.targetPath);
    return this.withRepoLock(async () => {
      await this.recoverLocked();
      await this.projection.ensureCurrent();
      const absolutePath = await this.resolveCanonicalPath(request.targetPath);
      const current = parseKnowledgeDocument(
        request.targetPath,
        await readFile(absolutePath),
      );
      if (
        current.revision !== request.expectedRevision ||
        current.etag !== request.expectedEtag
      ) {
        throw new KnowledgeConflictError(current);
      }

      const content = applyKnowledgeDocumentPatch(current, request.patch);
      await this.commitLocked({
        appendRecords: [],
        createdAt: new Date().toISOString(),
        fileWrites: [
          {
            content,
            expectedSha256: current.etag,
            targetPath: request.targetPath,
          },
        ],
        transactionId: request.transactionId,
      });

      return parseKnowledgeDocument(request.targetPath, content);
    });
  }

  private async commitLocked(
    request: CanonicalTransactionRequest,
  ): Promise<void> {
    validateRequest(request);
    for (const item of request.appendRecords) {
      const line = serializeCanonicalJsonlRecord(item.record);
      const existing = await this.findCanonicalRecord(item.record.record_id);
      if (
        existing &&
        (existing.targetPath !== item.targetPath ||
          existing.lineSha256 !== canonicalJsonlLineSha256(line))
      ) {
        throw new CanonicalStoreError(
          "RECORD_ID_CONFLICT",
          `Record ${item.record.record_id} already exists at ${existing.targetPath}`,
          request.transactionId,
        );
      }
    }
    const transactionDirectory = join(
      this.repositoryRoot,
      "transactions",
      request.transactionId,
    );
    const stagedFilesDirectory = join(transactionDirectory, "staged", "files");
    const stagedAppendsDirectory = join(
      transactionDirectory,
      "staged",
      "appends",
    );

    try {
      await mkdir(stagedFilesDirectory, { mode: 0o700, recursive: true });
      await mkdir(stagedAppendsDirectory, { mode: 0o700, recursive: true });
    } catch (error) {
      throw new CanonicalStoreError(
        "INVALID_TRANSACTION",
        `Cannot create transaction ${request.transactionId}`,
        request.transactionId,
        { cause: error },
      );
    }

    const preconditions: ManifestPrecondition[] = [];
    const fileWrites: ManifestFileWrite[] = [];
    const appendRecords: ManifestAppendRecord[] = [];

    for (const [index, item] of request.fileWrites.entries()) {
      await this.assertPrecondition(
        item.targetPath,
        item.expectedSha256,
        request.transactionId,
        false,
      );
      const ordinal = index + 1;
      const stagedPath = transactionStagedPath(
        request.transactionId,
        "files",
        `${formatOrdinal(ordinal)}.new`,
      );
      const bytes = toBuffer(item.content);
      await writeDurable(join(this.repositoryRoot, stagedPath), bytes, "wx");
      preconditions.push({
        expected_sha256: item.expectedSha256,
        path: item.targetPath,
      });
      fileWrites.push({
        new_sha256: computeByteSha256(bytes),
        ordinal,
        staged_path: stagedPath,
        target_path: item.targetPath,
      });
    }

    for (const [index, item] of request.appendRecords.entries()) {
      if (item.record.transaction_id !== request.transactionId) {
        throw new CanonicalStoreError(
          "INVALID_TRANSACTION",
          `Record ${item.record.record_id} is bound to a different transaction`,
          request.transactionId,
        );
      }
      const ordinal = index + 1;
      const stagedPath = transactionStagedPath(
        request.transactionId,
        "appends",
        `${formatOrdinal(ordinal)}.jsonl`,
      );
      const line = serializeCanonicalJsonlRecord(item.record);
      await writeDurable(join(this.repositoryRoot, stagedPath), line, "wx");
      appendRecords.push({
        line_sha256: canonicalJsonlLineSha256(line),
        ordinal,
        record_id: item.record.record_id,
        staged_path: stagedPath,
        target_path: item.targetPath,
      });
    }

    await fsyncDirectory(stagedFilesDirectory);
    await fsyncDirectory(stagedAppendsDirectory);

    await this.injectFault("after_staged_payloads", request.transactionId);

    for (const precondition of preconditions) {
      await this.assertPrecondition(
        precondition.path,
        precondition.expected_sha256,
        request.transactionId,
        false,
      );
    }

    const manifest: CanonicalTransactionManifest = {
      append_records: appendRecords,
      created_at: request.createdAt,
      file_writes: fileWrites,
      preconditions,
      schema_version: 1,
      state: "prepared",
      transaction_id: request.transactionId,
    };
    const manifestBytes = Buffer.from(
      `${canonicalizeJson(manifest)}\n`,
      "utf8",
    );
    const manifestTempPath = join(transactionDirectory, "manifest.tmp");
    const manifestPath = join(transactionDirectory, "manifest.json");
    await writeDurable(manifestTempPath, manifestBytes, "wx");
    await this.injectFault("after_manifest_temp", request.transactionId);
    await rename(manifestTempPath, manifestPath);
    await fsyncDirectory(transactionDirectory);
    await this.injectFault("after_prepared", request.transactionId);

    await this.applyPreparedTransaction(manifest, false);
    await this.writeCommittedMarker(manifest, manifestBytes);
    await this.projection.rebuild(request.transactionId);
    await this.injectFault("after_projection", request.transactionId);
    await this.cleanupTransaction(request.transactionId);
  }

  private async recoverLocked(): Promise<void> {
    const transactionsDirectory = join(this.repositoryRoot, "transactions");
    const entries = await readdir(transactionsDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries.sort((a, b) =>
      compareCodeUnits(a.name, b.name),
    )) {
      if (!entry.isDirectory()) {
        throw new CanonicalStoreError(
          "UNRECOVERABLE_TRANSACTION",
          `Unexpected entry in transactions/: ${entry.name}`,
        );
      }
      const transactionId = entry.name;
      const transactionDirectory = join(transactionsDirectory, transactionId);
      const manifestPath = join(transactionDirectory, "manifest.json");
      let manifestBytes: Buffer;
      try {
        manifestBytes = await readFile(manifestPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (await pathExists(join(transactionDirectory, "COMMITTED"))) {
          throw new CanonicalStoreError(
            "UNRECOVERABLE_TRANSACTION",
            `Transaction ${transactionId} has COMMITTED but no manifest`,
            transactionId,
          );
        }
        await rm(transactionDirectory, { force: true, recursive: true });
        await fsyncDirectory(transactionsDirectory);
        continue;
      }

      const manifest = parseManifest(transactionId, manifestBytes);
      const committedPath = join(transactionDirectory, "COMMITTED");
      if (await pathExists(committedPath)) {
        const marker = parseCommittedMarker(
          transactionId,
          await readFile(committedPath),
        );
        const expectedManifestHash = `sha256:${computeByteSha256(manifestBytes)}`;
        if (marker.manifest_sha256 !== expectedManifestHash) {
          throw new CanonicalStoreError(
            "UNRECOVERABLE_TRANSACTION",
            `COMMITTED marker for ${transactionId} does not match manifest bytes`,
            transactionId,
          );
        }
      } else {
        await this.applyPreparedTransaction(manifest, true);
        await this.writeCommittedMarker(manifest, manifestBytes, false);
      }

      await this.projection.rebuild(transactionId);
      await this.cleanupTransaction(transactionId);
    }
  }

  private async applyPreparedTransaction(
    manifest: CanonicalTransactionManifest,
    recovery: boolean,
  ): Promise<void> {
    const preconditions = new Map(
      manifest.preconditions.map((item) => [item.path, item.expected_sha256]),
    );
    for (const fileWrite of [...manifest.file_writes].sort(
      (a, b) => a.ordinal - b.ordinal,
    )) {
      await this.applyFileWrite(
        manifest.transaction_id,
        fileWrite,
        preconditions.get(fileWrite.target_path) ?? null,
        recovery,
      );
      if (!recovery) {
        await this.injectFault("after_file_write", manifest.transaction_id, {
          targetPath: fileWrite.target_path,
        });
      }
    }

    for (const appendRecord of [...manifest.append_records].sort(
      (a, b) => a.ordinal - b.ordinal,
    )) {
      await this.applyAppendRecord(
        manifest.transaction_id,
        appendRecord,
        recovery,
      );
    }
  }

  private async applyFileWrite(
    transactionId: string,
    item: ManifestFileWrite,
    expectedSha256: string | null,
    recovery: boolean,
  ): Promise<void> {
    const targetPath = await this.resolveCanonicalPath(item.target_path, true);
    const currentSha256 = await hashFileOrNull(targetPath);
    if (currentSha256 === item.new_sha256) return;
    if (currentSha256 !== expectedSha256) {
      throw new CanonicalStoreError(
        recovery ? "RECOVERY_CONFLICT" : "CONFLICT",
        `Precondition failed for ${item.target_path}`,
        transactionId,
      );
    }

    const stagedPath = await this.resolveCanonicalPath(item.staged_path, true);
    let stagedBytes: Buffer;
    try {
      stagedBytes = await readFile(stagedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CanonicalStoreError(
          "UNRECOVERABLE_TRANSACTION",
          `Staged file is missing for ${item.target_path}`,
          transactionId,
          { cause: error },
        );
      }
      throw error;
    }
    if (computeByteSha256(stagedBytes) !== item.new_sha256) {
      throw new CanonicalStoreError(
        "UNRECOVERABLE_TRANSACTION",
        `Staged file hash is invalid for ${item.target_path}`,
        transactionId,
      );
    }

    await mkdir(dirnameOf(targetPath), { mode: 0o700, recursive: true });
    await this.assertNoSymlinkComponents(item.target_path, true);
    await rename(stagedPath, targetPath);
    await fsyncDirectory(dirnameOf(targetPath));
  }

  private async applyAppendRecord(
    transactionId: string,
    item: ManifestAppendRecord,
    recovery: boolean,
  ): Promise<void> {
    const targetPath = await this.resolveCanonicalPath(item.target_path, true);
    await mkdir(dirnameOf(targetPath), { mode: 0o700, recursive: true });
    await this.assertNoSymlinkComponents(item.target_path, true);
    const existing = await this.findCanonicalRecord(
      item.record_id,
      recovery ? item.target_path : undefined,
    );
    if (existing) {
      if (
        existing.targetPath !== item.target_path ||
        existing.lineSha256 !== item.line_sha256
      ) {
        throw new CanonicalStoreError(
          "RECORD_ID_CONFLICT",
          `Record ${item.record_id} already exists at ${existing.targetPath} with incompatible bytes or path`,
          transactionId,
        );
      }
      return;
    }

    const stagedPath = await this.resolveCanonicalPath(item.staged_path, true);
    let lineBytes: Buffer;
    try {
      lineBytes = await readFile(stagedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CanonicalStoreError(
          "UNRECOVERABLE_TRANSACTION",
          `Staged append is missing for ${item.record_id}`,
          transactionId,
          { cause: error },
        );
      }
      throw error;
    }
    if (canonicalJsonlLineSha256(lineBytes) !== item.line_sha256) {
      throw new CanonicalStoreError(
        "UNRECOVERABLE_TRANSACTION",
        `Staged append hash is invalid for ${item.record_id}`,
        transactionId,
      );
    }
    if (lineBytes.at(-1) !== 0x0a || lineBytes.subarray(0, -1).includes(0x0a)) {
      throw new CanonicalStoreError(
        "UNRECOVERABLE_TRANSACTION",
        `Staged append for ${item.record_id} is not exactly one complete line`,
        transactionId,
      );
    }
    const stagedRecord = parseCanonicalJsonlLine(
      item.staged_path,
      1,
      decodeUtf8(item.staged_path, lineBytes.subarray(0, -1)),
    );
    if (
      stagedRecord.record_id !== item.record_id ||
      stagedRecord.transaction_id !== transactionId
    ) {
      throw new CanonicalStoreError(
        "UNRECOVERABLE_TRANSACTION",
        `Staged append identity is invalid for ${item.record_id}`,
        transactionId,
      );
    }

    if (!recovery) {
      await this.injectFault("before_append_write", transactionId, {
        lineBytes,
        targetPath: item.target_path,
      });
    }
    await appendDurable(targetPath, lineBytes);
    if (!recovery) {
      await this.injectFault("after_append_write", transactionId, {
        targetPath: item.target_path,
      });
    }
  }

  private async findCanonicalRecord(
    recordId: string,
    repairIncompleteTargetPath?: string,
  ): Promise<ExistingRecordLocation | null> {
    let found: ExistingRecordLocation | null = null;
    for (const targetPath of await findCanonicalJsonlPaths(
      this.repositoryRoot,
    )) {
      const existing = await inspectJsonlTarget(
        targetPath,
        join(this.repositoryRoot, targetPath),
        recordId,
        targetPath === repairIncompleteTargetPath,
      );
      if (!existing) continue;
      if (found) {
        throw new CanonicalStoreError(
          "RECORD_ID_CONFLICT",
          `Record ${recordId} appears in both ${found.targetPath} and ${targetPath}`,
        );
      }
      found = { ...existing, targetPath };
    }
    return found;
  }

  private async writeCommittedMarker(
    manifest: CanonicalTransactionManifest,
    manifestBytes: Buffer,
    injectFault = true,
  ): Promise<void> {
    const transactionDirectory = join(
      this.repositoryRoot,
      "transactions",
      manifest.transaction_id,
    );
    const marker: CommittedMarker = {
      committed_at: new Date().toISOString(),
      manifest_sha256: `sha256:${computeByteSha256(manifestBytes)}`,
      schema_version: 1,
      transaction_id: manifest.transaction_id,
    };
    const markerBytes = Buffer.from(`${canonicalizeJson(marker)}\n`, "utf8");
    const temporaryPath = join(transactionDirectory, "COMMITTED.tmp");
    const markerPath = join(transactionDirectory, "COMMITTED");
    await removeRegularTransactionTemp(temporaryPath, manifest.transaction_id);
    await writeDurable(temporaryPath, markerBytes, "wx");
    if (injectFault) {
      await this.injectFault(
        "after_committed_marker_temp",
        manifest.transaction_id,
      );
    }
    await rename(temporaryPath, markerPath);
    await fsyncDirectory(transactionDirectory);
    if (injectFault) {
      await this.injectFault("after_committed", manifest.transaction_id);
    }
  }

  private async assertPrecondition(
    targetPath: string,
    expectedSha256: string | null,
    transactionId: string,
    recovery: boolean,
  ): Promise<void> {
    const absolutePath = await this.resolveCanonicalPath(targetPath, true);
    const currentSha256 = await hashFileOrNull(absolutePath);
    if (currentSha256 !== expectedSha256) {
      throw new CanonicalStoreError(
        recovery ? "RECOVERY_CONFLICT" : "CONFLICT",
        `Precondition failed for ${targetPath}`,
        transactionId,
      );
    }
  }

  private async cleanupTransaction(transactionId: string): Promise<void> {
    const transactionsDirectory = join(this.repositoryRoot, "transactions");
    await rm(join(transactionsDirectory, transactionId), {
      force: true,
      recursive: true,
    });
    await fsyncDirectory(transactionsDirectory);
  }

  private async withRepoLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureLayout();
    return withPosixFileLock(
      join(this.repositoryRoot, ".write.lock"),
      this.lockTimeoutMs,
      callback,
    );
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.repositoryRoot, { mode: 0o700, recursive: true });
    await chmod(this.repositoryRoot, 0o700);
    await mkdir(join(this.repositoryRoot, "transactions"), {
      mode: 0o700,
      recursive: true,
    });
  }

  private async resolveCanonicalPath(
    path: string,
    allowMissing = false,
  ): Promise<string> {
    validateCanonicalPath(path);
    await this.assertNoSymlinkComponents(path, allowMissing);
    const absolutePath = resolve(this.repositoryRoot, path);
    const rootPrefix = `${this.repositoryRoot}${sep}`;
    if (!absolutePath.startsWith(rootPrefix)) {
      throw new CanonicalStoreError(
        "INVALID_CANONICAL_PATH",
        `Path escapes repository root: ${path}`,
      );
    }
    return absolutePath;
  }

  private async assertNoSymlinkComponents(
    path: string,
    allowMissing = false,
  ): Promise<void> {
    const segments = path.split("/");
    let current = this.repositoryRoot;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new CanonicalStoreError(
            "INVALID_CANONICAL_PATH",
            `Symlink components are not allowed: ${path}`,
          );
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          allowMissing
        ) {
          return;
        }
        throw error;
      }
    }
  }

  private async injectFault(
    point: CanonicalCommitPoint,
    transactionId: string,
    extra: Pick<CanonicalFaultContext, "lineBytes" | "targetPath"> = {},
  ): Promise<void> {
    if (!this.faultInjector) return;
    await this.faultInjector(point, {
      ...extra,
      repositoryRoot: this.repositoryRoot,
      transactionId,
    });
  }
}

function validateRequest(request: CanonicalTransactionRequest): void {
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

function parseManifest(
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

function parseCommittedMarker(
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

async function inspectJsonlTarget(
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

async function writeDurable(
  path: string,
  bytes: Uint8Array,
  flags: "wx",
): Promise<void> {
  const handle = await open(path, flags, 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendDurable(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("write() made no progress");
    }
    offset += bytesWritten;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return computeByteSha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeRegularTransactionTemp(
  path: string,
  transactionId: string,
): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new CanonicalStoreError(
        "UNRECOVERABLE_TRANSACTION",
        `${path} must be a regular temporary file`,
        transactionId,
      );
    }
    await unlink(path);
    await fsyncDirectory(dirnameOf(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertRegularFileOrMissing(
  path: string,
  displayPath: string,
): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) {
      throw new CanonicalStoreError(
        "CANONICAL_LOG_CORRUPT",
        `${displayPath}.corrupt must be a regular file`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function validateCanonicalPath(path: string): void {
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

function validateCanonicalTargetPath(path: string): void {
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

function validateKnowledgePath(path: string): void {
  validateCanonicalTargetPath(path);
  if (!/^knowledge\/[^/]+\.md$/u.test(path)) {
    throw new CanonicalStoreError(
      "INVALID_CANONICAL_PATH",
      `Knowledge path must match knowledge/*.md: ${path}`,
    );
  }
}

function validateSha256OrNull(
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

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function transactionStagedPath(
  transactionId: string,
  kind: "appends" | "files",
  name: string,
): string {
  return `transactions/${transactionId}/staged/${kind}/${name}`;
}

function formatOrdinal(value: number): string {
  return value.toString().padStart(4, "0");
}

function toBuffer(value: Uint8Array | string): Buffer {
  return typeof value === "string"
    ? Buffer.from(value, "utf8")
    : Buffer.from(value);
}

function decodeUtf8(path: string, bytes: Uint8Array): string {
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

function dirnameOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index < 0 ? "." : path.slice(0, index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

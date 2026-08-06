import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  canonicalJsonlLineSha256,
  parseCanonicalJsonlLine,
  type CanonicalJsonlRecord,
} from "./canonical-jsonl.js";
import { findCanonicalJsonlPaths } from "./canonical-files.js";
import { compareCodeUnits, sha256Jcs } from "./canonical.js";
import {
  computeByteSha256,
  KnowledgeStoreInvalidError,
  parseKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";

export interface ProjectedCanonicalRecord {
  readonly lineSha256: string;
  readonly record: CanonicalJsonlRecord;
  readonly targetPath: string;
}

export interface CanonicalProjectionSnapshot {
  readonly canonicalDigest: string;
  readonly checkpointTransactionId: string | null;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly records: readonly ProjectedCanonicalRecord[];
}

interface CapturedKnowledge {
  readonly document: KnowledgeDocument;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

interface CapturedRecord extends ProjectedCanonicalRecord {
  readonly lineNumber: number;
}

interface CanonicalCapture {
  readonly canonicalDigest: string;
  readonly knowledge: readonly CapturedKnowledge[];
  readonly records: readonly CapturedRecord[];
}

interface ProjectionMetaRow {
  readonly value: string;
}

interface RecordRow {
  readonly line_sha256: string;
  readonly record_json: string;
  readonly target_path: string;
}

interface KnowledgeRow {
  readonly body: string;
  readonly byte_sha256: string;
  readonly frontmatter_json: string;
  readonly path: string;
  readonly revision: number;
}

/** Full-rebuild SQLite projection used by the M1 local canonical store. */
export class SqliteCanonicalProjection {
  readonly databasePath: string;
  readonly repositoryRoot: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.databasePath = join(this.repositoryRoot, "index.sqlite");
  }

  async ensureCurrent(): Promise<CanonicalProjectionSnapshot> {
    const capture = await captureCanonicalState(this.repositoryRoot);
    const database = this.openDatabase();
    try {
      const currentDigest = getProjectionMeta(database, "canonical_digest");
      if (currentDigest === capture.canonicalDigest) {
        return readSnapshot(database);
      }
      const checkpoint = getProjectionMeta(
        database,
        "last_committed_transaction_id",
      );
      rebuildDatabase(database, capture, checkpoint);
      return readSnapshot(database);
    } finally {
      database.close();
    }
  }

  async rebuild(
    checkpointTransactionId?: string | null,
  ): Promise<CanonicalProjectionSnapshot> {
    const capture = await captureCanonicalState(this.repositoryRoot);
    const database = this.openDatabase();
    try {
      const checkpoint =
        checkpointTransactionId === undefined
          ? getProjectionMeta(database, "last_committed_transaction_id")
          : checkpointTransactionId;
      rebuildDatabase(database, capture, checkpoint);
      return readSnapshot(database);
    } finally {
      database.close();
    }
  }

  private openDatabase(): Database.Database {
    const database = new Database(this.databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    createSchema(database);
    return database;
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projection_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS canonical_records (
      target_path TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      record_id TEXT NOT NULL UNIQUE,
      record_type TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      line_sha256 TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (target_path, line_number)
    );
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      path TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL UNIQUE,
      repo_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT,
      byte_sha256 TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_file_state (
      path TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL UNIQUE,
      byte_sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ns INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
  `);
}

function rebuildDatabase(
  database: Database.Database,
  capture: CanonicalCapture,
  checkpointTransactionId: string | null,
): void {
  const insertRecord = database.prepare(`
    INSERT INTO canonical_records (
      target_path, line_number, record_id, record_type, transaction_id,
      recorded_at, line_sha256, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKnowledge = database.prepare(`
    INSERT INTO knowledge_documents (
      path, knowledge_id, repo_id, revision, status, byte_sha256,
      frontmatter_json, body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertKnowledgeState = database.prepare(`
    INSERT INTO knowledge_file_state (
      path, knowledge_id, byte_sha256, size, mtime_ns, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const setMeta = database.prepare(`
    INSERT INTO projection_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(
      "DELETE FROM canonical_records; DELETE FROM knowledge_documents; DELETE FROM knowledge_file_state;",
    );

    for (const entry of capture.records) {
      insertRecord.run(
        entry.targetPath,
        entry.lineNumber,
        entry.record.record_id,
        entry.record.record_type,
        entry.record.transaction_id,
        entry.record.recorded_at,
        entry.lineSha256,
        JSON.stringify(entry.record),
      );
    }

    const indexedAt = new Date().toISOString();
    for (const entry of capture.knowledge) {
      const { document } = entry;
      const status =
        typeof document.frontmatter.status === "string"
          ? document.frontmatter.status
          : null;
      insertKnowledge.run(
        document.path,
        document.frontmatter.id,
        document.frontmatter.repo_id,
        document.revision,
        status,
        document.etag,
        JSON.stringify(document.frontmatter),
        document.body,
      );
      insertKnowledgeState.run(
        document.path,
        document.frontmatter.id,
        document.etag,
        entry.size,
        entry.mtimeNs,
        indexedAt,
      );
    }

    setMeta.run("schema_version", "1");
    setMeta.run("canonical_digest", capture.canonicalDigest);
    setMeta.run("index_dirty", "false");
    if (checkpointTransactionId === null) {
      database
        .prepare("DELETE FROM projection_meta WHERE key = ?")
        .run("last_committed_transaction_id");
    } else {
      setMeta.run("last_committed_transaction_id", checkpointTransactionId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readSnapshot(
  database: Database.Database,
): CanonicalProjectionSnapshot {
  const records = database
    .prepare(
      `SELECT target_path, line_sha256, record_json
       FROM canonical_records ORDER BY target_path, line_number`,
    )
    .all() as unknown as RecordRow[];
  const knowledge = database
    .prepare(
      `SELECT path, revision, byte_sha256, frontmatter_json, body
       FROM knowledge_documents ORDER BY path`,
    )
    .all() as unknown as KnowledgeRow[];

  return {
    canonicalDigest: getProjectionMeta(database, "canonical_digest") ?? "",
    checkpointTransactionId: getProjectionMeta(
      database,
      "last_committed_transaction_id",
    ),
    records: records.map((row) => ({
      lineSha256: row.line_sha256,
      record: JSON.parse(row.record_json) as CanonicalJsonlRecord,
      targetPath: row.target_path,
    })),
    knowledge: knowledge.map((row) => ({
      body: row.body,
      etag: row.byte_sha256,
      frontmatter: JSON.parse(
        row.frontmatter_json,
      ) as KnowledgeDocument["frontmatter"],
      path: row.path,
      revision: row.revision,
    })),
  };
}

function getProjectionMeta(
  database: Database.Database,
  key: string,
): string | null {
  const row = database
    .prepare("SELECT value FROM projection_meta WHERE key = ?")
    .get(key) as unknown as ProjectionMetaRow | undefined;
  return row?.value ?? null;
}

async function captureCanonicalState(
  repositoryRoot: string,
): Promise<CanonicalCapture> {
  const knowledge = await captureKnowledge(repositoryRoot);
  const jsonlPaths = await findCanonicalJsonlPaths(repositoryRoot);
  const records: CapturedRecord[] = [];
  const fileHashes: Array<{ path: string; sha256: string }> = knowledge.map(
    ({ document }) => ({ path: document.path, sha256: document.etag }),
  );
  const seenRecordIds = new Map<string, string>();

  for (const targetPath of jsonlPaths) {
    const bytes = await readFile(join(repositoryRoot, targetPath));
    fileHashes.push({ path: targetPath, sha256: computeByteSha256(bytes) });
    const parsed = parseCompleteJsonl(targetPath, bytes);
    for (const entry of parsed) {
      const previous = seenRecordIds.get(entry.record.record_id);
      if (previous !== undefined) {
        throw new KnowledgeStoreInvalidError(
          targetPath,
          `duplicate canonical record_id ${entry.record.record_id} (first seen at ${previous})`,
        );
      }
      seenRecordIds.set(
        entry.record.record_id,
        `${targetPath}:${entry.lineNumber}`,
      );
      records.push({ targetPath, ...entry });
    }
  }

  fileHashes.sort((a, b) => compareCodeUnits(a.path, b.path));
  return {
    canonicalDigest: sha256Jcs(fileHashes),
    knowledge,
    records,
  };
}

async function captureKnowledge(
  repositoryRoot: string,
): Promise<CapturedKnowledge[]> {
  const directory = join(repositoryRoot, "knowledge");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const markdownEntries = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  const seenIds = new Map<string, string>();
  const result: CapturedKnowledge[] = [];

  for (const entry of markdownEntries) {
    const targetPath = `knowledge/${entry.name}`;
    if (!entry.isFile()) {
      throw new KnowledgeStoreInvalidError(
        targetPath,
        "knowledge entries must be regular files, not links or directories",
      );
    }
    const absolutePath = join(directory, entry.name);
    const [bytes, metadata] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath, { bigint: true }),
    ]);
    const document = parseKnowledgeDocument(targetPath, bytes);
    const previous = seenIds.get(document.frontmatter.id);
    if (previous !== undefined) {
      throw new KnowledgeStoreInvalidError(
        targetPath,
        `duplicate knowledge id ${document.frontmatter.id} (first seen at ${previous})`,
      );
    }
    seenIds.set(document.frontmatter.id, targetPath);
    result.push({
      document,
      mtimeNs: metadata.mtimeNs,
      size: metadata.size,
    });
  }

  return result;
}

function parseCompleteJsonl(
  targetPath: string,
  bytes: Buffer,
): Array<{
  lineNumber: number;
  lineSha256: string;
  record: CanonicalJsonlRecord;
}> {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) {
    throw new KnowledgeStoreInvalidError(
      targetPath,
      "canonical JSONL has an incomplete final line",
    );
  }

  const result = [];
  let start = 0;
  let lineNumber = 1;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const lineBytes = bytes.subarray(start, index);
    if (lineBytes.length === 0) {
      throw new KnowledgeStoreInvalidError(
        targetPath,
        `empty canonical JSONL line at ${lineNumber}`,
      );
    }
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch (error) {
      throw new KnowledgeStoreInvalidError(
        targetPath,
        `line ${lineNumber} is not valid UTF-8`,
        { cause: error },
      );
    }
    const completeLine = bytes.subarray(start, index + 1);
    result.push({
      lineNumber,
      lineSha256: canonicalJsonlLineSha256(completeLine),
      record: parseCanonicalJsonlLine(targetPath, lineNumber, line),
    });
    lineNumber += 1;
    start = index + 1;
  }
  return result;
}

import { chmodSync } from "node:fs";
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
  buildDomainProjectionSnapshot,
  type DomainProjectionSnapshot,
  type ProjectedKnowledge,
} from "./domain-projection.js";
import {
  KnowledgeCategorySchema,
  KnowledgeStatusSchema,
  RepositoryIdSchema,
  SeveritySchema,
} from "./domain-schemas.js";
import {
  computeKnowledgeSearchScore,
  KnowledgeSearchError,
  normalizeKnowledgeSearchQuery,
  validateKnowledgeSearchCandidateLimit,
  type ExhaustiveKnowledgeSearchRequest,
  type KnowledgeSearchHit,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult,
} from "./knowledge-search.js";
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
  readonly domain: DomainProjectionSnapshot;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly records: readonly ProjectedCanonicalRecord[];
}

export interface ReadOnlyCanonicalStateCapture {
  readonly canonicalDigest: string;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly records: readonly ProjectedCanonicalRecord[];
}

export interface CanonicalKnowledgeReadView {
  readonly searchResult: KnowledgeSearchResult | null;
  readonly snapshot: CanonicalProjectionSnapshot;
}

export interface CanonicalKnowledgeSearchView {
  readonly searchResults: readonly KnowledgeSearchResult[];
  readonly snapshot: CanonicalProjectionSnapshot;
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

interface KnowledgeDocumentRow {
  readonly body: string;
  readonly byte_sha256: string;
  readonly frontmatter_json: string;
  readonly path: string;
  readonly revision: number;
}

interface PayloadJsonRow {
  readonly payload_json: string;
}

interface ProjectedKnowledgeRow {
  readonly applied_count: number;
  readonly category: string;
  readonly created_at: string;
  readonly detail: string;
  readonly etag: string;
  readonly evidence_count: number;
  readonly id: string;
  readonly path: string;
  readonly repo_id: string;
  readonly revision: number;
  readonly rule: string;
  readonly scope_json: string;
  readonly severity: string;
  readonly sources_json: string;
  readonly status: string;
  readonly updated_at: string;
  readonly violation_count: number;
}

interface SearchKnowledgeRow extends ProjectedKnowledgeRow {
  readonly bm25_score: number | null;
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
      ensureCaptureProjected(database, capture);
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

  async searchKnowledge(
    request: KnowledgeSearchRequest,
  ): Promise<KnowledgeSearchResult> {
    const capture = await captureCanonicalState(this.repositoryRoot);
    const database = this.openDatabase();
    try {
      ensureCaptureProjected(database, capture);
      return searchKnowledgeDatabase(database, request);
    } finally {
      database.close();
    }
  }

  async readKnowledgeView(
    searchRequest?: ExhaustiveKnowledgeSearchRequest,
  ): Promise<CanonicalKnowledgeReadView> {
    const view = await this.readKnowledgeSearchView(
      searchRequest === undefined ? [] : [searchRequest],
    );
    return {
      searchResult: view.searchResults[0] ?? null,
      snapshot: view.snapshot,
    };
  }

  /** Runs multiple exhaustive searches against one consistent projection. */
  async readKnowledgeSearchView(
    searchRequests: readonly ExhaustiveKnowledgeSearchRequest[],
  ): Promise<CanonicalKnowledgeSearchView> {
    const capture = await captureCanonicalState(this.repositoryRoot);
    const database = this.openDatabase();
    try {
      ensureCaptureProjected(database, capture);
      database.exec("BEGIN");
      try {
        const view = {
          searchResults: searchRequests.map((request) =>
            searchKnowledgeDatabase(database, request, true),
          ),
          snapshot: readSnapshot(database),
        };
        database.exec("COMMIT");
        return view;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }

  private openDatabase(): Database.Database {
    const database = new Database(this.databasePath);
    try {
      // SQLite otherwise inherits the process umask and commonly creates 0644.
      // Tighten the main file before WAL/SHM creation so sidecars inherit 0600.
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      database.close();
      throw error;
    }
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    createSchema(database);
    return database;
  }
}

/** Captures and validates canonical files without opening or updating SQLite. */
export async function captureCanonicalStateReadOnly(
  repositoryRoot: string,
): Promise<ReadOnlyCanonicalStateCapture> {
  const capture = await captureCanonicalState(resolve(repositoryRoot));
  return {
    canonicalDigest: capture.canonicalDigest,
    knowledge: capture.knowledge.map((entry) => entry.document),
    records: capture.records.map((entry) => ({
      lineSha256: entry.lineSha256,
      record: entry.record,
      targetPath: entry.targetPath,
    })),
  };
}

function ensureCaptureProjected(
  database: Database.Database,
  capture: CanonicalCapture,
): void {
  if (
    getProjectionMeta(database, "canonical_digest") ===
      capture.canonicalDigest &&
    getProjectionMeta(database, "schema_version") === "2"
  ) {
    return;
  }
  rebuildDatabase(
    database,
    capture,
    getProjectionMeta(database, "last_committed_transaction_id"),
  );
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
    CREATE TABLE IF NOT EXISTS pull_requests (
      repo_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pull_request_id TEXT NOT NULL UNIQUE,
      name_with_owner TEXT NOT NULL,
      title TEXT NOT NULL,
      merged_at TEXT,
      base_ref_oid TEXT NOT NULL,
      head_ref_oid TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repo_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS pull_request_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      thread_ids_json TEXT NOT NULL,
      review_summary_ids_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_threads (
      repo_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      path TEXT,
      comment_ids_json TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      state_fingerprint TEXT NOT NULL,
      is_resolved INTEGER NOT NULL,
      is_outdated INTEGER NOT NULL,
      observation_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repo_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS review_comments (
      comment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      body TEXT NOT NULL,
      diff_hunk TEXT,
      url TEXT NOT NULL,
      author_login TEXT,
      author_association TEXT,
      actor_kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      trust TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_removals (
      repo_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      previous_snapshot_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      observation_id TEXT PRIMARY KEY,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS distill_jobs (
      job_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      distillation_key TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      lease_generation INTEGER NOT NULL,
      lease_token_hash TEXT,
      lease_expires_at TEXT,
      skip_reason TEXT,
      last_error TEXT,
      next_retry_at TEXT,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (repo_id, thread_id, distillation_key)
    );
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      repo_id TEXT NOT NULL,
      rule TEXT NOT NULL,
      detail TEXT NOT NULL,
      search_rule TEXT NOT NULL,
      search_detail TEXT NOT NULL,
      category TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      evidence_count INTEGER NOT NULL,
      violation_count INTEGER NOT NULL,
      applied_count INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      etag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      knowledge_id UNINDEXED,
      rule,
      detail,
      tokenize = 'trigram'
    );
    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      eligible_for_count INTEGER NOT NULL,
      content_fingerprint TEXT NOT NULL,
      state_fingerprint TEXT NOT NULL,
      supersedes TEXT,
      superseded_by TEXT,
      comment_ids_json TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      actors_json TEXT NOT NULL,
      originator_json TEXT NOT NULL,
      path TEXT,
      url TEXT,
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS evidence_active_unique
      ON evidence(knowledge_id, thread_id) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS revision_proposals (
      proposal_id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      status TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submission_receipts (
      receipt_id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      stable_response_json TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE (job_id, phase)
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      record_id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      at TEXT NOT NULL,
      context_json TEXT,
      note TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_search_filter
      ON knowledge(repo_id, status, category, id);
    CREATE INDEX IF NOT EXISTS evidence_knowledge_status
      ON evidence(knowledge_id, status, eligible_for_count);
    CREATE INDEX IF NOT EXISTS comments_thread
      ON review_comments(thread_id, created_at, comment_id);
  `);
}

function rebuildDatabase(
  database: Database.Database,
  capture: CanonicalCapture,
  checkpointTransactionId: string | null,
): void {
  const domain = buildDomainProjectionSnapshot(
    capture.records.map((entry) => entry.record),
    capture.knowledge.map((entry) => entry.document),
  );
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

    replaceDomainProjection(database, domain);

    setMeta.run("schema_version", "2");
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

function replaceDomainProjection(
  database: Database.Database,
  domain: DomainProjectionSnapshot,
): void {
  database.exec(`
    DELETE FROM knowledge_fts;
    DELETE FROM pull_requests;
    DELETE FROM pull_request_snapshots;
    DELETE FROM review_threads;
    DELETE FROM review_comments;
    DELETE FROM thread_removals;
    DELETE FROM distill_jobs;
    DELETE FROM knowledge;
    DELETE FROM evidence;
    DELETE FROM revision_proposals;
    DELETE FROM submission_receipts;
    DELETE FROM outcomes;
  `);

  const insertPullRequest = database.prepare(`
    INSERT INTO pull_requests (
      repo_id, pr_number, pull_request_id, name_with_owner, title, merged_at,
      base_ref_oid, head_ref_oid, snapshot_id, observation_id, observed_at,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.pullRequests) {
    insertPullRequest.run(
      value.repo_id,
      value.pr_number,
      value.pull_request_id,
      value.name_with_owner,
      value.title,
      value.merged_at,
      value.base_ref_oid,
      value.head_ref_oid,
      value.snapshot_id,
      value.observation_id,
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertSnapshot = database.prepare(`
    INSERT INTO pull_request_snapshots (
      snapshot_id, repo_id, pr_number, thread_ids_json,
      review_summary_ids_json, observed_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.pullRequestSnapshots) {
    insertSnapshot.run(
      value.snapshot_id,
      value.repo_id,
      value.pr_number,
      JSON.stringify(value.thread_ids),
      JSON.stringify(value.review_summary_ids),
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertThread = database.prepare(`
    INSERT INTO review_threads (
      repo_id, thread_id, snapshot_id, pr_number, path, comment_ids_json,
      content_fingerprint, state_fingerprint, is_resolved, is_outdated,
      observation_id, observed_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.threads) {
    insertThread.run(
      value.repo_id,
      value.thread_id,
      value.snapshot_id,
      value.pr_number,
      value.path ?? null,
      JSON.stringify(value.comment_ids),
      value.content_fingerprint,
      value.state_fingerprint,
      Number(value.is_resolved),
      Number(value.is_outdated),
      value.observation_id,
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertComment = database.prepare(`
    INSERT INTO review_comments (
      comment_id, thread_id, snapshot_id, body, diff_hunk, url,
      author_login, author_association, actor_kind, provider, trust,
      created_at, updated_at, observation_id, observed_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.comments) {
    insertComment.run(
      value.comment_id,
      value.thread_id,
      value.snapshot_id,
      value.body,
      value.diff_hunk ?? null,
      value.url,
      value.actor.login,
      value.actor.author_association ?? null,
      value.actor.actor_kind,
      value.actor.provider,
      value.actor.trust,
      value.created_at,
      value.updated_at,
      value.observation_id,
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertThreadRemoval = database.prepare(`
    INSERT INTO thread_removals (
      repo_id, thread_id, pr_number, previous_snapshot_id, snapshot_id,
      observation_id, observed_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.threadRemovals) {
    insertThreadRemoval.run(
      value.repo_id,
      value.thread_id,
      value.pr_number,
      value.previous_snapshot_id,
      value.snapshot_id,
      value.observation_id,
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertJob = database.prepare(`
    INSERT INTO distill_jobs (
      job_id, repo_id, thread_id, distillation_key, state, attempts,
      lease_generation, lease_token_hash, lease_expires_at, skip_reason,
      last_error, next_retry_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.distillJobs) {
    insertJob.run(
      value.job_id,
      value.repo_id,
      value.thread_id,
      value.distillation_key,
      value.state,
      value.attempts,
      value.lease_generation,
      value.lease_token_hash ?? null,
      value.lease_expires_at ?? null,
      value.skip_reason ?? null,
      value.last_error ?? null,
      value.next_retry_at ?? null,
      value.updated_at,
      JSON.stringify(value),
    );
  }

  const insertKnowledge = database.prepare(`
    INSERT INTO knowledge (
      id, path, repo_id, rule, detail, search_rule, search_detail, category,
      scope_json, severity, status, evidence_count, violation_count,
      applied_count, sources_json, revision, etag, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteKnowledgeFts = database.prepare(
    "DELETE FROM knowledge_fts WHERE knowledge_id = ?",
  );
  const insertKnowledgeFts = database.prepare(
    "INSERT INTO knowledge_fts (knowledge_id, rule, detail) VALUES (?, ?, ?)",
  );
  for (const value of domain.knowledge) {
    const searchRule = foldSearchText(value.rule);
    const searchDetail = foldSearchText(value.detail);
    insertKnowledge.run(
      value.id,
      value.path,
      value.repoId,
      value.rule,
      value.detail,
      searchRule,
      searchDetail,
      value.category,
      JSON.stringify(value.scope),
      value.severity,
      value.status,
      value.evidenceCount,
      value.violationCount,
      value.appliedCount,
      JSON.stringify(value.sources),
      value.revision,
      value.etag,
      value.createdAt,
      value.updatedAt,
    );
    deleteKnowledgeFts.run(value.id);
    insertKnowledgeFts.run(value.id, searchRule, searchDetail);
  }

  const insertEvidence = database.prepare(`
    INSERT INTO evidence (
      evidence_id, knowledge_id, repo_id, occurrence_key, thread_id,
      pr_number, status, eligible_for_count, content_fingerprint,
      state_fingerprint, supersedes, superseded_by, comment_ids_json,
      sources_json, actors_json, originator_json, path, url, observed_at,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.evidence) {
    insertEvidence.run(
      value.evidence_id,
      value.knowledge_id,
      value.repo_id,
      value.occurrence_key,
      value.thread_id,
      value.pr_number,
      value.status,
      Number(value.eligible_for_count),
      value.content_fingerprint,
      value.state_fingerprint,
      value.supersedes ?? null,
      value.superseded_by ?? null,
      JSON.stringify(value.comment_ids),
      JSON.stringify(value.sources),
      JSON.stringify(value.actors),
      JSON.stringify(value.originator),
      value.path ?? null,
      value.url ?? null,
      value.observed_at,
      JSON.stringify(value),
    );
  }

  const insertProposal = database.prepare(`
    INSERT INTO revision_proposals (
      proposal_id, knowledge_id, repo_id, status, patch_json,
      evidence_ids_json, created_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.revisionProposals) {
    insertProposal.run(
      value.proposal_id,
      value.knowledge_id,
      value.repo_id,
      value.status,
      JSON.stringify(value.patch),
      JSON.stringify(value.evidence_ids),
      value.created_at,
      value.updated_at,
      JSON.stringify(value),
    );
  }

  const insertReceipt = database.prepare(`
    INSERT INTO submission_receipts (
      receipt_id, submission_id, job_id, phase, request_sha256,
      stable_response_json, committed_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.submissionReceipts) {
    insertReceipt.run(
      value.receipt_id,
      value.submission_id,
      value.job_id,
      value.phase,
      value.request_sha256,
      JSON.stringify(value.stable_response),
      value.committed_at,
      JSON.stringify(value),
    );
  }

  const insertOutcome = database.prepare(`
    INSERT INTO outcomes (
      record_id, knowledge_id, repo_id, outcome, at, context_json, note,
      payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of domain.outcomes) {
    insertOutcome.run(
      value.recordId,
      value.knowledge_id,
      value.repo_id,
      value.outcome,
      value.at,
      value.context === undefined ? null : JSON.stringify(value.context),
      value.note ?? null,
      JSON.stringify(value),
    );
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
    .all() as unknown as KnowledgeDocumentRow[];

  return {
    canonicalDigest: getProjectionMeta(database, "canonical_digest") ?? "",
    checkpointTransactionId: getProjectionMeta(
      database,
      "last_committed_transaction_id",
    ),
    domain: readDomainProjection(database),
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

function readDomainProjection(
  database: Database.Database,
): DomainProjectionSnapshot {
  return {
    comments: readPayloads(
      database,
      "SELECT payload_json FROM review_comments ORDER BY comment_id",
    ),
    distillJobs: readPayloads(
      database,
      "SELECT payload_json FROM distill_jobs ORDER BY job_id",
    ),
    evidence: readPayloads(
      database,
      "SELECT payload_json FROM evidence ORDER BY evidence_id",
    ),
    knowledge: (
      database
        .prepare("SELECT * FROM knowledge ORDER BY id")
        .all() as unknown as ProjectedKnowledgeRow[]
    ).map(projectedKnowledgeFromRow),
    outcomes: readPayloads(
      database,
      "SELECT payload_json FROM outcomes ORDER BY record_id",
    ),
    pullRequestSnapshots: readPayloads(
      database,
      "SELECT payload_json FROM pull_request_snapshots ORDER BY snapshot_id",
    ),
    pullRequests: readPayloads(
      database,
      "SELECT payload_json FROM pull_requests ORDER BY repo_id, pr_number",
    ),
    revisionProposals: readPayloads(
      database,
      "SELECT payload_json FROM revision_proposals ORDER BY proposal_id",
    ),
    submissionReceipts: readPayloads(
      database,
      "SELECT payload_json FROM submission_receipts ORDER BY receipt_id",
    ),
    threadRemovals: readPayloads(
      database,
      "SELECT payload_json FROM thread_removals ORDER BY observation_id",
    ),
    threads: readPayloads(
      database,
      "SELECT payload_json FROM review_threads ORDER BY repo_id, thread_id",
    ),
  };
}

function readPayloads<T>(database: Database.Database, sql: string): T[] {
  const rows = database.prepare(sql).all() as unknown as PayloadJsonRow[];
  return rows.map((row) => JSON.parse(row.payload_json) as T);
}

function projectedKnowledgeFromRow(
  row: ProjectedKnowledgeRow,
): ProjectedKnowledge {
  return {
    appliedCount: row.applied_count,
    category: KnowledgeCategorySchema.parse(row.category),
    createdAt: row.created_at,
    detail: row.detail,
    etag: row.etag,
    evidenceCount: row.evidence_count,
    id: row.id,
    path: row.path,
    repoId: row.repo_id,
    revision: row.revision,
    rule: row.rule,
    scope: parseStringArray(row.scope_json, "scope_json"),
    severity: parseSeverity(row.severity),
    sources: parseStringArray(row.sources_json, "sources_json"),
    status: KnowledgeStatusSchema.parse(row.status),
    updatedAt: row.updated_at,
    violationCount: row.violation_count,
  };
}

function searchKnowledgeDatabase(
  database: Database.Database,
  request: KnowledgeSearchRequest,
  exhaustive = false,
): KnowledgeSearchResult {
  const repoId = RepositoryIdSchema.parse(request.repoId);
  const category =
    request.category === undefined
      ? undefined
      : KnowledgeCategorySchema.parse(request.category);
  const statuses = new Set(
    (request.statuses ?? ["active"]).map((status) =>
      KnowledgeStatusSchema.parse(status),
    ),
  );
  if (statuses.size === 0) {
    throw new KnowledgeSearchError(
      "SEARCH_QUERY_INVALID",
      "statuses must contain at least one value",
    );
  }
  const orderedStatuses = [...statuses].sort(compareCodeUnits);
  const candidateLimit = exhaustive
    ? null
    : validateKnowledgeSearchCandidateLimit(request.candidateLimit);
  const limitClause = candidateLimit === null ? "" : "LIMIT ?";
  const query = normalizeKnowledgeSearchQuery(request.query);
  const statusPlaceholders = orderedStatuses.map(() => "?").join(", ");
  const categoryClause = category === undefined ? "" : "AND k.category = ?";
  let rows: SearchKnowledgeRow[];

  if (query.mode === "fts") {
    rows = database
      .prepare(
        `SELECT k.*, bm25(knowledge_fts) AS bm25_score
         FROM knowledge_fts
         JOIN knowledge AS k ON k.id = knowledge_fts.knowledge_id
         WHERE knowledge_fts MATCH ?
           AND k.repo_id = ?
           AND k.status IN (${statusPlaceholders})
         ${categoryClause}
         ORDER BY bm25_score ASC, k.id ASC
         ${limitClause}`,
      )
      .all(
        query.ftsLiteral,
        repoId,
        ...orderedStatuses,
        ...(category === undefined ? [] : [category]),
        ...(candidateLimit === null ? [] : [candidateLimit]),
      ) as unknown as SearchKnowledgeRow[];
  } else {
    rows = database
      .prepare(
        `SELECT k.*, NULL AS bm25_score
         FROM knowledge AS k
         WHERE (
           k.search_rule LIKE ? ESCAPE '\\'
           OR k.search_detail LIKE ? ESCAPE '\\'
         )
           AND k.repo_id = ?
           AND k.status IN (${statusPlaceholders})
           ${categoryClause}
         ORDER BY CASE
           WHEN k.search_rule = ? OR k.search_detail = ? THEN 0
           ELSE 1
         END ASC, k.id ASC
         ${limitClause}`,
      )
      .all(
        query.likePattern,
        query.likePattern,
        repoId,
        ...orderedStatuses,
        ...(category === undefined ? [] : [category]),
        query.folded,
        query.folded,
        ...(candidateLimit === null ? [] : [candidateLimit]),
      ) as unknown as SearchKnowledgeRow[];
  }

  const hits: KnowledgeSearchHit[] = rows.map((row, textRank) => {
    const knowledge = projectedKnowledgeFromRow(row);
    return {
      ...knowledge,
      bm25Score: row.bm25_score,
      score: computeKnowledgeSearchScore(
        textRank,
        knowledge.severity,
        knowledge.evidenceCount,
        knowledge.violationCount,
      ),
      textRank,
    };
  });
  hits.sort(
    (left, right) =>
      right.score - left.score ||
      left.textRank - right.textRank ||
      compareCodeUnits(left.id, right.id),
  );
  return { hits, mode: query.mode, normalizedQuery: query.normalized };
}

function foldSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function parseStringArray(value: string, column: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${column} must contain a JSON string array`);
  }
  return parsed;
}

function parseSeverity(value: string): ProjectedKnowledge["severity"] {
  return SeveritySchema.parse(value);
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

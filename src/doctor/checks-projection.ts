import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import { canonicalizeJson, compareCodeUnits } from "../canonical.js";
import type { DomainProjectionSnapshot } from "../domain-projection.js";
import {
  PROJECTION_SCHEMA_VERSION,
  type ReadOnlyCanonicalStateCapture,
} from "../sqlite-projection.js";
import type { CanonicalInspection } from "./checks-canonical.js";
import { DoctorReportBuilder, type DoctorCheck } from "./report-builder.js";
import { errorCode, errorMessage, octal } from "./util.js";

export interface ProjectionDiagnosticContext {
  readonly canonical: CanonicalInspection | null;
  readonly path: string;
  readonly repoId: string;
  readonly repository: string;
}

export interface ProjectionFileInspection {
  readonly databaseBytes: Buffer;
  readonly pendingWalBytes: number;
  readonly permission: number;
  readonly sqliteHeader: boolean;
  readonly walHeader: boolean;
  readonly walInspectionError: string | null;
}

export interface ProjectionMeta {
  readonly canonical_digest: string | null;
  readonly index_dirty: string | null;
  readonly last_committed_transaction_id: string | null;
  readonly schema_version: string | null;
}

export interface ProjectionConsistencyContext {
  readonly canonical: CanonicalInspection | null;
  readonly database: Database.Database;
  readonly meta: ProjectionMeta;
  readonly repoId: string;
}

export type ProjectionMismatch = Readonly<Record<string, unknown>>;
export type ProjectionMismatchCheckId =
  | "derived_counts"
  | "knowledge_consistency"
  | "repository_identity"
  | "schema_meta";

export interface ProjectionMismatchCheck {
  readonly id: ProjectionMismatchCheckId;
  inspect(context: ProjectionConsistencyContext): readonly ProjectionMismatch[];
}

/** Preserves diagnostic insertion order until the complete phase is emitted. */
export class ProjectionDiagnosticResultBuilder {
  readonly #checks: DoctorCheck[] = [];

  add(check: DoctorCheck): void {
    this.#checks.push(check);
  }

  appendTo(report: DoctorReportBuilder): void {
    for (const check of this.#checks) report.add(check);
  }

  build(): readonly DoctorCheck[] {
    return [...this.#checks];
  }
}

export const PROJECTION_MISMATCH_CHECKS = [
  { id: "schema_meta", inspect: inspectSchemaAndMeta },
  { id: "repository_identity", inspect: inspectRepositoryIdentity },
  { id: "derived_counts", inspect: inspectDerivedCounts },
  { id: "knowledge_consistency", inspect: inspectKnowledgeConsistency },
] as const satisfies readonly ProjectionMismatchCheck[];

export async function inspectSqliteProjection(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  canonical: CanonicalInspection | null,
  repoId: string,
  repository: string,
): Promise<void> {
  const context = Object.freeze({
    canonical,
    path: join(repositoryRoot, "index.sqlite"),
    repoId,
    repository,
  });
  const results = new ProjectionDiagnosticResultBuilder();
  try {
    const file = await inspectProjectionFile(context, results);
    if (file === null) return;
    const database = openProjectionSnapshot(context, file, results);
    if (database === null) return;
    try {
      inspectOpenProjection(context, file, database, results);
    } finally {
      database.close();
    }
  } finally {
    results.appendTo(report);
  }
}

export async function inspectProjectionFile(
  context: ProjectionDiagnosticContext,
  results: ProjectionDiagnosticResultBuilder,
): Promise<ProjectionFileInspection | null> {
  const handle = await openProjectionFileHandle(context, results);
  if (handle === null) return null;
  let permission = 0;
  let databaseBytes: Buffer;
  try {
    permission = inspectProjectionFileMode(
      context,
      await handle.stat(),
      results,
    );
    databaseBytes = await handle.readFile();
  } catch (error) {
    addUnreadableProjectionChecks(context, error, results);
    return null;
  } finally {
    await handle.close();
  }
  const sqliteHeader = databaseBytes
    .subarray(0, 16)
    .equals(Buffer.from("SQLite format 3\0", "binary"));
  const walHeader =
    sqliteHeader && databaseBytes[18] === 2 && databaseBytes[19] === 2;
  const walPath = `${context.path}-wal`;
  let pendingWalBytes = 0;
  let walInspectionError: string | null = null;
  try {
    pendingWalBytes = (await lstat(walPath)).size;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      walInspectionError = errorCode(error);
    }
  }
  return Object.freeze({
    databaseBytes,
    pendingWalBytes,
    permission,
    sqliteHeader,
    walHeader,
    walInspectionError,
  });
}

async function openProjectionFileHandle(
  context: ProjectionDiagnosticContext,
  results: ProjectionDiagnosticResultBuilder,
): Promise<FileHandle | null> {
  try {
    return await open(context.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    let metadata: Stats;
    try {
      metadata = await lstat(context.path);
    } catch {
      addMissingProjectionChecks(context, results);
      return null;
    }
    inspectProjectionFileMode(context, metadata, results);
    addUnreadableProjectionChecks(context, error, results);
    return null;
  }
}

function inspectProjectionFileMode(
  context: ProjectionDiagnosticContext,
  metadata: Stats,
  results: ProjectionDiagnosticResultBuilder,
): number {
  const permission = metadata.mode & 0o777;
  if (!metadata.isFile() || metadata.isSymbolicLink() || permission !== 0o600) {
    results.add({
      details: { mode: octal(permission) },
      id: "sqlite.journal",
      message: "index.sqlite must be a mode-600 regular file.",
      path: context.path,
      remedy: `Run chmod 600 ${context.path}, then reindex if integrity checks fail.`,
      status: "fail",
    });
  }
  return permission;
}

function addMissingProjectionChecks(
  context: ProjectionDiagnosticContext,
  results: ProjectionDiagnosticResultBuilder,
): void {
  results.add({
    id: "sqlite.journal",
    message: "SQLite projection does not exist.",
    path: context.path,
    remedy: `Run repo-knowledge reindex ${context.repository}.`,
    status: "fail",
  });
  results.add({
    id: "sqlite.projection",
    message: "Projection metadata could not be checked without index.sqlite.",
    path: context.path,
    status: "warn",
  });
}

function addUnreadableProjectionChecks(
  context: ProjectionDiagnosticContext,
  error: unknown,
  results: ProjectionDiagnosticResultBuilder,
): void {
  results.add({
    details: { error: errorCode(error) },
    id: "sqlite.journal",
    message: "SQLite projection could not be read without mutation.",
    path: context.path,
    remedy: `Restore access to index.sqlite, then run repo-knowledge reindex ${context.repository}.`,
    status: "fail",
  });
  results.add({
    id: "sqlite.projection",
    message: "Projection metadata could not be read.",
    path: context.path,
    status: "warn",
  });
}

export function openProjectionSnapshot(
  context: ProjectionDiagnosticContext,
  file: ProjectionFileInspection,
  results: ProjectionDiagnosticResultBuilder,
): Database.Database | null {
  // A WAL-format database cannot be deserialized directly. Flip only the
  // private in-memory snapshot to rollback format after confirming that no
  // uncheckpointed WAL bytes exist; the on-disk projection is never opened.
  const snapshotBytes = Buffer.from(file.databaseBytes);
  if (file.walHeader) {
    snapshotBytes[18] = 1;
    snapshotBytes[19] = 1;
  }
  try {
    return new Database(snapshotBytes, { readonly: true });
  } catch (error) {
    if (file.permission === 0o600) {
      results.add({
        details: {
          error: errorMessage(error),
          sqlite_header: file.sqliteHeader,
          ...(file.walInspectionError === null
            ? {}
            : { wal_error: file.walInspectionError }),
        },
        id: "sqlite.journal",
        message: "SQLite journal state or database header is invalid.",
        path: context.path,
        remedy: `Run repo-knowledge reindex ${context.repository}.`,
        status: "fail",
      });
    }
    results.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection snapshot could not be opened read-only.",
      path: context.path,
      remedy: `Run repo-knowledge reindex ${context.repository}.`,
      status: "fail",
    });
    return null;
  }
}

export function inspectOpenProjection(
  context: ProjectionDiagnosticContext,
  file: ProjectionFileInspection,
  database: Database.Database,
  results: ProjectionDiagnosticResultBuilder,
): void {
  try {
    const quickCheck = String(
      database.pragma("quick_check", { simple: true }),
    ).toLowerCase();
    const journal = inspectProjectionJournal(context, file, quickCheck);
    if (journal !== null) results.add(journal);
    const comparisonGate = inspectProjectionComparisonGate(context, file);
    if (comparisonGate !== null) {
      results.add(comparisonGate);
      return;
    }
    results.add(inspectProjectionConsistency(context, database));
  } catch (error) {
    results.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection schema or metadata could not be inspected.",
      path: context.path,
      remedy: `Run repo-knowledge reindex ${context.repository}.`,
      status: "fail",
    });
  }
}

export function inspectProjectionJournal(
  context: ProjectionDiagnosticContext,
  file: ProjectionFileInspection,
  quickCheck: string,
): DoctorCheck | null {
  if (file.permission !== 0o600) return null;
  const journalOk =
    file.walHeader &&
    file.pendingWalBytes === 0 &&
    file.walInspectionError === null &&
    quickCheck === "ok";
  return journalOk
    ? {
        details: {
          journal_mode: "wal",
          pending_wal_bytes: file.pendingWalBytes,
          quick_check: quickCheck,
        },
        id: "sqlite.journal",
        message:
          "SQLite is private, WAL-backed, fully checkpointed, and passes quick_check.",
        path: context.path,
        status: "pass",
      }
    : {
        details: {
          journal_mode: file.walHeader ? "wal" : "rollback-or-invalid",
          pending_wal_bytes: file.pendingWalBytes,
          quick_check: quickCheck,
          ...(file.walInspectionError === null
            ? {}
            : { wal_error: file.walInspectionError }),
        },
        id: "sqlite.journal",
        message:
          "SQLite journal mode, checkpoint state, or integrity is invalid.",
        path: context.path,
        remedy: `Run repo-knowledge reindex ${context.repository}.`,
        status: "fail",
      };
}

export function inspectProjectionComparisonGate(
  context: ProjectionDiagnosticContext,
  file: ProjectionFileInspection,
): DoctorCheck | null {
  if (file.pendingWalBytes === 0 && file.walInspectionError === null) {
    return null;
  }
  return {
    details: {
      pending_wal_bytes: file.pendingWalBytes,
      ...(file.walInspectionError === null
        ? {}
        : { wal_error: file.walInspectionError }),
    },
    id: "sqlite.projection",
    message:
      "Projection comparison was skipped because the main database snapshot may not include WAL frames.",
    path: context.path,
    remedy:
      "Stop repository writers, allow SQLite to checkpoint, then rerun doctor before deciding whether reindex is necessary.",
    status: "warn",
  };
}

export function inspectProjectionConsistency(
  context: ProjectionDiagnosticContext,
  database: Database.Database,
): DoctorCheck {
  const consistency = createProjectionConsistencyContext(
    database,
    context.canonical,
    context.repoId,
  );
  const mismatches = runProjectionMismatchChecks(consistency);
  return mismatches.length === 0
    ? {
        details: {
          canonical_digest: consistency.meta.canonical_digest,
          checkpoint: consistency.meta.last_committed_transaction_id,
        },
        id: "sqlite.projection",
        message:
          "Projection checkpoint, canonical digest, records, and derived counts are current.",
        path: context.path,
        status: "pass",
      }
    : {
        details: { mismatches },
        id: "sqlite.projection",
        message: "SQLite projection is dirty or differs from canonical state.",
        path: context.path,
        remedy: `Run repo-knowledge reindex ${context.repository}; use reconcile only for optional Markdown metadata.`,
        status: "fail",
      };
}

export function createProjectionConsistencyContext(
  database: Database.Database,
  canonical: CanonicalInspection | null,
  repoId: string,
): ProjectionConsistencyContext {
  return Object.freeze({
    canonical,
    database,
    meta: Object.freeze(readProjectionMeta(database)),
    repoId,
  });
}

export function runProjectionMismatchChecks(
  context: ProjectionConsistencyContext,
  checks: readonly ProjectionMismatchCheck[] = PROJECTION_MISMATCH_CHECKS,
): readonly ProjectionMismatch[] {
  return checks.flatMap((check) => check.inspect(context));
}

function inspectSchemaAndMeta(
  context: ProjectionConsistencyContext,
): readonly ProjectionMismatch[] {
  const mismatches: ProjectionMismatch[] = [];
  if (context.meta.schema_version !== PROJECTION_SCHEMA_VERSION) {
    mismatches.push({
      actual: context.meta.schema_version,
      expected: PROJECTION_SCHEMA_VERSION,
      field: "schema_version",
    });
  }
  if (context.meta.index_dirty !== "false") {
    mismatches.push({
      actual: context.meta.index_dirty,
      expected: "false",
      field: "index_dirty",
    });
  }
  return mismatches;
}

function inspectRepositoryIdentity(
  context: ProjectionConsistencyContext,
): readonly ProjectionMismatch[] {
  const mismatches: ProjectionMismatch[] = [];
  if (context.canonical === null) return mismatches;

  if (
    context.meta.canonical_digest !== context.canonical.capture.canonicalDigest
  ) {
    mismatches.push({
      actual: context.meta.canonical_digest,
      expected: context.canonical.capture.canonicalDigest,
      field: "canonical_digest",
    });
  }

  const checkpointFloor = latestCanonicalTransactionId(
    context.canonical.capture,
  );
  const checkpoint = context.meta.last_committed_transaction_id;
  const hasCanonicalState =
    context.canonical.capture.knowledge.length > 0 ||
    context.canonical.capture.records.length > 0;
  if (hasCanonicalState && checkpoint === null) {
    mismatches.push({
      actual: null,
      expected:
        checkpointFloor === null
          ? "a committed transaction id"
          : `at least ${checkpointFloor}`,
      field: "last_committed_transaction_id",
    });
  } else if (
    checkpointFloor !== null &&
    checkpoint !== null &&
    compareCodeUnits(checkpoint, checkpointFloor) < 0
  ) {
    mismatches.push({
      actual: checkpoint,
      expected: `at least ${checkpointFloor}`,
      field: "last_committed_transaction_id",
    });
  }
  return mismatches;
}

function inspectDerivedCounts(
  context: ProjectionConsistencyContext,
): readonly ProjectionMismatch[] {
  const mismatches: ProjectionMismatch[] = [];
  if (context.canonical !== null) {
    compareProjectionCounts(context.database, context.canonical, mismatches);
  }
  return mismatches;
}

function inspectKnowledgeConsistency(
  context: ProjectionConsistencyContext,
): readonly ProjectionMismatch[] {
  const mismatches: ProjectionMismatch[] = [];
  if (context.canonical !== null) {
    compareProjectedKnowledge(
      context.database,
      context.canonical.domain,
      context.repoId,
      mismatches,
    );
  }
  return mismatches;
}

function readProjectionMeta(database: Database.Database): ProjectionMeta {
  const rows = database
    .prepare("SELECT key, value FROM projection_meta ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    canonical_digest: values.get("canonical_digest") ?? null,
    index_dirty: values.get("index_dirty") ?? null,
    last_committed_transaction_id:
      values.get("last_committed_transaction_id") ?? null,
    schema_version: values.get("schema_version") ?? null,
  };
}

function latestCanonicalTransactionId(
  capture: ReadOnlyCanonicalStateCapture,
): string | null {
  return capture.records.reduce<string | null>((latest, entry) => {
    const transactionId = entry.record.transaction_id;
    return latest === null || compareCodeUnits(latest, transactionId) < 0
      ? transactionId
      : latest;
  }, null);
}

function compareProjectionCounts(
  database: Database.Database,
  canonical: CanonicalInspection,
  mismatches: ProjectionMismatch[],
): void {
  const expected = new Map<string, number>([
    ["canonical_records", canonical.capture.records.length],
    ["knowledge_documents", canonical.capture.knowledge.length],
    ["knowledge", canonical.domain.knowledge.length],
    ["evidence", canonical.domain.evidence.length],
    ["distill_jobs", canonical.domain.distillJobs.length],
    ["pull_requests", canonical.domain.pullRequests.length],
    ["pull_request_snapshots", canonical.domain.pullRequestSnapshots.length],
    ["review_threads", canonical.domain.threads.length],
    ["review_comments", canonical.domain.comments.length],
    ["revision_proposals", canonical.domain.revisionProposals.length],
    ["submission_receipts", canonical.domain.submissionReceipts.length],
    ["outcomes", canonical.domain.outcomes.length],
  ]);
  for (const [table, count] of expected) {
    const row = database
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .get() as { count: number };
    if (row.count !== count) {
      mismatches.push({ actual: row.count, expected: count, table });
    }
  }
}

function compareProjectedKnowledge(
  database: Database.Database,
  domain: DomainProjectionSnapshot,
  repoId: string,
  mismatches: ProjectionMismatch[],
): void {
  const rows = database
    .prepare(
      `SELECT id, repo_id, evidence_count, violation_count, applied_count,
              not_applicable_count, false_positive_count
       FROM knowledge WHERE repo_id = ? ORDER BY id`,
    )
    .all(repoId) as Array<{
    applied_count: number;
    evidence_count: number;
    false_positive_count: number;
    id: string;
    not_applicable_count: number;
    repo_id: string;
    violation_count: number;
  }>;
  const expected = domain.knowledge
    .filter((item) => item.repoId === repoId)
    .map((item) => ({
      applied_count: item.appliedCount,
      evidence_count: item.evidenceCount,
      false_positive_count: item.falsePositiveCount,
      id: item.id,
      not_applicable_count: item.notApplicableCount,
      repo_id: item.repoId,
      violation_count: item.violationCount,
    }));
  if (canonicalizeJson(rows) !== canonicalizeJson(expected)) {
    mismatches.push({ actual: rows, expected, table: "knowledge counts" });
  }
}

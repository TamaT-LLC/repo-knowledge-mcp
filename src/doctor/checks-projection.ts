import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";

import { canonicalizeJson, compareCodeUnits } from "../canonical.js";
import type { DomainProjectionSnapshot } from "../domain-projection.js";
import {
  PROJECTION_SCHEMA_VERSION,
  type ReadOnlyCanonicalStateCapture,
} from "../sqlite-projection.js";
import type { CanonicalInspection } from "./checks-canonical.js";
import { DoctorReportBuilder } from "./report-builder.js";
import { errorCode, errorMessage, octal } from "./util.js";

export async function inspectSqliteProjection(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  canonical: CanonicalInspection | null,
  repoId: string,
  repository: string,
): Promise<void> {
  const path = join(repositoryRoot, "index.sqlite");
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch {
    report.add({
      id: "sqlite.journal",
      message: "SQLite projection does not exist.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    report.add({
      id: "sqlite.projection",
      message: "Projection metadata could not be checked without index.sqlite.",
      path,
      status: "warn",
    });
    return;
  }
  const permission = metadata.mode & 0o777;
  if (!metadata.isFile() || metadata.isSymbolicLink() || permission !== 0o600) {
    report.add({
      details: { mode: octal(permission) },
      id: "sqlite.journal",
      message: "index.sqlite must be a mode-600 regular file.",
      path,
      remedy: `Run chmod 600 ${path}, then reindex if integrity checks fail.`,
      status: "fail",
    });
  }

  let databaseBytes: Buffer;
  try {
    databaseBytes = await readFile(path);
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "sqlite.journal",
      message: "SQLite projection could not be read without mutation.",
      path,
      remedy: `Restore access to index.sqlite, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    report.add({
      id: "sqlite.projection",
      message: "Projection metadata could not be read.",
      path,
      status: "warn",
    });
    return;
  }
  const sqliteHeader = databaseBytes
    .subarray(0, 16)
    .equals(Buffer.from("SQLite format 3\0", "binary"));
  const walHeader =
    sqliteHeader && databaseBytes[18] === 2 && databaseBytes[19] === 2;
  const walPath = `${path}-wal`;
  let pendingWalBytes = 0;
  let walInspectionError: string | null = null;
  try {
    pendingWalBytes = (await lstat(walPath)).size;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      walInspectionError = errorCode(error);
    }
  }

  // A WAL-format database cannot be deserialized directly. Flip only the
  // private in-memory snapshot to rollback format after confirming that no
  // uncheckpointed WAL bytes exist; the on-disk projection is never opened.
  const snapshotBytes = Buffer.from(databaseBytes);
  if (walHeader) {
    snapshotBytes[18] = 1;
    snapshotBytes[19] = 1;
  }
  let database: Database.Database;
  try {
    database = new Database(snapshotBytes, { readonly: true });
  } catch (error) {
    if (permission === 0o600) {
      report.add({
        details: {
          error: errorMessage(error),
          sqlite_header: sqliteHeader,
          ...(walInspectionError === null
            ? {}
            : { wal_error: walInspectionError }),
        },
        id: "sqlite.journal",
        message: "SQLite journal state or database header is invalid.",
        path,
        remedy: `Run repo-knowledge reindex ${repository}.`,
        status: "fail",
      });
    }
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection snapshot could not be opened read-only.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    return;
  }
  try {
    const quickCheck = String(
      database.pragma("quick_check", { simple: true }),
    ).toLowerCase();
    const journalOk =
      walHeader &&
      pendingWalBytes === 0 &&
      walInspectionError === null &&
      quickCheck === "ok" &&
      permission === 0o600;
    if (permission === 0o600) {
      report.add(
        journalOk
          ? {
              details: {
                journal_mode: "wal",
                pending_wal_bytes: pendingWalBytes,
                quick_check: quickCheck,
              },
              id: "sqlite.journal",
              message:
                "SQLite is private, WAL-backed, fully checkpointed, and passes quick_check.",
              path,
              status: "pass",
            }
          : {
              details: {
                journal_mode: walHeader ? "wal" : "rollback-or-invalid",
                pending_wal_bytes: pendingWalBytes,
                quick_check: quickCheck,
                ...(walInspectionError === null
                  ? {}
                  : { wal_error: walInspectionError }),
              },
              id: "sqlite.journal",
              message:
                "SQLite journal mode, checkpoint state, or integrity is invalid.",
              path,
              remedy: `Run repo-knowledge reindex ${repository}.`,
              status: "fail",
            },
      );
    }

    if (pendingWalBytes > 0 || walInspectionError !== null) {
      report.add({
        details: {
          pending_wal_bytes: pendingWalBytes,
          ...(walInspectionError === null
            ? {}
            : { wal_error: walInspectionError }),
        },
        id: "sqlite.projection",
        message:
          "Projection comparison was skipped because the main database snapshot may not include WAL frames.",
        path,
        remedy:
          "Stop repository writers, allow SQLite to checkpoint, then rerun doctor before deciding whether reindex is necessary.",
        status: "warn",
      });
      return;
    }

    const meta = readProjectionMeta(database);
    const mismatches: Array<Record<string, unknown>> = [];
    if (meta.schema_version !== PROJECTION_SCHEMA_VERSION) {
      mismatches.push({
        actual: meta.schema_version,
        expected: PROJECTION_SCHEMA_VERSION,
        field: "schema_version",
      });
    }
    if (meta.index_dirty !== "false") {
      mismatches.push({
        actual: meta.index_dirty,
        expected: "false",
        field: "index_dirty",
      });
    }
    if (
      canonical !== null &&
      meta.canonical_digest !== canonical.capture.canonicalDigest
    ) {
      mismatches.push({
        actual: meta.canonical_digest,
        expected: canonical.capture.canonicalDigest,
        field: "canonical_digest",
      });
    }
    if (canonical !== null) {
      const checkpointFloor = latestCanonicalTransactionId(canonical.capture);
      const checkpoint = meta.last_committed_transaction_id ?? null;
      const hasCanonicalState =
        canonical.capture.knowledge.length > 0 ||
        canonical.capture.records.length > 0;
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
      compareProjectionCounts(database, canonical, mismatches);
      compareProjectedKnowledge(database, canonical.domain, repoId, mismatches);
    }
    report.add(
      mismatches.length === 0
        ? {
            details: {
              canonical_digest: meta.canonical_digest,
              checkpoint: meta.last_committed_transaction_id,
            },
            id: "sqlite.projection",
            message:
              "Projection checkpoint, canonical digest, records, and derived counts are current.",
            path,
            status: "pass",
          }
        : {
            details: { mismatches },
            id: "sqlite.projection",
            message:
              "SQLite projection is dirty or differs from canonical state.",
            path,
            remedy: `Run repo-knowledge reindex ${repository}; use reconcile only for optional Markdown metadata.`,
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection schema or metadata could not be inspected.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
  } finally {
    database.close();
  }
}

function readProjectionMeta(
  database: Database.Database,
): Record<string, string | null> {
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
  mismatches: Array<Record<string, unknown>>,
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
  mismatches: Array<Record<string, unknown>>,
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

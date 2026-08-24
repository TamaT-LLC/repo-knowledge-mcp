import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalizeJson, compareCodeUnits } from "../canonical.js";
import { CanonicalJsonlError } from "../canonical-jsonl.js";
import {
  buildDomainProjectionSnapshot,
  DomainProjectionError,
  type DomainProjectionSnapshot,
} from "../domain-projection.js";
import type { KnowledgeEvidence } from "../domain-schemas.js";
import {
  KnowledgeStoreInvalidError,
  type KnowledgeDocument,
} from "../knowledge-document.js";
import {
  captureCanonicalStateReadOnly,
  type ReadOnlyCanonicalStateCapture,
} from "../sqlite-projection.js";
import { DoctorReportBuilder } from "./report-builder.js";
import { asOptionalObject, errorCode, errorMessage, octal } from "./util.js";

export interface CanonicalInspection {
  readonly capture: ReadOnlyCanonicalStateCapture;
  readonly domain: DomainProjectionSnapshot;
}

export async function inspectTransactions(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  repository: string,
): Promise<void> {
  const path = join(repositoryRoot, "transactions");
  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      report.add({
        id: "canonical.transactions",
        message: "No unresolved canonical transactions exist.",
        path,
        status: "pass",
      });
      return;
    }
    report.add({
      details: { error: errorCode(error) },
      id: "canonical.transactions",
      message: "Transaction journal could not be inspected.",
      path,
      status: "fail",
    });
    return;
  }
  if (entries.length === 0) {
    report.add({
      id: "canonical.transactions",
      message: "No unresolved canonical transactions exist.",
      path,
      status: "pass",
    });
    return;
  }
  const unresolved = entries
    .sort((a, b) => compareCodeUnits(a.name, b.name))
    .map((entry) => ({
      kind: entry.isDirectory() ? "transaction" : "unexpected-entry",
      name: entry.name,
    }));
  report.add({
    details: { unresolved },
    id: "canonical.transactions",
    message: "Unresolved or malformed canonical transaction entries remain.",
    path,
    remedy: `Run repo-knowledge reindex ${repository} to invoke canonical recovery. If it reports RECOVERY_CONFLICT or UNRECOVERABLE_TRANSACTION, restore the affected target or staged payload before retrying.`,
    status: "fail",
  });
}

export async function inspectCanonicalState(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  repoId: string,
  repository: string,
): Promise<CanonicalInspection | null> {
  let capture: ReadOnlyCanonicalStateCapture;
  try {
    capture = await captureCanonicalStateReadOnly(repositoryRoot);
    report.add({
      details: {
        canonical_digest: capture.canonicalDigest,
        knowledge: capture.knowledge.length,
        records: capture.records.length,
      },
      id: "canonical.files",
      message:
        "Canonical Markdown and JSONL are complete, unique, and structurally valid.",
      path: repositoryRoot,
      status: "pass",
    });
  } catch (error) {
    const relativePath =
      error instanceof KnowledgeStoreInvalidError ||
      error instanceof CanonicalJsonlError
        ? error.path
        : null;
    const path =
      relativePath === null
        ? repositoryRoot
        : join(repositoryRoot, relativePath);
    report.add({
      details: { error: errorMessage(error) },
      id: "canonical.files",
      message: "Canonical Markdown or JSONL is invalid.",
      path,
      remedy: `Restore or repair the reported canonical file, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    addSkippedCanonicalChecks(report);
    return null;
  }

  await inspectCanonicalFilePermissions(report, repositoryRoot, capture);
  let domain: DomainProjectionSnapshot;
  try {
    domain = buildDomainProjectionSnapshot(
      capture.records.map((entry) => entry.record),
      capture.knowledge,
    );
    report.add({
      id: "canonical.domain",
      message: "Canonical records reduce to a valid domain state.",
      path: repositoryRoot,
      status: "pass",
    });
  } catch (error) {
    const targetPath =
      error instanceof DomainProjectionError
        ? capture.records.find(
            (entry) => entry.record.record_id === error.recordId,
          )?.targetPath
        : error instanceof KnowledgeStoreInvalidError
          ? error.path
          : undefined;
    report.add({
      details: { error: errorMessage(error) },
      id: "canonical.domain",
      message: "Canonical records do not reduce to a valid domain state.",
      ...(targetPath === undefined
        ? { path: repositoryRoot }
        : { path: join(repositoryRoot, targetPath) }),
      remedy: `Repair or restore the reported canonical source, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    for (const id of [
      "canonical.repo_identity",
      "canonical.orphan_evidence",
      "canonical.derived_counts",
    ]) {
      report.add({
        id,
        message: "Check was skipped because canonical domain reduction failed.",
        status: "warn",
      });
    }
    return null;
  }

  inspectCanonicalRepoIdentity(report, repositoryRoot, capture, repoId);
  inspectOrphanEvidence(report, repositoryRoot, capture, domain, repoId);
  inspectDerivedCounts(
    report,
    repositoryRoot,
    capture.knowledge,
    domain,
    repository,
  );
  return { capture, domain };
}

function addSkippedCanonicalChecks(report: DoctorReportBuilder): void {
  for (const id of [
    "canonical.permissions",
    "canonical.domain",
    "canonical.repo_identity",
    "canonical.orphan_evidence",
    "canonical.derived_counts",
  ]) {
    report.add({
      id,
      message: "Check was skipped because canonical file capture failed.",
      status: "warn",
    });
  }
}

async function inspectCanonicalFilePermissions(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
): Promise<void> {
  const paths = new Set([
    ...capture.knowledge.map((document) => document.path),
    ...capture.records.map((entry) => entry.targetPath),
  ]);
  const invalid: Array<{ mode: string; path: string }> = [];
  for (const path of [...paths].sort(compareCodeUnits)) {
    let metadata: Stats;
    try {
      metadata = await lstat(join(repositoryRoot, path));
    } catch (error) {
      report.add({
        details: { error: errorCode(error) },
        id: "canonical.permissions",
        message:
          "A canonical file disappeared or became unreadable during diagnosis.",
        path: join(repositoryRoot, path),
        remedy:
          "Stop concurrent writers, restore the reported canonical file, and rerun doctor.",
        status: "fail",
      });
      return;
    }
    const permission = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      permission !== 0o600
    ) {
      invalid.push({ mode: octal(permission), path });
    }
  }
  report.add(
    invalid.length === 0
      ? {
          id: "canonical.permissions",
          message: "Canonical files are regular mode-600 files.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { invalid },
          id: "canonical.permissions",
          message:
            "One or more canonical files have unsafe type or permissions.",
          path: join(repositoryRoot, invalid[0]!.path),
          remedy:
            "Replace symlinks with trusted regular files and set canonical file modes to 600.",
          status: "fail",
        },
  );
}

function inspectCanonicalRepoIdentity(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
  repoId: string,
): void {
  const mismatches: Array<{
    actual: string;
    expected: string;
    path: string;
    record_id?: string;
  }> = [];
  for (const document of capture.knowledge) {
    if (document.frontmatter.repo_id !== repoId) {
      mismatches.push({
        actual: document.frontmatter.repo_id,
        expected: repoId,
        path: document.path,
      });
    }
  }
  for (const entry of capture.records) {
    const payload = asOptionalObject(entry.record.payload);
    const actual = payload?.repo_id;
    if (typeof actual === "string" && actual !== repoId) {
      mismatches.push({
        actual,
        expected: repoId,
        path: entry.targetPath,
        record_id: entry.record.record_id,
      });
    }
  }
  report.add(
    mismatches.length === 0
      ? {
          id: "canonical.repo_identity",
          message: "Canonical repo_id values match the registry binding.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { mismatches },
          id: "canonical.repo_identity",
          message: "Canonical data contains a different repository ID.",
          path: join(repositoryRoot, mismatches[0]!.path),
          remedy:
            "Do not rewrite IDs automatically; restore data into the correct registry-bound store.",
          status: "fail",
        },
  );
}

function inspectOrphanEvidence(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
  domain: DomainProjectionSnapshot,
  repoId: string,
): void {
  const knowledge = new Set(
    domain.knowledge
      .filter((item) => item.repoId === repoId)
      .map((item) => item.id),
  );
  const orphaned = domain.evidence
    .filter(
      (evidence) =>
        evidence.repo_id === repoId && !knowledge.has(evidence.knowledge_id),
    )
    .map((evidence) => ({
      evidence_id: evidence.evidence_id,
      knowledge_id: evidence.knowledge_id,
      path: evidencePath(capture, evidence),
      thread_id: evidence.thread_id,
    }));
  report.add(
    orphaned.length === 0
      ? {
          id: "canonical.orphan_evidence",
          message:
            "Every evidence item references an existing knowledge document.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { orphaned },
          id: "canonical.orphan_evidence",
          message:
            "Evidence references missing knowledge, commonly caused by direct Markdown deletion.",
          path:
            orphaned[0]!.path === undefined
              ? repositoryRoot
              : join(repositoryRoot, orphaned[0]!.path),
          remedy:
            "Restore the deleted knowledge Markdown from backup or version control; prefer status transitions over direct deletion.",
          status: "fail",
        },
  );
}

function inspectDerivedCounts(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  documents: readonly KnowledgeDocument[],
  domain: DomainProjectionSnapshot,
  repository: string,
): void {
  const byId = new Map(domain.knowledge.map((item) => [item.id, item]));
  const mismatches: Array<{
    actual: unknown;
    expected: unknown;
    field: string;
    path: string;
  }> = [];
  for (const document of documents) {
    const projected = byId.get(document.frontmatter.id);
    if (projected === undefined) continue;
    compareOptionalDerived(
      mismatches,
      document,
      "evidence_count",
      projected.evidenceCount,
    );
    compareOptionalDerived(
      mismatches,
      document,
      "violation_count",
      projected.violationCount,
    );
    compareOptionalDerived(
      mismatches,
      document,
      "applied_count",
      projected.appliedCount,
    );
    compareOptionalDerived(mismatches, document, "sources", projected.sources);
  }
  report.add(
    mismatches.length === 0
      ? {
          id: "canonical.derived_counts",
          message:
            "Any explicitly stored derived metadata agrees with canonical events.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { mismatches },
          id: "canonical.derived_counts",
          message: "Stored derived metadata differs from event-derived values.",
          path: join(repositoryRoot, mismatches[0]!.path),
          remedy: `Run repo-knowledge reconcile ${repository} --write-derived-metadata after reviewing canonical events.`,
          status: "warn",
        },
  );
}

function compareOptionalDerived(
  target: Array<{
    actual: unknown;
    expected: unknown;
    field: string;
    path: string;
  }>,
  document: KnowledgeDocument,
  field: string,
  expected: unknown,
): void {
  if (!Object.hasOwn(document.frontmatter, field)) return;
  const actual = document.frontmatter[field];
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    target.push({ actual, expected, field, path: document.path });
  }
}

function evidencePath(
  capture: ReadOnlyCanonicalStateCapture,
  evidence: KnowledgeEvidence,
): string | undefined {
  return capture.records.find((entry) => {
    const payload = asOptionalObject(entry.record.payload);
    return payload?.evidence_id === evidence.evidence_id;
  })?.targetPath;
}

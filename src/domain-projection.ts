import { z } from "zod";

import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import { compareCodeUnits, sortAndDedupeStrings } from "./canonical.js";
import {
  CommentObservationSchema,
  KnowledgeCategorySchema,
  KnowledgeEvidenceSchema,
  KnowledgeIdSchema,
  KnowledgeOutcomeSchema,
  KnowledgeRevisionProposalSchema,
  KnowledgeStatusSchema,
  PullRequestObservationSchema,
  PullRequestSnapshotSchema,
  RepositoryIdSchema,
  ScopePatternSchema,
  SeveritySchema,
  SubmissionReceiptSchema,
  ThreadRemovedObservationSchema,
  ThreadObservationSchema,
  type CommentObservation,
  type DistillJob,
  type KnowledgeEvidence,
  type KnowledgeOutcome,
  type KnowledgeRevisionProposal,
  type PullRequestObservation,
  type PullRequestSnapshot,
  type SubmissionReceipt,
  type ThreadRemovedObservation,
  type ThreadObservation,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_RECORD_TYPES,
  DistillJobStateError,
  reduceDistillationJobRecords,
} from "./distill-job-state.js";
import {
  KnowledgeStoreInvalidError,
  type KnowledgeDocument,
} from "./knowledge-document.js";

const EVIDENCE_RECORD_TYPES = new Set([
  "EvidenceCreated",
  "EvidenceSuperseded",
  "EvidenceWithdrawn",
  "KnowledgeEvidence",
]);
const PROPOSAL_RECORD_TYPES = new Set([
  "KnowledgeRevisionProposal",
  "KnowledgeRevisionProposalApproved",
  "KnowledgeRevisionProposalRejected",
]);

const KnowledgeProjectionFrontmatterSchema = z
  .object({
    category: KnowledgeCategorySchema,
    created_at: z.iso.datetime({ offset: true }),
    id: KnowledgeIdSchema,
    repo_id: RepositoryIdSchema,
    revision: z.number().int().positive(),
    rule: z.string().min(1),
    scope: z.array(ScopePatternSchema),
    severity: SeveritySchema,
    status: KnowledgeStatusSchema,
    updated_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();

export type DomainProjectionErrorCode = "INVALID_DOMAIN_RECORD";

export class DomainProjectionError extends Error {
  readonly code: DomainProjectionErrorCode = "INVALID_DOMAIN_RECORD";

  constructor(
    readonly recordId: string,
    readonly recordType: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid ${recordType} projection record ${recordId}: ${message}`,
      options,
    );
    this.name = "DomainProjectionError";
  }
}

export interface ProjectedKnowledgeOutcome extends KnowledgeOutcome {
  readonly recordId: string;
}

export interface ReducedDomainProjection {
  readonly comments: readonly CommentObservation[];
  readonly distillJobs: readonly DistillJob[];
  readonly evidence: readonly KnowledgeEvidence[];
  readonly outcomes: readonly ProjectedKnowledgeOutcome[];
  readonly pullRequestSnapshots: readonly PullRequestSnapshot[];
  readonly pullRequests: readonly PullRequestObservation[];
  readonly revisionProposals: readonly KnowledgeRevisionProposal[];
  readonly submissionReceipts: readonly SubmissionReceipt[];
  readonly threadRemovals: readonly ThreadRemovedObservation[];
  readonly threads: readonly ThreadObservation[];
}

export interface ProjectedKnowledge {
  readonly appliedCount: number;
  readonly category: z.infer<typeof KnowledgeCategorySchema>;
  readonly createdAt: string;
  readonly detail: string;
  readonly etag: string;
  readonly evidenceCount: number;
  readonly id: string;
  readonly path: string;
  readonly repoId: string;
  readonly revision: number;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: z.infer<typeof SeveritySchema>;
  readonly sources: readonly string[];
  readonly status: z.infer<typeof KnowledgeStatusSchema>;
  readonly updatedAt: string;
  readonly violationCount: number;
}

export interface DomainProjectionSnapshot extends ReducedDomainProjection {
  readonly knowledge: readonly ProjectedKnowledge[];
}

interface Sequenced<T> {
  readonly sequence: number;
  readonly timestamp: number;
  readonly value: T;
}

/** Deterministically folds recognized canonical record types into latest state. */
export function reduceDomainRecords(
  records: readonly CanonicalJsonlRecord[],
): ReducedDomainProjection {
  const pullRequests = new Map<string, Sequenced<PullRequestObservation>>();
  const snapshots = new Map<string, Sequenced<PullRequestSnapshot>>();
  const threads = new Map<string, Sequenced<ThreadObservation>>();
  const comments = new Map<string, Sequenced<CommentObservation>>();
  const jobRecords: CanonicalJsonlRecord[] = [];
  const evidence = new Map<string, Sequenced<KnowledgeEvidence>>();
  const proposals = new Map<string, Sequenced<KnowledgeRevisionProposal>>();
  const receipts = new Map<string, Sequenced<SubmissionReceipt>>();
  const threadRemovals = new Map<string, Sequenced<ThreadRemovedObservation>>();
  const outcomes = new Map<string, Sequenced<ProjectedKnowledgeOutcome>>();

  records.forEach((record, sequence) => {
    switch (record.record_type) {
      case "PullRequestObservation":
      case "PullRequestObserved": {
        const value = parsePayload(record, PullRequestObservationSchema);
        upsertLatest(
          pullRequests,
          `${value.repo_id}\0${String(value.pr_number)}`,
          value,
          value.observed_at,
          sequence,
        );
        return;
      }
      case "PullRequestSnapshot":
      case "PullRequestSnapshotCompleted": {
        const value = parsePayload(record, PullRequestSnapshotSchema);
        upsertLatest(
          snapshots,
          value.snapshot_id,
          value,
          value.observed_at,
          sequence,
        );
        return;
      }
      case "ThreadObservation":
      case "ThreadObserved": {
        const value = parsePayload(record, ThreadObservationSchema);
        upsertLatest(
          threads,
          `${value.repo_id}\0${value.thread_id}`,
          value,
          value.observed_at,
          sequence,
        );
        return;
      }
      case "CommentObservation":
      case "CommentObserved": {
        const value = parsePayload(record, CommentObservationSchema);
        upsertLatest(
          comments,
          value.comment_id,
          value,
          record.recorded_at,
          sequence,
        );
        return;
      }
      case "ThreadRemoved": {
        const value = parsePayload(record, ThreadRemovedObservationSchema);
        upsertLatest(
          threadRemovals,
          record.record_id,
          value,
          value.observed_at,
          sequence,
        );
        return;
      }
      case "SubmissionReceipt": {
        const value = parsePayload(record, SubmissionReceiptSchema);
        upsertLatest(
          receipts,
          value.receipt_id,
          value,
          value.committed_at,
          sequence,
        );
        return;
      }
      case "OutcomeRecorded": {
        const value = parsePayload(record, KnowledgeOutcomeSchema);
        upsertLatest(
          outcomes,
          record.record_id,
          { ...value, recordId: record.record_id },
          value.at,
          sequence,
        );
        return;
      }
      default:
        break;
    }

    if (DISTILLATION_JOB_RECORD_TYPES.has(record.record_type)) {
      jobRecords.push(record);
      return;
    }
    if (EVIDENCE_RECORD_TYPES.has(record.record_type)) {
      const value = parsePayload(record, KnowledgeEvidenceSchema);
      upsertLatest(
        evidence,
        value.evidence_id,
        value,
        value.observed_at,
        sequence,
      );
      return;
    }
    if (PROPOSAL_RECORD_TYPES.has(record.record_type)) {
      const value = parsePayload(record, KnowledgeRevisionProposalSchema);
      upsertLatest(
        proposals,
        value.proposal_id,
        value,
        value.updated_at,
        sequence,
      );
    }
  });

  let distillJobs: readonly DistillJob[];
  try {
    distillJobs = reduceDistillationJobRecords(jobRecords);
  } catch (error) {
    if (error instanceof DistillJobStateError) {
      throw new DomainProjectionError(
        error.recordId ?? "unknown",
        error.recordType ?? "DistillJobEvent",
        error.message,
        { cause: error },
      );
    }
    throw error;
  }

  return {
    comments: sortedValues(comments),
    distillJobs,
    evidence: sortedValues(evidence),
    outcomes: sortedValues(outcomes),
    pullRequestSnapshots: sortedValues(snapshots),
    pullRequests: sortedValues(pullRequests),
    revisionProposals: sortedValues(proposals),
    submissionReceipts: sortedValues(receipts),
    threadRemovals: sortedValues(threadRemovals),
    threads: sortedValues(threads),
  };
}

/** Combines canonical Markdown with event-derived counters and sources. */
export function projectKnowledgeDocuments(
  documents: readonly KnowledgeDocument[],
  domain: ReducedDomainProjection,
): readonly ProjectedKnowledge[] {
  const evidenceByKnowledge = groupBy(
    domain.evidence,
    (item) => item.knowledge_id,
  );
  const outcomesByKnowledge = groupBy(
    domain.outcomes,
    (item) => item.knowledge_id,
  );

  return documents
    .map((document): ProjectedKnowledge => {
      const parsed = KnowledgeProjectionFrontmatterSchema.safeParse(
        document.frontmatter,
      );
      if (!parsed.success) {
        throw new KnowledgeStoreInvalidError(
          document.path,
          `frontmatter is not projectable: ${parsed.error.message}`,
          { cause: parsed.error },
        );
      }
      const matchingEvidence = (evidenceByKnowledge.get(parsed.data.id) ?? [])
        .filter((item) => item.repo_id === parsed.data.repo_id)
        .filter((item) => item.status === "active");
      const matchingOutcomes = (
        outcomesByKnowledge.get(parsed.data.id) ?? []
      ).filter((item) => item.repo_id === parsed.data.repo_id);

      return {
        appliedCount: matchingOutcomes.filter(
          (item) => item.outcome === "applied",
        ).length,
        category: parsed.data.category,
        createdAt: parsed.data.created_at,
        detail: document.body,
        etag: document.etag,
        evidenceCount: matchingEvidence.filter(
          (item) => item.eligible_for_count,
        ).length,
        id: parsed.data.id,
        path: document.path,
        repoId: parsed.data.repo_id,
        revision: parsed.data.revision,
        rule: parsed.data.rule,
        scope: sortAndDedupeStrings(parsed.data.scope),
        severity: parsed.data.severity,
        sources: sortAndDedupeStrings(
          matchingEvidence.flatMap((item) => item.sources),
        ),
        status: parsed.data.status,
        updatedAt: parsed.data.updated_at,
        violationCount: matchingOutcomes.filter(
          (item) => item.outcome === "violated",
        ).length,
      };
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function buildDomainProjectionSnapshot(
  records: readonly CanonicalJsonlRecord[],
  documents: readonly KnowledgeDocument[],
): DomainProjectionSnapshot {
  const domain = reduceDomainRecords(records);
  return {
    ...domain,
    knowledge: projectKnowledgeDocuments(documents, domain),
  };
}

function parsePayload<T>(
  record: CanonicalJsonlRecord,
  schema: z.ZodType<T>,
): T {
  const parsed = schema.safeParse(record.payload);
  if (parsed.success) return parsed.data;
  throw new DomainProjectionError(
    record.record_id,
    record.record_type,
    parsed.error.message,
    { cause: parsed.error },
  );
}

function upsertLatest<T>(
  target: Map<string, Sequenced<T>>,
  key: string,
  value: T,
  timestamp: string,
  sequence: number,
): void {
  const candidate = { sequence, timestamp: Date.parse(timestamp), value };
  const previous = target.get(key);
  if (
    previous === undefined ||
    candidate.timestamp > previous.timestamp ||
    (candidate.timestamp === previous.timestamp && sequence > previous.sequence)
  ) {
    target.set(key, candidate);
  }
}

function sortedValues<T>(source: ReadonlyMap<string, Sequenced<T>>): T[] {
  return [...source.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, entry]) => entry.value);
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const group = result.get(key(value));
    if (group === undefined) result.set(key(value), [value]);
    else group.push(value);
  }
  return result;
}

import { z } from "zod";

import {
  DistillJobStateSchema,
  EvidenceStatusSchema,
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  KnowledgeOutcomeSchema,
  KnowledgeStatusSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  SeveritySchema,
  SourceProviderSchema,
  type KnowledgeCategory,
  type KnowledgeOutcome,
  type KnowledgeStatus,
  type Severity,
} from "./domain-schemas.js";
import type { CanonicalKnowledgeReadView } from "./sqlite-projection.js";
import type { SyncCheckpoint } from "./sync-checkpoint-store.js";

export const STATS_SCHEMA_VERSION = 1;
export const STATS_TIMEZONE = "UTC";
export const MAX_STATS_DAY_BUCKET_COUNT = 366;

const MS_PER_UTC_DAY = 24 * 60 * 60 * 1000;
const UTC_DAY_KEY_LENGTH = "YYYY-MM-DD".length;

export const StatsBucketSchema = z.enum(["total", "day"]);

export type StatsBucketMode = z.infer<typeof StatsBucketSchema>;

/**
 * Wire contract for the M2 stats aggregation request. `since` / `until` are
 * ISO 8601 instants with an explicit offset (or `Z`) and select the half-open
 * window `[since, until)`; both are optional for `bucket: "total"` and both
 * are required for `bucket: "day"`.
 */
export const RepositoryStatsRequestSchema = z
  .object({
    bucket: StatsBucketSchema.optional(),
    since: IsoDateTimeSchema.optional(),
    until: IsoDateTimeSchema.optional(),
  })
  .strict();

export interface RepositoryStatsRequest {
  readonly bucket?: StatsBucketMode;
  readonly since?: string;
  readonly until?: string;
}

export type KnowledgeOutcomeType = KnowledgeOutcome["outcome"];
export type EvidenceStatusKey = z.infer<typeof EvidenceStatusSchema>;
export type SourceProviderKey = z.infer<typeof SourceProviderSchema>;
export type DistillJobStateKey = z.infer<typeof DistillJobStateSchema>;

const KNOWLEDGE_STATUS_KEYS = KnowledgeStatusSchema.options;
const KNOWLEDGE_CATEGORY_KEYS = KnowledgeCategorySchema.options;
const SEVERITY_KEYS = SeveritySchema.options;
const EVIDENCE_SOURCE_KEYS = SourceProviderSchema.options;
const EVIDENCE_STATUS_KEYS = EvidenceStatusSchema.options;
const OUTCOME_TYPE_KEYS = KnowledgeOutcomeSchema.shape.outcome.options;
const JOB_STATE_KEYS = DistillJobStateSchema.options;

export interface StatsWindow {
  readonly bucket: StatsBucketMode;
  readonly since: string | null;
  readonly timezone: typeof STATS_TIMEZONE;
  readonly until: string | null;
}

export interface KnowledgeStatsSection {
  readonly by_category: Readonly<Record<KnowledgeCategory, number>>;
  readonly by_severity: Readonly<Record<Severity, number>>;
  readonly by_status: Readonly<Record<KnowledgeStatus, number>>;
  readonly total: number;
}

export interface EvidenceStatsSection {
  readonly by_source: Readonly<Record<SourceProviderKey, number>>;
  readonly by_status: Readonly<Record<EvidenceStatusKey, number>>;
  readonly eligible_for_count: number;
  readonly total: number;
}

export interface OutcomeStatsSection {
  readonly by_type: Readonly<Record<KnowledgeOutcomeType, number>>;
  readonly total: number;
}

export interface JobStatsSection {
  readonly by_state: Readonly<Record<DistillJobStateKey, number>>;
  readonly total: number;
}

export interface SyncCheckpointStats {
  readonly last_pr_number: number;
  readonly last_updated_at: string;
  readonly updated_at: string;
}

export interface SyncStatsSection {
  readonly last_checkpoint: SyncCheckpointStats | null;
}

export interface OperationsStatsSection {
  readonly failed_jobs: number;
  readonly last_sync_checkpoint_at: string | null;
  readonly pending_jobs: number;
}

export interface RepositoryStatsDayBucket {
  readonly day: string;
  readonly evidence_total: number;
  readonly outcome_by_type: Readonly<Record<KnowledgeOutcomeType, number>>;
  readonly outcome_total: number;
}

export interface RepositoryStats {
  readonly buckets: readonly RepositoryStatsDayBucket[] | null;
  readonly canonical_digest: string;
  readonly evidence: EvidenceStatsSection;
  readonly jobs: JobStatsSection;
  readonly knowledge: KnowledgeStatsSection;
  readonly operations: OperationsStatsSection;
  readonly outcomes: OutcomeStatsSection;
  readonly repo: string;
  readonly stats_schema_version: typeof STATS_SCHEMA_VERSION;
  readonly sync: SyncStatsSection;
  readonly window: StatsWindow;
}

export type StatsReadErrorCode =
  | "INVALID_STATS_REQUEST"
  | "INVALID_STATS_WINDOW"
  | "STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH"
  | "STATS_WINDOW_REQUIRED"
  | "STATS_WINDOW_TOO_LARGE";

export class StatsReadError extends Error {
  constructor(
    readonly code: StatsReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "StatsReadError";
  }
}

export interface StatsReadRepository {
  readKnowledgeView(): Promise<CanonicalKnowledgeReadView>;
}

export interface StatsSyncCheckpointReader {
  read(): Promise<SyncCheckpoint | null>;
}

export interface StatsReadServiceOptions {
  readonly repo: string;
  readonly repoId: string;
  readonly repository: StatsReadRepository;
  readonly syncCheckpoints: StatsSyncCheckpointReader;
}

interface ResolvedStatsWindow {
  readonly bucket: StatsBucketMode;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
}

/**
 * Read-only aggregation service behind the M2 `stats` contract. Every value
 * is a pure function of the canonical snapshot (through the same consistent
 * projection read boundary as the knowledge read services) plus the
 * repo-local sync checkpoint, so the same canonical state always yields the
 * same versioned response, before and after reindex.
 */
export class StatsReadService {
  readonly repo: string;
  readonly repoId: string;

  private readonly repository: StatsReadRepository;
  private readonly syncCheckpoints: StatsSyncCheckpointReader;

  constructor(options: StatsReadServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.syncCheckpoints = options.syncCheckpoints;
  }

  async getStats(
    request: RepositoryStatsRequest = {},
  ): Promise<RepositoryStats> {
    const window = resolveStatsWindow(parseStatsRequest(request));
    const snapshot = (await this.repository.readKnowledgeView()).snapshot;
    const checkpoint = await this.readRepositoryCheckpoint();

    const knowledge = snapshot.domain.knowledge.filter(
      (item) => item.repoId === this.repoId,
    );
    const evidence = snapshot.domain.evidence.filter(
      (item) =>
        item.repo_id === this.repoId &&
        isWithinWindow(Date.parse(item.observed_at), window),
    );
    const outcomes = snapshot.domain.outcomes.filter(
      (item) =>
        item.repo_id === this.repoId &&
        isWithinWindow(Date.parse(item.at), window),
    );
    const jobs = snapshot.domain.distillJobs.filter(
      (item) => item.repo_id === this.repoId,
    );

    const jobsByState = countByKey(JOB_STATE_KEYS, jobs, (job) => [job.state]);
    return {
      buckets:
        window.bucket === "day"
          ? buildDayBuckets(window, evidence, outcomes)
          : null,
      canonical_digest: snapshot.canonicalDigest,
      evidence: {
        by_source: countByKey(
          EVIDENCE_SOURCE_KEYS,
          evidence,
          (item) => item.sources,
        ),
        by_status: countByKey(EVIDENCE_STATUS_KEYS, evidence, (item) => [
          item.status,
        ]),
        eligible_for_count: evidence.filter(
          (item) => item.status === "active" && item.eligible_for_count,
        ).length,
        total: evidence.length,
      },
      jobs: { by_state: jobsByState, total: jobs.length },
      knowledge: {
        by_category: countByKey(KNOWLEDGE_CATEGORY_KEYS, knowledge, (item) => [
          item.category,
        ]),
        by_severity: countByKey(SEVERITY_KEYS, knowledge, (item) => [
          item.severity,
        ]),
        by_status: countByKey(KNOWLEDGE_STATUS_KEYS, knowledge, (item) => [
          item.status,
        ]),
        total: knowledge.length,
      },
      operations: {
        failed_jobs: jobsByState.failed,
        last_sync_checkpoint_at:
          checkpoint === null ? null : checkpoint.updated_at,
        pending_jobs: jobsByState.pending,
      },
      outcomes: {
        by_type: countByKey(OUTCOME_TYPE_KEYS, outcomes, (item) => [
          item.outcome,
        ]),
        total: outcomes.length,
      },
      repo: this.repo,
      stats_schema_version: STATS_SCHEMA_VERSION,
      sync: {
        last_checkpoint:
          checkpoint === null
            ? null
            : {
                last_pr_number: checkpoint.cursor.last_pr_number,
                last_updated_at: checkpoint.cursor.last_updated_at,
                updated_at: checkpoint.updated_at,
              },
      },
      window: {
        bucket: window.bucket,
        since: window.sinceMs === null ? null : toUtcInstant(window.sinceMs),
        timezone: STATS_TIMEZONE,
        until: window.untilMs === null ? null : toUtcInstant(window.untilMs),
      },
    };
  }

  /**
   * The checkpoint file is repo-local state, so a cursor bound to another
   * repository can only mean a corrupted or misplaced storage directory.
   * Fail closed instead of reporting a foreign repository's sync progress.
   */
  private async readRepositoryCheckpoint(): Promise<SyncCheckpoint | null> {
    const checkpoint = await this.syncCheckpoints.read();
    if (checkpoint !== null && checkpoint.cursor.repo_id !== this.repoId) {
      throw new StatsReadError(
        "STATS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
        `stored sync checkpoint belongs to ${checkpoint.cursor.repo_id}, not ${this.repoId}`,
      );
    }
    return checkpoint;
  }
}

function parseStatsRequest(
  request: RepositoryStatsRequest,
): z.infer<typeof RepositoryStatsRequestSchema> {
  const parsed = RepositoryStatsRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new StatsReadError(
      "INVALID_STATS_REQUEST",
      `stats request is malformed: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function resolveStatsWindow(
  request: z.infer<typeof RepositoryStatsRequestSchema>,
): ResolvedStatsWindow {
  const bucket = request.bucket ?? "total";
  const sinceMs =
    request.since === undefined ? null : Date.parse(request.since);
  const untilMs =
    request.until === undefined ? null : Date.parse(request.until);
  if (sinceMs !== null && untilMs !== null && sinceMs >= untilMs) {
    throw new StatsReadError(
      "INVALID_STATS_WINDOW",
      "since must be strictly before until in the half-open window [since, until)",
    );
  }
  if (bucket === "day") {
    if (sinceMs === null || untilMs === null) {
      throw new StatsReadError(
        "STATS_WINDOW_REQUIRED",
        'bucket "day" requires both since and until so the bucket list is bounded',
      );
    }
    const bucketCount = countUtcDayBuckets(sinceMs, untilMs);
    if (bucketCount > MAX_STATS_DAY_BUCKET_COUNT) {
      throw new StatsReadError(
        "STATS_WINDOW_TOO_LARGE",
        `window spans ${String(bucketCount)} UTC days; the maximum is ${String(MAX_STATS_DAY_BUCKET_COUNT)}`,
      );
    }
  }
  return { bucket, sinceMs, untilMs };
}

function buildDayBuckets(
  window: ResolvedStatsWindow,
  evidence: readonly { readonly observed_at: string }[],
  outcomes: readonly Pick<KnowledgeOutcome, "at" | "outcome">[],
): readonly RepositoryStatsDayBucket[] {
  // resolveStatsWindow guarantees a bounded [since, until) for bucket "day".
  const sinceMs = window.sinceMs!;
  const untilMs = window.untilMs!;
  const evidenceByDay = new Map<string, number>();
  const outcomesByDay = new Map<string, Record<KnowledgeOutcomeType, number>>();
  for (const item of evidence) {
    const day = utcDayKey(Date.parse(item.observed_at));
    evidenceByDay.set(day, (evidenceByDay.get(day) ?? 0) + 1);
  }
  for (const item of outcomes) {
    const day = utcDayKey(Date.parse(item.at));
    const counts = outcomesByDay.get(day) ?? zeroCounts(OUTCOME_TYPE_KEYS);
    counts[item.outcome] += 1;
    outcomesByDay.set(day, counts);
  }

  const buckets: RepositoryStatsDayBucket[] = [];
  for (
    let dayStartMs = utcDayStart(sinceMs);
    dayStartMs < untilMs;
    dayStartMs += MS_PER_UTC_DAY
  ) {
    const day = utcDayKey(dayStartMs);
    const outcomeByType =
      outcomesByDay.get(day) ?? zeroCounts(OUTCOME_TYPE_KEYS);
    buckets.push({
      day,
      evidence_total: evidenceByDay.get(day) ?? 0,
      outcome_by_type: outcomeByType,
      outcome_total: sumCounts(outcomeByType),
    });
  }
  return buckets;
}

function countByKey<K extends string, T>(
  keys: readonly K[],
  values: readonly T[],
  keysOf: (value: T) => readonly K[],
): Readonly<Record<K, number>> {
  const counts = zeroCounts(keys);
  for (const value of values) {
    for (const key of keysOf(value)) counts[key] += 1;
  }
  return counts;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}

function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function isWithinWindow(
  instantMs: number,
  window: ResolvedStatsWindow,
): boolean {
  if (window.sinceMs !== null && instantMs < window.sinceMs) return false;
  if (window.untilMs !== null && instantMs >= window.untilMs) return false;
  return true;
}

function countUtcDayBuckets(sinceMs: number, untilMs: number): number {
  return Math.ceil((untilMs - utcDayStart(sinceMs)) / MS_PER_UTC_DAY);
}

function utcDayStart(instantMs: number): number {
  return Math.floor(instantMs / MS_PER_UTC_DAY) * MS_PER_UTC_DAY;
}

function utcDayKey(instantMs: number): string {
  return toUtcInstant(utcDayStart(instantMs)).slice(0, UTC_DAY_KEY_LENGTH);
}

function toUtcInstant(instantMs: number): string {
  return new Date(instantMs).toISOString();
}

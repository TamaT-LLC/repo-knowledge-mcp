import type {
  KnowledgeCategory,
  KnowledgeStatus,
  Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";

export const DEFAULT_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT = 50;
export const MAX_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT = 500;
export const MAX_KNOWLEDGE_SEARCH_QUERY_CODE_POINTS = 512;

export type KnowledgeSearchMode = "fts" | "like";

export interface KnowledgeSearchRequest {
  readonly candidateLimit?: number;
  readonly category?: KnowledgeCategory;
  readonly query: string;
  readonly repoId: string;
  readonly statuses?: readonly KnowledgeStatus[];
}

export type ExhaustiveKnowledgeSearchRequest = Omit<
  KnowledgeSearchRequest,
  "candidateLimit"
>;

export interface KnowledgeSearchHit extends ProjectedKnowledge {
  readonly bm25Score: number | null;
  readonly score: number;
  readonly textRank: number;
}

export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeSearchHit[];
  readonly mode: KnowledgeSearchMode;
  readonly normalizedQuery: string;
}

export type KnowledgeSearchErrorCode =
  "SEARCH_LIMIT_INVALID" | "SEARCH_QUERY_INVALID";

export class KnowledgeSearchError extends Error {
  constructor(
    readonly code: KnowledgeSearchErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "KnowledgeSearchError";
  }
}

export interface NormalizedKnowledgeSearchQuery {
  readonly codePointLength: number;
  readonly folded: string;
  readonly ftsLiteral: string;
  readonly likePattern: string;
  readonly mode: KnowledgeSearchMode;
  readonly normalized: string;
}

export function normalizeKnowledgeSearchQuery(
  query: string,
): NormalizedKnowledgeSearchQuery {
  const normalized = query.normalize("NFKC").trim();
  const codePointLength = [...normalized].length;
  if (
    codePointLength === 0 ||
    codePointLength > MAX_KNOWLEDGE_SEARCH_QUERY_CODE_POINTS ||
    !/[\p{L}\p{N}]/u.test(normalized)
  ) {
    throw new KnowledgeSearchError(
      "SEARCH_QUERY_INVALID",
      `query must contain a letter or number and be at most ${String(MAX_KNOWLEDGE_SEARCH_QUERY_CODE_POINTS)} Unicode code points`,
    );
  }
  const folded = normalized.toLocaleLowerCase("en-US");
  return {
    codePointLength,
    folded,
    ftsLiteral: toFtsLiteral(folded),
    likePattern: `%${escapeLikeLiteral(folded)}%`,
    mode: codePointLength < 3 ? "like" : "fts",
    normalized,
  };
}

export function toFtsLiteral(query: string): string {
  const normalized = query.normalize("NFKC");
  return `"${normalized.replaceAll('"', '""')}"`;
}

export function escapeLikeLiteral(query: string): string {
  return query
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function validateKnowledgeSearchCandidateLimit(
  value = DEFAULT_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT
  ) {
    throw new KnowledgeSearchError(
      "SEARCH_LIMIT_INVALID",
      `candidateLimit must be between 1 and ${String(MAX_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT)}`,
    );
  }
  return value;
}

export function reciprocalRank(rank: number): number {
  if (!Number.isSafeInteger(rank) || rank < 0) {
    throw new TypeError("rank must be a non-negative safe integer");
  }
  return 1 / (1 + rank);
}

export function severityBoost(severity: Severity): number {
  switch (severity) {
    case "must":
      return 0.4;
    case "should":
      return 0.2;
    case "consider":
      return 0;
  }
}

export function evidenceBoost(evidenceCount: number): number {
  assertCount(evidenceCount, "evidenceCount");
  return Math.min(0.3, 0.15 * Math.log1p(evidenceCount));
}

export function violationBoost(violationCount: number): number {
  assertCount(violationCount, "violationCount");
  return Math.min(0.15, 0.05 * Math.log1p(violationCount));
}

export const OUTCOME_RANKING_POLICY_VERSION = "m2-outcome-v1";

/**
 * Machine-trackable M2 outcome ranking policy (design doc §11).
 * Changing any constant is a policy change and must bump the version.
 */
export const OUTCOME_RANKING_POLICY = Object.freeze({
  appliedBoostCap: 0.2,
  appliedBoostWeight: 0.1,
  falsePositivePenaltyCap: 0.25,
  falsePositivePenaltyWeight: 0.125,
  minAppliedSample: 3,
  notApplicablePenaltyCap: 0.1,
  notApplicablePenaltyWeight: 0.05,
  version: OUTCOME_RANKING_POLICY_VERSION,
});

export const MAX_OUTCOME_SCORE = OUTCOME_RANKING_POLICY.appliedBoostCap;
export const MIN_OUTCOME_SCORE = -(
  OUTCOME_RANKING_POLICY.notApplicablePenaltyCap +
  OUTCOME_RANKING_POLICY.falsePositivePenaltyCap
);

export interface KnowledgeOutcomeCounts {
  readonly appliedCount: number;
  readonly falsePositiveCount: number;
  readonly notApplicableCount: number;
  readonly violationCount: number;
}

/**
 * Positive `applied` signal. Disabled below the minimum sample so a couple of
 * self-reported events cannot start a self-reinforcing loop.
 */
export function appliedBoost(appliedCount: number): number {
  assertCount(appliedCount, "appliedCount");
  if (appliedCount < OUTCOME_RANKING_POLICY.minAppliedSample) return 0;
  return Math.min(
    OUTCOME_RANKING_POLICY.appliedBoostCap,
    OUTCOME_RANKING_POLICY.appliedBoostWeight * Math.log1p(appliedCount),
  );
}

/** Bounded dampening for `not_applicable`; never contributes a positive term. */
export function notApplicablePenalty(notApplicableCount: number): number {
  assertCount(notApplicableCount, "notApplicableCount");
  return Math.min(
    OUTCOME_RANKING_POLICY.notApplicablePenaltyCap,
    OUTCOME_RANKING_POLICY.notApplicablePenaltyWeight *
      Math.log1p(notApplicableCount),
  );
}

/** Bounded penalty for `false_positive`; never contributes a positive term. */
export function falsePositivePenalty(falsePositiveCount: number): number {
  assertCount(falsePositiveCount, "falsePositiveCount");
  return Math.min(
    OUTCOME_RANKING_POLICY.falsePositivePenaltyCap,
    OUTCOME_RANKING_POLICY.falsePositivePenaltyWeight *
      Math.log1p(falsePositiveCount),
  );
}

/**
 * Bounded M2 outcome score in [MIN_OUTCOME_SCORE, MAX_OUTCOME_SCORE].
 * `violated` is intentionally excluded: it stays in the M1 violation boost so
 * it is never double counted. Zero outcomes always yield exactly 0, which
 * keeps the ranking identical to M1.
 */
export function outcomeScore(counts: KnowledgeOutcomeCounts): number {
  return (
    appliedBoost(counts.appliedCount) -
    notApplicablePenalty(counts.notApplicableCount) -
    falsePositivePenalty(counts.falsePositiveCount)
  );
}

export function computeKnowledgeSearchScore(
  textRank: number,
  severity: Severity,
  evidenceCount: number,
  outcomeCounts: KnowledgeOutcomeCounts,
): number {
  return (
    reciprocalRank(textRank) +
    severityBoost(severity) +
    evidenceBoost(evidenceCount) +
    violationBoost(outcomeCounts.violationCount) +
    outcomeScore(outcomeCounts)
  );
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

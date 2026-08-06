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

export function computeKnowledgeSearchScore(
  textRank: number,
  severity: Severity,
  evidenceCount: number,
  violationCount: number,
): number {
  return (
    reciprocalRank(textRank) +
    severityBoost(severity) +
    evidenceBoost(evidenceCount) +
    violationBoost(violationCount)
  );
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

import picomatch from "picomatch";

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import {
  ExtractCandidateSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  type DistilledCandidate,
  type ExtractCandidate,
} from "./domain-schemas.js";
import {
  computeKnowledgeSearchScore,
  KnowledgeSearchError,
  MAX_KNOWLEDGE_SEARCH_QUERY_CODE_POINTS,
  normalizeKnowledgeSearchQuery,
  type ExhaustiveKnowledgeSearchRequest,
  type KnowledgeSearchHit,
} from "./knowledge-search.js";
import {
  computeMatchSetDigest,
  normalizePossibleMatchSets,
  type PossibleKnowledgeMatch,
  type PossibleMatchSet,
} from "./possible-match.js";
import type { CanonicalKnowledgeSearchView } from "./sqlite-projection.js";

export const DEFAULT_MERGE_CANDIDATE_LIMIT = 8;
export const MIN_MERGE_CANDIDATE_LIMIT = 5;
export const MAX_MERGE_CANDIDATE_LIMIT = 10;

export type MergeCandidateSearchErrorCode =
  "CANDIDATE_SET_INVALID" | "MERGE_SEARCH_INVALID";

export class MergeCandidateSearchError extends Error {
  constructor(
    readonly code: MergeCandidateSearchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "MergeCandidateSearchError";
  }
}

export interface MergeCandidateSearchRepository {
  readKnowledgeSearchView(
    requests: readonly ExhaustiveKnowledgeSearchRequest[],
  ): Promise<CanonicalKnowledgeSearchView>;
}

export interface MergeCandidateSearchServiceOptions {
  readonly candidateLimit?: number;
  readonly repoId: string;
  readonly repository: MergeCandidateSearchRepository;
}

export interface MergeCandidateSearchRequest {
  readonly candidates: readonly ExtractCandidate[];
  readonly threadId: string;
}

export interface MergeCandidateSearchResult {
  readonly candidates: readonly ExtractCandidate[];
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchSet<PossibleKnowledgeMatch>[];
}

export interface MergeCandidateSearchPlan {
  readonly candidateLimit: number;
  readonly candidates: readonly ExtractCandidate[];
  readonly searchable: readonly SearchableCandidate[];
  readonly threadId: string;
}

export interface SearchableCandidate {
  readonly candidate: ExtractCandidate;
  readonly request: ExhaustiveKnowledgeSearchRequest;
}

/** Performs candidate-specific merge search without entering a write path. */
export class MergeCandidateSearchService {
  private readonly candidateLimit: number;
  private readonly repoId: string;
  private readonly repository: MergeCandidateSearchRepository;

  constructor(options: MergeCandidateSearchServiceOptions) {
    this.candidateLimit = validateCandidateLimit(options.candidateLimit);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
  }

  async search(
    request: MergeCandidateSearchRequest,
  ): Promise<MergeCandidateSearchResult> {
    const plan = createMergeCandidateSearchPlan({
      candidateLimit: this.candidateLimit,
      candidates: request.candidates,
      repoId: this.repoId,
      threadId: request.threadId,
    });
    const view = await this.repository.readKnowledgeSearchView(
      plan.searchable.map((entry) => entry.request),
    );
    return resolveMergeCandidateSearch(plan, view);
  }
}

export interface CreateMergeCandidateSearchPlanRequest {
  readonly candidateLimit?: number;
  readonly candidates: readonly ExtractCandidate[];
  readonly repoId: string;
  readonly threadId: string;
}

/** Creates the deterministic FTS work needed by both extract and finalize. */
export function createMergeCandidateSearchPlan(
  request: CreateMergeCandidateSearchPlanRequest,
): MergeCandidateSearchPlan {
  const repoId = RepositoryIdSchema.parse(request.repoId);
  const threadId = NonEmptyStringSchema.parse(request.threadId);
  const candidateLimit = validateCandidateLimit(request.candidateLimit);
  const candidates = collapseExactCandidateRules(request.candidates);
  if (candidates.length === 0) {
    throw new MergeCandidateSearchError(
      "CANDIDATE_SET_INVALID",
      "merge search requires at least one candidate",
    );
  }

  const searchable = candidates.map((candidate): SearchableCandidate => {
    const query = candidateSearchQuery(candidate.candidate);
    if (query === null) {
      throw new MergeCandidateSearchError(
        "CANDIDATE_SET_INVALID",
        `candidate ${candidate.candidate_id} has no searchable rule or detail`,
      );
    }
    return {
      candidate,
      request: {
        category: candidate.candidate.category,
        query,
        repoId,
        statuses: ["active", "proposed"],
      },
    };
  });
  return { candidateLimit, candidates, searchable, threadId };
}

/** Resolves one already-consistent projection view into the bound match set. */
export function resolveMergeCandidateSearch(
  plan: MergeCandidateSearchPlan,
  view: CanonicalKnowledgeSearchView,
): MergeCandidateSearchResult {
  if (view.searchResults.length !== plan.searchable.length) {
    throw new MergeCandidateSearchError(
      "MERGE_SEARCH_INVALID",
      "repository returned the wrong number of search results",
    );
  }

  const hitsByCandidate = new Map<string, readonly KnowledgeSearchHit[]>();
  plan.searchable.forEach((entry, index) => {
    const result = view.searchResults[index]!;
    const hits = rerankAfterScopeFilter(
      result.hits.filter((hit) =>
        scopesMayOverlap(entry.candidate.candidate.scope, hit.scope),
      ),
    ).slice(0, plan.candidateLimit);
    hitsByCandidate.set(entry.candidate.candidate_id, hits);
  });

  const repoId = plan.searchable[0]!.request.repoId;
  const previousKnowledgeIds = sortAndDedupeStrings(
    view.snapshot.domain.evidence
      .filter(
        (evidence) =>
          evidence.repo_id === repoId && evidence.thread_id === plan.threadId,
      )
      .map((evidence) => evidence.knowledge_id),
  );
  const previousKnowledgeIdSet = new Set(previousKnowledgeIds);
  const knowledgeById = new Map(
    view.snapshot.domain.knowledge
      .filter((knowledge) => knowledge.repoId === repoId)
      .map((knowledge) => [knowledge.id, knowledge] as const),
  );
  const possibleMatches = normalizePossibleMatchSets(
    plan.candidates.map((candidate) => {
      const ids = new Set(
        (hitsByCandidate.get(candidate.candidate_id) ?? []).map(
          (hit) => hit.id,
        ),
      );
      for (const id of previousKnowledgeIds) ids.add(id);

      const matches = [...ids].flatMap((id): PossibleKnowledgeMatch[] => {
        const knowledge = knowledgeById.get(id);
        if (knowledge === undefined) return [];
        if (
          knowledge.status === "rejected" ||
          knowledge.status === "deprecated"
        ) {
          return [];
        }
        if (
          knowledge.status !== "active" &&
          knowledge.status !== "proposed" &&
          !(
            knowledge.status === "stale" &&
            previousKnowledgeIdSet.has(knowledge.id)
          )
        ) {
          return [];
        }
        return [
          {
            category: knowledge.category,
            detail: knowledge.detail,
            etag: knowledge.etag,
            knowledge_id: knowledge.id,
            revision: knowledge.revision,
            rule: knowledge.rule,
            scope: knowledge.scope,
            severity: knowledge.severity,
            status: knowledge.status,
          },
        ];
      });
      return {
        candidate_id: candidate.candidate_id,
        possible_matches: matches,
      };
    }),
  );

  return {
    candidates: plan.candidates,
    match_set_digest: computeMatchSetDigest(possibleMatches),
    possible_matches: possibleMatches,
  };
}

/** NFKC/whitespace normalization used only for exact duplicate collapse. */
export function normalizeCandidateRule(rule: string): string {
  const normalized = NonEmptyStringSchema.parse(rule)
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new MergeCandidateSearchError(
      "CANDIDATE_SET_INVALID",
      "candidate rule must contain non-whitespace content",
    );
  }
  return normalized;
}

/** Collapses scalar-equivalent exact rules and unions set-like evidence/scope. */
export function collapseExactCandidateRules(
  values: readonly ExtractCandidate[],
): ExtractCandidate[] {
  const candidates = values.map((value) => ExtractCandidateSchema.parse(value));
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.candidate_id)) {
      throw new MergeCandidateSearchError(
        "CANDIDATE_SET_INVALID",
        `duplicate candidate ID ${candidate.candidate_id}`,
      );
    }
    ids.add(candidate.candidate_id);
  }

  const groups = new Map<string, ExtractCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateCollapseKey(candidate.candidate);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }

  return [...groups.values()]
    .map((group) => {
      group.sort((left, right) =>
        compareCodeUnits(left.candidate_id, right.candidate_id),
      );
      const representative = group[0]!;
      return {
        candidate: {
          ...representative.candidate,
          confidence: Math.max(
            ...group.map((candidate) => candidate.candidate.confidence),
          ),
          evidence_comment_ids: sortAndDedupeStrings(
            group.flatMap(
              (candidate) => candidate.candidate.evidence_comment_ids,
            ),
          ),
          scope: sortAndDedupeStrings(
            group.flatMap((candidate) => candidate.candidate.scope),
          ),
        },
        candidate_id: representative.candidate_id,
      } satisfies ExtractCandidate;
    })
    .sort((left, right) =>
      compareCodeUnits(left.candidate_id, right.candidate_id),
    );
}

function candidateCollapseKey(candidate: DistilledCandidate): string {
  return canonicalizeJson({
    category: candidate.category,
    detail: normalizeCandidateText(candidate.detail),
    rule: normalizeCandidateRule(candidate.rule),
    severity: candidate.severity,
  });
}

function normalizeCandidateText(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ");
}

/** Conservative glob-overlap test: uncertain pattern pairs remain candidates. */
export function scopesMayOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((leftPattern) =>
    right.some((rightPattern) => patternsMayOverlap(leftPattern, rightPattern)),
  );
}

function patternsMayOverlap(left: string, right: string): boolean {
  try {
    picomatch(left, scopeOptions());
    picomatch(right, scopeOptions());
    const leftScan = picomatch.scan(left);
    const rightScan = picomatch.scan(right);
    if (!leftScan.isGlob && picomatch.isMatch(left, right, scopeOptions())) {
      return true;
    }
    if (!rightScan.isGlob && picomatch.isMatch(right, left, scopeOptions())) {
      return true;
    }
    const leftBase = normalizedGlobBase(leftScan.base);
    const rightBase = normalizedGlobBase(rightScan.base);
    if (leftBase.length === 0 || rightBase.length === 0) return true;
    return (
      leftBase === rightBase ||
      leftBase.startsWith(`${rightBase}/`) ||
      rightBase.startsWith(`${leftBase}/`)
    );
  } catch (error) {
    throw new MergeCandidateSearchError(
      "MERGE_SEARCH_INVALID",
      "candidate or knowledge scope contains an invalid glob",
      { cause: error },
    );
  }
}

function scopeOptions(): picomatch.PicomatchOptions {
  return { dot: true, nocase: false };
}

function normalizedGlobBase(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function candidateSearchQuery(candidate: DistilledCandidate): string | null {
  for (const value of [candidate.rule, candidate.detail]) {
    try {
      const bounded = [...value.normalize("NFKC")]
        .slice(0, MAX_KNOWLEDGE_SEARCH_QUERY_CODE_POINTS)
        .join("");
      return normalizeKnowledgeSearchQuery(bounded).normalized;
    } catch (error) {
      if (!(error instanceof KnowledgeSearchError)) throw error;
    }
  }
  return null;
}

function rerankAfterScopeFilter(
  hits: readonly KnowledgeSearchHit[],
): KnowledgeSearchHit[] {
  return [...hits]
    .sort(
      (left, right) =>
        left.textRank - right.textRank || compareCodeUnits(left.id, right.id),
    )
    .map((hit, textRank) => ({
      ...hit,
      score: computeKnowledgeSearchScore(
        textRank,
        hit.severity,
        hit.evidenceCount,
        hit,
      ),
      textRank,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.textRank - right.textRank ||
        compareCodeUnits(left.id, right.id),
    );
}

function validateCandidateLimit(value?: number): number {
  const resolved = value ?? DEFAULT_MERGE_CANDIDATE_LIMIT;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < MIN_MERGE_CANDIDATE_LIMIT ||
    resolved > MAX_MERGE_CANDIDATE_LIMIT
  ) {
    throw new TypeError(
      `candidateLimit must be between ${String(MIN_MERGE_CANDIDATE_LIMIT)} and ${String(MAX_MERGE_CANDIDATE_LIMIT)}`,
    );
  }
  return resolved;
}

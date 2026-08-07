import { posix } from "node:path";

import picomatch from "picomatch";
import { z } from "zod";

import { compareCodeUnits, sortAndDedupeStrings } from "./canonical.js";
import {
  EvidenceIdSchema,
  IsoDateTimeSchema,
  KnowledgeIdSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  type GeneratedCodeExample,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import { parseKnowledgeBodyCodeExample } from "./knowledge-code-example.js";
import {
  DEFAULT_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT,
  MAX_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT,
  normalizeKnowledgeSearchQuery,
  type ExhaustiveKnowledgeSearchRequest,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult as ProjectionSearchResult,
} from "./knowledge-search.js";
import type { KnowledgeFrontmatter } from "./knowledge-document.js";
import type {
  CanonicalKnowledgeReadView,
  CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";

export const DEFAULT_GET_RULES_LIMIT = 20;
export const DEFAULT_SEARCH_KNOWLEDGE_LIMIT = 20;
export const MAX_READ_RESULT_LIMIT = 100;
export const DEFAULT_EVIDENCE_LIMIT = 50;
export const MAX_EVIDENCE_LIMIT = 100;

export type KnowledgeReadErrorCode =
  | "INVALID_CURSOR"
  | "INVALID_EVIDENCE_LIMIT"
  | "INVALID_FILE_PATH"
  | "INVALID_LIMIT"
  | "INVALID_SCOPE_PATTERN"
  | "KNOWLEDGE_NOT_FOUND"
  | "KNOWLEDGE_PROJECTION_INVALID";

export class KnowledgeReadError extends Error {
  constructor(
    readonly code: KnowledgeReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "KnowledgeReadError";
  }
}

export interface KnowledgeReadRepository {
  readKnowledgeView(
    searchRequest?: ExhaustiveKnowledgeSearchRequest,
  ): Promise<CanonicalKnowledgeReadView>;
  searchKnowledge(
    request: KnowledgeSearchRequest,
  ): Promise<ProjectionSearchResult>;
}

export interface KnowledgeReadServiceOptions {
  readonly repo: string;
  readonly repoId: string;
  readonly repository: KnowledgeReadRepository;
}

export interface GetRulesRequest {
  readonly filePaths?: readonly string[];
  readonly limit?: number;
  readonly task?: string;
}

export type RuleMatchReason =
  | { readonly type: "global" }
  | {
      readonly file_path: string;
      readonly pattern: string;
      readonly type: "scope";
    }
  | { readonly score: number; readonly type: "task" };

export interface GetRulesRule {
  readonly evidence_count: number;
  readonly example_url?: string;
  readonly id: string;
  readonly match_reasons: readonly RuleMatchReason[];
  readonly rule: string;
  readonly severity: Severity;
  readonly violation_count: number;
}

export interface GetRulesResult {
  readonly matched_count: number;
  readonly repo: string;
  readonly rules: readonly GetRulesRule[];
  readonly truncated: boolean;
}

export interface SearchKnowledgeRequest {
  readonly category?: KnowledgeCategory;
  readonly limit?: number;
  readonly query: string;
}

export interface SearchKnowledgeItem {
  readonly applied_count: number;
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly etag: string;
  readonly evidence_count: number;
  readonly id: string;
  readonly revision: number;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly score: number;
  readonly severity: Severity;
  readonly sources: readonly string[];
  readonly violation_count: number;
}

export interface SearchKnowledgeResult {
  readonly mode: ProjectionSearchResult["mode"];
  readonly query: string;
  readonly repo: string;
  readonly results: readonly SearchKnowledgeItem[];
}

export interface GetKnowledgeRequest {
  readonly cursor?: string;
  readonly evidenceLimit?: number;
  readonly id: string;
}

export interface KnowledgeDetail {
  readonly applied_count: number;
  /**
   * Structured M2 code example parsed from the canonical body, or null for
   * M1-era documents and hand-edited bodies without a valid example section.
   */
  readonly code_example: GeneratedCodeExample | null;
  readonly detail: string;
  readonly etag: string;
  readonly evidence_count: number;
  readonly frontmatter: Readonly<KnowledgeFrontmatter>;
  readonly id: string;
  readonly revision: number;
  readonly sources: readonly string[];
  readonly violation_count: number;
}

export interface GetKnowledgeResult {
  readonly evidence: readonly KnowledgeEvidence[];
  readonly knowledge: KnowledgeDetail;
  readonly next_cursor: string | null;
  readonly repo: string;
}

interface RuleMatchAccumulator {
  readonly knowledge: ProjectedKnowledge;
  readonly reasons: RuleMatchReason[];
  taskScore: number | undefined;
}

const EvidenceCursorSchema = z
  .object({
    evidence_id: EvidenceIdSchema,
    knowledge_id: KnowledgeIdSchema,
    observed_at: IsoDateTimeSchema,
    repo_id: RepositoryIdSchema,
    version: z.literal(1),
  })
  .strict();

type EvidenceCursor = z.infer<typeof EvidenceCursorSchema>;

/** Active-only application service shared by MCP and ordinary CLI reads. */
export class KnowledgeReadService {
  readonly repo: string;
  readonly repoId: string;

  private readonly repository: KnowledgeReadRepository;

  constructor(options: KnowledgeReadServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
  }

  async getRules(request: GetRulesRequest = {}): Promise<GetRulesResult> {
    const limit = validateResultLimit(
      request.limit,
      DEFAULT_GET_RULES_LIMIT,
      "get_rules limit",
    );
    const filePaths = normalizeRepositoryFilePaths(request.filePaths ?? []);
    if (request.task !== undefined) {
      normalizeKnowledgeSearchQuery(request.task);
    }

    const taskSearchRequest: ExhaustiveKnowledgeSearchRequest | undefined =
      request.task === undefined
        ? undefined
        : {
            query: request.task,
            repoId: this.repoId,
            statuses: ["active"],
          };
    const view = await this.repository.readKnowledgeView(taskSearchRequest);
    const snapshot = view.snapshot;
    const active = snapshot.domain.knowledge.filter(
      (knowledge) =>
        knowledge.repoId === this.repoId && knowledge.status === "active",
    );
    const matches = new Map<string, RuleMatchAccumulator>();

    for (const knowledge of active) {
      const reasons = scopeMatchReasons(knowledge.scope, filePaths);
      if (reasons.length > 0) {
        matches.set(knowledge.id, {
          knowledge,
          reasons,
          taskScore: undefined,
        });
      }
    }

    if (view.searchResult !== null) {
      const taskMatches = view.searchResult;
      for (const hit of taskMatches.hits) {
        const existing = matches.get(hit.id);
        if (existing !== undefined) {
          existing.taskScore = hit.score;
          existing.reasons.push({ score: hit.score, type: "task" });
        } else if (filePaths.length === 0) {
          matches.set(hit.id, {
            knowledge: hit,
            reasons: [{ score: hit.score, type: "task" }],
            taskScore: hit.score,
          });
        }
      }
    }

    const exampleUrls = representativeEvidenceUrls(snapshot, this.repoId);
    const ordered = [...matches.values()].sort(compareRuleMatches);
    const matchedCount = ordered.length;
    return {
      matched_count: matchedCount,
      repo: this.repo,
      rules: ordered.slice(0, limit).map(({ knowledge, reasons }) => {
        const exampleUrl = exampleUrls.get(knowledge.id);
        return {
          evidence_count: knowledge.evidenceCount,
          ...(exampleUrl === undefined ? {} : { example_url: exampleUrl }),
          id: knowledge.id,
          match_reasons: reasons,
          rule: knowledge.rule,
          severity: knowledge.severity,
          violation_count: knowledge.violationCount,
        };
      }),
      truncated: matchedCount > limit,
    };
  }

  async searchKnowledge(
    request: SearchKnowledgeRequest,
  ): Promise<SearchKnowledgeResult> {
    const limit = validateResultLimit(
      request.limit,
      DEFAULT_SEARCH_KNOWLEDGE_LIMIT,
      "search_knowledge limit",
    );
    const projection = await this.repository.searchKnowledge({
      candidateLimit: Math.min(
        MAX_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT,
        Math.max(DEFAULT_KNOWLEDGE_SEARCH_CANDIDATE_LIMIT, limit),
      ),
      ...(request.category === undefined ? {} : { category: request.category }),
      query: request.query,
      repoId: this.repoId,
      statuses: ["active"],
    });

    return {
      mode: projection.mode,
      query: projection.normalizedQuery,
      repo: this.repo,
      results: projection.hits.slice(0, limit).map((hit) => ({
        applied_count: hit.appliedCount,
        category: hit.category,
        detail: hit.detail,
        etag: hit.etag,
        evidence_count: hit.evidenceCount,
        id: hit.id,
        revision: hit.revision,
        rule: hit.rule,
        scope: hit.scope,
        score: hit.score,
        severity: hit.severity,
        sources: hit.sources,
        violation_count: hit.violationCount,
      })),
    };
  }

  async getKnowledge(
    request: GetKnowledgeRequest,
  ): Promise<GetKnowledgeResult> {
    const id = KnowledgeIdSchema.parse(request.id);
    const evidenceLimit = validateEvidenceLimit(request.evidenceLimit);
    const cursor =
      request.cursor === undefined
        ? undefined
        : decodeEvidenceCursor(request.cursor, id, this.repoId);
    const snapshot = (await this.repository.readKnowledgeView()).snapshot;
    const knowledge = snapshot.domain.knowledge.find(
      (item) =>
        item.id === id &&
        item.repoId === this.repoId &&
        item.status === "active",
    );
    if (knowledge === undefined) {
      throw new KnowledgeReadError(
        "KNOWLEDGE_NOT_FOUND",
        `active knowledge ${id} was not found in ${this.repo}`,
      );
    }
    const document = snapshot.knowledge.find(
      (item) => item.path === knowledge.path,
    );
    if (document === undefined || document.frontmatter.id !== knowledge.id) {
      throw new KnowledgeReadError(
        "KNOWLEDGE_PROJECTION_INVALID",
        `projection ${knowledge.id} has no matching canonical Markdown`,
      );
    }

    const allEvidence = snapshot.domain.evidence
      .filter(
        (item) => item.knowledge_id === id && item.repo_id === this.repoId,
      )
      .sort(compareEvidenceDescending);
    const afterCursor =
      cursor === undefined
        ? allEvidence
        : allEvidence.filter((item) => isAfterEvidenceCursor(item, cursor));
    const page = afterCursor.slice(0, evidenceLimit);
    const nextCursor =
      afterCursor.length > evidenceLimit
        ? encodeEvidenceCursor(page.at(-1)!, id, this.repoId)
        : null;

    return {
      evidence: page,
      knowledge: {
        applied_count: knowledge.appliedCount,
        code_example: parseKnowledgeBodyCodeExample(document.body).code_example,
        detail: knowledge.detail,
        etag: knowledge.etag,
        evidence_count: knowledge.evidenceCount,
        frontmatter: document.frontmatter,
        id: knowledge.id,
        revision: knowledge.revision,
        sources: knowledge.sources,
        violation_count: knowledge.violationCount,
      },
      next_cursor: nextCursor,
      repo: this.repo,
    };
  }
}

export function normalizeRepositoryFilePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("\\\\")
  ) {
    throw invalidFilePath(value);
  }
  const withPosixSeparators = value.replaceAll("\\", "/");
  if (withPosixSeparators.split("/").includes("..")) {
    throw invalidFilePath(value);
  }
  const normalized = posix.normalize(withPosixSeparators);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw invalidFilePath(value);
  }
  return normalized;
}

export function encodeEvidenceCursor(
  evidence: Pick<KnowledgeEvidence, "evidence_id" | "observed_at">,
  knowledgeId: string,
  repoId: string,
): string {
  const payload = EvidenceCursorSchema.parse({
    evidence_id: evidence.evidence_id,
    knowledge_id: knowledgeId,
    observed_at: evidence.observed_at,
    repo_id: repoId,
    version: 1,
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function normalizeRepositoryFilePaths(values: readonly string[]): string[] {
  return sortAndDedupeStrings(values.map(normalizeRepositoryFilePath));
}

function scopeMatchReasons(
  scope: readonly string[],
  filePaths: readonly string[],
): RuleMatchReason[] {
  if (scope.length === 0) return [{ type: "global" }];
  if (filePaths.length === 0) return [];

  const reasons: RuleMatchReason[] = [];
  for (const pattern of scope) {
    if (pattern.startsWith("!")) {
      throw new KnowledgeReadError(
        "INVALID_SCOPE_PATTERN",
        `negative scope pattern is not supported: ${pattern}`,
      );
    }
    let isMatch: (value: string) => boolean;
    try {
      isMatch = picomatch(pattern, { dot: true, nocase: false });
    } catch (error) {
      throw new KnowledgeReadError(
        "INVALID_SCOPE_PATTERN",
        `scope pattern could not be compiled: ${pattern}`,
        { cause: error },
      );
    }
    for (const filePath of filePaths) {
      if (isMatch(filePath)) {
        reasons.push({ file_path: filePath, pattern, type: "scope" });
      }
    }
  }
  return reasons;
}

function representativeEvidenceUrls(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
): Map<string, string> {
  const result = new Map<string, string>();
  const ordered = snapshot.domain.evidence
    .filter(
      (item) =>
        item.repo_id === repoId &&
        item.status === "active" &&
        item.url !== undefined,
    )
    .sort(compareEvidenceDescending);
  for (const evidence of ordered) {
    const url = evidence.url;
    if (url !== undefined && !result.has(evidence.knowledge_id)) {
      result.set(evidence.knowledge_id, url);
    }
  }
  return result;
}

function compareRuleMatches(
  left: RuleMatchAccumulator,
  right: RuleMatchAccumulator,
): number {
  return (
    severityPriority(left.knowledge.severity) -
      severityPriority(right.knowledge.severity) ||
    compareOptionalScores(left.taskScore, right.taskScore) ||
    right.knowledge.evidenceCount - left.knowledge.evidenceCount ||
    right.knowledge.violationCount - left.knowledge.violationCount ||
    compareCodeUnits(left.knowledge.id, right.knowledge.id)
  );
}

function compareOptionalScores(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  return right - left;
}

function severityPriority(severity: Severity): number {
  switch (severity) {
    case "must":
      return 0;
    case "should":
      return 1;
    case "consider":
      return 2;
  }
}

function validateResultLimit(
  value: number | undefined,
  defaultValue: number,
  label: string,
): number {
  const resolved = value ?? defaultValue;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_READ_RESULT_LIMIT
  ) {
    throw new KnowledgeReadError(
      "INVALID_LIMIT",
      `${label} must be between 1 and ${String(MAX_READ_RESULT_LIMIT)}`,
    );
  }
  return resolved;
}

function validateEvidenceLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_EVIDENCE_LIMIT;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_EVIDENCE_LIMIT
  ) {
    throw new KnowledgeReadError(
      "INVALID_EVIDENCE_LIMIT",
      `evidenceLimit must be between 1 and ${String(MAX_EVIDENCE_LIMIT)}`,
    );
  }
  return resolved;
}

function decodeEvidenceCursor(
  cursor: string,
  knowledgeId: string,
  repoId: string,
): EvidenceCursor {
  if (
    cursor.length === 0 ||
    cursor.length > 2_048 ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    throw invalidCursor();
  }
  try {
    const parsed = EvidenceCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    if (parsed.knowledge_id !== knowledgeId || parsed.repo_id !== repoId) {
      throw invalidCursor();
    }
    return parsed;
  } catch (error) {
    if (error instanceof KnowledgeReadError) throw error;
    throw invalidCursor(error);
  }
}

function compareEvidenceDescending(
  left: KnowledgeEvidence,
  right: KnowledgeEvidence,
): number {
  return (
    Date.parse(right.observed_at) - Date.parse(left.observed_at) ||
    compareCodeUnits(right.evidence_id, left.evidence_id)
  );
}

function isAfterEvidenceCursor(
  evidence: KnowledgeEvidence,
  cursor: EvidenceCursor,
): boolean {
  const evidenceTime = Date.parse(evidence.observed_at);
  const cursorTime = Date.parse(cursor.observed_at);
  return (
    evidenceTime < cursorTime ||
    (evidenceTime === cursorTime &&
      compareCodeUnits(evidence.evidence_id, cursor.evidence_id) < 0)
  );
}

function invalidFilePath(value: string): KnowledgeReadError {
  return new KnowledgeReadError(
    "INVALID_FILE_PATH",
    `file path must be repository-relative: ${JSON.stringify(value)}`,
  );
}

function invalidCursor(cause?: unknown): KnowledgeReadError {
  return new KnowledgeReadError(
    "INVALID_CURSOR",
    "evidence cursor is malformed or belongs to another knowledge item",
    cause === undefined ? undefined : { cause },
  );
}

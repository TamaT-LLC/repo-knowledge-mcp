import { posix } from "node:path";

import type { GlobalStore } from "./global-store.js";
import {
  GLOBAL_STORE_ID,
  ALWAYS_RETURN_LIMIT,
} from "./global-always-return.js";
import {
  conversationSummary,
  isConversationKnowledge,
} from "./conversation-knowledge-summary.js";
import picomatch from "picomatch";
import { z } from "zod";

import { compareCodeUnits, sortAndDedupeStrings } from "./canonical.js";
import {
  EvidenceIdSchema,
  IsoDateTimeSchema,
  KnowledgeIdSchema,
  RepositoryReadinessSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  type DistillJob,
  type GeneratedCodeExample,
  type KnowledgeCategory,
  type KnowledgeEvidence,
  type RepositoryReadiness,
  type Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import { parseKnowledgeBodyCodeExample } from "./knowledge-code-example.js";
import {
  normalizeKnowledgeSearchQuery,
  type ExhaustiveKnowledgeSearchRequest,
  type KnowledgeSearchRequest,
  type KnowledgeSearchResult as ProjectionSearchResult,
} from "./knowledge-search.js";
import type { KnowledgeFrontmatter } from "./knowledge-document.js";
import type { SyncCheckpoint } from "./sync-checkpoint-store.js";
import { scopeGlobOptions } from "./scope-glob.js";
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
  | "KNOWLEDGE_PROJECTION_INVALID"
  | "READINESS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH";

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

export interface KnowledgeReadSyncCheckpointReader {
  read(): Promise<SyncCheckpoint | null>;
}

export interface KnowledgeReadServiceOptions {
  readonly globalStore?: GlobalStore;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: KnowledgeReadRepository;
  readonly syncCheckpoints?: KnowledgeReadSyncCheckpointReader;
}

export interface GetRulesRequest {
  readonly filePaths?: readonly string[];
  readonly limit?: number;
  readonly task?: string;
}

export type RuleMatchReason =
  | {
      readonly type: "global_store";
      readonly via: "always" | "scope" | "task";
      readonly score?: number;
    }
  | { readonly type: "global" }
  | {
      readonly file_path: string;
      readonly pattern: string;
      readonly type: "scope";
    }
  | { readonly score: number; readonly type: "task" };

export interface GetRulesRule {
  readonly always_return_set_by?: "mcp";
  readonly evidence_count: number;
  readonly example_url?: string;
  readonly id: string;
  readonly match_reasons: readonly RuleMatchReason[];
  readonly rule: string;
  readonly severity: Severity;
  readonly violation_count: number;
}

export interface GetRulesResult {
  readonly global_matched_count?: number;
  readonly global_read_failed?: true;
  readonly global_truncated?: boolean;
  readonly matched_count: number;
  readonly readiness: RepositoryReadiness;
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
  readonly conversation_summary?: ReturnType<typeof conversationSummary>;
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

  private readonly globalStore: GlobalStore | undefined;
  private readonly repository: KnowledgeReadRepository;
  private readonly syncCheckpoints:
    | KnowledgeReadSyncCheckpointReader
    | undefined;

  constructor(options: KnowledgeReadServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.globalStore = options.globalStore;
    this.syncCheckpoints = options.syncCheckpoints;
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
            queryMode: "literal_terms",
            repoId: this.repoId,
            statuses: ["active"],
          };
    const [view, global] = await Promise.all([
      this.repository.readKnowledgeView(taskSearchRequest),
      this.globalStore?.readRules(request.task).catch(() => null),
    ]);
    const snapshot = view.snapshot;
    const checkpoint = await this.readRepositoryCheckpoint();
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
    const ranked = rankGlobalRules(
      global ?? undefined,
      filePaths,
      new Set(
        snapshot.domain.knowledge
          .filter((knowledge) => knowledge.repoId === this.repoId)
          .map((knowledge) => knowledge.id),
      ),
    );
    const alwaysQuota = Math.min(
      ranked.always.length,
      ALWAYS_RETURN_LIMIT,
      limit,
    );
    const matchedQuota = Math.min(
      ranked.matches.length,
      2,
      limit - alwaysQuota,
    );
    const local = ordered.slice(0, limit - alwaysQuota - matchedQuota);
    // PR4e will filter global candidates against this fixed local selection.
    const always = ranked.always.slice(0, alwaysQuota);
    const matched = ranked.matches.slice(
      0,
      Math.min(5, limit - local.length - always.length),
    );
    const globalCount = ranked.always.length + ranked.matches.length;
    return {
      matched_count: matchedCount,
      ...(global === null ? { global_read_failed: true as const } : {}),
      ...(global?.active.length
        ? {
            global_matched_count: globalCount,
            global_truncated: globalCount > always.length + matched.length,
          }
        : {}),
      readiness: deriveRepositoryReadiness(
        snapshot,
        checkpoint,
        this.repo,
        this.repoId,
      ),
      repo: this.repo,
      rules: [
        ...local.map((item) => {
          const exampleUrl = exampleUrls.get(item.knowledge.id);
          return {
            ...ruleResult(item),
            ...(exampleUrl === undefined ? {} : { example_url: exampleUrl }),
          };
        }),
        ...always.map((item) => ({
          ...ruleResult(item),
          ...(item.setByMcp ? { always_return_set_by: "mcp" as const } : {}),
        })),
        ...matched.map(ruleResult),
      ],
      truncated: matchedCount > local.length,
    };
  }

  private async readRepositoryCheckpoint(): Promise<SyncCheckpoint | null> {
    const checkpoint = await this.syncCheckpoints?.read();
    if (checkpoint === undefined || checkpoint === null) return null;
    if (checkpoint.cursor.repo_id !== this.repoId) {
      throw new KnowledgeReadError(
        "READINESS_SYNC_CHECKPOINT_REPOSITORY_MISMATCH",
        `stored sync checkpoint belongs to ${checkpoint.cursor.repo_id}, not ${this.repoId}`,
      );
    }
    return checkpoint;
  }

  async searchKnowledge(
    request: SearchKnowledgeRequest,
  ): Promise<SearchKnowledgeResult> {
    const limit = validateResultLimit(
      request.limit,
      DEFAULT_SEARCH_KNOWLEDGE_LIMIT,
      "search_knowledge limit",
    );
    const view = await this.repository.readKnowledgeView({
      ...(request.category === undefined ? {} : { category: request.category }),
      query: request.query,
      queryMode: "literal_terms",
      repoId: this.repoId,
      statuses: ["active"],
    });
    const projection = view.searchResult;
    if (projection === null) {
      throw new TypeError(
        "search_knowledge requires an exhaustive search result",
      );
    }

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
    const localSnapshot = (await this.repository.readKnowledgeView()).snapshot;
    const useGlobal =
      this.globalStore &&
      !localSnapshot.domain.knowledge.some(
        (k) => k.id === id && k.repoId === this.repoId,
      ) &&
      (await this.globalStore.exists());
    const { repoId, snapshot } = useGlobal
      ? {
          repoId: GLOBAL_STORE_ID,
          snapshot: await this.globalStore.store.readSnapshot(),
        }
      : { repoId: this.repoId, snapshot: localSnapshot };
    const cursor =
      request.cursor === undefined
        ? undefined
        : decodeEvidenceCursor(request.cursor, id, repoId);
    const knowledge = snapshot.domain.knowledge.find(
      (item) =>
        item.id === id && item.repoId === repoId && item.status === "active",
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

    if (isConversationKnowledge(document.frontmatter)) {
      const { id, repo_id, revision, schema_version } = document.frontmatter;
      return {
        repo: this.repo,
        evidence: [],
        next_cursor: null,
        conversation_summary: conversationSummary(
          snapshot,
          document.frontmatter,
        ),
        knowledge: {
          id,
          revision,
          frontmatter: {
            id,
            repo_id,
            revision,
            schema_version,
            rule: knowledge.rule,
          },
          detail: knowledge.rule,
          code_example: null,
          applied_count: knowledge.appliedCount,
          evidence_count: knowledge.evidenceCount,
          etag: knowledge.etag,
          sources: [],
          violation_count: knowledge.violationCount,
        },
      };
    }
    const allEvidence = snapshot.domain.evidence
      .filter((item) => item.knowledge_id === id && item.repo_id === repoId)
      .sort(compareEvidenceDescending);
    const afterCursor =
      cursor === undefined
        ? allEvidence
        : allEvidence.filter((item) => isAfterEvidenceCursor(item, cursor));
    const page = afterCursor.slice(0, evidenceLimit);
    const nextCursor =
      afterCursor.length > evidenceLimit
        ? encodeEvidenceCursor(page.at(-1)!, id, repoId)
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

interface GlobalMatch extends RuleMatchAccumulator {
  setByMcp?: boolean;
}

function rankGlobalRules(
  global:
    | Awaited<ReturnType<GlobalStore["store"]["readGlobalRules"]>>
    | undefined,
  files: string[],
  repositoryIds: ReadonlySet<string>,
) {
  const always: GlobalMatch[] = [];
  const matches: GlobalMatch[] = [];
  if (!global) return { always, matches };
  const scopeMatches = new Map<string, boolean>();
  const matchesFiles = (pattern: string) => {
    if (!scopeMatches.has(pattern))
      scopeMatches.set(pattern, scopeMatchReasons([pattern], files).length > 0);
    return scopeMatches.get(pattern);
  };
  for (const knowledge of global.active) {
    // get_knowledge and record_outcome resolve such an ID to the repository,
    // so a global copy would be listed twice and never be reachable.
    if (repositoryIds.has(knowledge.id)) continue;
    const setting = global.settings.get(knowledge.id);
    if (setting) {
      always.push({
        knowledge,
        taskScore: undefined,
        reasons: [{ type: "global_store", via: "always" }],
        setByMcp: setting.actor === "mcp",
      });
      continue;
    }
    const reasons: RuleMatchReason[] = [];
    // A global rule with an empty scope matches only through its task score.
    if (knowledge.scope.length > 0 && knowledge.scope.some(matchesFiles))
      reasons.push({ type: "global_store", via: "scope" });
    const taskScore = global.scores.get(knowledge.id);
    if (taskScore !== undefined)
      reasons.push({ type: "global_store", via: "task", score: taskScore });
    if (reasons.length) matches.push({ knowledge, taskScore, reasons });
  }
  const severity = (a: GlobalMatch, b: GlobalMatch) =>
    severityPriority(a.knowledge.severity) -
    severityPriority(b.knowledge.severity);
  const recent = (a: GlobalMatch, b: GlobalMatch) =>
    Date.parse(b.knowledge.updatedAt) - Date.parse(a.knowledge.updatedAt) ||
    compareCodeUnits(a.knowledge.id, b.knowledge.id);
  always.sort((a, b) => severity(a, b) || recent(a, b));
  matches.sort(
    (a, b) =>
      compareOptionalScores(a.taskScore, b.taskScore) ||
      severity(a, b) ||
      b.knowledge.appliedCount - a.knowledge.appliedCount ||
      recent(a, b),
  );
  return { always, matches };
}

function ruleResult({
  knowledge,
  reasons,
}: RuleMatchAccumulator): GetRulesRule {
  return {
    id: knowledge.id,
    rule: knowledge.rule,
    severity: knowledge.severity,
    evidence_count: knowledge.evidenceCount,
    violation_count: knowledge.violationCount,
    match_reasons: reasons,
  };
}

const LEARNING_JOB_STATES: ReadonlySet<DistillJob["state"]> = new Set([
  "pending",
  "processing",
  "awaiting_finalize",
]);

/**
 * Readiness is exhaustive and deliberately independent of the current search
 * match: an initialized repository with active knowledge remains `ready` when
 * no active rule applies to the requested files or task.
 */
export function deriveRepositoryReadiness(
  snapshot: CanonicalProjectionSnapshot,
  checkpoint: SyncCheckpoint | null,
  repo: string,
  repoId: string,
): RepositoryReadiness {
  const knowledge = snapshot.domain.knowledge.filter(
    (item) => item.repoId === repoId,
  );
  const jobs = snapshot.domain.distillJobs.filter(
    (item) => item.repo_id === repoId,
  );
  const hasActiveKnowledge = knowledge.some((item) => item.status === "active");
  const hasProposedKnowledge = knowledge.some(
    (item) => item.status === "proposed",
  );
  const hasLearningJob = jobs.some((item) =>
    LEARNING_JOB_STATES.has(item.state),
  );
  const hasSyncHistory =
    checkpoint !== null || hasCanonicalSyncHistory(snapshot, repoId);

  if (hasActiveKnowledge) {
    return readiness(
      "ready",
      "Use the returned rules. If `rules` is empty, continue: this repository is initialized and no active rule matched the requested files or task.",
    );
  }
  if (hasLearningJob || hasProposedKnowledge) {
    return readiness(
      "learning",
      learningNextAction(repo, hasLearningJob, hasProposedKnowledge),
    );
  }
  if (jobs.some((item) => item.state === "failed")) {
    return readiness(
      "learning",
      `Distillation jobs failed. Inspect the failed jobs' \`last_error\` in canonical \`events/distillation.jsonl\` and provider diagnostics, fix the cause, then run \`repo-knowledge redistill ${repo} --failed\` followed by \`repo-knowledge distill ${repo}\`.`,
    );
  }
  if (!hasSyncHistory && jobs.length === 0 && knowledge.length === 0) {
    return readiness(
      "setup_required",
      `Run \`repo-knowledge setup ${repo}\` to initialize private storage and perform the first repository sync.`,
    );
  }
  return readiness(
    "empty",
    `No reusable rules are available after synchronization. Run \`repo-knowledge sync ${repo}\` after new reviews, then process any resulting distillation work.`,
  );
}

function hasCanonicalSyncHistory(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
): boolean {
  return (
    snapshot.domain.pullRequests.some((item) => item.repo_id === repoId) ||
    snapshot.domain.pullRequestSnapshots.some(
      (item) => item.repo_id === repoId,
    ) ||
    snapshot.domain.threads.some((item) => item.repo_id === repoId) ||
    snapshot.domain.threadRemovals.some((item) => item.repo_id === repoId)
  );
}

function learningNextAction(
  repo: string,
  hasLearningJob: boolean,
  hasProposedKnowledge: boolean,
): string {
  if (hasLearningJob && hasProposedKnowledge) {
    return `${pendingDistillationNextAction(repo)} Also inspect \`repo-knowledge list ${repo} --status proposed\`, then approve selected items with \`repo-knowledge approve <id> --repo ${repo}\` from a TTY.`;
  }
  if (hasLearningJob) {
    return pendingDistillationNextAction(repo);
  }
  return `Inspect \`repo-knowledge list ${repo} --status proposed\` and approve selected items with \`repo-knowledge approve <id> --repo ${repo}\` from a TTY.`;
}

function pendingDistillationNextAction(repo: string): string {
  return `Enable one explicit distillation route in \`$REPO_KNOWLEDGE_HOME/config.json\` (or \`~/.repo-knowledge/config.json\`): configure \`llm.mode\` (\`anthropic\`, \`openai\`, or \`xai\`), \`llm.allowCloudTransmission\`, and \`llm.model\`, sign in to the matching subscription CLI (\`claude auth login\`, \`codex login\`, or \`grok login\`), then run \`repo-knowledge distill ${repo}\`; or enable both \`hostAssistedDistillation.enabled\` and \`hostAssistedDistillation.allowReviewContentTransmission\`, then call \`prepare_distillation\` and \`submit_distillation\` from the MCP client.`;
}

function readiness(
  state: RepositoryReadiness["state"],
  nextAction: string,
): RepositoryReadiness {
  return RepositoryReadinessSchema.parse({
    next_action: nextAction,
    state,
  });
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
      isMatch = picomatch(pattern, scopeGlobOptions());
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
    compareOptionalScores(left.taskScore, right.taskScore) ||
    severityPriority(left.knowledge.severity) -
      severityPriority(right.knowledge.severity) ||
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

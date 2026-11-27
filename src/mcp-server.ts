import {
  McpServer,
  type ToolAnnotations,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import pino, { type Logger } from "pino";
import { z } from "zod";
import { ConversationSummarySchema } from "./conversation-knowledge-summary.js";
import { openStore, type GlobalStore } from "./global-store.js";

import {
  DistillJobStateSchema,
  EvidenceActorSchema,
  EvidenceIdSchema,
  EvidenceStatusSchema,
  GitHubNodeIdSchema,
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  KnowledgeOutcomeSchema,
  KnowledgeStatusSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  RepositoryReadinessSchema,
  Sha256DigestSchema,
  SeveritySchema,
  SourceProviderSchema,
} from "./domain-schemas.js";
import {
  MAX_EVIDENCE_LIMIT,
  MAX_READ_RESULT_LIMIT,
  KnowledgeReadService,
  type GetKnowledgeRequest,
  type GetKnowledgeResult,
  type GetRulesRequest,
  type GetRulesResult,
  type SearchKnowledgeRequest,
  type SearchKnowledgeResult,
} from "./knowledge-read-service.js";
import {
  registerMutationTools,
  type KnowledgeMutationServiceResolver,
} from "./mcp-mutation-tools.js";
import { REPO_KNOWLEDGE_PACKAGE_VERSION } from "./package-version.js";
import {
  RepositoryResolver,
  type RepositoryResolutionInput,
  type RepositoryResolverOptions,
} from "./repository-resolver.js";
import {
  RepositoryStatsRequestSchema,
  STATS_SCHEMA_VERSION,
  STATS_TIMEZONE,
  StatsBucketSchema,
  StatsReadService,
  type RepositoryStats,
  type RepositoryStatsRequest,
} from "./stats-read-service.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { SyncRunOutcomeSchema, SyncStatusStore } from "./sync-status-store.js";

export const REPO_KNOWLEDGE_SERVER_NAME = "repo-knowledge";
export const REPO_KNOWLEDGE_SERVER_VERSION = REPO_KNOWLEDGE_PACKAGE_VERSION;
export const REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION =
  "Before modifying code, call the repo-knowledge MCP `get_rules` tool with the files you expect to change.";
export const REPO_KNOWLEDGE_SERVER_INSTRUCTIONS = [
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  "After a returned active rule has an observable applicability or work result, call `record_outcome` once with a stable `event_key`; never treat retrieval itself as `applied`.",
  "Use host-assisted distillation only when it is explicitly enabled; otherwise do not transmit review content or diffs through the host model.",
].join("\n\n");

export const READ_TOOL_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
}) satisfies ToolAnnotations;

const RepositorySelectionSchema = {
  repo: RepositoryNameSchema.optional().meta({
    description:
      "Repository in owner/name form. Overrides workspace and startup defaults.",
  }),
  workspace_path: NonEmptyStringSchema.optional().meta({
    description:
      "Allowed local workspace whose origin identifies the repository.",
  }),
};

export const GetRulesInputSchema = z.strictObject({
  ...RepositorySelectionSchema,
  file_paths: z
    .array(z.string().min(1))
    .optional()
    .meta({ description: "Repository-relative files expected to change." }),
  limit: z.number().int().positive().max(MAX_READ_RESULT_LIMIT).optional(),
  task: z.string().min(1).optional().meta({
    description: "Short description used to find task-relevant rules.",
  }),
});

const RuleMatchReasonSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("global") }),
  z.strictObject({
    type: z.literal("global_store"),
    via: z.enum(["always", "task", "scope"]),
    score: z.number().optional(),
  }),
  z.strictObject({
    file_path: z.string(),
    pattern: z.string(),
    type: z.literal("scope"),
  }),
  z.strictObject({ score: z.number(), type: z.literal("task") }),
]);

export const GetRulesOutputSchema = z.strictObject({
  matched_count: z.number().int().nonnegative(),
  global_matched_count: z.number().int().nonnegative().optional(),
  global_truncated: z.boolean().optional(),
  global_read_failed: z.literal(true).optional(),
  readiness: RepositoryReadinessSchema.meta({
    description:
      "Repository initialization and learning state with an executable next step.",
  }),
  repo: RepositoryNameSchema,
  rules: z.array(
    z.strictObject({
      evidence_count: z.number().int().nonnegative(),
      example_url: z.url().optional(),
      id: KnowledgeIdSchema,
      match_reasons: z.array(RuleMatchReasonSchema),
      always_return_set_by: z.literal("mcp").optional(),
      rule: z.string(),
      severity: SeveritySchema,
      violation_count: z.number().int().nonnegative(),
    }),
  ),
  truncated: z.boolean(),
});

export const SearchKnowledgeInputSchema = z.strictObject({
  ...RepositorySelectionSchema,
  category: KnowledgeCategorySchema.optional(),
  limit: z.number().int().positive().max(MAX_READ_RESULT_LIMIT).optional(),
  query: z.string().min(1),
});

export const SearchKnowledgeOutputSchema = z.strictObject({
  mode: z.enum(["fts", "like"]),
  query: z.string(),
  repo: RepositoryNameSchema,
  results: z.array(
    z.strictObject({
      applied_count: z.number().int().nonnegative(),
      category: KnowledgeCategorySchema,
      detail: z.string(),
      etag: z.string().min(1),
      evidence_count: z.number().int().nonnegative(),
      id: KnowledgeIdSchema,
      revision: z.number().int().nonnegative(),
      rule: z.string(),
      scope: z.array(z.string()),
      score: z.number(),
      severity: SeveritySchema,
      sources: z.array(SourceProviderSchema),
      violation_count: z.number().int().nonnegative(),
    }),
  ),
});

export const GetKnowledgeInputSchema = z.strictObject({
  ...RepositorySelectionSchema,
  cursor: z.string().min(1).optional(),
  evidence_limit: z
    .number()
    .int()
    .positive()
    .max(MAX_EVIDENCE_LIMIT)
    .optional(),
  id: KnowledgeIdSchema,
});

const McpKnowledgeEvidenceSchema = z.strictObject({
  actors: z.array(EvidenceActorSchema).min(1),
  author_association: NonEmptyStringSchema.optional(),
  comment_ids: z.array(GitHubNodeIdSchema).min(1),
  content_fingerprint: Sha256DigestSchema,
  eligible_for_count: z.boolean(),
  evidence_id: EvidenceIdSchema,
  knowledge_id: KnowledgeIdSchema,
  observed_at: IsoDateTimeSchema,
  occurrence_key: NonEmptyStringSchema,
  originator: EvidenceActorSchema,
  path: NonEmptyStringSchema.optional(),
  pr_number: z.number().int().positive(),
  repo_id: RepositoryIdSchema,
  sources: z.array(SourceProviderSchema).min(1),
  state_fingerprint: Sha256DigestSchema,
  status: EvidenceStatusSchema,
  superseded_by: EvidenceIdSchema.optional(),
  supersedes: EvidenceIdSchema.optional(),
  thread_id: NonEmptyStringSchema,
  url: z.url().optional(),
});

const McpGeneratedCodeExampleSchema = z.strictObject({
  content: NonEmptyStringSchema,
  evidence_comment_ids: z.array(GitHubNodeIdSchema).min(1),
  generated_example: z.literal(true),
  language: NonEmptyStringSchema,
});

export const GetKnowledgeOutputSchema = z.strictObject({
  evidence: z.array(McpKnowledgeEvidenceSchema),
  conversation_summary: ConversationSummarySchema.optional(),
  knowledge: z.strictObject({
    applied_count: z.number().int().nonnegative(),
    code_example: McpGeneratedCodeExampleSchema.nullable().meta({
      description:
        "Structured generated code example, or null when the document has none.",
    }),
    detail: z.string(),
    etag: z.string().min(1),
    evidence_count: z.number().int().nonnegative(),
    frontmatter: z.looseObject({
      id: KnowledgeIdSchema,
      repo_id: RepositoryIdSchema,
      revision: z.number().int().nonnegative(),
      schema_version: z.literal(1),
    }),
    id: KnowledgeIdSchema,
    revision: z.number().int().nonnegative(),
    sources: z.array(SourceProviderSchema),
    violation_count: z.number().int().nonnegative(),
  }),
  next_cursor: z.string().nullable(),
  repo: RepositoryNameSchema,
});

// The canonical request schema is extended, not redefined, so the MCP surface
// can never accept window fields the stats read service would reject.
export const StatsInputSchema = RepositoryStatsRequestSchema.extend(
  RepositorySelectionSchema,
);

const StatsCountSchema = z.number().int().nonnegative();
const RawSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const UtcDayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const OutcomeByTypeSchema = z.record(
  KnowledgeOutcomeSchema.shape.outcome,
  StatsCountSchema,
);

export const StatsOutputSchema = z.strictObject({
  buckets: z
    .array(
      z.strictObject({
        day: UtcDayKeySchema,
        evidence_total: StatsCountSchema,
        outcome_by_type: OutcomeByTypeSchema,
        outcome_total: StatsCountSchema,
      }),
    )
    .nullable(),
  canonical_digest: RawSha256DigestSchema,
  evidence: z.strictObject({
    by_source: z.record(SourceProviderSchema, StatsCountSchema),
    by_status: z.record(EvidenceStatusSchema, StatsCountSchema),
    eligible_for_count: StatsCountSchema,
    total: StatsCountSchema,
  }),
  jobs: z.strictObject({
    by_state: z.record(DistillJobStateSchema, StatsCountSchema),
    total: StatsCountSchema,
  }),
  knowledge: z.strictObject({
    by_category: z.record(KnowledgeCategorySchema, StatsCountSchema),
    by_severity: z.record(SeveritySchema, StatsCountSchema),
    by_status: z.record(KnowledgeStatusSchema, StatsCountSchema),
    total: StatsCountSchema,
  }),
  operations: z.strictObject({
    failed_jobs: StatsCountSchema,
    last_sync_checkpoint_at: IsoDateTimeSchema.nullable(),
    last_sync_success_at: IsoDateTimeSchema.nullable(),
    pending_jobs: StatsCountSchema,
  }),
  outcomes: z.strictObject({
    by_type: OutcomeByTypeSchema,
    total: StatsCountSchema,
  }),
  repo: RepositoryNameSchema,
  stats_schema_version: z.literal(STATS_SCHEMA_VERSION),
  sync: z.strictObject({
    last_checkpoint: z
      .strictObject({
        last_pr_number: z.number().int().positive(),
        last_updated_at: IsoDateTimeSchema,
        updated_at: IsoDateTimeSchema,
      })
      .nullable(),
    last_run: z
      .strictObject({
        consecutive_failures: StatsCountSchema,
        error_code: z.string().min(1).nullable(),
        finished_at: IsoDateTimeSchema,
        has_more: z.boolean().nullable(),
        outcome: SyncRunOutcomeSchema,
        started_at: IsoDateTimeSchema,
      })
      .nullable(),
    last_success_at: IsoDateTimeSchema.nullable(),
  }),
  window: z.strictObject({
    bucket: StatsBucketSchema,
    since: IsoDateTimeSchema.nullable(),
    timezone: z.literal(STATS_TIMEZONE),
    until: IsoDateTimeSchema.nullable(),
  }),
});

export interface KnowledgeReadOperations {
  getKnowledge(request: GetKnowledgeRequest): Promise<GetKnowledgeResult>;
  getRules(request?: GetRulesRequest): Promise<GetRulesResult>;
  /** Versioned read-only aggregation over the same canonical projection. */
  getStats(request?: RepositoryStatsRequest): Promise<RepositoryStats>;
  searchKnowledge(
    request: SearchKnowledgeRequest,
  ): Promise<SearchKnowledgeResult>;
}

export interface KnowledgeReadServiceResolutionInput
  extends RepositoryResolutionInput {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export interface KnowledgeReadServiceResolver {
  resolve(
    input: KnowledgeReadServiceResolutionInput,
  ): Promise<KnowledgeReadOperations>;
}

export type CanonicalKnowledgeReadServiceResolverOptions = Omit<
  RepositoryResolverOptions,
  "startupRepo" | "startupWorkspace"
> & { readonly globalStore?: GlobalStore };

/** Connects MCP repository selection to the canonical active-only read service. */
export class CanonicalKnowledgeReadServiceResolver
  implements KnowledgeReadServiceResolver
{
  private readonly options: CanonicalKnowledgeReadServiceResolverOptions;

  constructor(options: CanonicalKnowledgeReadServiceResolverOptions) {
    this.options = options;
  }

  async resolve(
    input: KnowledgeReadServiceResolutionInput,
  ): Promise<KnowledgeReadOperations> {
    const repositoryResolver = new RepositoryResolver({
      ...this.options,
      ...(input.startupRepo === undefined
        ? {}
        : { startupRepo: input.startupRepo }),
      ...(input.startupWorkspace === undefined
        ? {}
        : { startupWorkspace: input.startupWorkspace }),
    });
    const resolution = await repositoryResolver.resolve({
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
    });

    const repositoryStore = openStore({ kind: "repository", ...resolution });
    const knowledgeReads = new KnowledgeReadService({
      ...(this.options.globalStore
        ? { globalStore: this.options.globalStore }
        : {}),
      repo: resolution.currentName,
      repoId: resolution.repoId,
      repository: repositoryStore,
      syncCheckpoints: new SyncCheckpointStore(resolution.absolutePath),
    });
    const statsReads = new StatsReadService({
      repo: resolution.currentName,
      repoId: resolution.repoId,
      repository: repositoryStore,
      syncCheckpoints: new SyncCheckpointStore(resolution.absolutePath),
      syncStatus: new SyncStatusStore(resolution.absolutePath),
    });
    return {
      getKnowledge: (request) => knowledgeReads.getKnowledge(request),
      getRules: (request) => knowledgeReads.getRules(request),
      getStats: (request) => statsReads.getStats(request),
      searchKnowledge: (request) => knowledgeReads.searchKnowledge(request),
    };
  }
}

export interface BuildServerOptions {
  readonly allowAlwaysReturnChanges?: boolean;
  readonly instructions?: string;
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly readServiceResolver: KnowledgeReadServiceResolver;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
  readonly version?: string;
}

/** Builds one identically registered MCP server for either protocol era. */
export function buildServer(options: BuildServerOptions): McpServer {
  const server = new McpServer(
    {
      name: REPO_KNOWLEDGE_SERVER_NAME,
      version: options.version ?? REPO_KNOWLEDGE_SERVER_VERSION,
    },
    {
      instructions: options.instructions ?? REPO_KNOWLEDGE_SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "get_rules",
    {
      annotations: READ_TOOL_ANNOTATIONS,
      description:
        "Return active repository rules that apply to files or a task, plus repository readiness and the next user action. Call before modifying code.",
      inputSchema: GetRulesInputSchema,
      outputSchema: GetRulesOutputSchema,
      title: "Get repository rules",
    },
    async (input) => {
      const readService = await resolveReadService(options, input);
      const output = GetRulesOutputSchema.parse(
        await readService.getRules({
          ...(input.file_paths === undefined
            ? {}
            : { filePaths: input.file_paths }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.task === undefined ? {} : { task: input.task }),
        }),
      );
      return {
        content: [{ type: "text", text: summarizeRules(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      annotations: READ_TOOL_ANNOTATIONS,
      description:
        "Search active repository knowledge by text and optional category.",
      inputSchema: SearchKnowledgeInputSchema,
      outputSchema: SearchKnowledgeOutputSchema,
      title: "Search repository knowledge",
    },
    async (input) => {
      const readService = await resolveReadService(options, input);
      const output = SearchKnowledgeOutputSchema.parse(
        await readService.searchKnowledge({
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          query: input.query,
        }),
      );
      return {
        content: [{ type: "text", text: summarizeSearch(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_knowledge",
    {
      annotations: READ_TOOL_ANNOTATIONS,
      description:
        "Get one active knowledge item and a cursor-paginated evidence page.",
      inputSchema: GetKnowledgeInputSchema,
      outputSchema: GetKnowledgeOutputSchema,
      title: "Get repository knowledge",
    },
    async (input) => {
      const readService = await resolveReadService(options, input);
      const output = GetKnowledgeOutputSchema.parse(
        await readService.getKnowledge({
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.evidence_limit === undefined
            ? {}
            : { evidenceLimit: input.evidence_limit }),
          id: input.id,
        }),
      );
      return {
        content: [{ type: "text", text: summarizeKnowledge(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "stats",
    {
      annotations: READ_TOOL_ANNOTATIONS,
      description:
        'Return versioned repository aggregates over knowledge, evidence, outcomes, distill jobs, and sync state. The optional half-open window [since, until) filters only time-stamped observations; bucket "day" additionally requires since and until and returns zero-filled UTC day buckets. This tool never modifies canonical data.',
      inputSchema: StatsInputSchema,
      outputSchema: StatsOutputSchema,
      title: "Get repository stats",
    },
    async (input) => {
      const readService = await resolveReadService(options, input);
      const output = StatsOutputSchema.parse(
        await readService.getStats({
          ...(input.bucket === undefined ? {} : { bucket: input.bucket }),
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.until === undefined ? {} : { until: input.until }),
        }),
      );
      return {
        content: [{ type: "text", text: summarizeStats(output) }],
        structuredContent: output,
      };
    },
  );

  registerMutationTools(server, {
    ...(options.allowAlwaysReturnChanges
      ? { allowAlwaysReturnChanges: true }
      : {}),
    mutationServiceResolver: options.mutationServiceResolver,
    ...(options.startupRepo === undefined
      ? {}
      : { startupRepo: options.startupRepo }),
    ...(options.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: options.startupWorkspace }),
  });

  return server;
}

export interface RepoKnowledgeLogger {
  error(bindings: object, message: string): void;
}

export interface ServeRepoKnowledgeStdioOptions extends BuildServerOptions {
  readonly logger?: RepoKnowledgeLogger;
  readonly transport?: Transport;
}

/** Creates a pino logger whose destination is explicitly fixed to stderr. */
export function createStderrLogger(): Logger {
  return pino(
    { name: REPO_KNOWLEDGE_SERVER_NAME },
    pino.destination({ dest: 2, sync: true }),
  );
}

/** Serves legacy initialize and 2026-07-28 connections from the same factory. */
export function serveRepoKnowledgeStdio(
  options: ServeRepoKnowledgeStdioOptions,
): StdioServerHandle {
  const { logger = createStderrLogger(), transport, ...buildOptions } = options;

  return serveStdio(() => buildServer(buildOptions), {
    legacy: "serve",
    onerror(error) {
      logger.error({ err: error }, "MCP stdio transport error");
    },
    ...(transport === undefined ? {} : { transport }),
  });
}

function resolveReadService(
  options: BuildServerOptions,
  input: {
    readonly repo?: string | undefined;
    readonly workspace_path?: string | undefined;
  },
): Promise<KnowledgeReadOperations> {
  return options.readServiceResolver.resolve({
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.workspace_path === undefined
      ? {}
      : { workspacePath: input.workspace_path }),
    ...(options.startupRepo === undefined
      ? {}
      : { startupRepo: options.startupRepo }),
    ...(options.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: options.startupWorkspace }),
  });
}

function summarizeRules(output: z.infer<typeof GetRulesOutputSchema>): string {
  if (output.global_matched_count !== undefined) {
    const fromGlobal = output.rules.filter((rule) =>
      rule.match_reasons.some((r) => r.type === "global_store"),
    ).length;
    return `### Repository rules\n\nReturned ${output.rules.length - fromGlobal} of ${output.matched_count} repository and ${fromGlobal} of ${output.global_matched_count} global rules for \`${output.repo}\`.\n\nReadiness: **${output.readiness.state}**. ${output.readiness.next_action}`;
  }
  const warning = output.global_read_failed
    ? "\n\nGlobal rules could not be read. Run `repo-knowledge doctor` for details."
    : "";
  const shown = output.rules.length;
  const truncation = output.truncated ? ` Showing the first **${shown}**.` : "";
  return `### Repository rules\n\nFound **${output.matched_count}** active rule(s) for \`${output.repo}\`.${truncation}${warning}\n\nReadiness: **${output.readiness.state}**. ${output.readiness.next_action}`;
}

function summarizeSearch(
  output: z.infer<typeof SearchKnowledgeOutputSchema>,
): string {
  return `### Knowledge search\n\nFound **${output.results.length}** active result(s) for \`${output.repo}\` using ${output.mode.toUpperCase()} search.`;
}

function summarizeStats(output: z.infer<typeof StatsOutputSchema>): string {
  const windowNote =
    output.window.since === null && output.window.until === null
      ? "over the full history"
      : `in [${output.window.since ?? "beginning"}, ${output.window.until ?? "now"})`;
  return `### Repository stats\n\n\`${output.repo}\` has **${output.knowledge.total}** knowledge item(s), **${output.evidence.total}** evidence item(s), and **${output.outcomes.total}** outcome(s) ${windowNote} (stats schema v${output.stats_schema_version}).`;
}

function summarizeKnowledge(
  output: z.infer<typeof GetKnowledgeOutputSchema>,
): string {
  const continuation =
    output.next_cursor === null ? "" : " More evidence is available.";
  return `### Knowledge detail\n\nLoaded \`${output.knowledge.id}\` from \`${output.repo}\` with **${output.evidence.length}** evidence item(s).${continuation}`;
}

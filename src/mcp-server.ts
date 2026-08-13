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

import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
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

export const REPO_KNOWLEDGE_SERVER_NAME = "repo-knowledge";
export const REPO_KNOWLEDGE_SERVER_VERSION = "0.3.0";
export const REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION =
  "Before modifying code, call the repo-knowledge MCP `get_rules` tool with the files you expect to change.";
export const REPO_KNOWLEDGE_SERVER_INSTRUCTIONS = [
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  "Use host-assisted distillation only when it is explicitly enabled; otherwise do not transmit review content or diffs through the host model.",
].join("\n\n");

export const READ_TOOL_ANNOTATIONS = Object.freeze({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
}) satisfies ToolAnnotations;

const RepositorySelectionSchema = {
  repo: RepositoryNameSchema.optional().describe(
    "Repository in owner/name form. Overrides workspace and startup defaults.",
  ),
  workspace_path: NonEmptyStringSchema.optional().describe(
    "Allowed local workspace whose origin identifies the repository.",
  ),
};

export const GetRulesInputSchema = z
  .object({
    ...RepositorySelectionSchema,
    file_paths: z
      .array(z.string().min(1))
      .optional()
      .describe("Repository-relative files expected to change."),
    limit: z.number().int().positive().max(MAX_READ_RESULT_LIMIT).optional(),
    task: z
      .string()
      .min(1)
      .optional()
      .describe("Short description used to find task-relevant rules."),
  })
  .strict();

const RuleMatchReasonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }).strict(),
  z
    .object({
      file_path: z.string(),
      pattern: z.string(),
      type: z.literal("scope"),
    })
    .strict(),
  z.object({ score: z.number(), type: z.literal("task") }).strict(),
]);

export const GetRulesOutputSchema = z
  .object({
    matched_count: z.number().int().nonnegative(),
    readiness: RepositoryReadinessSchema.describe(
      "Repository initialization and learning state with an executable next step.",
    ),
    repo: RepositoryNameSchema,
    rules: z.array(
      z
        .object({
          evidence_count: z.number().int().nonnegative(),
          example_url: z.url().optional(),
          id: KnowledgeIdSchema,
          match_reasons: z.array(RuleMatchReasonSchema),
          rule: z.string(),
          severity: SeveritySchema,
          violation_count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    truncated: z.boolean(),
  })
  .strict();

export const SearchKnowledgeInputSchema = z
  .object({
    ...RepositorySelectionSchema,
    category: KnowledgeCategorySchema.optional(),
    limit: z.number().int().positive().max(MAX_READ_RESULT_LIMIT).optional(),
    query: z.string().min(1),
  })
  .strict();

export const SearchKnowledgeOutputSchema = z
  .object({
    mode: z.enum(["fts", "like"]),
    query: z.string(),
    repo: RepositoryNameSchema,
    results: z.array(
      z
        .object({
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
        })
        .strict(),
    ),
  })
  .strict();

export const GetKnowledgeInputSchema = z
  .object({
    ...RepositorySelectionSchema,
    cursor: z.string().min(1).optional(),
    evidence_limit: z
      .number()
      .int()
      .positive()
      .max(MAX_EVIDENCE_LIMIT)
      .optional(),
    id: KnowledgeIdSchema,
  })
  .strict();

const McpKnowledgeEvidenceSchema = z
  .object({
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
  })
  .strict();

const McpGeneratedCodeExampleSchema = z
  .object({
    content: NonEmptyStringSchema,
    evidence_comment_ids: z.array(GitHubNodeIdSchema).min(1),
    generated_example: z.literal(true),
    language: NonEmptyStringSchema,
  })
  .strict();

export const GetKnowledgeOutputSchema = z
  .object({
    evidence: z.array(McpKnowledgeEvidenceSchema),
    knowledge: z
      .object({
        applied_count: z.number().int().nonnegative(),
        code_example: McpGeneratedCodeExampleSchema.nullable().describe(
          "Structured generated code example, or null when the document has none.",
        ),
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
      })
      .strict(),
    next_cursor: z.string().nullable(),
    repo: RepositoryNameSchema,
  })
  .strict();

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

export const StatsOutputSchema = z
  .object({
    buckets: z
      .array(
        z
          .object({
            day: UtcDayKeySchema,
            evidence_total: StatsCountSchema,
            outcome_by_type: OutcomeByTypeSchema,
            outcome_total: StatsCountSchema,
          })
          .strict(),
      )
      .nullable(),
    canonical_digest: RawSha256DigestSchema,
    evidence: z
      .object({
        by_source: z.record(SourceProviderSchema, StatsCountSchema),
        by_status: z.record(EvidenceStatusSchema, StatsCountSchema),
        eligible_for_count: StatsCountSchema,
        total: StatsCountSchema,
      })
      .strict(),
    jobs: z
      .object({
        by_state: z.record(DistillJobStateSchema, StatsCountSchema),
        total: StatsCountSchema,
      })
      .strict(),
    knowledge: z
      .object({
        by_category: z.record(KnowledgeCategorySchema, StatsCountSchema),
        by_severity: z.record(SeveritySchema, StatsCountSchema),
        by_status: z.record(KnowledgeStatusSchema, StatsCountSchema),
        total: StatsCountSchema,
      })
      .strict(),
    operations: z
      .object({
        failed_jobs: StatsCountSchema,
        last_sync_checkpoint_at: IsoDateTimeSchema.nullable(),
        pending_jobs: StatsCountSchema,
      })
      .strict(),
    outcomes: z
      .object({ by_type: OutcomeByTypeSchema, total: StatsCountSchema })
      .strict(),
    repo: RepositoryNameSchema,
    stats_schema_version: z.literal(STATS_SCHEMA_VERSION),
    sync: z
      .object({
        last_checkpoint: z
          .object({
            last_pr_number: z.number().int().positive(),
            last_updated_at: IsoDateTimeSchema,
            updated_at: IsoDateTimeSchema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    window: z
      .object({
        bucket: StatsBucketSchema,
        since: IsoDateTimeSchema.nullable(),
        timezone: z.literal(STATS_TIMEZONE),
        until: IsoDateTimeSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export interface KnowledgeReadOperations {
  getKnowledge(request: GetKnowledgeRequest): Promise<GetKnowledgeResult>;
  getRules(request?: GetRulesRequest): Promise<GetRulesResult>;
  /** Versioned read-only aggregation over the same canonical projection. */
  getStats(request?: RepositoryStatsRequest): Promise<RepositoryStats>;
  searchKnowledge(
    request: SearchKnowledgeRequest,
  ): Promise<SearchKnowledgeResult>;
}

export interface KnowledgeReadServiceResolutionInput extends RepositoryResolutionInput {
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
>;

/** Connects MCP repository selection to the canonical active-only read service. */
export class CanonicalKnowledgeReadServiceResolver implements KnowledgeReadServiceResolver {
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

    const repositoryStore = new CanonicalTransactionStore(
      resolution.absolutePath,
    );
    const knowledgeReads = new KnowledgeReadService({
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
  const logger = options.logger ?? createStderrLogger();
  const buildOptions: BuildServerOptions = {
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
    mutationServiceResolver: options.mutationServiceResolver,
    readServiceResolver: options.readServiceResolver,
    ...(options.startupRepo === undefined
      ? {}
      : { startupRepo: options.startupRepo }),
    ...(options.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: options.startupWorkspace }),
    ...(options.version === undefined ? {} : { version: options.version }),
  };

  return serveStdio(() => buildServer(buildOptions), {
    legacy: "serve",
    onerror(error) {
      logger.error({ err: error }, "MCP stdio transport error");
    },
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
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
  const shown = output.rules.length;
  const truncation = output.truncated ? ` Showing the first **${shown}**.` : "";
  return `### Repository rules\n\nFound **${output.matched_count}** active rule(s) for \`${output.repo}\`.${truncation}\n\nReadiness: **${output.readiness.state}**. ${output.readiness.next_action}`;
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

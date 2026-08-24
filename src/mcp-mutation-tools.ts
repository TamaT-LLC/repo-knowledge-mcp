import {
  type CallToolResult,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { mapMutationError } from "./mcp-mutation-error-mapping.js";
import {
  resolveMutationService,
  type KnowledgeMutationServiceResolver,
} from "./mcp-mutation-resolver.js";
import {
  AddKnowledgeInputSchema,
  AddKnowledgeOutputSchema,
  AddKnowledgeResultSchema,
  IngestPrInputSchema,
  IngestPrOutputSchema,
  IngestPrResultSchema,
  MUTATION_TOOL_ANNOTATIONS,
  MutationToolSummarySchema,
  PrepareDistillationInputSchema,
  PrepareDistillationOutputSchema,
  PrepareDistillationResultSchema,
  RecordOutcomeInputSchema,
  RecordOutcomeOutputSchema,
  RecordOutcomeResultSchema,
  SubmitDistillationInputSchema,
  SubmitDistillationOutputSchema,
  SubmitDistillationResultSchema,
  SyncRepoInputSchema,
  SyncRepoOutputSchema,
  SyncRepoResultSchema,
  UpdateKnowledgeInputSchema,
  UpdateKnowledgeOutputSchema,
  UpdateKnowledgeResultSchema,
} from "./mcp-mutation-schemas.js";
import {
  renderMutationContent,
  summarizeAdd,
  summarizeIngest,
  summarizePrepare,
  summarizeRecordOutcome,
  summarizeSubmit,
  summarizeSync,
  summarizeUpdate,
  type MutationToolPresentation,
} from "./mcp-mutation-summaries.js";

export type { MutationToolErrorPayload } from "./mcp-mutation-error-mapping.js";
export { mapMutationError } from "./mcp-mutation-error-mapping.js";
export {
  CanonicalKnowledgeMutationServiceResolver,
  type CanonicalKnowledgeMutationServiceResolverOptions,
  type IngestPrMutationRequest,
  type KnowledgeMutationOperations,
  type KnowledgeMutationServiceResolutionInput,
  type KnowledgeMutationServiceResolver,
  type RepositoryMutationPipelineFactory,
  type RepositoryMutationPipelineFactoryContext,
  type RepositoryMutationPipelineOperations,
} from "./mcp-mutation-resolver.js";
export {
  AddKnowledgeInputSchema,
  AddKnowledgeOutputSchema,
  AddKnowledgeResultSchema,
  IngestPrInputSchema,
  IngestPrOutputSchema,
  IngestPrResultSchema,
  MUTATION_TOOL_ANNOTATIONS,
  MutationToolSummarySchema,
  PrepareDistillationInputSchema,
  PrepareDistillationOutputSchema,
  PrepareDistillationResultSchema,
  RecordOutcomeInputSchema,
  RecordOutcomeOutputSchema,
  RecordOutcomeResultSchema,
  SubmitDistillationInputSchema,
  SubmitDistillationOutputSchema,
  SubmitDistillationResultSchema,
  SyncRepoInputSchema,
  SyncRepoOutputSchema,
  SyncRepoResultSchema,
  UpdateKnowledgeInputSchema,
  UpdateKnowledgeOutputSchema,
  UpdateKnowledgeResultSchema,
} from "./mcp-mutation-schemas.js";

export interface RegisterMutationToolsOptions {
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

/** Registers model-plane tools; all authorization remains in application services. */
export function registerMutationTools(
  server: McpServer,
  options: RegisterMutationToolsOptions,
): void {
  server.registerTool(
    "ingest_pr",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.ingest_pr,
      description:
        "Ingest a complete GitHub pull-request review snapshot and run only explicitly enabled provider distillation.",
      inputSchema: IngestPrInputSchema,
      outputSchema: IngestPrOutputSchema,
      title: "Ingest pull request",
    },
    async (input) => {
      return executeMutation(
        IngestPrResultSchema,
        async () =>
          (await resolveMutationService(options, input)).ingestPullRequest({
            pr_number: input.pr_number,
          }),
        summarizeIngest,
      );
    },
  );

  server.registerTool(
    "sync_repo",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.sync_repo,
      description:
        "Incrementally sync updated pull requests through the ingest pipeline, resuming from the durable checkpoint unless a strictly older explicit since boundary is given.",
      inputSchema: SyncRepoInputSchema,
      outputSchema: SyncRepoOutputSchema,
      title: "Sync repository pull requests",
    },
    async (input) => {
      return executeMutation(
        SyncRepoResultSchema,
        async () =>
          (await resolveMutationService(options, input)).syncRepo({
            ...(input.since === undefined ? {} : { since: input.since }),
          }),
        summarizeSync,
      );
    },
  );

  server.registerTool(
    "prepare_distillation",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.prepare_distillation,
      description:
        "Lease host-assisted distillation work. Review content is returned only after both host-assisted opt-ins are enabled.",
      inputSchema: PrepareDistillationInputSchema,
      outputSchema: PrepareDistillationOutputSchema,
      title: "Prepare host-assisted distillation",
    },
    async (input) => {
      return executeMutation(
        PrepareDistillationResultSchema,
        async () =>
          (await resolveMutationService(options, input)).prepareDistillation({
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        summarizePrepare,
      );
    },
  );

  server.registerTool(
    "submit_distillation",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.submit_distillation,
      description:
        "Submit idempotent extract or finalize results for a leased host-assisted job.",
      inputSchema: SubmitDistillationInputSchema,
      outputSchema: SubmitDistillationOutputSchema,
      title: "Submit host-assisted distillation",
    },
    async (input) => {
      return executeMutation(
        SubmitDistillationResultSchema,
        async () => {
          const service = await resolveMutationService(options, input);
          return input.phase === "extract"
            ? service.submitExtract(input)
            : service.submitFinalize(input);
        },
        summarizeSubmit,
      );
    },
  );

  server.registerTool(
    "add_knowledge",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.add_knowledge,
      description:
        "Create manual repository knowledge in proposed state. This tool cannot activate knowledge.",
      inputSchema: AddKnowledgeInputSchema,
      outputSchema: AddKnowledgeOutputSchema,
      title: "Propose repository knowledge",
    },
    async (input) => {
      return executeMutation(
        AddKnowledgeResultSchema,
        async () =>
          (await resolveMutationService(options, input)).addKnowledge({
            category: input.category,
            detail: input.detail,
            ...(input.related_ids === undefined
              ? {}
              : { related_ids: input.related_ids }),
            rule: input.rule,
            scope: input.scope,
            severity: input.severity,
          }),
        summarizeAdd,
      );
    },
  );

  server.registerTool(
    "update_knowledge",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.update_knowledge,
      description:
        "Create a pending edit proposal using revision and exact-byte ETag CAS. This tool never edits or approves canonical knowledge directly.",
      inputSchema: UpdateKnowledgeInputSchema,
      outputSchema: UpdateKnowledgeOutputSchema,
      title: "Propose a knowledge edit",
    },
    async (input) => {
      return executeMutation(
        UpdateKnowledgeResultSchema,
        async () =>
          (await resolveMutationService(options, input)).updateKnowledge({
            expected_etag: input.expected_etag,
            expected_revision: input.expected_revision,
            id: input.id,
            patch: input.patch,
          }),
        summarizeUpdate,
      );
    },
  );

  server.registerTool(
    "record_outcome",
    {
      annotations: MUTATION_TOOL_ANNOTATIONS.record_outcome,
      description:
        "Record one idempotent outcome for an active knowledge id only after applicability or a real work result is observed. For the host-friendly path, supply a stable event_key, result_observed: true, context, and note; event_id is derived deterministically. Never record an outcome merely because get_rules returned a rule. Retrying the identical request returns the original result. This tool never enables provider transmission or changes knowledge content/status.",
      inputSchema: RecordOutcomeInputSchema,
      outputSchema: RecordOutcomeOutputSchema,
      title: "Record a rule outcome",
    },
    async (input) => {
      return executeMutation(
        RecordOutcomeResultSchema,
        async () =>
          (await resolveMutationService(options, input)).recordOutcome({
            at: input.at,
            ...(input.context === undefined ? {} : { context: input.context }),
            ...(input.event_id === undefined
              ? {}
              : { event_id: input.event_id }),
            ...(input.event_key === undefined
              ? {}
              : { event_key: input.event_key }),
            knowledge_id: input.knowledge_id,
            ...(input.note === undefined ? {} : { note: input.note }),
            outcome: input.outcome,
            ...(input.result_observed === undefined
              ? {}
              : { result_observed: input.result_observed }),
          }),
        summarizeRecordOutcome,
      );
    },
  );
}

async function executeMutation<T extends z.ZodType>(
  schema: T,
  operation: () => Promise<unknown>,
  summarize: (result: z.output<T>) => MutationToolPresentation,
): Promise<CallToolResult> {
  try {
    const result = schema.parse(await operation());
    const presentation = summarize(result);
    const summary = MutationToolSummarySchema.parse(presentation.summary);
    return {
      content: [
        {
          type: "text",
          text: renderMutationContent(presentation.body, summary),
        },
      ],
      structuredContent: { ok: true, result, summary },
    };
  } catch (error) {
    const mapped = mapMutationError(error);
    const summary = MutationToolSummarySchema.parse({
      counts: { failed_operations: 1 },
      next_action: mapped.next_action ?? null,
      retryable: mapped.retryable,
    });
    return {
      content: [
        {
          type: "text",
          text: renderMutationContent(
            `### ${mapped.code}\n\n${mapped.message}`,
            summary,
          ),
        },
      ],
      isError: true,
      structuredContent: { error: mapped, ok: false, summary },
    };
  }
}

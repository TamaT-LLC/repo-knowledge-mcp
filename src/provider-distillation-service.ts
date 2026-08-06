import {
  computeOutputSchemaDigest,
  computeTrustPolicyDigest,
  resolveRepositoryPolicy,
} from "./config.js";
import {
  DistillationOutputSchema,
  JobIdSchema,
  NonEmptyStringSchema,
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  Sha256DigestSchema,
  type DistillJob,
  type DistillationOutput,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import {
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  buildDistillationUserInput,
  type DistillationPromptTemplate,
  type DistillationPromptThread,
} from "./distillation-prompt.js";
import {
  DistillJobCoordinator,
  type DistillJobLeaseCredentials,
} from "./distill-job-coordinator.js";
import {
  computeDistillationInputDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
} from "./github-snapshot-normalizer.js";
import {
  LlmProviderError,
  type LlmProviderAdapter,
  type LlmProviderFailureKind,
  type StructuredCompletionResponse,
} from "./llm-provider.js";

export type ProviderTransmissionDeniedReason =
  "cloud_transmission_disabled" | "mode_disabled" | "repository_policy_denied";

export type ProviderTransmissionDecision =
  | {
      readonly allowed: false;
      readonly reason: ProviderTransmissionDeniedReason;
    }
  | {
      readonly allowed: true;
      readonly mode: "anthropic";
      readonly model: string | null;
    };

export interface ProviderDistillationThread extends DistillationPromptThread {
  readonly distillationInputDigest: string;
  readonly distillationKey: string;
}

export interface ProviderDistillationRunRequest {
  readonly job_id: string;
  readonly repo_id: string;
  readonly repository: string;
  readonly repositoryContext: unknown;
  readonly signal?: AbortSignal;
  readonly thread: ProviderDistillationThread;
}

export interface DistillationProvenance {
  readonly distillation_key: string;
  readonly model: string;
  readonly output_schema_digest: string;
  readonly output_schema_version: string;
  readonly prompt_digest: string;
  readonly prompt_version: string;
  readonly provider: string;
  readonly response_id?: string;
  readonly trust_policy_digest: string;
}

export interface ProviderDistillationExtractedResult {
  readonly job: DistillJob;
  readonly lease: DistillJobLeaseCredentials;
  readonly output: DistillationOutput;
  readonly provenance: DistillationProvenance;
  readonly state: "extracted";
}

export interface ProviderDistillationPendingResult {
  readonly reason: ProviderTransmissionDeniedReason | "job_unavailable";
  readonly state: "pending";
}

export interface ProviderDistillationFailedResult {
  readonly failure_kind: LlmProviderFailureKind | "json_validation";
  readonly job: DistillJob;
  readonly state: "failed" | "retry_scheduled";
}

export type ProviderDistillationRunResult =
  | ProviderDistillationExtractedResult
  | ProviderDistillationFailedResult
  | ProviderDistillationPendingResult;

export type ProviderDistillationDiagnosticEvent =
  | "provider_call_completed"
  | "provider_call_failed"
  | "provider_call_started"
  | "provider_output_invalid";

/** Whitelisted diagnostic fields intentionally cannot carry review content. */
export interface ProviderDistillationDiagnostic {
  readonly attempt: number;
  readonly candidate_count?: number;
  readonly event: ProviderDistillationDiagnosticEvent;
  readonly job_id: string;
  readonly model: string | null;
  readonly provider: string;
  readonly validation_issue_count?: number;
}

export type ProviderDistillationDiagnosticSink = (
  diagnostic: ProviderDistillationDiagnostic,
) => void;

export interface ProviderDistillationServiceOptions {
  readonly adapter: LlmProviderAdapter;
  readonly config: RepoKnowledgeConfig;
  readonly diagnosticSink?: ProviderDistillationDiagnosticSink;
  readonly prompt: DistillationPromptTemplate;
}

export type ProviderDistillationServiceErrorCode =
  "DISTILLATION_CONTEXT_MISMATCH" | "PROVIDER_MISMATCH";

export class ProviderDistillationServiceError extends Error {
  constructor(
    readonly code: ProviderDistillationServiceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProviderDistillationServiceError";
  }
}

export class DistillationOutputValidationError extends Error {
  readonly code = "DISTILLATION_OUTPUT_INVALID";

  constructor(
    readonly validationSummary: string,
    readonly issueCount: number,
  ) {
    super(`DISTILLATION_OUTPUT_INVALID: ${validationSummary}`);
    this.name = "DistillationOutputValidationError";
  }
}

/** Evaluates mode and the effective per-repository transmission opt-in. */
export function evaluateProviderTransmission(
  config: RepoKnowledgeConfig,
  repository: string,
): ProviderTransmissionDecision {
  const parsed = RepoKnowledgeConfigSchema.parse(config);
  const normalizedRepository = RepositoryNameSchema.parse(repository);
  if (parsed.llm.mode === "disabled") {
    return { allowed: false, reason: "mode_disabled" };
  }
  const policy = resolveRepositoryPolicy(parsed, normalizedRepository);
  if (!policy.allowCloudTransmission) {
    return {
      allowed: false,
      reason:
        parsed.repoPolicies[normalizedRepository]?.allowCloudTransmission ===
        false
          ? "repository_policy_denied"
          : "cloud_transmission_disabled",
    };
  }
  return {
    allowed: true,
    mode: parsed.llm.mode,
    model: parsed.llm.model,
  };
}

/** Processes one leased provider attempt; all provider waits occur lock-free. */
export class ProviderDistillationService {
  private readonly adapter: LlmProviderAdapter;
  private readonly config: RepoKnowledgeConfig;
  private readonly diagnosticSink: ProviderDistillationDiagnosticSink;
  private readonly outputSchemaDigest: string;
  private readonly prompt: DistillationPromptTemplate;
  private readonly trustPolicyDigest: string;

  constructor(
    private readonly coordinator: DistillJobCoordinator,
    options: ProviderDistillationServiceOptions,
  ) {
    this.adapter = options.adapter;
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.prompt = {
      instructions: NonEmptyStringSchema.parse(options.prompt.instructions),
      promptDigest: Sha256DigestSchema.parse(options.prompt.promptDigest),
      promptVersion: NonEmptyStringSchema.parse(options.prompt.promptVersion),
    };
    this.diagnosticSink =
      options.diagnosticSink ?? writeProviderDistillationDiagnostic;
    this.outputSchemaDigest = Sha256DigestSchema.parse(
      computeOutputSchemaDigest(DISTILLATION_OUTPUT_JSON_SCHEMA),
    );
    if (this.outputSchemaDigest !== DISTILLATION_OUTPUT_SCHEMA_DIGEST) {
      throw new TypeError("distillation output schema digest is inconsistent");
    }
    this.trustPolicyDigest = computeTrustPolicyDigest(this.config.trust);
  }

  async run(
    request: ProviderDistillationRunRequest,
  ): Promise<ProviderDistillationRunResult> {
    const repoId = RepositoryIdSchema.parse(request.repo_id);
    const jobId = JobIdSchema.parse(request.job_id);
    const repository = RepositoryNameSchema.parse(request.repository);
    const access = evaluateProviderTransmission(this.config, repository);
    if (!access.allowed) {
      return { reason: access.reason, state: "pending" };
    }
    if (this.adapter.provider !== access.mode) {
      throw new ProviderDistillationServiceError(
        "PROVIDER_MISMATCH",
        `configured mode ${access.mode} does not match adapter ${this.adapter.provider}`,
      );
    }
    const thread = validateThread(request.thread);
    assertThreadInputBinding(thread, request.repositoryContext);
    const baseInput = buildDistillationUserInput({
      repositoryContext: request.repositoryContext,
      thread,
    });
    const expectedKey = computeThreadDistillationKey({
      distillationInputDigest: thread.distillationInputDigest,
      outputSchemaDigest: this.outputSchemaDigest,
      promptDigest: this.prompt.promptDigest,
      trustPolicyDigest: this.trustPolicyDigest,
    });
    const lease = await this.coordinator.acquireLease({
      job_id: jobId,
      repo_id: repoId,
    });
    if (lease === null) {
      return { reason: "job_unavailable", state: "pending" };
    }
    const attempt = lease.job.validation_failures + 1;
    if (
      lease.job.thread_id !== thread.threadId ||
      lease.job.distillation_key !== thread.distillationKey ||
      thread.distillationKey !== expectedKey
    ) {
      return this.failContextMismatch(lease, access.model, attempt);
    }

    const input =
      lease.job.validation_failures === 0
        ? baseInput
        : buildDistillationUserInput({
            repositoryContext: request.repositoryContext,
            retryValidationError:
              lease.job.last_error ?? "previous output failed validation",
            thread,
          });
    this.diagnosticSink({
      attempt,
      event: "provider_call_started",
      job_id: jobId,
      model: access.model,
      provider: this.adapter.provider,
    });

    let response: StructuredCompletionResponse;
    try {
      response = validateProviderResponse(
        await this.adapter.completeStructured({
          input,
          jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
          ...(access.model === null ? {} : { model: access.model }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          system: this.prompt.instructions,
        }),
        this.adapter.provider,
      );
    } catch (error) {
      const failureKind =
        error instanceof LlmProviderError ? error.failureKind : "system";
      const failureCode =
        error instanceof LlmProviderError
          ? error.code
          : "UNEXPECTED_PROVIDER_ERROR";
      this.diagnosticSink({
        attempt,
        event: "provider_call_failed",
        job_id: jobId,
        model: access.model,
        provider: this.adapter.provider,
      });
      const job = await this.coordinator.fail({
        ...lease,
        failure_kind: failureKind,
        last_error: `provider request failed (${failureCode})`,
      });
      return { failure_kind: failureKind, job, state: "failed" };
    }

    let output: DistillationOutput;
    try {
      output = parseDistillationOutput(
        response.outputText,
        thread.normalizedComments.map((comment) => comment.id),
      );
    } catch (error) {
      if (!(error instanceof DistillationOutputValidationError)) throw error;
      this.diagnosticSink({
        attempt,
        event: "provider_output_invalid",
        job_id: jobId,
        model: response.model,
        provider: response.provider,
        validation_issue_count: error.issueCount,
      });
      const job = await this.coordinator.fail({
        ...lease,
        failure_kind: "json_validation",
        last_error: error.validationSummary,
      });
      return {
        failure_kind: "json_validation",
        job,
        state: job.state === "pending" ? "retry_scheduled" : "failed",
      };
    }

    const job = await this.coordinator.markAwaitingFinalize(lease);
    this.diagnosticSink({
      attempt,
      candidate_count: output.candidates.length,
      event: "provider_call_completed",
      job_id: jobId,
      model: response.model,
      provider: response.provider,
    });
    return {
      job,
      lease: leaseCredentials(lease),
      output,
      provenance: {
        distillation_key: thread.distillationKey,
        model: NonEmptyStringSchema.parse(response.model),
        output_schema_digest: this.outputSchemaDigest,
        output_schema_version: DISTILLATION_OUTPUT_SCHEMA_VERSION,
        prompt_digest: this.prompt.promptDigest,
        prompt_version: this.prompt.promptVersion,
        provider: NonEmptyStringSchema.parse(response.provider),
        ...(response.responseId === undefined
          ? {}
          : { response_id: response.responseId }),
        trust_policy_digest: this.trustPolicyDigest,
      },
      state: "extracted",
    };
  }

  private async failContextMismatch(
    lease: DistillJobLeaseCredentials,
    model: string | null,
    attempt: number,
  ): Promise<ProviderDistillationFailedResult> {
    this.diagnosticSink({
      attempt,
      event: "provider_call_failed",
      job_id: lease.job_id,
      model,
      provider: this.adapter.provider,
    });
    const job = await this.coordinator.fail({
      ...lease,
      failure_kind: "system",
      last_error: "distillation context no longer matches the leased job",
    });
    return { failure_kind: "system", job, state: "failed" };
  }
}

/** Parses provider text and binds every evidence ID to the supplied thread. */
export function parseDistillationOutput(
  outputText: string,
  allowedCommentIds: readonly string[],
): DistillationOutput {
  let value: unknown;
  try {
    value = JSON.parse(outputText) as unknown;
  } catch {
    throw new DistillationOutputValidationError("output must be valid JSON", 1);
  }
  const parsed = DistillationOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".") || "<root>";
      return `${path}: ${issue.message}`;
    });
    throw new DistillationOutputValidationError(
      boundedValidationSummary(issues),
      issues.length,
    );
  }
  const allowed = new Set(
    allowedCommentIds.map((id) => NonEmptyStringSchema.parse(id)),
  );
  const invalidEvidence = parsed.data.candidates.filter((candidate) =>
    candidate.evidence_comment_ids.some((id) => !allowed.has(id)),
  ).length;
  if (invalidEvidence > 0) {
    throw new DistillationOutputValidationError(
      "evidence_comment_ids must be a subset of the current review thread",
      invalidEvidence,
    );
  }
  return parsed.data;
}

/** Default logger: one structured JSON object per stderr line, never stdout. */
export function writeProviderDistillationDiagnostic(
  diagnostic: ProviderDistillationDiagnostic,
): void {
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
}

function validateThread(
  thread: ProviderDistillationThread,
): ProviderDistillationThread {
  NonEmptyStringSchema.parse(thread.threadId);
  Sha256DigestSchema.parse(thread.contentFingerprint);
  Sha256DigestSchema.parse(thread.distillationInputDigest);
  Sha256DigestSchema.parse(thread.distillationKey);
  if (thread.normalizedComments.length === 0) {
    throw new TypeError("distillation thread must contain a review comment");
  }
  if (thread.normalizedActors.length !== thread.normalizedComments.length) {
    throw new TypeError("each review comment must have one normalized actor");
  }
  const ids = thread.normalizedComments.map((comment) =>
    NonEmptyStringSchema.parse(comment.id),
  );
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("distillation thread comment IDs must be unique");
  }
  return thread;
}

function assertThreadInputBinding(
  thread: ProviderDistillationThread,
  repositoryContext: unknown,
): void {
  const contentFingerprint = computeThreadContentFingerprint(
    thread.threadId,
    thread.path,
    thread.normalizedComments,
  );
  const distillationInputDigest = computeDistillationInputDigest({
    normalizedActors: thread.normalizedActors,
    normalizedComments: thread.normalizedComments,
    path: thread.path,
    repositoryContext,
    threadId: thread.threadId,
  });
  if (
    contentFingerprint !== thread.contentFingerprint ||
    distillationInputDigest !== thread.distillationInputDigest
  ) {
    throw new ProviderDistillationServiceError(
      "DISTILLATION_CONTEXT_MISMATCH",
      "review data does not match its content and distillation digests",
    );
  }
}

function validateProviderResponse(
  response: StructuredCompletionResponse,
  expectedProvider: string,
): StructuredCompletionResponse {
  const provider = NonEmptyStringSchema.safeParse(response.provider);
  const model = NonEmptyStringSchema.safeParse(response.model);
  const outputText = zodFreeString(response.outputText);
  const responseId =
    response.responseId === undefined
      ? undefined
      : NonEmptyStringSchema.safeParse(response.responseId);
  if (
    !provider.success ||
    provider.data !== expectedProvider ||
    !model.success ||
    outputText === null ||
    (responseId !== undefined && !responseId.success)
  ) {
    throw new LlmProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "system",
      expectedProvider,
      "provider adapter returned invalid response metadata",
    );
  }
  return {
    model: model.data,
    outputText,
    provider: provider.data,
    ...(responseId === undefined ? {} : { responseId: responseId.data }),
  };
}

function zodFreeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function leaseCredentials(
  lease: DistillJobLeaseCredentials,
): DistillJobLeaseCredentials {
  return {
    job_id: lease.job_id,
    lease_generation: lease.lease_generation,
    lease_token: lease.lease_token,
  };
}

function boundedValidationSummary(issues: readonly string[]): string {
  const value = issues.join("; ");
  return value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}

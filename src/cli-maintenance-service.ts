import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeComments,
} from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import { CanonicalTransactionStore } from "./canonical-transaction-store.js";
import { computeTrustPolicyDigest } from "./config.js";
import {
  CommentObservationSchema,
  EventIdSchema,
  JobIdSchema,
  KnowledgeStatusSchema,
  ObservationIdSchema,
  RepoKnowledgeConfigSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  Sha256DigestSchema,
  TransactionIdSchema,
  type CommentObservation,
  type DistillJob,
  type KnowledgeEvidence,
  type RepoKnowledgeConfig,
  type ThreadObservation,
} from "./domain-schemas.js";
import {
  DISTILLATION_JOB_CREATED,
  DISTILLATION_JOB_REDISTILL_REQUESTED,
  createDistillationJobEventRecord,
} from "./distill-job-state.js";
import { DISTILL_JOB_EVENT_PATH } from "./distill-job-coordinator.js";
import {
  RAW_COMMENT_PATH,
  type IngestPullRequestResult,
} from "./github-ingest-service.js";
import {
  RAW_COMMENT_RECORD_TYPE,
  classifyCommentExclusion,
  computeDistillationInputDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  reclassifyReviewerIdentity,
  type NormalizedDistillationActor,
  type NormalizedDistillationComment,
} from "./github-snapshot-normalizer.js";
import { createDomainId } from "./ids.js";
import type { ProviderPostIngestRunner } from "./ingest-pr-mutation-service.js";
import {
  applyKnowledgeDocumentPatch,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { evaluateProviderTransmission } from "./provider-transmission.js";
import {
  RepositoryResolver,
  type RepositoryResolution,
  type RepositoryResolverOptions,
} from "./repository-resolver.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";
import { AdminPlaneService } from "./admin-plane-service.js";
import type {
  CliDistillResult,
  CliListKnowledgeRequest,
  CliListKnowledgeResult,
  CliReconcileResult,
  CliRedistillRequest,
  CliRedistillResult,
  CliReindexResult,
  CliRepositoryOperations,
  CliRepositoryOperationsResolver,
} from "./cli.js";
import type { KnowledgeMutationServiceResolutionInput } from "./mcp-mutation-tools.js";
import {
  ReviewInboxService,
  type ReviewInboxRequest,
  type ReviewInboxResult,
} from "./review-inbox-service.js";

export type CliMaintenanceErrorCode =
  | "CLI_PROVIDER_PIPELINE_MISSING"
  | "CLI_REDISTILL_SOURCE_INVALID";

export class CliMaintenanceError extends Error {
  constructor(
    readonly code: CliMaintenanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "CliMaintenanceError";
  }
}

export interface CanonicalCliRepositoryServiceOptions {
  readonly config: RepoKnowledgeConfig;
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextJobId?: (timestamp: number) => string;
  readonly nextKnowledgeId?: (timestamp: number) => string;
  readonly nextObservationId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly promptVersion: string;
  readonly providerRunner?: ProviderPostIngestRunner;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
  readonly repositoryContext: unknown;
}

/**
 * Canonical CLI-only operations; MCP mutations continue through their
 * services, and `stats` is provided by the repository application graph
 * through the shared read-only StatsReadService.
 */
export class CanonicalCliRepositoryService
  implements Omit<CliRepositoryOperations, "stats">
{
  readonly admin: AdminPlaneService;

  private readonly config: RepoKnowledgeConfig;
  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextJobId: (timestamp: number) => string;
  private readonly nextKnowledgeId: (timestamp: number) => string;
  private readonly nextObservationId: (timestamp: number) => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly outputSchemaDigest: string;
  private readonly promptDigest: string;
  private readonly promptVersion: string;
  private readonly providerRunner: ProviderPostIngestRunner | undefined;
  private readonly repo: string;
  private readonly repoId: string;
  private readonly repository: CanonicalTransactionStore;
  private readonly repositoryContext: unknown;
  private readonly reviewInboxService: ReviewInboxService;
  private readonly trustPolicyDigest: string;

  constructor(options: CanonicalCliRepositoryServiceOptions) {
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.repositoryContext = JSON.parse(
      canonicalizeJson(options.repositoryContext),
    ) as unknown;
    this.outputSchemaDigest = Sha256DigestSchema.parse(
      options.outputSchemaDigest,
    );
    this.promptDigest = Sha256DigestSchema.parse(options.promptDigest);
    this.promptVersion = options.promptVersion;
    if (this.promptVersion.length === 0) {
      throw new TypeError("promptVersion must not be empty");
    }
    this.trustPolicyDigest = computeTrustPolicyDigest(this.config.trust);
    this.providerRunner = options.providerRunner;
    this.now = options.now ?? (() => new Date());
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextJobId =
      options.nextJobId ?? ((timestamp) => createDomainId("job", timestamp));
    this.nextKnowledgeId =
      options.nextKnowledgeId ??
      ((timestamp) => createDomainId("knowledge", timestamp));
    this.nextObservationId =
      options.nextObservationId ??
      ((timestamp) => createDomainId("observation", timestamp));
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
    this.admin = new AdminPlaneService({
      nextEventId: this.nextEventId,
      nextKnowledgeId: this.nextKnowledgeId,
      nextTransactionId: this.nextTransactionId,
      now: this.now,
      repo: this.repo,
      repoId: this.repoId,
      repository: this.repository,
    });
    this.reviewInboxService = new ReviewInboxService({
      details: this.admin,
      repo: this.repo,
      repoId: this.repoId,
      repository: this.repository,
    });
  }

  async distill(): Promise<CliDistillResult> {
    const snapshot = await this.repository.readSnapshot();
    const current = currentPullRequestSnapshots(snapshot, this.repoId);
    const currentThreadIds = new Set(
      current.flatMap((item) => [
        ...item.thread_ids,
        ...item.review_summary_ids,
      ]),
    );
    const initialPending = snapshot.domain.distillJobs.filter(
      (job) =>
        job.repo_id === this.repoId &&
        currentThreadIds.has(job.thread_id) &&
        job.state !== "done" &&
        job.state !== "skipped",
    ).length;
    const transmission = evaluateProviderTransmission(this.config, this.repo);
    if (!transmission.allowed) {
      return {
        distilled: 0,
        pending: initialPending,
        reason: transmission.reason,
      };
    }
    if (this.providerRunner === undefined) {
      throw new CliMaintenanceError(
        "CLI_PROVIDER_PIPELINE_MISSING",
        `provider mode ${transmission.mode} is enabled without a runner`,
      );
    }

    let distilled = 0;
    let pending = 0;
    for (const source of current) {
      const result = await this.providerRunner.run({
        ingest: emptyIngestResult(this.repoId, source.snapshot_id),
        pr_number: source.pr_number,
      });
      distilled += result.distilled;
      pending += result.pending;
    }
    return { distilled, pending };
  }

  async listKnowledge(
    request: CliListKnowledgeRequest = {},
  ): Promise<CliListKnowledgeResult> {
    const status =
      request.status === undefined
        ? undefined
        : KnowledgeStatusSchema.parse(request.status);
    const snapshot = await this.repository.readSnapshot();
    return {
      knowledge: snapshot.domain.knowledge
        .filter(
          (item) =>
            item.repoId === this.repoId &&
            (status === undefined || item.status === status),
        )
        .sort((left, right) => compareCodeUnits(left.id, right.id))
        .map((item) => ({
          applied_count: item.appliedCount,
          evidence_count: item.evidenceCount,
          id: item.id,
          revision: item.revision,
          rule: item.rule,
          severity: item.severity,
          status: item.status,
          violation_count: item.violationCount,
        })),
      repo: this.repo,
      revision_proposals: snapshot.domain.revisionProposals
        .filter(
          (proposal) =>
            proposal.repo_id === this.repoId && proposal.status === "pending",
        )
        .sort((left, right) =>
          compareCodeUnits(left.proposal_id, right.proposal_id),
        )
        .map((proposal) => ({
          knowledge_id: proposal.knowledge_id,
          proposal_id: proposal.proposal_id,
          updated_at: proposal.updated_at,
        })),
    };
  }

  async reviewInbox(
    request: ReviewInboxRequest = {},
  ): Promise<ReviewInboxResult> {
    return this.reviewInboxService.list(request);
  }

  async reindex(): Promise<CliReindexResult> {
    const snapshot = await this.repository.reindex();
    return {
      evidence: snapshot.domain.evidence.filter(
        (item) => item.repo_id === this.repoId,
      ).length,
      jobs: snapshot.domain.distillJobs.filter(
        (item) => item.repo_id === this.repoId,
      ).length,
      knowledge: snapshot.domain.knowledge.filter(
        (item) => item.repoId === this.repoId,
      ).length,
      repo: this.repo,
      submissions: snapshot.domain.submissionReceipts.filter((receipt) => {
        const job = snapshot.domain.distillJobs.find(
          (candidate) => candidate.job_id === receipt.job_id,
        );
        return job?.repo_id === this.repoId;
      }).length,
    };
  }

  async redistill(request: CliRedistillRequest): Promise<CliRedistillResult> {
    return this.repository.runLockedMutation((snapshot) => {
      const selected = selectRedistillThreads(snapshot, this.repoId, request);
      const operation = operationTime(
        this.now,
        selected.flatMap((thread) => [
          thread.observed_at,
          ...snapshot.domain.distillJobs
            .filter((job) => job.thread_id === thread.thread_id)
            .map((job) => job.updated_at),
        ]),
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const appendRecords: Array<{
        readonly record: CanonicalJsonlRecord;
        readonly targetPath: string;
      }> = [];
      let createdJobs = 0;
      let reclassifiedComments = 0;
      let resetJobs = 0;
      let unchanged = 0;

      for (const thread of selected) {
        const source = currentThreadSource(
          snapshot,
          thread,
          this.config,
          this.repositoryContext,
          this.outputSchemaDigest,
          this.promptDigest,
          this.trustPolicyDigest,
        );
        if (source === null) {
          unchanged += 1;
          continue;
        }
        for (const change of source.identityChanges) {
          const observationId = ObservationIdSchema.parse(
            this.nextObservationId(operation.timestamp),
          );
          const payload = CommentObservationSchema.parse({
            ...change.comment,
            actor: change.actor,
            observation_id: observationId,
            observed_at: operation.recordedAt,
          });
          appendRecords.push({
            record: observationRecord(
              payload,
              transactionId,
              operation.recordedAt,
            ),
            targetPath: RAW_COMMENT_PATH,
          });
          reclassifiedComments += 1;
        }

        const existing = snapshot.domain.distillJobs.find(
          (job) =>
            job.repo_id === this.repoId &&
            job.thread_id === thread.thread_id &&
            job.distillation_key === source.distillationKey,
        );
        if (existing === undefined) {
          appendRecords.push({
            record: createDistillationJobEventRecord({
              eventId: EventIdSchema.parse(
                this.nextEventId(operation.timestamp),
              ),
              payload: {
                distillation_key: source.distillationKey,
                job_id: JobIdSchema.parse(this.nextJobId(operation.timestamp)),
                repo_id: this.repoId,
                thread_id: thread.thread_id,
              },
              recordedAt: operation.recordedAt,
              transactionId,
              type: DISTILLATION_JOB_CREATED,
            }),
            targetPath: DISTILL_JOB_EVENT_PATH,
          });
          createdJobs += 1;
          continue;
        }
        // --outdated only fills in missing current-key jobs; a thread whose
        // M2 prompt/schema/trust digest already produced a job is up to date
        // and must never be re-queued by this selector.
        if (request.selector === "outdated") {
          unchanged += 1;
          continue;
        }
        if (isTerminal(existing)) {
          appendRecords.push({
            record: createDistillationJobEventRecord({
              eventId: EventIdSchema.parse(
                this.nextEventId(operation.timestamp),
              ),
              payload: {
                distillation_key: existing.distillation_key,
                job_id: existing.job_id,
                lease_generation: existing.lease_generation,
              },
              recordedAt: operation.recordedAt,
              transactionId,
              type: DISTILLATION_JOB_REDISTILL_REQUESTED,
            }),
            targetPath: DISTILL_JOB_EVENT_PATH,
          });
          resetJobs += 1;
          continue;
        }
        unchanged += 1;
      }

      const value = {
        created_jobs: createdJobs,
        reclassified_comments: reclassifiedComments,
        reset_jobs: resetJobs,
        selected_threads: selected.length,
        unchanged,
      };
      return appendRecords.length === 0
        ? { transaction: null, value }
        : {
            transaction: {
              appendRecords,
              createdAt: operation.recordedAt,
              fileWrites: [],
              transactionId,
            },
            value,
          };
    });
  }

  async reconcileDerivedMetadata(): Promise<CliReconcileResult> {
    return this.repository.runLockedMutation((snapshot) => {
      const current = snapshot.domain.knowledge
        .filter((item) => item.repoId === this.repoId)
        .sort((left, right) => compareCodeUnits(left.id, right.id));
      const operation = operationTime(
        this.now,
        current.map((item) => item.updatedAt),
      );
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const fileWrites: Array<{
        readonly content: string;
        readonly expectedSha256: string;
        readonly targetPath: string;
      }> = [];
      let unchanged = 0;
      for (const projected of current) {
        const document = requiredKnowledgeDocument(snapshot, projected.id);
        const metadata = derivedMetadata(snapshot, projected.id);
        if (hasDerivedMetadata(document, metadata)) {
          unchanged += 1;
          continue;
        }
        fileWrites.push({
          content: applyKnowledgeDocumentPatch(document, {
            frontmatter: {
              ...metadata,
              updated_at: operation.recordedAt,
            },
          }),
          expectedSha256: document.etag,
          targetPath: document.path,
        });
      }
      const value = {
        repo: this.repo,
        transaction_id: fileWrites.length === 0 ? null : transactionId,
        unchanged,
        written: fileWrites.length,
      };
      return fileWrites.length === 0
        ? { transaction: null, value }
        : {
            transaction: {
              appendRecords: [],
              createdAt: operation.recordedAt,
              fileWrites,
              transactionId,
            },
            value,
          };
    });
  }
}

export interface CliRepositoryOperationsFactoryContext {
  readonly repository: RepositoryResolution;
  readonly repositoryStore: CanonicalTransactionStore;
}

export interface CliRepositoryOperationsFactory {
  create(
    context: CliRepositoryOperationsFactoryContext,
  ): CliRepositoryOperations | Promise<CliRepositoryOperations>;
}

export type CanonicalCliRepositoryOperationsResolverOptions = Omit<
  RepositoryResolverOptions,
  "startupRepo" | "startupWorkspace"
> & {
  readonly operationsFactory: CliRepositoryOperationsFactory;
};

/** Resolves CLI repository selection through the same stable registry path. */
export class CanonicalCliRepositoryOperationsResolver
  implements CliRepositoryOperationsResolver
{
  private readonly operationsFactory: CliRepositoryOperationsFactory;
  private readonly resolverOptions: Omit<
    RepositoryResolverOptions,
    "startupRepo" | "startupWorkspace"
  >;

  constructor(options: CanonicalCliRepositoryOperationsResolverOptions) {
    const { operationsFactory, ...resolverOptions } = options;
    this.operationsFactory = operationsFactory;
    this.resolverOptions = resolverOptions;
  }

  async resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<CliRepositoryOperations> {
    const resolver = new RepositoryResolver({
      ...this.resolverOptions,
      ...(input.startupRepo === undefined
        ? {}
        : { startupRepo: input.startupRepo }),
      ...(input.startupWorkspace === undefined
        ? {}
        : { startupWorkspace: input.startupWorkspace }),
    });
    const repository = await resolver.resolve({
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
    });
    const repositoryStore = new CanonicalTransactionStore(
      repository.absolutePath,
    );
    return this.operationsFactory.create({ repository, repositoryStore });
  }
}

interface CurrentThreadSource {
  readonly distillationKey: string;
  readonly identityChanges: readonly {
    readonly actor: CommentObservation["actor"];
    readonly comment: CommentObservation;
  }[];
}

function currentThreadSource(
  snapshot: CanonicalProjectionSnapshot,
  thread: ThreadObservation,
  config: RepoKnowledgeConfig,
  repositoryContext: unknown,
  outputSchemaDigest: string,
  promptDigest: string,
  trustPolicyDigest: string,
): CurrentThreadSource | null {
  const commentsById = new Map(
    snapshot.domain.comments.map((comment) => [comment.comment_id, comment]),
  );
  const working = normalizeComments(
    thread.comment_ids.map((commentId) => {
      const comment = commentsById.get(commentId);
      if (
        comment === undefined ||
        comment.thread_id !== thread.thread_id ||
        comment.snapshot_id !== thread.snapshot_id
      ) {
        throw new CliMaintenanceError(
          "CLI_REDISTILL_SOURCE_INVALID",
          `thread ${thread.thread_id} has an incomplete canonical comment set`,
        );
      }
      const actor = reclassifyReviewerIdentity(comment.actor, config.trust);
      const normalized: NormalizedDistillationComment = {
        body: comment.body,
        createdAt: comment.created_at,
        ...(comment.diff_hunk === undefined
          ? {}
          : { diffHunk: comment.diff_hunk }),
        id: comment.comment_id,
        updatedAt: comment.updated_at,
      };
      return {
        actor,
        comment,
        createdAt: comment.created_at,
        excluded: classifyCommentExclusion(comment.body, actor) !== null,
        id: comment.comment_id,
        normalized,
      };
    }),
  );
  const included = working.filter((item) => !item.excluded);
  if (included.length === 0) return null;
  const normalizedComments = included.map((item) => item.normalized);
  if (
    computeThreadContentFingerprint(
      thread.thread_id,
      thread.path ?? null,
      normalizedComments,
    ) !== thread.content_fingerprint
  ) {
    throw new CliMaintenanceError(
      "CLI_REDISTILL_SOURCE_INVALID",
      `thread ${thread.thread_id} content fingerprint is inconsistent`,
    );
  }
  const normalizedActors: NormalizedDistillationActor[] = included.map(
    ({ actor }) => ({
      actor_id: actor.actor_id ?? null,
      actor_kind: actor.actor_kind,
      authorAssociation: actor.author_association ?? null,
      login: actor.login,
      provider: actor.provider,
      trust: actor.trust,
    }),
  );
  const distillationInputDigest = computeDistillationInputDigest({
    normalizedActors,
    normalizedComments,
    path: thread.path ?? null,
    repositoryContext,
    threadId: thread.thread_id,
  });
  return {
    distillationKey: computeThreadDistillationKey({
      distillationInputDigest,
      outputSchemaDigest,
      promptDigest,
      trustPolicyDigest,
    }),
    identityChanges: working
      .filter(
        ({ actor, comment }) =>
          canonicalizeJson(actor) !== canonicalizeJson(comment.actor),
      )
      .map(({ actor, comment }) => ({ actor, comment })),
  };
}

function selectRedistillThreads(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  request: CliRedistillRequest,
): ThreadObservation[] {
  const currentIds = new Set(
    currentPullRequestSnapshots(snapshot, repoId).flatMap((item) => [
      ...item.thread_ids,
      ...item.review_summary_ids,
    ]),
  );
  let selectedIds: Set<string>;
  switch (request.selector) {
    case "all":
    case "outdated":
      selectedIds = currentIds;
      break;
    case "author":
      selectedIds = new Set(
        snapshot.domain.comments
          .filter((comment) => comment.actor.login === request.author)
          .map((comment) => comment.thread_id),
      );
      break;
    case "failed":
      selectedIds = new Set(
        snapshot.domain.distillJobs
          .filter((job) => job.repo_id === repoId && job.state === "failed")
          .map((job) => job.thread_id),
      );
      break;
    case "prompt-version": {
      const knowledgeIds = new Set(
        snapshot.knowledge
          .filter(
            (document) =>
              document.frontmatter.repo_id === repoId &&
              asRecord(document.frontmatter.origin)?.prompt_version ===
                request.prompt_version,
          )
          .map((document) => String(document.frontmatter.id)),
      );
      selectedIds = new Set(
        snapshot.domain.evidence
          .filter(
            (evidence) =>
              evidence.repo_id === repoId &&
              knowledgeIds.has(evidence.knowledge_id),
          )
          .map((evidence) => evidence.thread_id),
      );
      break;
    }
  }
  return snapshot.domain.threads
    .filter(
      (thread) =>
        thread.repo_id === repoId &&
        currentIds.has(thread.thread_id) &&
        selectedIds.has(thread.thread_id),
    )
    .sort((left, right) => compareCodeUnits(left.thread_id, right.thread_id));
}

function currentPullRequestSnapshots(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
): CanonicalProjectionSnapshot["domain"]["pullRequestSnapshots"] {
  const byId = new Map(
    snapshot.domain.pullRequestSnapshots
      .filter((item) => item.repo_id === repoId)
      .map((item) => [item.snapshot_id, item]),
  );
  const fromPullRequests = snapshot.domain.pullRequests
    .filter((item) => item.repo_id === repoId)
    .map((item) => byId.get(item.snapshot_id))
    .filter(
      (
        item,
      ): item is CanonicalProjectionSnapshot["domain"]["pullRequestSnapshots"][number] =>
        item !== undefined,
    );
  if (fromPullRequests.length > 0) {
    return [...fromPullRequests].sort(
      (left, right) =>
        left.pr_number - right.pr_number ||
        compareCodeUnits(left.snapshot_id, right.snapshot_id),
    );
  }
  const latest = new Map<
    number,
    CanonicalProjectionSnapshot["domain"]["pullRequestSnapshots"][number]
  >();
  for (const item of byId.values()) {
    const previous = latest.get(item.pr_number);
    if (
      previous === undefined ||
      compareCodeUnits(previous.observed_at, item.observed_at) < 0 ||
      (previous.observed_at === item.observed_at &&
        compareCodeUnits(previous.snapshot_id, item.snapshot_id) < 0)
    ) {
      latest.set(item.pr_number, item);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.pr_number - right.pr_number ||
      compareCodeUnits(left.snapshot_id, right.snapshot_id),
  );
}

function emptyIngestResult(
  repoId: string,
  snapshotId: string,
): IngestPullRequestResult {
  return {
    changed_threads: 0,
    distilled: 0,
    jobs_created: 0,
    new_threads: 0,
    pending: 0,
    repo_id: repoId,
    snapshot_id: snapshotId,
    unchanged: 0,
    warnings: [],
  };
}

function observationRecord(
  payload: CommentObservation,
  transactionId: string,
  recordedAt: string,
): CanonicalJsonlRecord<CommentObservation> {
  return {
    payload,
    record_id: payload.observation_id,
    record_type: RAW_COMMENT_RECORD_TYPE,
    recorded_at: recordedAt,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

function requiredKnowledgeDocument(
  snapshot: CanonicalProjectionSnapshot,
  id: string,
): KnowledgeDocument {
  const document = snapshot.knowledge.find(
    (item) => item.frontmatter.id === id,
  );
  if (document === undefined) {
    throw new CliMaintenanceError(
      "CLI_REDISTILL_SOURCE_INVALID",
      `knowledge ${id} has no canonical document`,
    );
  }
  return document;
}

interface DerivedMetadata {
  readonly applied_count: number;
  readonly evidence_count: number;
  readonly representative_evidence: readonly Record<string, unknown>[];
  readonly sources: readonly string[];
  readonly violation_count: number;
}

function derivedMetadata(
  snapshot: CanonicalProjectionSnapshot,
  knowledgeId: string,
): DerivedMetadata {
  const projected = snapshot.domain.knowledge.find(
    (item) => item.id === knowledgeId,
  )!;
  const evidence = snapshot.domain.evidence
    .filter(
      (item) => item.knowledge_id === knowledgeId && item.status === "active",
    )
    .sort(compareRepresentativeEvidence)
    .slice(0, 3)
    .map((item) => ({
      evidence_id: item.evidence_id,
      ...(item.path === undefined ? {} : { path: item.path }),
      pr: item.pr_number,
      source: item.originator.provider,
      thread_id: item.thread_id,
      ...(item.url === undefined ? {} : { url: item.url }),
    }));
  return {
    applied_count: projected.appliedCount,
    evidence_count: projected.evidenceCount,
    representative_evidence: evidence,
    sources: projected.sources,
    violation_count: projected.violationCount,
  };
}

function compareRepresentativeEvidence(
  left: KnowledgeEvidence,
  right: KnowledgeEvidence,
): number {
  return (
    compareCodeUnits(right.observed_at, left.observed_at) ||
    compareCodeUnits(left.evidence_id, right.evidence_id)
  );
}

function hasDerivedMetadata(
  document: KnowledgeDocument,
  expected: DerivedMetadata,
): boolean {
  const current = {
    applied_count: document.frontmatter.applied_count ?? null,
    evidence_count: document.frontmatter.evidence_count ?? null,
    representative_evidence:
      document.frontmatter.representative_evidence ?? null,
    sources: document.frontmatter.sources ?? null,
    violation_count: document.frontmatter.violation_count ?? null,
  };
  return canonicalizeJson(current) === canonicalizeJson(expected);
}

function isTerminal(job: DistillJob): boolean {
  return (
    job.state === "done" || job.state === "failed" || job.state === "skipped"
  );
}

function operationTime(
  now: () => Date,
  floors: readonly string[],
): { readonly recordedAt: string; readonly timestamp: number } {
  const clock = now().getTime();
  const timestamp = Math.max(
    clock,
    ...floors.map((value) => Date.parse(value)),
  );
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("CLI operation clock is invalid");
  }
  return { recordedAt: new Date(timestamp).toISOString(), timestamp };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

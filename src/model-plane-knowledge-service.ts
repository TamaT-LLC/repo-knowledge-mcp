import { sortAndDedupeStrings } from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  CanonicalTransactionStore,
  KnowledgeConflictError,
} from "./canonical-transaction-store.js";
import { REVISION_PROPOSAL_EVENT_PATH } from "./canonical-finalize-service.js";
import {
  EventIdSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  KnowledgeRevisionPatchSchema,
  KnowledgeRevisionProposalSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  SeveritySchema,
  TransactionIdSchema,
  type KnowledgeCategory,
  type KnowledgeRevisionPatch,
  type KnowledgeRevisionProposal,
  type Severity,
} from "./domain-schemas.js";
import { createDomainId } from "./ids.js";
import {
  parseKnowledgeDocument,
  serializeKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

export interface ModelPlaneAddKnowledgeRequest {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly related_ids?: readonly string[];
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: Severity;
}

export interface ModelPlaneAddKnowledgeResult {
  readonly etag: string;
  readonly id: string;
  readonly origin: "manual";
  readonly repo: string;
  readonly revision: number;
  readonly status: "proposed";
}

export interface ModelPlaneUpdateKnowledgeRequest {
  readonly expected_etag: string;
  readonly expected_revision: number;
  readonly id: string;
  readonly patch: KnowledgeRevisionPatch;
}

export interface ModelPlaneUpdateKnowledgeResult {
  readonly current_etag: string;
  readonly current_revision: number;
  readonly knowledge_id: string;
  readonly proposal_id: string;
  readonly repo: string;
  readonly status: "pending";
}

export type ModelPlaneKnowledgeErrorCode =
  | "INVALID_KNOWLEDGE_STATE"
  | "KNOWLEDGE_NOT_FOUND"
  | "MODEL_PLANE_PROJECTION_INVALID";

export class ModelPlaneKnowledgeError extends Error {
  constructor(
    readonly code: ModelPlaneKnowledgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ModelPlaneKnowledgeError";
  }
}

export interface ModelPlaneKnowledgeServiceOptions {
  readonly nextEventId?: (timestamp: number) => string;
  readonly nextKnowledgeId?: (timestamp: number) => string;
  readonly nextProposalId?: (timestamp: number) => string;
  readonly nextTransactionId?: (timestamp: number) => string;
  readonly now?: () => Date;
  readonly proposalEventPath?: string;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: CanonicalTransactionStore;
}

interface OperationTime {
  readonly recordedAt: string;
  readonly timestamp: number;
}

/** Model-controlled mutations that can create proposals but never approve them. */
export class ModelPlaneKnowledgeService {
  readonly repo: string;
  readonly repoId: string;

  private readonly nextEventId: (timestamp: number) => string;
  private readonly nextKnowledgeId: (timestamp: number) => string;
  private readonly nextProposalId: (timestamp: number) => string;
  private readonly nextTransactionId: (timestamp: number) => string;
  private readonly now: () => Date;
  private readonly proposalEventPath: string;
  private readonly repository: CanonicalTransactionStore;

  constructor(options: ModelPlaneKnowledgeServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.nextEventId =
      options.nextEventId ??
      ((timestamp) => createDomainId("event", timestamp));
    this.nextKnowledgeId =
      options.nextKnowledgeId ??
      ((timestamp) => createDomainId("knowledge", timestamp));
    this.nextProposalId =
      options.nextProposalId ??
      ((timestamp) =>
        `proposal_${createDomainId("event", timestamp).slice(4)}`);
    this.nextTransactionId =
      options.nextTransactionId ??
      ((timestamp) => createDomainId("transaction", timestamp));
    this.proposalEventPath = canonicalProposalPath(
      options.proposalEventPath ?? REVISION_PROPOSAL_EVENT_PATH,
    );
  }

  async addKnowledge(
    request: ModelPlaneAddKnowledgeRequest,
  ): Promise<ModelPlaneAddKnowledgeResult> {
    const input = parseAddRequest(request);
    return this.repository.runLockedMutation((snapshot) => {
      const operation = operationTime(this.now());
      const knowledgeId = KnowledgeIdSchema.parse(
        this.nextKnowledgeId(operation.timestamp),
      );
      if (snapshot.domain.knowledge.some((item) => item.id === knowledgeId)) {
        throw modelError(
          "MODEL_PLANE_PROJECTION_INVALID",
          `generated knowledge ID ${knowledgeId} already exists`,
        );
      }
      assertRelatedKnowledge(snapshot, this.repoId, input.related_ids);

      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const path = `knowledge/${knowledgeId}.md`;
      const content = serializeKnowledgeDocument(
        path,
        {
          category: input.category,
          created_at: operation.recordedAt,
          id: knowledgeId,
          origin: { type: "manual" },
          related_ids: input.related_ids,
          repo_id: this.repoId,
          revision: 1,
          rule: input.rule,
          schema_version: 1,
          scope: input.scope,
          severity: input.severity,
          status: "proposed",
          updated_at: operation.recordedAt,
        },
        input.detail,
      );
      const document = parseKnowledgeDocument(path, content);
      return {
        transaction: {
          appendRecords: [],
          createdAt: operation.recordedAt,
          fileWrites: [{ content, expectedSha256: null, targetPath: path }],
          transactionId,
        },
        value: {
          etag: document.etag,
          id: knowledgeId,
          origin: "manual" as const,
          repo: this.repo,
          revision: document.revision,
          status: "proposed" as const,
        },
      };
    });
  }

  async updateKnowledge(
    request: ModelPlaneUpdateKnowledgeRequest,
  ): Promise<ModelPlaneUpdateKnowledgeResult> {
    const knowledgeId = KnowledgeIdSchema.parse(request.id);
    const expectedRevision = positiveRevision(request.expected_revision);
    const expectedEtag = exactEtag(request.expected_etag);
    const patch = KnowledgeRevisionPatchSchema.parse(request.patch);

    return this.repository.runLockedMutation((snapshot) => {
      const current = findCurrentKnowledge(snapshot, knowledgeId, this.repoId);
      assertExpectedGeneration(
        current.document,
        knowledgeId,
        expectedRevision,
        expectedEtag,
      );
      if (
        current.status !== "active" &&
        current.status !== "proposed" &&
        current.status !== "stale"
      ) {
        throw modelError(
          "INVALID_KNOWLEDGE_STATE",
          `knowledge ${knowledgeId} in ${current.status} state cannot receive an edit proposal`,
        );
      }

      const operation = operationTime(this.now(), current.updatedAt);
      const transactionId = TransactionIdSchema.parse(
        this.nextTransactionId(operation.timestamp),
      );
      const proposalId = NonEmptyStringSchema.parse(
        this.nextProposalId(operation.timestamp),
      );
      if (
        snapshot.domain.revisionProposals.some(
          (proposal) => proposal.proposal_id === proposalId,
        )
      ) {
        throw modelError(
          "MODEL_PLANE_PROJECTION_INVALID",
          `generated proposal ID ${proposalId} already exists`,
        );
      }
      const proposal = KnowledgeRevisionProposalSchema.parse({
        created_at: operation.recordedAt,
        evidence_ids: [],
        knowledge_id: knowledgeId,
        patch,
        proposal_id: proposalId,
        repo_id: this.repoId,
        status: "pending",
        updated_at: operation.recordedAt,
      });
      const event: CanonicalJsonlRecord<KnowledgeRevisionProposal> = {
        payload: proposal,
        record_id: EventIdSchema.parse(this.nextEventId(operation.timestamp)),
        record_type: "KnowledgeRevisionProposal",
        recorded_at: operation.recordedAt,
        schema_version: 1,
        transaction_id: transactionId,
      };
      return {
        transaction: {
          appendRecords: [
            { record: event, targetPath: this.proposalEventPath },
          ],
          createdAt: operation.recordedAt,
          fileWrites: [],
          transactionId,
        },
        value: {
          current_etag: current.document.etag,
          current_revision: current.document.revision,
          knowledge_id: knowledgeId,
          proposal_id: proposalId,
          repo: this.repo,
          status: "pending" as const,
        },
      };
    });
  }
}

function parseAddRequest(
  request: ModelPlaneAddKnowledgeRequest,
): Required<ModelPlaneAddKnowledgeRequest> {
  const patch = KnowledgeRevisionPatchSchema.parse({
    category: KnowledgeCategorySchema.parse(request.category),
    detail: request.detail,
    rule: request.rule,
    scope: request.scope,
    severity: SeveritySchema.parse(request.severity),
  });
  return {
    category: patch.category!,
    detail: patch.detail!,
    related_ids: sortAndDedupeStrings(
      (request.related_ids ?? []).map((id) => KnowledgeIdSchema.parse(id)),
    ),
    rule: patch.rule!,
    scope: patch.scope!,
    severity: patch.severity!,
  };
}

function assertRelatedKnowledge(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  relatedIds: readonly string[],
): void {
  for (const relatedId of relatedIds) {
    const related = snapshot.domain.knowledge.find(
      (item) => item.id === relatedId && item.repoId === repoId,
    );
    if (
      related === undefined ||
      related.status === "deprecated" ||
      related.status === "rejected"
    ) {
      throw modelError(
        "KNOWLEDGE_NOT_FOUND",
        `related knowledge ${relatedId} is not available in this repository`,
      );
    }
  }
}

function findCurrentKnowledge(
  snapshot: CanonicalProjectionSnapshot,
  knowledgeId: string,
  repoId: string,
): {
  readonly document: KnowledgeDocument;
  readonly status: string;
  readonly updatedAt: string;
} {
  const projected = snapshot.domain.knowledge.find(
    (item) => item.id === knowledgeId && item.repoId === repoId,
  );
  if (projected === undefined) {
    throw modelError(
      "KNOWLEDGE_NOT_FOUND",
      `knowledge ${knowledgeId} was not found in this repository`,
    );
  }
  const document = snapshot.knowledge.find(
    (item) =>
      item.path === projected.path && item.frontmatter.id === projected.id,
  );
  if (document === undefined) {
    throw modelError(
      "MODEL_PLANE_PROJECTION_INVALID",
      `knowledge ${knowledgeId} has no matching canonical Markdown`,
    );
  }
  return {
    document,
    status: projected.status,
    updatedAt: projected.updatedAt,
  };
}

function assertExpectedGeneration(
  current: KnowledgeDocument,
  knowledgeId: string,
  expectedRevision: number,
  expectedEtag: string,
): void {
  if (
    current.frontmatter.id !== knowledgeId ||
    current.revision !== expectedRevision ||
    current.etag !== expectedEtag
  ) {
    throw new KnowledgeConflictError(current);
  }
}

function positiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expected_revision must be a positive safe integer");
  }
  return value;
}

function exactEtag(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(
      "expected_etag must be the lowercase SHA-256 of the exact Markdown bytes",
    );
  }
  return value;
}

function canonicalProposalPath(value: string): string {
  const path = NonEmptyStringSchema.parse(value);
  if (!/^events\/(?!.*(?:^|\/)\.\.?\/)[^/]+\.jsonl$/u.test(path)) {
    throw new TypeError(
      "proposalEventPath must be a direct events/*.jsonl path",
    );
  }
  return path;
}

function operationTime(now: Date, floor?: string): OperationTime {
  const clock = now.getTime();
  if (!Number.isSafeInteger(clock) || clock < 0) {
    throw new TypeError("now() returned an invalid Date");
  }
  const timestamp = Math.max(
    clock,
    floor === undefined ? 0 : Date.parse(floor),
  );
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("knowledge timestamp is invalid");
  }
  return { recordedAt: new Date(timestamp).toISOString(), timestamp };
}

function modelError(
  code: ModelPlaneKnowledgeErrorCode,
  message: string,
  cause?: unknown,
): ModelPlaneKnowledgeError {
  return new ModelPlaneKnowledgeError(code, message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

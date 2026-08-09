import { z } from "zod";

import {
  AdminPlaneError,
  type AdminEvidenceReview,
  type AdminKnowledgeReview,
  type AdminRevisionProposalReview,
} from "./admin-plane-service.js";
import {
  canonicalizeJson,
  compareCodeUnits,
  sha256Jcs,
  sortAndDedupeStrings,
} from "./canonical.js";
import {
  EvidenceActorSchema,
  EvidenceIdSchema,
  EvidenceStatusSchema,
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  KnowledgeRevisionPatchSchema,
  KnowledgeStatusSchema,
  NonEmptyStringSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
  SeveritySchema,
  SourceProviderSchema,
  TrustLevelSchema,
  type KnowledgeEvidence,
  type KnowledgeRevisionProposal,
  type Severity,
} from "./domain-schemas.js";
import type { ProjectedKnowledge } from "./domain-projection.js";
import type { KnowledgeDocument } from "./knowledge-document.js";
import type {
  CanonicalKnowledgeReadView,
  CanonicalProjectionSnapshot,
} from "./sqlite-projection.js";

export const DEFAULT_REVIEW_INBOX_LIMIT = 20;
export const MAX_REVIEW_INBOX_LIMIT = 100;
export const DEFAULT_REVIEW_INBOX_PROJECTION_RETRIES = 2;

export const ReviewInboxKindSchema = z.enum(["knowledge", "revision_proposal"]);

const ReviewInboxEvidenceSchema = z
  .object({
    actors: z.array(EvidenceActorSchema).min(1),
    comment_ids: z.array(NonEmptyStringSchema).min(1),
    evidence_id: EvidenceIdSchema,
    observed_at: IsoDateTimeSchema,
    originator: EvidenceActorSchema,
    sources: z.array(SourceProviderSchema).min(1),
    status: EvidenceStatusSchema,
    url: z.url().optional(),
  })
  .strict();

const ReviewInboxPossibleMatchSchema = z
  .object({
    etag: NonEmptyStringSchema,
    id: KnowledgeIdSchema,
    revision: z.number().int().positive(),
    rule: NonEmptyStringSchema,
    scope: z.array(NonEmptyStringSchema),
    severity: SeveritySchema,
    status: KnowledgeStatusSchema,
  })
  .strict();

const ReviewInboxItemBaseShape = {
  category: KnowledgeCategorySchema,
  created_at: IsoDateTimeSchema,
  detail: z.string(),
  etag: NonEmptyStringSchema,
  evidence: z.array(ReviewInboxEvidenceSchema),
  item_id: NonEmptyStringSchema,
  knowledge_id: KnowledgeIdSchema,
  knowledge_status: KnowledgeStatusSchema,
  origin: z.record(z.string(), z.unknown()).nullable(),
  possible_matches: z.array(ReviewInboxPossibleMatchSchema),
  related_ids: z.array(KnowledgeIdSchema),
  revision: z.number().int().positive(),
  rule: NonEmptyStringSchema,
  scope: z.array(NonEmptyStringSchema),
  severity: SeveritySchema,
  sources: z.array(SourceProviderSchema),
  trust_classes: z.array(TrustLevelSchema),
  updated_at: IsoDateTimeSchema,
};

export const ReviewInboxItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...ReviewInboxItemBaseShape,
      kind: z.literal("knowledge"),
      proposal_id: z.null(),
      proposal_patch: z.null(),
      status: z.enum(["proposed", "stale"]),
    })
    .strict(),
  z
    .object({
      ...ReviewInboxItemBaseShape,
      kind: z.literal("revision_proposal"),
      proposal_id: NonEmptyStringSchema,
      proposal_patch: KnowledgeRevisionPatchSchema,
      status: z.literal("pending"),
    })
    .strict(),
]);

export const ReviewInboxRequestSchema = z
  .object({
    cursor: NonEmptyStringSchema.optional(),
    kind: ReviewInboxKindSchema.optional(),
    limit: z.number().int().positive().max(MAX_REVIEW_INBOX_LIMIT).optional(),
    severity: SeveritySchema.optional(),
    source: SourceProviderSchema.optional(),
  })
  .strict();

export const ReviewInboxResultSchema = z
  .object({
    items: z.array(ReviewInboxItemSchema),
    next_cursor: z.string().nullable(),
    repo: RepositoryNameSchema,
    total_count: z.number().int().nonnegative(),
  })
  .strict();

const ReviewInboxCursorSchema = z
  .object({
    canonical_digest: z.string().regex(/^[a-f0-9]{64}$/u),
    created_at: IsoDateTimeSchema,
    filter_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    item_id: NonEmptyStringSchema,
    kind: ReviewInboxKindSchema,
    repo_id: RepositoryIdSchema,
    version: z.literal(1),
  })
  .strict();

export type ReviewInboxKind = z.infer<typeof ReviewInboxKindSchema>;
export type ReviewInboxItem = z.infer<typeof ReviewInboxItemSchema>;
export type ReviewInboxRequest = z.input<typeof ReviewInboxRequestSchema>;
export type ReviewInboxResult = z.infer<typeof ReviewInboxResultSchema>;

type ParsedReviewInboxRequest = z.output<typeof ReviewInboxRequestSchema>;
type ReviewInboxCursor = z.infer<typeof ReviewInboxCursorSchema>;
type SourceProvider = KnowledgeEvidence["sources"][number];

export type ReviewInboxErrorCode =
  | "INVALID_REVIEW_INBOX_CURSOR"
  | "INVALID_REVIEW_INBOX_REQUEST"
  | "REVIEW_INBOX_CURSOR_STALE"
  | "REVIEW_INBOX_PROJECTION_CHANGED"
  | "REVIEW_INBOX_PROJECTION_INVALID";

export class ReviewInboxError extends Error {
  constructor(
    readonly code: ReviewInboxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReviewInboxError";
  }
}

export interface ReviewInboxRepository {
  readKnowledgeView(): Promise<CanonicalKnowledgeReadView>;
}

export interface ReviewInboxDetailReader {
  getKnowledgeReview(id: string): Promise<AdminKnowledgeReview>;
  getRevisionProposalReview(
    proposalId: string,
  ): Promise<AdminRevisionProposalReview>;
}

export interface ReviewInboxServiceOptions {
  readonly details: ReviewInboxDetailReader;
  readonly maxProjectionRetries?: number;
  readonly repo: string;
  readonly repoId: string;
  readonly repository: ReviewInboxRepository;
}

interface InboxDescriptorBase {
  readonly createdAt: string;
  readonly evidence: readonly KnowledgeEvidence[];
  readonly itemId: string;
  readonly knowledge: ProjectedKnowledge;
  readonly sources: readonly SourceProvider[];
  readonly updatedAt: string;
}

interface KnowledgeInboxDescriptor extends InboxDescriptorBase {
  readonly kind: "knowledge";
  readonly knowledge: ProjectedKnowledge & {
    readonly status: "proposed" | "stale";
  };
  readonly severity: Severity;
}

interface RevisionInboxDescriptor extends InboxDescriptorBase {
  readonly kind: "revision_proposal";
  readonly proposal: KnowledgeRevisionProposal & { readonly status: "pending" };
  readonly severity: Severity;
}

type InboxDescriptor = KnowledgeInboxDescriptor | RevisionInboxDescriptor;

/**
 * Read-only, cursor-paginated projection over every item awaiting a personal
 * admin decision. Detail rendering is delegated to the existing admin read
 * plane, while digest checks ensure a page never combines two generations.
 */
export class ReviewInboxService {
  readonly repo: string;
  readonly repoId: string;

  private readonly details: ReviewInboxDetailReader;
  private readonly maxProjectionRetries: number;
  private readonly repository: ReviewInboxRepository;

  constructor(options: ReviewInboxServiceOptions) {
    this.repo = RepositoryNameSchema.parse(options.repo);
    this.repoId = RepositoryIdSchema.parse(options.repoId);
    this.details = options.details;
    this.repository = options.repository;
    this.maxProjectionRetries = parseProjectionRetries(
      options.maxProjectionRetries ?? DEFAULT_REVIEW_INBOX_PROJECTION_RETRIES,
    );
  }

  async list(request: ReviewInboxRequest = {}): Promise<ReviewInboxResult> {
    const parsed = parseRequest(request);
    const filterSha256 = reviewInboxFilterDigest(parsed);
    const cursor =
      parsed.cursor === undefined
        ? null
        : decodeReviewInboxCursor(parsed.cursor, this.repoId, filterSha256);

    for (let attempt = 0; attempt <= this.maxProjectionRetries; attempt += 1) {
      const initial = (await this.repository.readKnowledgeView()).snapshot;
      assertCursorGeneration(cursor, initial.canonicalDigest);
      try {
        const result = await this.readPage(
          initial,
          parsed,
          filterSha256,
          cursor,
        );
        const final = (await this.repository.readKnowledgeView()).snapshot;
        if (final.canonicalDigest === initial.canonicalDigest) return result;
        if (cursor !== null) throw staleCursor();
      } catch (error) {
        if (
          error instanceof ReviewInboxError &&
          error.code !== "REVIEW_INBOX_PROJECTION_INVALID"
        ) {
          throw error;
        }
        const final = (await this.repository.readKnowledgeView()).snapshot;
        if (final.canonicalDigest === initial.canonicalDigest) {
          if (error instanceof ReviewInboxError) throw error;
          throw projectionInvalid(error);
        }
        if (cursor !== null) throw staleCursor();
      }
    }
    throw new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_CHANGED",
      "canonical state changed repeatedly while the review inbox page was rendered; retry from the first page",
    );
  }

  private async readPage(
    snapshot: CanonicalProjectionSnapshot,
    request: ParsedReviewInboxRequest,
    filterSha256: string,
    cursor: ReviewInboxCursor | null,
  ): Promise<ReviewInboxResult> {
    const filtered = collectInboxDescriptors(snapshot, this.repoId).filter(
      (descriptor) => matchesRequest(descriptor, request),
    );
    const afterCursor =
      cursor === null
        ? filtered
        : filtered.filter(
            (descriptor) => compareDescriptorCursor(descriptor, cursor) > 0,
          );
    const limit = request.limit ?? DEFAULT_REVIEW_INBOX_LIMIT;
    const page = afterCursor.slice(0, limit);
    const items: ReviewInboxItem[] = [];
    for (const descriptor of page) {
      items.push(await this.hydrate(descriptor));
    }
    const nextCursor =
      afterCursor.length > limit
        ? encodeReviewInboxCursor(
            page.at(-1)!,
            snapshot.canonicalDigest,
            filterSha256,
            this.repoId,
          )
        : null;
    return ReviewInboxResultSchema.parse({
      items,
      next_cursor: nextCursor,
      repo: this.repo,
      total_count: filtered.length,
    });
  }

  private async hydrate(descriptor: InboxDescriptor): Promise<ReviewInboxItem> {
    if (descriptor.kind === "knowledge") {
      const review = await this.details.getKnowledgeReview(
        descriptor.knowledge.id,
      );
      assertKnowledgeBinding(review, descriptor);
      return ReviewInboxItemSchema.parse({
        ...reviewItemBase(
          review,
          descriptor.evidence,
          descriptor.createdAt,
          descriptor.updatedAt,
        ),
        item_id: descriptor.itemId,
        kind: "knowledge",
        knowledge_status: descriptor.knowledge.status,
        proposal_id: null,
        proposal_patch: null,
        status: descriptor.knowledge.status,
      });
    }

    const review = await this.details.getRevisionProposalReview(
      descriptor.proposal.proposal_id,
    );
    assertRevisionBinding(review, descriptor);
    const patch = review.proposal.patch;
    return ReviewInboxItemSchema.parse({
      ...reviewItemBase(
        review.knowledge,
        descriptor.evidence,
        descriptor.createdAt,
        descriptor.updatedAt,
      ),
      category: patch.category ?? review.knowledge.category,
      detail: patch.detail ?? review.knowledge.detail,
      item_id: descriptor.itemId,
      kind: "revision_proposal",
      knowledge_status: review.knowledge.status,
      proposal_id: descriptor.proposal.proposal_id,
      proposal_patch: patch,
      rule: patch.rule ?? review.knowledge.rule,
      scope: patch.scope ?? review.knowledge.scope,
      severity: patch.severity ?? review.knowledge.severity,
      status: "pending",
    });
  }
}

function collectInboxDescriptors(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
): InboxDescriptor[] {
  const knowledgeById = new Map(
    snapshot.domain.knowledge
      .filter((knowledge) => knowledge.repoId === repoId)
      .map((knowledge) => [knowledge.id, knowledge]),
  );
  const documentById = new Map(
    snapshot.knowledge
      .filter((document) => document.frontmatter.repo_id === repoId)
      .map((document) => [document.frontmatter.id, document]),
  );
  const evidenceByKnowledge = groupBy(
    snapshot.domain.evidence.filter((evidence) => evidence.repo_id === repoId),
    (evidence) => evidence.knowledge_id,
  );
  const evidenceById = new Map(
    snapshot.domain.evidence
      .filter((evidence) => evidence.repo_id === repoId)
      .map((evidence) => [evidence.evidence_id, evidence]),
  );
  const descriptors: InboxDescriptor[] = [];

  for (const knowledge of knowledgeById.values()) {
    if (!isInboxKnowledge(knowledge)) continue;
    assertDocumentBinding(documentById, knowledge);
    const evidence = evidenceByKnowledge.get(knowledge.id) ?? [];
    descriptors.push({
      createdAt: knowledge.createdAt,
      evidence,
      itemId: knowledge.id,
      kind: "knowledge",
      knowledge,
      severity: knowledge.severity,
      sources: evidenceSources(evidence),
      updatedAt: knowledge.updatedAt,
    });
  }

  for (const proposal of snapshot.domain.revisionProposals) {
    if (proposal.repo_id !== repoId || !isPendingProposal(proposal)) continue;
    const knowledge = knowledgeById.get(proposal.knowledge_id);
    if (knowledge === undefined) {
      throw new ReviewInboxError(
        "REVIEW_INBOX_PROJECTION_INVALID",
        `pending revision proposal ${proposal.proposal_id} targets missing knowledge ${proposal.knowledge_id}`,
      );
    }
    assertDocumentBinding(documentById, knowledge);
    const evidence = proposal.evidence_ids.map((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      if (item === undefined || item.knowledge_id !== proposal.knowledge_id) {
        throw new ReviewInboxError(
          "REVIEW_INBOX_PROJECTION_INVALID",
          `pending revision proposal ${proposal.proposal_id} references missing or foreign evidence ${evidenceId}`,
        );
      }
      return item;
    });
    descriptors.push({
      createdAt: proposal.created_at,
      evidence,
      itemId: proposal.proposal_id,
      kind: "revision_proposal",
      knowledge,
      proposal,
      severity: proposal.patch.severity ?? knowledge.severity,
      sources: evidenceSources(evidence),
      updatedAt: proposal.updated_at,
    });
  }

  return descriptors.sort(compareDescriptors);
}

function assertDocumentBinding(
  documents: ReadonlyMap<string, KnowledgeDocument>,
  knowledge: ProjectedKnowledge,
): void {
  const document = documents.get(knowledge.id);
  if (
    document === undefined ||
    document.path !== knowledge.path ||
    document.revision !== knowledge.revision
  ) {
    throw new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_INVALID",
      `knowledge ${knowledge.id} has no matching canonical document`,
    );
  }
}

function matchesRequest(
  descriptor: InboxDescriptor,
  request: ParsedReviewInboxRequest,
): boolean {
  return (
    (request.kind === undefined || descriptor.kind === request.kind) &&
    (request.severity === undefined ||
      descriptor.severity === request.severity) &&
    (request.source === undefined ||
      descriptor.sources.includes(request.source))
  );
}

function compareDescriptors(
  left: InboxDescriptor,
  right: InboxDescriptor,
): number {
  return (
    compareCodeUnits(left.createdAt, right.createdAt) ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.itemId, right.itemId)
  );
}

function compareDescriptorCursor(
  descriptor: InboxDescriptor,
  cursor: ReviewInboxCursor,
): number {
  return (
    compareCodeUnits(descriptor.createdAt, cursor.created_at) ||
    compareCodeUnits(descriptor.kind, cursor.kind) ||
    compareCodeUnits(descriptor.itemId, cursor.item_id)
  );
}

function reviewItemBase(
  review: AdminKnowledgeReview,
  evidence: readonly KnowledgeEvidence[],
  createdAt: string,
  updatedAt: string,
) {
  const selectedIds = new Set(evidence.map((item) => item.evidence_id));
  const selectedEvidence = review.evidence.filter((item) =>
    selectedIds.has(item.evidence_id),
  );
  if (selectedEvidence.length !== evidence.length) {
    throw new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_INVALID",
      `knowledge ${review.id} review omitted evidence required by the inbox item`,
    );
  }
  return {
    category: review.category,
    created_at: createdAt,
    detail: review.detail,
    etag: review.etag,
    evidence: selectedEvidence,
    knowledge_id: review.id,
    origin: review.origin,
    possible_matches: review.possible_matches,
    related_ids: review.related_ids,
    revision: review.revision,
    rule: review.rule,
    scope: review.scope,
    severity: review.severity,
    sources: evidenceSources(evidence),
    trust_classes: trustClasses(selectedEvidence),
    updated_at: updatedAt,
  };
}

function isInboxKnowledge(
  knowledge: ProjectedKnowledge,
): knowledge is ProjectedKnowledge & {
  readonly status: "proposed" | "stale";
} {
  return knowledge.status === "proposed" || knowledge.status === "stale";
}

function isPendingProposal(
  proposal: KnowledgeRevisionProposal,
): proposal is KnowledgeRevisionProposal & { readonly status: "pending" } {
  return proposal.status === "pending";
}

function assertKnowledgeBinding(
  review: AdminKnowledgeReview,
  descriptor: KnowledgeInboxDescriptor,
): void {
  if (
    review.id !== descriptor.knowledge.id ||
    review.etag !== descriptor.knowledge.etag ||
    review.revision !== descriptor.knowledge.revision ||
    review.status !== descriptor.knowledge.status
  ) {
    throw new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_INVALID",
      `knowledge ${descriptor.knowledge.id} changed while its inbox item was rendered`,
    );
  }
}

function assertRevisionBinding(
  review: AdminRevisionProposalReview,
  descriptor: RevisionInboxDescriptor,
): void {
  if (
    review.proposal.proposal_id !== descriptor.proposal.proposal_id ||
    review.proposal.status !== "pending" ||
    review.knowledge.id !== descriptor.knowledge.id ||
    review.knowledge.etag !== descriptor.knowledge.etag ||
    review.knowledge.revision !== descriptor.knowledge.revision ||
    canonicalizeJson(review.proposal) !== canonicalizeJson(descriptor.proposal)
  ) {
    throw new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_INVALID",
      `revision proposal ${descriptor.proposal.proposal_id} changed while its inbox item was rendered`,
    );
  }
}

function evidenceSources(
  evidence: readonly KnowledgeEvidence[],
): readonly SourceProvider[] {
  return sortAndDedupeStrings(
    evidence.flatMap((item) => item.sources),
  ) as SourceProvider[];
}

function trustClasses(
  evidence: readonly AdminEvidenceReview[],
): ReviewInboxItem["trust_classes"] {
  return sortAndDedupeStrings(
    evidence.flatMap((item) => [
      item.originator.trust,
      ...item.actors.map((actor) => actor.trust),
    ]),
  ) as ReviewInboxItem["trust_classes"];
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const existing = result.get(key(value));
    if (existing === undefined) result.set(key(value), [value]);
    else existing.push(value);
  }
  return result;
}

function parseRequest(request: ReviewInboxRequest): ParsedReviewInboxRequest {
  const parsed = ReviewInboxRequestSchema.safeParse(request);
  if (parsed.success) return parsed.data;
  throw new ReviewInboxError(
    "INVALID_REVIEW_INBOX_REQUEST",
    parsed.error.message,
    { cause: parsed.error },
  );
}

function reviewInboxFilterDigest(request: ParsedReviewInboxRequest): string {
  return sha256Jcs({
    kind: request.kind ?? null,
    severity: request.severity ?? null,
    source: request.source ?? null,
  });
}

function encodeReviewInboxCursor(
  descriptor: InboxDescriptor,
  canonicalDigest: string,
  filterSha256: string,
  repoId: string,
): string {
  return Buffer.from(
    JSON.stringify(
      ReviewInboxCursorSchema.parse({
        canonical_digest: canonicalDigest,
        created_at: descriptor.createdAt,
        filter_sha256: filterSha256,
        item_id: descriptor.itemId,
        kind: descriptor.kind,
        repo_id: repoId,
        version: 1,
      }),
    ),
    "utf8",
  ).toString("base64url");
}

function decodeReviewInboxCursor(
  cursor: string,
  repoId: string,
  filterSha256: string,
): ReviewInboxCursor {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(cursor, "base64url"),
      ),
    ) as unknown;
  } catch (error) {
    throw invalidCursor("cursor is not valid base64url UTF-8 JSON", error);
  }
  const parsed = ReviewInboxCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidCursor(parsed.error.message, parsed.error);
  }
  if (
    parsed.data.repo_id !== repoId ||
    parsed.data.filter_sha256 !== filterSha256
  ) {
    throw invalidCursor(
      "cursor belongs to another repository or filter combination",
    );
  }
  return parsed.data;
}

function assertCursorGeneration(
  cursor: ReviewInboxCursor | null,
  canonicalDigest: string,
): void {
  if (cursor !== null && cursor.canonical_digest !== canonicalDigest) {
    throw staleCursor();
  }
}

function invalidCursor(message: string, cause?: unknown): ReviewInboxError {
  return new ReviewInboxError("INVALID_REVIEW_INBOX_CURSOR", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function staleCursor(): ReviewInboxError {
  return new ReviewInboxError(
    "REVIEW_INBOX_CURSOR_STALE",
    "canonical inbox state changed after this cursor was issued; restart from the first page",
  );
}

function projectionInvalid(error: unknown): ReviewInboxError {
  if (error instanceof AdminPlaneError) {
    return new ReviewInboxError(
      "REVIEW_INBOX_PROJECTION_INVALID",
      error.message,
      { cause: error },
    );
  }
  return new ReviewInboxError(
    "REVIEW_INBOX_PROJECTION_INVALID",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function parseProjectionRetries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    throw new TypeError("maxProjectionRetries must be between 0 and 10");
  }
  return value;
}

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import { type CanonicalFileWriteRequest } from "./canonical-transaction-store.js";
import { evaluateCodeExampleGrounding } from "./code-example-grounding.js";
import {
  IsoDateTimeSchema,
  KnowledgeEvidenceSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  type CommentObservation,
  type DistilledCandidate,
  type EvidenceActor,
  type ExtractCandidate,
  type KnowledgeEvidence,
  type KnowledgeRevisionPatch,
  type ThreadObservation,
} from "./domain-schemas.js";
import { renderKnowledgeBodyWithCodeExample } from "./knowledge-code-example.js";
import {
  applyKnowledgeDocumentPatch,
  serializeKnowledgeDocument,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import type { DistillationProvenance } from "./provider-distillation-service.js";
import type { CanonicalProjectionSnapshot } from "./sqlite-projection.js";

import {
  CanonicalFinalizeError,
  type CanonicalFinalizeSourceBinding,
  type OperationTime,
  type NewAssignedCandidate,
  type AssignedCandidate,
  type EvidenceGroup,
  type PlannedEvidenceLifecycle,
} from "./canonical-finalize-types.js";

export function evidenceGroups(
  assigned: readonly AssignedCandidate[],
): EvidenceGroup[] {
  const commentsByKnowledge = new Map<string, string[]>();
  for (const entry of assigned) {
    const comments = commentsByKnowledge.get(entry.knowledgeId) ?? [];
    comments.push(...entry.candidate.candidate.evidence_comment_ids);
    commentsByKnowledge.set(entry.knowledgeId, comments);
  }
  return [...commentsByKnowledge]
    .map(([knowledgeId, commentIds]) => ({
      commentIds: sortAndDedupeStrings(commentIds),
      knowledgeId,
    }))
    .sort((left, right) =>
      compareCodeUnits(left.knowledgeId, right.knowledgeId),
    );
}

export function isNewAssignedCandidate(
  entry: AssignedCandidate,
): entry is NewAssignedCandidate {
  return entry.createsKnowledge;
}

export function buildActiveEvidence(input: {
  readonly commentIds: readonly string[];
  readonly comments: readonly CommentObservation[];
  readonly evidenceId: string;
  readonly knowledgeId: string;
  readonly previous: KnowledgeEvidence | undefined;
  readonly repoId: string;
  readonly thread: ThreadObservation;
}): KnowledgeEvidence {
  const commentById = new Map(
    input.comments.map((comment) => [comment.comment_id, comment]),
  );
  const selected = input.commentIds.map((id) => commentById.get(id)!);
  const originatorComment = input.comments[0]!;
  const actors = selected.map(evidenceActor).sort(compareEvidenceActors);
  const originator = evidenceActor(originatorComment);
  return KnowledgeEvidenceSchema.parse({
    actors,
    ...(originatorComment.actor.author_association === undefined
      ? {}
      : {
          author_association: originatorComment.actor.author_association,
        }),
    comment_ids: input.commentIds,
    content_fingerprint: input.thread.content_fingerprint,
    eligible_for_count: true,
    evidence_id: input.evidenceId,
    knowledge_id: input.knowledgeId,
    observed_at: input.thread.observed_at,
    occurrence_key: `${input.knowledgeId}:${input.thread.thread_id}`,
    originator,
    ...(input.thread.path === undefined ? {} : { path: input.thread.path }),
    pr_number: input.thread.pr_number,
    repo_id: input.repoId,
    sources: sortAndDedupeStrings(actors.map((actor) => actor.provider)),
    state_fingerprint: input.thread.state_fingerprint,
    status: "active",
    ...(input.previous === undefined
      ? {}
      : { supersedes: input.previous.evidence_id }),
    thread_id: input.thread.thread_id,
    url: originatorComment.url,
  });
}

function evidenceActor(comment: CommentObservation): EvidenceActor {
  return {
    actor_kind: comment.actor.actor_kind,
    comment_id: comment.comment_id,
    provider: comment.actor.provider,
    trust: comment.actor.trust,
    ...(comment.actor.actor_id === undefined
      ? {}
      : { actor_id: comment.actor.actor_id }),
    ...(comment.actor.login === null ? {} : { login: comment.actor.login }),
  };
}

function compareEvidenceActors(
  left: EvidenceActor,
  right: EvidenceActor,
): number {
  return compareCodeUnits(left.comment_id, right.comment_id);
}

export function compareComments(
  left: CommentObservation,
  right: CommentObservation,
): number {
  return (
    compareCodeUnits(left.created_at, right.created_at) ||
    compareCodeUnits(left.comment_id, right.comment_id)
  );
}

export function validateCandidateEvidenceComments(
  candidates: readonly ExtractCandidate[],
  thread: ThreadObservation,
  comments: readonly CommentObservation[],
): void {
  validateEvidenceCommentIds(
    candidates.flatMap((candidate) => [
      ...candidate.candidate.evidence_comment_ids,
      ...(candidate.candidate.code_example?.evidence_comment_ids ?? []),
    ]),
    thread,
    comments,
  );
  const sources = comments.map((comment) => ({
    body: comment.body,
    ...(comment.diff_hunk === undefined ? {} : { diffHunk: comment.diff_hunk }),
    id: comment.comment_id,
  }));
  for (const candidate of candidates) {
    const example = candidate.candidate.code_example;
    if (example === undefined) continue;
    const grounding = evaluateCodeExampleGrounding(example, sources);
    if (!grounding.grounded) {
      throw new CanonicalFinalizeError(
        "EVIDENCE_COMMENTS_INVALID",
        `code_example content references tokens absent from its cited evidence: ${grounding.ungrounded_tokens.join(
          ", ",
        )}`,
      );
    }
  }
}

export function validateEvidenceCommentIds(
  values: readonly string[],
  thread: ThreadObservation,
  comments: readonly CommentObservation[],
): void {
  const currentIds = new Set(comments.map((comment) => comment.comment_id));
  const invalid = sortAndDedupeStrings(values).filter(
    (id) => !thread.comment_ids.includes(id) || !currentIds.has(id),
  );
  if (invalid.length > 0) {
    throw new CanonicalFinalizeError(
      "EVIDENCE_COMMENTS_INVALID",
      `evidence comments are outside the current snapshot: ${invalid.join(", ")}`,
    );
  }
}

export function newKnowledgeFileWrite(
  entry: NewAssignedCandidate,
  recordedAt: string,
  provenance: DistillationProvenance,
  repoId: string,
  transactionId: string,
): CanonicalFileWriteRequest {
  const path = `knowledge/${entry.knowledgeId}.md`;
  const candidate = entry.candidate.candidate;
  return {
    content: serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: candidate.category,
        created_at: recordedAt,
        id: entry.knowledgeId,
        last_automatic_update: {
          at: recordedAt,
          transaction_id: transactionId,
        },
        origin: {
          model: provenance.model,
          output_schema_digest: provenance.output_schema_digest,
          output_schema_version: provenance.output_schema_version,
          prompt_digest: provenance.prompt_digest,
          prompt_version: provenance.prompt_version,
          provider: provenance.provider,
          trust_policy_digest: provenance.trust_policy_digest,
          type: "distilled",
        },
        related_ids: entry.relatedIds,
        repo_id: repoId,
        revision: 1,
        rule: candidate.rule,
        schema_version: 1,
        scope: candidate.scope,
        severity: candidate.severity,
        status: entry.initialStatus,
        updated_at: recordedAt,
      },
      renderDistilledCandidateBody(candidate),
    ),
    expectedSha256: null,
    targetPath: path,
  };
}

/**
 * Renders the canonical Markdown body for a distilled candidate. A grounded
 * code example is appended below the detail with its `generated_example: true`
 * flag and evidence comment IDs, so the knowledge file keeps the §6.2 M2
 * grounding constraints visible after finalize. Same-merge decisions reuse
 * this rendering inside the revision proposal patch, which also removes a
 * previously stored example whenever the redistilled candidate no longer
 * grounds one.
 */
export function renderDistilledCandidateBody(
  candidate: DistilledCandidate,
): string {
  return renderKnowledgeBodyWithCodeExample(
    candidate.detail,
    candidate.code_example,
  );
}

export function revisionPatch(
  entry: ExtractCandidate,
  target: CanonicalProjectionSnapshot["domain"]["knowledge"][number],
): KnowledgeRevisionPatch | null {
  const candidate = entry.candidate;
  const renderedDetail = renderDistilledCandidateBody(candidate);
  const patch: Record<string, unknown> = {};
  if (candidate.category !== target.category)
    patch.category = candidate.category;
  if (
    comparableMarkdown(renderedDetail) !== comparableMarkdown(target.detail)
  ) {
    patch.detail = renderedDetail;
  }
  if (candidate.rule !== target.rule) patch.rule = candidate.rule;
  if (canonicalizeJson(candidate.scope) !== canonicalizeJson(target.scope)) {
    patch.scope = candidate.scope;
  }
  if (candidate.severity !== target.severity)
    patch.severity = candidate.severity;
  return Object.keys(patch).length === 0
    ? null
    : (patch as KnowledgeRevisionPatch);
}

function comparableMarkdown(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

export function staleKnowledgeFileWrites(
  knowledgeIds: readonly string[],
  snapshot: CanonicalProjectionSnapshot,
  recordedAt: string,
  transactionId: string,
): CanonicalFileWriteRequest[] {
  const documents = knowledgeDocumentsById(snapshot);
  return knowledgeIds.map((knowledgeId) => {
    const current = documents.get(knowledgeId)!;
    return {
      content: applyKnowledgeDocumentPatch(current, {
        frontmatter: {
          last_automatic_update: {
            at: recordedAt,
            transaction_id: transactionId,
          },
          status: "stale",
          updated_at: recordedAt,
        },
      }),
      expectedSha256: current.etag,
      targetPath: current.path,
    };
  });
}

function knowledgeDocumentsById(
  snapshot: CanonicalProjectionSnapshot,
): Map<string, KnowledgeDocument> {
  return new Map(
    snapshot.knowledge.map((document) => [
      NonEmptyStringSchema.parse(document.frontmatter.id),
      document,
    ]),
  );
}

export function currentActiveEvidence(
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  threadId: string,
): KnowledgeEvidence[] {
  return snapshot.domain.evidence
    .filter(
      (evidence) =>
        evidence.repo_id === repoId &&
        evidence.thread_id === threadId &&
        evidence.status === "active",
    )
    .sort((left, right) =>
      compareCodeUnits(left.evidence_id, right.evidence_id),
    );
}

export function hasActiveEvidenceAfter(
  knowledgeId: string,
  snapshot: CanonicalProjectionSnapshot,
  repoId: string,
  currentThreadId: string,
  replacementKnowledgeIds: ReadonlySet<string>,
): boolean {
  if (replacementKnowledgeIds.has(knowledgeId)) return true;
  return snapshot.domain.evidence.some(
    (evidence) =>
      evidence.repo_id === repoId &&
      evidence.knowledge_id === knowledgeId &&
      evidence.thread_id !== currentThreadId &&
      evidence.status === "active",
  );
}

export function isAutomaticStaleCandidate(
  knowledgeId: string,
  snapshot: CanonicalProjectionSnapshot,
): boolean {
  const document = knowledgeDocumentsById(snapshot).get(knowledgeId);
  const projected = snapshot.domain.knowledge.find(
    (knowledge) => knowledge.id === knowledgeId,
  );
  if (
    document === undefined ||
    projected === undefined ||
    (projected.status !== "active" && projected.status !== "proposed")
  ) {
    return false;
  }
  const activation = asRecord(document.frontmatter.activation);
  if (activation?.origin === "human" || activation?.pinned === true)
    return false;
  const origin = asRecord(document.frontmatter.origin);
  return activation?.origin === "automatic" || origin?.type === "distilled";
}

export function emptyEvidenceLifecycle(): PlannedEvidenceLifecycle {
  return {
    active: [],
    records: [],
    staleKnowledgeIds: [],
    withdrawnEvidenceIds: [],
  };
}

export function parseSourceBinding(
  request: CanonicalFinalizeSourceBinding,
): CanonicalFinalizeSourceBinding {
  return {
    content_fingerprint: Sha256DigestSchema.parse(request.content_fingerprint),
    distillation_key: Sha256DigestSchema.parse(request.distillation_key),
    thread_id: NonEmptyStringSchema.parse(request.thread_id),
  };
}

export function parseProvenance(
  value: DistillationProvenance,
): DistillationProvenance {
  return {
    distillation_key: Sha256DigestSchema.parse(value.distillation_key),
    model: NonEmptyStringSchema.parse(value.model),
    output_schema_digest: Sha256DigestSchema.parse(value.output_schema_digest),
    output_schema_version: NonEmptyStringSchema.parse(
      value.output_schema_version,
    ),
    prompt_digest: Sha256DigestSchema.parse(value.prompt_digest),
    prompt_version: NonEmptyStringSchema.parse(value.prompt_version),
    provider: NonEmptyStringSchema.parse(value.provider),
    ...(value.response_id === undefined
      ? {}
      : { response_id: NonEmptyStringSchema.parse(value.response_id) }),
    trust_policy_digest: Sha256DigestSchema.parse(value.trust_policy_digest),
  };
}

export function parseMatchSetDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new CanonicalFinalizeError(
      "FINALIZE_REQUEST_INVALID",
      "expected_match_set_digest must be lowercase SHA-256 hex",
    );
  }
  return value;
}

export function operationTime(
  now: Date,
  currentUpdatedAt: string,
): OperationTime {
  const clockTimestamp = now.getTime();
  if (!Number.isFinite(clockTimestamp)) {
    throw new CanonicalFinalizeError(
      "FINALIZE_REQUEST_INVALID",
      "now() returned an invalid Date",
    );
  }
  const timestamp = Math.max(clockTimestamp, Date.parse(currentUpdatedAt));
  return {
    recordedAt: IsoDateTimeSchema.parse(new Date(timestamp).toISOString()),
    timestamp,
  };
}

export function canonicalEventPath(value: string): string {
  const path = NonEmptyStringSchema.parse(value);
  if (!path.startsWith("events/") || !path.endsWith(".jsonl")) {
    throw new TypeError("canonical event paths must be events/*.jsonl");
  }
  return path;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

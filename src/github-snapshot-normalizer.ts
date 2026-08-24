import { computeTrustPolicyDigest } from "./config.js";
import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeComments,
  sha256Jcs,
  sortAndDedupeStrings,
} from "./canonical.js";
import type { CanonicalJsonlRecord } from "./canonical-jsonl.js";
import {
  CommentObservationSchema,
  ObservationIdSchema,
  PullRequestObservationSchema,
  PullRequestSnapshotSchema,
  ReviewerIdentitySchema,
  Sha256DigestSchema,
  ThreadObservationSchema,
  TransactionIdSchema,
  TrustConfigSchema,
  type CommentObservation,
  type KnowledgeStatus,
  type PullRequestObservation,
  type PullRequestSnapshot,
  type ReviewerIdentity,
  type ThreadObservation,
  type TrustConfig,
} from "./domain-schemas.js";
import {
  reviewSummaryThreadId,
  type CompleteGitHubPullRequestSnapshot,
  type GitHubReviewActor,
} from "./github-pull-request-client.js";
import { createDomainId } from "./ids.js";

export const RAW_PULL_REQUEST_RECORD_TYPE = "PullRequestObservation";
export const RAW_THREAD_RECORD_TYPE = "ThreadObservation";
export const RAW_COMMENT_RECORD_TYPE = "CommentObservation";

export type CommentExclusionReason =
  | "ci-bot-boilerplate"
  | "empty-body"
  | "emoji-only";

export type RawOnlyReason =
  | "external-contributor"
  | "unknown-actor"
  | "unknown-bot";

export type ThreadDistillationDisposition = "distill" | "filtered" | "raw-only";

export type GitHubSnapshotNormalizationErrorCode =
  | "DUPLICATE_OBSERVATION_ID"
  | "SNAPSHOT_INCONSISTENT";

export class GitHubSnapshotNormalizationError extends Error {
  constructor(
    readonly code: GitHubSnapshotNormalizationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GitHubSnapshotNormalizationError";
  }
}

export interface NormalizedDistillationComment {
  readonly body: string;
  readonly createdAt: string;
  readonly diffHunk?: string;
  readonly id: string;
  readonly updatedAt: string;
}

export interface NormalizedDistillationActor {
  readonly actor_id: string | null;
  readonly actor_kind: ReviewerIdentity["actor_kind"];
  readonly authorAssociation: string | null;
  readonly login: string | null;
  readonly provider: ReviewerIdentity["provider"];
  readonly trust: ReviewerIdentity["trust"];
}

export interface NormalizedDistillationThread {
  readonly contentFingerprint: string;
  readonly disposition: ThreadDistillationDisposition;
  readonly distillationInputDigest: string;
  readonly distillationKey: string;
  readonly excludedCommentIds: readonly string[];
  readonly initialKnowledgeStatus: Extract<
    KnowledgeStatus,
    "active" | "proposed"
  > | null;
  readonly isOutdated: boolean;
  readonly isResolved: boolean;
  readonly normalizedActors: readonly NormalizedDistillationActor[];
  readonly normalizedComments: readonly NormalizedDistillationComment[];
  readonly path: string | null;
  readonly rawOnlyReason: RawOnlyReason | null;
  readonly stateFingerprint: string;
  readonly threadId: string;
}

export interface UnknownBotWarning {
  readonly actorId: string | null;
  readonly code: "UNKNOWN_BOT_RAW_ONLY";
  readonly commentIds: readonly string[];
  readonly configPath: "trust.aiReviewers";
  readonly login: string | null;
  readonly threadIds: readonly string[];
}

export interface NormalizedRawObservationRecords {
  readonly comments: readonly CanonicalJsonlRecord<CommentObservation>[];
  readonly pullRequests: readonly CanonicalJsonlRecord<PullRequestObservation>[];
  readonly threadObservations: readonly CanonicalJsonlRecord<ThreadObservation>[];
}

export interface NormalizedGitHubPullRequestSnapshot {
  readonly records: NormalizedRawObservationRecords;
  readonly snapshot: PullRequestSnapshot;
  readonly threads: readonly NormalizedDistillationThread[];
  readonly trustPolicyDigest: string;
  readonly warnings: readonly UnknownBotWarning[];
}

export interface NormalizeGitHubPullRequestSnapshotRequest {
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly repositoryContext: unknown;
  readonly snapshot: CompleteGitHubPullRequestSnapshot;
  readonly transactionId: string;
  readonly trust: TrustConfig;
}

export interface GitHubSnapshotNormalizerOptions {
  readonly nextObservationId?: () => string;
}

export interface DistillationInputDigestRequest {
  readonly normalizedActors: readonly NormalizedDistillationActor[];
  readonly normalizedComments: readonly NormalizedDistillationComment[];
  readonly path: string | null;
  readonly repositoryContext: unknown;
  readonly threadId: string;
}

export interface DistillationKeyRequest {
  readonly distillationInputDigest: string;
  readonly outputSchemaDigest: string;
  readonly promptDigest: string;
  readonly trustPolicyDigest: string;
}

interface SourceComment {
  readonly author: GitHubReviewActor | null;
  readonly authorAssociation: string;
  readonly body: string;
  readonly createdAt: string;
  readonly diffHunk?: string;
  readonly id: string;
  readonly updatedAt: string;
  readonly url: string;
}

interface SourceThread {
  readonly comments: readonly SourceComment[];
  readonly id: string;
  readonly isOutdated: boolean;
  readonly isResolved: boolean;
  readonly path: string | null;
}

interface WorkingComment {
  readonly createdAt: string;
  readonly exclusionReason: CommentExclusionReason | null;
  readonly id: string;
  readonly identity: ReviewerIdentity;
  readonly normalized: NormalizedDistillationComment;
  readonly source: SourceComment;
}

interface MutableUnknownBotWarning {
  readonly actorId: string | null;
  readonly commentIds: string[];
  readonly login: string | null;
  readonly threadIds: string[];
}

/** Converts a complete GitHub snapshot into raw records and distillation inputs. */
export function normalizeGitHubPullRequestSnapshot(
  request: NormalizeGitHubPullRequestSnapshotRequest,
  options: GitHubSnapshotNormalizerOptions = {},
): NormalizedGitHubPullRequestSnapshot {
  const transactionId = TransactionIdSchema.parse(request.transactionId);
  const snapshot = PullRequestSnapshotSchema.parse(request.snapshot.snapshot);
  const trust = TrustConfigSchema.parse(request.trust);
  const promptDigest = Sha256DigestSchema.parse(request.promptDigest);
  const outputSchemaDigest = Sha256DigestSchema.parse(
    request.outputSchemaDigest,
  );
  canonicalizeJson(request.repositoryContext);
  assertSnapshotConsistency(request.snapshot, snapshot);

  const trustPolicyDigest = computeTrustPolicyDigest(trust);
  const observationIds = observationIdAllocator(options.nextObservationId);
  const pullRequestObservation = PullRequestObservationSchema.parse({
    base_ref_oid: request.snapshot.pullRequest.baseRefOid,
    head_ref_oid: request.snapshot.pullRequest.headRefOid,
    merged_at: request.snapshot.pullRequest.mergedAt,
    name_with_owner: request.snapshot.repository.nameWithOwner,
    observation_id: observationIds.next(),
    observation_type: "pull_request",
    observed_at: snapshot.observed_at,
    pr_number: request.snapshot.pullRequest.number,
    pull_request_id: request.snapshot.pullRequest.id,
    repo_id: request.snapshot.repository.id,
    snapshot_id: snapshot.snapshot_id,
    title: request.snapshot.pullRequest.title,
  });

  const commentRecords: CanonicalJsonlRecord<CommentObservation>[] = [];
  const threadRecords: CanonicalJsonlRecord<ThreadObservation>[] = [];
  const normalizedThreads: NormalizedDistillationThread[] = [];
  const warningMap = new Map<string, MutableUnknownBotWarning>();
  const seenCommentIds = new Set<string>();

  for (const thread of sourceThreads(request.snapshot)) {
    const workingComments = normalizeComments(
      thread.comments.map((comment) => {
        const identity = buildReviewerIdentity(
          comment.author,
          comment.authorAssociation,
          trust,
        );
        const normalized = normalizeDistillationComment(comment);
        return {
          createdAt: comment.createdAt,
          exclusionReason: classifyCommentExclusion(normalized.body, identity),
          id: comment.id,
          identity,
          normalized,
          source: comment,
        } satisfies WorkingComment;
      }),
    );

    for (const comment of workingComments) {
      if (seenCommentIds.has(comment.source.id)) {
        throw inconsistent(`duplicate comment ${comment.source.id}`);
      }
      seenCommentIds.add(comment.source.id);
      const observation = CommentObservationSchema.parse({
        actor: comment.identity,
        body: comment.normalized.body,
        comment_id: comment.source.id,
        created_at: comment.source.createdAt,
        ...(comment.normalized.diffHunk === undefined
          ? {}
          : { diff_hunk: comment.normalized.diffHunk }),
        observation_id: observationIds.next(),
        observation_type: "comment",
        observed_at: snapshot.observed_at,
        snapshot_id: snapshot.snapshot_id,
        thread_id: thread.id,
        updated_at: comment.source.updatedAt,
        url: comment.source.url,
      });
      commentRecords.push(
        observationRecord(
          RAW_COMMENT_RECORD_TYPE,
          observation,
          transactionId,
          snapshot.observed_at,
        ),
      );
    }

    const included = workingComments.filter(
      (comment) => comment.exclusionReason === null,
    );
    const normalizedComments = included.map((comment) => comment.normalized);
    const normalizedActors = included.map((comment) =>
      normalizedActor(comment.identity),
    );
    const contentFingerprint = computeThreadContentFingerprint(
      thread.id,
      thread.path,
      normalizedComments,
    );
    const stateFingerprint = computeThreadStateFingerprint(
      thread.isResolved,
      thread.isOutdated,
    );
    const distillationInputDigest = computeDistillationInputDigest({
      normalizedActors,
      normalizedComments,
      path: thread.path,
      repositoryContext: request.repositoryContext,
      threadId: thread.id,
    });
    const distillationKey = computeThreadDistillationKey({
      distillationInputDigest,
      outputSchemaDigest,
      promptDigest,
      trustPolicyDigest,
    });
    const policy = threadPolicy(included, trust);

    for (const comment of included) {
      if (rawOnlyReason(comment.identity, trust) !== "unknown-bot") continue;
      addUnknownBotWarning(
        warningMap,
        comment.identity,
        comment.source.id,
        thread.id,
      );
    }

    const threadObservation = ThreadObservationSchema.parse({
      comment_ids: workingComments.map((comment) => comment.source.id),
      content_fingerprint: contentFingerprint,
      is_outdated: thread.isOutdated,
      is_resolved: thread.isResolved,
      observation_id: observationIds.next(),
      observation_type: "thread",
      observed_at: snapshot.observed_at,
      ...(thread.path === null ? {} : { path: thread.path }),
      pr_number: request.snapshot.pullRequest.number,
      repo_id: request.snapshot.repository.id,
      snapshot_id: snapshot.snapshot_id,
      state_fingerprint: stateFingerprint,
      thread_id: thread.id,
    });
    threadRecords.push(
      observationRecord(
        RAW_THREAD_RECORD_TYPE,
        threadObservation,
        transactionId,
        snapshot.observed_at,
      ),
    );
    normalizedThreads.push({
      contentFingerprint,
      disposition: policy.disposition,
      distillationInputDigest,
      distillationKey,
      excludedCommentIds: sortAndDedupeStrings(
        workingComments
          .filter((comment) => comment.exclusionReason !== null)
          .map((comment) => comment.source.id),
      ),
      initialKnowledgeStatus: policy.initialKnowledgeStatus,
      isOutdated: thread.isOutdated,
      isResolved: thread.isResolved,
      normalizedActors,
      normalizedComments,
      path: thread.path,
      rawOnlyReason: policy.rawOnlyReason,
      stateFingerprint,
      threadId: thread.id,
    });
  }

  return {
    records: {
      comments: commentRecords,
      pullRequests: [
        observationRecord(
          RAW_PULL_REQUEST_RECORD_TYPE,
          pullRequestObservation,
          transactionId,
          snapshot.observed_at,
        ),
      ],
      threadObservations: threadRecords,
    },
    snapshot,
    threads: normalizedThreads,
    trustPolicyDigest,
    warnings: [...warningMap.entries()]
      .sort(([first], [second]) => compareCodeUnits(first, second))
      .map(([, warning]) => ({
        actorId: warning.actorId,
        code: "UNKNOWN_BOT_RAW_ONLY",
        commentIds: sortAndDedupeStrings(warning.commentIds),
        configPath: "trust.aiReviewers",
        login: warning.login,
        threadIds: sortAndDedupeStrings(warning.threadIds),
      })),
  };
}

/** Normalizes CRLF and lone CR line endings without changing other content. */
export function normalizeLf(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

/** Builds the trust identity used by raw observations and distillation inputs. */
export function buildReviewerIdentity(
  actor: GitHubReviewActor | null,
  authorAssociation: string,
  trustConfig: TrustConfig,
): ReviewerIdentity {
  const trust = TrustConfigSchema.parse(trustConfig);
  const actorKind =
    actor?.__typename === "User"
      ? "user"
      : actor?.__typename === "Bot"
        ? "bot"
        : "unknown";
  const login = actor?.login ?? null;
  const provider = reviewerProvider(actorKind, login, trust);
  const isExplicitlyTrusted =
    (actor !== null && trust.trustedActorIds.includes(actor.id)) ||
    (login !== null && trust.trustedLogins.includes(login));
  const isConfiguredAi =
    actorKind === "bot" &&
    login !== null &&
    Object.hasOwn(trust.aiReviewers, login);
  const trustLevel =
    isExplicitlyTrusted || isConfiguredAi
      ? "trusted"
      : actorKind === "user" && isExternalAssociation(authorAssociation)
        ? "untrusted"
        : "unknown";

  return ReviewerIdentitySchema.parse({
    ...(actor === null ? {} : { actor_id: actor.id }),
    actor_kind: actorKind,
    author_association: authorAssociation,
    login,
    provider,
    trust: trustLevel,
  });
}

/** Re-evaluates stored actor metadata after a local trust-policy change. */
export function reclassifyReviewerIdentity(
  identity: ReviewerIdentity,
  trustConfig: TrustConfig,
): ReviewerIdentity {
  const current = ReviewerIdentitySchema.parse(identity);
  const trust = TrustConfigSchema.parse(trustConfig);
  const isExplicitlyTrusted =
    (current.actor_id !== undefined &&
      trust.trustedActorIds.includes(current.actor_id)) ||
    (current.login !== null && trust.trustedLogins.includes(current.login));
  const isConfiguredAi =
    current.actor_kind === "bot" &&
    current.login !== null &&
    Object.hasOwn(trust.aiReviewers, current.login);
  return ReviewerIdentitySchema.parse({
    ...(current.actor_id === undefined ? {} : { actor_id: current.actor_id }),
    actor_kind: current.actor_kind,
    ...(current.author_association === undefined
      ? {}
      : { author_association: current.author_association }),
    login: current.login,
    provider: reviewerProvider(current.actor_kind, current.login, trust),
    trust:
      isExplicitlyTrusted || isConfiguredAi
        ? "trusted"
        : current.actor_kind === "user" &&
            isExternalAssociation(current.author_association ?? "")
          ? "untrusted"
          : "unknown",
  });
}

/** Returns why a comment is omitted from fingerprint and prompt input. */
export function classifyCommentExclusion(
  normalizedBody: string,
  identity: ReviewerIdentity,
): CommentExclusionReason | null {
  if (normalizedBody.trim().length === 0) return "empty-body";
  if (isEmojiOnly(normalizedBody)) return "emoji-only";
  if (isCiBotBoilerplate(normalizedBody, identity)) {
    return "ci-bot-boilerplate";
  }
  return null;
}

/** Detects bodies composed only of emoji sequences and whitespace. */
export function isEmojiOnly(value: string): boolean {
  const withoutKeycaps = value.replace(KEYCAP_SEQUENCE, "");
  const hasEmoji =
    withoutKeycaps !== value ||
    /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(value);
  if (!hasEmoji) return false;

  return withoutKeycaps.replace(EMOJI_SEQUENCE_CODE_POINTS, "").length === 0;
}

export function computeThreadContentFingerprint(
  threadId: string,
  path: string | null,
  normalizedComments: readonly NormalizedDistillationComment[],
): string {
  return prefixedJcsHash({
    comments: normalizedComments,
    path,
    threadId,
  });
}

export function computeThreadStateFingerprint(
  isResolved: boolean,
  isOutdated: boolean,
): string {
  return prefixedJcsHash({ isOutdated, isResolved });
}

export function computeDistillationInputDigest(
  request: DistillationInputDigestRequest,
): string {
  return prefixedJcsHash({
    normalized_actors: request.normalizedActors,
    normalized_comments: request.normalizedComments,
    path: request.path,
    repository_context: request.repositoryContext,
    thread_id: request.threadId,
  });
}

export function computeThreadDistillationKey(
  request: DistillationKeyRequest,
): string {
  return prefixedJcsHash({
    distillation_input_digest: Sha256DigestSchema.parse(
      request.distillationInputDigest,
    ),
    output_schema_digest: Sha256DigestSchema.parse(request.outputSchemaDigest),
    prompt_digest: Sha256DigestSchema.parse(request.promptDigest),
    trust_policy_digest: Sha256DigestSchema.parse(request.trustPolicyDigest),
  });
}

function sourceThreads(
  snapshot: CompleteGitHubPullRequestSnapshot,
): SourceThread[] {
  const threads: SourceThread[] = snapshot.threads.map((thread) => ({
    comments: thread.comments,
    id: thread.id,
    isOutdated: thread.isOutdated,
    isResolved: thread.isResolved,
    path: thread.path,
  }));
  for (const review of snapshot.reviewSummaries) {
    threads.push({
      comments: [
        {
          author: review.author,
          authorAssociation: review.authorAssociation,
          body: review.body,
          createdAt: review.createdAt,
          id: review.id,
          updatedAt: review.updatedAt,
          url: review.url,
        },
      ],
      id: review.syntheticThreadId,
      isOutdated: false,
      isResolved: false,
      path: null,
    });
  }
  return threads.sort((a, b) => compareCodeUnits(a.id, b.id));
}

function normalizeDistillationComment(
  comment: SourceComment,
): NormalizedDistillationComment {
  const diffHunk =
    comment.diffHunk === undefined ? undefined : normalizeLf(comment.diffHunk);
  return {
    body: normalizeLf(comment.body),
    createdAt: comment.createdAt,
    ...(diffHunk === undefined || diffHunk.length === 0 ? {} : { diffHunk }),
    id: comment.id,
    updatedAt: comment.updatedAt,
  };
}

function normalizedActor(
  identity: ReviewerIdentity,
): NormalizedDistillationActor {
  return {
    actor_id: identity.actor_id ?? null,
    actor_kind: identity.actor_kind,
    authorAssociation: identity.author_association ?? null,
    login: identity.login,
    provider: identity.provider,
    trust: identity.trust,
  };
}

function reviewerProvider(
  actorKind: ReviewerIdentity["actor_kind"],
  login: string | null,
  trust: TrustConfig,
): SourceProvider {
  const alias = login === null ? undefined : trust.sourceAliases[login];
  if (alias !== undefined) {
    return alias;
  }
  const aiReviewer = login === null ? undefined : trust.aiReviewers[login];
  if (aiReviewer !== undefined) {
    return aiReviewer;
  }
  return actorKind === "user" ? "human" : "other";
}

function rawOnlyReason(
  identity: ReviewerIdentity,
  trust: TrustConfig,
): RawOnlyReason | null {
  if (identity.trust === "trusted") return null;
  if (identity.actor_kind === "bot") return "unknown-bot";
  if (identity.actor_kind === "unknown") return "unknown-actor";
  if (
    isExternalAssociation(identity.author_association ?? "") &&
    trust.externalContributors === "raw-only"
  ) {
    return "external-contributor";
  }
  return null;
}

function threadPolicy(
  comments: readonly WorkingComment[],
  trust: TrustConfig,
): {
  readonly disposition: ThreadDistillationDisposition;
  readonly initialKnowledgeStatus: "active" | "proposed" | null;
  readonly rawOnlyReason: RawOnlyReason | null;
} {
  if (comments.length === 0) {
    return {
      disposition: "filtered",
      initialKnowledgeStatus: null,
      rawOnlyReason: null,
    };
  }
  const reasons = comments
    .map((comment) => rawOnlyReason(comment.identity, trust))
    .filter((reason): reason is RawOnlyReason => reason !== null);
  if (reasons.length > 0) {
    const reason = reasons.includes("unknown-bot")
      ? "unknown-bot"
      : reasons.includes("unknown-actor")
        ? "unknown-actor"
        : "external-contributor";
    return {
      disposition: "raw-only",
      initialKnowledgeStatus: null,
      rawOnlyReason: reason,
    };
  }

  return {
    disposition: "distill",
    // Severity and activation eligibility do not exist at normalization time.
    // CanonicalFinalizeService performs the complete fail-closed decision.
    initialKnowledgeStatus: "proposed",
    rawOnlyReason: null,
  };
}

function isExternalAssociation(value: string): boolean {
  return (
    value === "NONE" ||
    value === "FIRST_TIME_CONTRIBUTOR" ||
    value === "FIRST_TIMER"
  );
}

function isCiBotBoilerplate(body: string, identity: ReviewerIdentity): boolean {
  if (identity.actor_kind !== "bot" || identity.login === null) return false;
  if (!CI_BOT_LOGIN.test(identity.login)) return false;
  return CI_BOILERPLATE.test(body);
}

const CI_BOT_LOGIN =
  /^(?:circleci|codecov|coveralls|github-actions|netlify|sonarcloud|vercel)(?:\[bot\])?$/iu;
const CI_BOILERPLATE =
  /(?:build|check|ci|coverage|deploy(?:ment)?|preview|workflow)[\s\S]{0,200}(?:complete|failed|passed|ready|status|succeed)/iu;
const KEYCAP_SEQUENCE = /(?:#|\*|[0-9])(?:\uFE0F)?\u20E3/gu;
const EMOJI_SEQUENCE_CODE_POINTS =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0E|\uFE0F|\s)/gu;

function addUnknownBotWarning(
  warnings: Map<string, MutableUnknownBotWarning>,
  identity: ReviewerIdentity,
  commentId: string,
  threadId: string,
): void {
  const key =
    identity.actor_id === undefined
      ? `login:${identity.login ?? "<unknown>"}`
      : `id:${identity.actor_id}`;
  const current = warnings.get(key);
  if (current === undefined) {
    warnings.set(key, {
      actorId: identity.actor_id ?? null,
      commentIds: [commentId],
      login: identity.login,
      threadIds: [threadId],
    });
    return;
  }
  current.commentIds.push(commentId);
  current.threadIds.push(threadId);
}

function observationRecord<TPayload>(
  recordType: string,
  payload: TPayload & { readonly observation_id: string },
  transactionId: string,
  recordedAt: string,
): CanonicalJsonlRecord<TPayload> {
  return {
    payload,
    record_id: payload.observation_id,
    record_type: recordType,
    recorded_at: recordedAt,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

function observationIdAllocator(
  nextObservationId: (() => string) | undefined,
): { readonly next: () => string } {
  const generate = nextObservationId ?? (() => createDomainId("observation"));
  const seen = new Set<string>();
  return {
    next: () => {
      const id = ObservationIdSchema.parse(generate());
      if (seen.has(id)) {
        throw new GitHubSnapshotNormalizationError(
          "DUPLICATE_OBSERVATION_ID",
          `observation ID generator returned ${id} more than once`,
        );
      }
      seen.add(id);
      return id;
    },
  };
}

function assertSnapshotConsistency(
  complete: CompleteGitHubPullRequestSnapshot,
  snapshot: PullRequestSnapshot,
): void {
  if (
    complete.repository.id !== snapshot.repo_id ||
    complete.pullRequest.number !== snapshot.pr_number
  ) {
    throw inconsistent(
      "repository or pull request identity does not match snapshot",
    );
  }
  const threadIds = complete.threads.map((thread) => thread.id);
  const reviewIds = complete.reviewSummaries.map((review) => review.id);
  const reviewThreadIds = complete.reviewSummaries.map(
    (review) => review.syntheticThreadId,
  );
  if (
    new Set(threadIds).size !== threadIds.length ||
    new Set(reviewIds).size !== reviewIds.length ||
    new Set([...threadIds, ...reviewThreadIds]).size !==
      threadIds.length + reviewThreadIds.length ||
    !sameStrings(sortAndDedupeStrings(threadIds), snapshot.thread_ids) ||
    !sameStrings(sortAndDedupeStrings(reviewIds), snapshot.review_summary_ids)
  ) {
    throw inconsistent("thread or review summary IDs do not match snapshot");
  }
  for (const review of complete.reviewSummaries) {
    if (review.syntheticThreadId !== reviewSummaryThreadId(review.id)) {
      throw inconsistent(`invalid synthetic thread ID for review ${review.id}`);
    }
  }
}

function sameStrings(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return (
    first.length === second.length &&
    first.every((value, index) => value === second[index])
  );
}

function prefixedJcsHash(value: unknown): string {
  return `sha256:${sha256Jcs(value)}`;
}

function inconsistent(message: string): GitHubSnapshotNormalizationError {
  return new GitHubSnapshotNormalizationError("SNAPSHOT_INCONSISTENT", message);
}

type SourceProvider = ReviewerIdentity["provider"];

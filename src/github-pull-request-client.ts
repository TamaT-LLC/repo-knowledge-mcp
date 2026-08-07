import { z } from "zod";

import { sortAndDedupeStrings } from "./canonical.js";
import {
  GitHubNodeIdSchema,
  IsoDateTimeSchema,
  PullRequestSnapshotSchema,
  RepositoryNameSchema,
  type PullRequestSnapshot,
} from "./domain-schemas.js";
import { GhRunner, type GhRunnerLike } from "./gh-runner.js";
import {
  GraphqlPageInfoSchema,
  GitHubSnapshotError,
  PAGE_INFO_FIELDS,
  assertConnectionPageBudget as assertPageBudget,
  assertFreshConnectionCursor as assertFreshCursor,
  assertGraphqlPageSize as pageSize,
  duplicateGraphqlNode as duplicateNode,
  executeGhGraphql,
  graphqlResponseInvalid as responseInvalid,
  nextConnectionCursor as nextCursor,
  requireGraphqlRepository as requireRepository,
  type GraphqlPageInfo,
} from "./github-graphql.js";
import { createDomainId } from "./ids.js";

export {
  MAX_GRAPHQL_CONNECTION_PAGES,
  MAX_GRAPHQL_PAGE_SIZE,
  GitHubSnapshotError,
  type GitHubSnapshotErrorCode,
} from "./github-graphql.js";

export const DEFAULT_REVIEW_THREAD_PAGE_SIZE = 20;
export const DEFAULT_REVIEW_COMMENT_PAGE_SIZE = 30;
export const DEFAULT_REVIEW_PAGE_SIZE = 50;

const ACTOR_FIELDS = `
  __typename
  login
  ... on Node { id }
`;

const COMMENT_FIELDS = `
  id
  author { ${ACTOR_FIELDS} }
  authorAssociation
  body
  diffHunk
  url
  createdAt
  updatedAt
`;

const REVIEW_FIELDS = `
  id
  author { ${ACTOR_FIELDS} }
  authorAssociation
  body
  state
  url
  createdAt
  updatedAt
  submittedAt
`;

export const FETCH_PULL_REQUEST_SNAPSHOT_QUERY = `
query FetchPullRequestSnapshot(
  $owner: String!
  $name: String!
  $number: Int!
  $threadPageSize: Int!
  $commentPageSize: Int!
  $reviewPageSize: Int!
) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    pullRequest(number: $number) {
      id
      number
      title
      mergedAt
      baseRefOid
      headRefOid
      updatedAt
      reviewThreads(first: $threadPageSize) {
        pageInfo { ${PAGE_INFO_FIELDS} }
        nodes {
          id
          path
          isResolved
          isOutdated
          comments(first: $commentPageSize) {
            pageInfo { ${PAGE_INFO_FIELDS} }
            nodes { ${COMMENT_FIELDS} }
          }
        }
      }
      reviews(first: $reviewPageSize) {
        pageInfo { ${PAGE_INFO_FIELDS} }
        nodes { ${REVIEW_FIELDS} }
      }
    }
  }
}`;

export const FETCH_REVIEW_THREADS_PAGE_QUERY = `
query FetchReviewThreadsPage(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String!
  $threadPageSize: Int!
  $commentPageSize: Int!
) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      id
      number
      reviewThreads(first: $threadPageSize, after: $after) {
        pageInfo { ${PAGE_INFO_FIELDS} }
        nodes {
          id
          path
          isResolved
          isOutdated
          comments(first: $commentPageSize) {
            pageInfo { ${PAGE_INFO_FIELDS} }
            nodes { ${COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

export const FETCH_REVIEW_THREAD_COMMENTS_PAGE_QUERY = `
query FetchReviewThreadCommentsPage(
  $threadId: ID!
  $after: String!
  $commentPageSize: Int!
) {
  node(id: $threadId) {
    __typename
    ... on PullRequestReviewThread {
      id
      comments(first: $commentPageSize, after: $after) {
        pageInfo { ${PAGE_INFO_FIELDS} }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

export const FETCH_PULL_REQUEST_REVIEWS_PAGE_QUERY = `
query FetchPullRequestReviewsPage(
  $owner: String!
  $name: String!
  $number: Int!
  $after: String!
  $reviewPageSize: Int!
) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      id
      number
      reviews(first: $reviewPageSize, after: $after) {
        pageInfo { ${PAGE_INFO_FIELDS} }
        nodes { ${REVIEW_FIELDS} }
      }
    }
  }
}`;

export const VALIDATE_PULL_REQUEST_SNAPSHOT_QUERY = `
query ValidatePullRequestSnapshot(
  $owner: String!
  $name: String!
  $number: Int!
  $threadIds: [ID!]!
) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      id
      number
      title
      mergedAt
      baseRefOid
      headRefOid
      updatedAt
      reviewThreads(first: 1) { totalCount }
      reviews(first: 1) { totalCount }
    }
  }
  nodes(ids: $threadIds) {
    __typename
    ... on PullRequestReviewThread {
      id
      path
      isResolved
      isOutdated
      comments(first: 1) { totalCount }
    }
  }
}`;

const ActorSchema = z
  .object({
    __typename: z.string().min(1),
    id: GitHubNodeIdSchema,
    login: z.string().min(1),
  })
  .strict();

const ReviewCommentSchema = z
  .object({
    author: ActorSchema.nullable(),
    authorAssociation: z.string().min(1),
    body: z.string(),
    createdAt: IsoDateTimeSchema,
    diffHunk: z.string(),
    id: GitHubNodeIdSchema,
    updatedAt: IsoDateTimeSchema,
    url: z.string().url(),
  })
  .strict();

const ReviewCommentsConnectionSchema = z
  .object({
    nodes: z.array(ReviewCommentSchema),
    pageInfo: GraphqlPageInfoSchema,
  })
  .strict();

const ReviewThreadNodeSchema = z
  .object({
    comments: ReviewCommentsConnectionSchema,
    id: GitHubNodeIdSchema,
    isOutdated: z.boolean(),
    isResolved: z.boolean(),
    path: z.string(),
  })
  .strict();

const ReviewThreadsConnectionSchema = z
  .object({
    nodes: z.array(ReviewThreadNodeSchema),
    pageInfo: GraphqlPageInfoSchema,
  })
  .strict();

const ReviewSummarySchema = z
  .object({
    author: ActorSchema.nullable(),
    authorAssociation: z.string().min(1),
    body: z.string(),
    createdAt: IsoDateTimeSchema,
    id: GitHubNodeIdSchema,
    state: z.string().min(1),
    submittedAt: IsoDateTimeSchema.nullable(),
    updatedAt: IsoDateTimeSchema,
    url: z.string().url(),
  })
  .strict();

const ReviewsConnectionSchema = z
  .object({
    nodes: z.array(ReviewSummarySchema),
    pageInfo: GraphqlPageInfoSchema,
  })
  .strict();

const InitialResponseDataSchema = z
  .object({
    repository: z
      .object({
        id: GitHubNodeIdSchema,
        nameWithOwner: RepositoryNameSchema,
        pullRequest: z
          .object({
            baseRefOid: z.string().min(1),
            headRefOid: z.string().min(1),
            id: GitHubNodeIdSchema,
            mergedAt: IsoDateTimeSchema.nullable(),
            number: z.number().int().positive(),
            reviewThreads: ReviewThreadsConnectionSchema,
            reviews: ReviewsConnectionSchema.nullable(),
            title: z.string().min(1),
            updatedAt: IsoDateTimeSchema,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const ThreadPageResponseDataSchema = z
  .object({
    repository: z
      .object({
        id: GitHubNodeIdSchema,
        pullRequest: z
          .object({
            id: GitHubNodeIdSchema,
            number: z.number().int().positive(),
            reviewThreads: ReviewThreadsConnectionSchema,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const CommentPageResponseDataSchema = z
  .object({
    node: z
      .object({
        __typename: z.literal("PullRequestReviewThread"),
        comments: ReviewCommentsConnectionSchema,
        id: GitHubNodeIdSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const ReviewPageResponseDataSchema = z
  .object({
    repository: z
      .object({
        id: GitHubNodeIdSchema,
        pullRequest: z
          .object({
            id: GitHubNodeIdSchema,
            number: z.number().int().positive(),
            reviews: ReviewsConnectionSchema.nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const ConnectionCountSchema = z
  .object({ totalCount: z.number().int().min(0) })
  .strict();

const SnapshotValidationResponseDataSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          __typename: z.literal("PullRequestReviewThread"),
          comments: ConnectionCountSchema,
          id: GitHubNodeIdSchema,
          isOutdated: z.boolean(),
          isResolved: z.boolean(),
          path: z.string(),
        })
        .strict()
        .nullable(),
    ),
    repository: z
      .object({
        id: GitHubNodeIdSchema,
        pullRequest: z
          .object({
            baseRefOid: z.string().min(1),
            headRefOid: z.string().min(1),
            id: GitHubNodeIdSchema,
            mergedAt: IsoDateTimeSchema.nullable(),
            number: z.number().int().positive(),
            reviewThreads: ConnectionCountSchema,
            reviews: ConnectionCountSchema.nullable(),
            title: z.string().min(1),
            updatedAt: IsoDateTimeSchema,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type GitHubReviewActor = z.infer<typeof ActorSchema>;
export type GitHubReviewComment = z.infer<typeof ReviewCommentSchema>;

export interface GitHubReviewThread {
  readonly comments: readonly GitHubReviewComment[];
  readonly id: string;
  readonly isOutdated: boolean;
  readonly isResolved: boolean;
  readonly path: string;
}

export interface GitHubReviewSummary {
  readonly author: GitHubReviewActor | null;
  readonly authorAssociation: string;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly syntheticThreadId: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface GitHubRepositoryMetadata {
  readonly id: string;
  readonly nameWithOwner: string;
}

export interface GitHubPullRequestMetadata {
  readonly baseRefOid: string;
  readonly headRefOid: string;
  readonly id: string;
  readonly mergedAt: string | null;
  readonly number: number;
  readonly title: string;
}

export interface CompleteGitHubPullRequestSnapshot {
  readonly pullRequest: GitHubPullRequestMetadata;
  readonly repository: GitHubRepositoryMetadata;
  readonly reviewSummaries: readonly GitHubReviewSummary[];
  readonly snapshot: PullRequestSnapshot;
  readonly threads: readonly GitHubReviewThread[];
}

export interface FetchGitHubPullRequestRequest {
  readonly prNumber: number;
  readonly repo: string;
}

export interface GitHubPullRequestClientOptions {
  readonly commentPageSize?: number;
  readonly ghRunner?: GhRunnerLike;
  readonly nextSnapshotId?: () => string;
  readonly now?: () => Date;
  readonly reviewPageSize?: number;
  readonly threadPageSize?: number;
}

interface MutableReviewThread extends GitHubReviewThread {
  readonly comments: GitHubReviewComment[];
  readonly seenCommentIds: Set<string>;
  nextCommentCursor: string | null;
}

interface PullRequestIdentity {
  readonly baseRefOid: string;
  readonly headRefOid: string;
  readonly mergedAt: string | null;
  readonly prId: string;
  readonly prNumber: number;
  readonly repoId: string;
  readonly title: string;
  readonly updatedAt: string;
}

/** Fetches only complete PR snapshots; every partial state fails by throwing. */
export class GitHubPullRequestSnapshotClient {
  private readonly commentPageSize: number;
  private readonly ghRunner: GhRunnerLike;
  private readonly nextSnapshotId: () => string;
  private readonly now: () => Date;
  private readonly reviewPageSize: number;
  private readonly threadPageSize: number;

  constructor(options: GitHubPullRequestClientOptions = {}) {
    this.commentPageSize = pageSize(
      options.commentPageSize ?? DEFAULT_REVIEW_COMMENT_PAGE_SIZE,
      "commentPageSize",
    );
    this.ghRunner = options.ghRunner ?? new GhRunner();
    this.nextSnapshotId =
      options.nextSnapshotId ?? (() => createDomainId("snapshot"));
    this.now = options.now ?? (() => new Date());
    this.reviewPageSize = pageSize(
      options.reviewPageSize ?? DEFAULT_REVIEW_PAGE_SIZE,
      "reviewPageSize",
    );
    this.threadPageSize = pageSize(
      options.threadPageSize ?? DEFAULT_REVIEW_THREAD_PAGE_SIZE,
      "threadPageSize",
    );
  }

  async fetchCompleteSnapshot(
    request: FetchGitHubPullRequestRequest,
  ): Promise<CompleteGitHubPullRequestSnapshot> {
    const repo = RepositoryNameSchema.parse(request.repo);
    if (!Number.isSafeInteger(request.prNumber) || request.prNumber < 1) {
      throw new TypeError("prNumber must be a positive safe integer");
    }
    const [owner, name] = repo.split("/") as [string, string];
    const initial = await this.execute(
      "initial snapshot",
      FETCH_PULL_REQUEST_SNAPSHOT_QUERY,
      {
        name,
        owner,
      },
      {
        commentPageSize: this.commentPageSize,
        number: request.prNumber,
        reviewPageSize: this.reviewPageSize,
        threadPageSize: this.threadPageSize,
      },
      InitialResponseDataSchema,
    );
    const repository = requireRepository(
      initial.repository,
      "initial snapshot",
    );
    const pullRequest = requirePullRequest(
      repository.pullRequest,
      "initial snapshot",
    );
    if (pullRequest.reviews === null) {
      throw responseInvalid("initial snapshot", "reviews connection was null");
    }
    const identity: PullRequestIdentity = {
      baseRefOid: pullRequest.baseRefOid,
      headRefOid: pullRequest.headRefOid,
      mergedAt: pullRequest.mergedAt,
      prId: pullRequest.id,
      prNumber: pullRequest.number,
      repoId: repository.id,
      title: pullRequest.title,
      updatedAt: pullRequest.updatedAt,
    };
    if (identity.prNumber !== request.prNumber) {
      throw changedError("initial snapshot");
    }

    const threads = new Map<string, MutableReviewThread>();
    appendThreadNodes(
      threads,
      pullRequest.reviewThreads.nodes,
      "initial reviewThreads page",
    );
    await this.fetchRemainingThreadPages(
      owner,
      name,
      identity,
      pullRequest.reviewThreads.pageInfo,
      threads,
    );
    await this.fetchRemainingCommentPages(threads);

    const reviews = [...pullRequest.reviews.nodes];
    const seenReviewIds = new Set(reviews.map((review) => review.id));
    if (seenReviewIds.size !== reviews.length) {
      throw duplicateNode("initial reviews page", "review");
    }
    await this.fetchRemainingReviewPages(
      owner,
      name,
      identity,
      pullRequest.reviews.pageInfo,
      reviews,
      seenReviewIds,
    );

    const observedAt = this.now().toISOString();
    await this.validateSnapshotStability(
      owner,
      name,
      identity,
      threads,
      reviews.length,
    );

    const snapshotId = this.nextSnapshotId();
    const parsedSnapshot = PullRequestSnapshotSchema.safeParse({
      complete: true,
      observed_at: observedAt,
      pr_number: identity.prNumber,
      repo_id: identity.repoId,
      review_summary_ids: sortAndDedupeStrings(
        reviews.map((review) => review.id),
      ),
      snapshot_id: snapshotId,
      thread_ids: sortAndDedupeStrings([...threads.keys()]),
    });
    if (!parsedSnapshot.success) {
      throw new GitHubSnapshotError(
        "SNAPSHOT_INVALID",
        "snapshot finalization",
        parsedSnapshot.error.message,
        { cause: parsedSnapshot.error },
      );
    }

    return {
      pullRequest: {
        baseRefOid: pullRequest.baseRefOid,
        headRefOid: pullRequest.headRefOid,
        id: pullRequest.id,
        mergedAt: pullRequest.mergedAt,
        number: pullRequest.number,
        title: pullRequest.title,
      },
      repository: {
        id: repository.id,
        nameWithOwner: repository.nameWithOwner,
      },
      reviewSummaries: reviews.map((review) => ({
        ...review,
        syntheticThreadId: reviewSummaryThreadId(review.id),
      })),
      snapshot: parsedSnapshot.data,
      threads: [...threads.values()].map((thread) => ({
        comments: thread.comments,
        id: thread.id,
        isOutdated: thread.isOutdated,
        isResolved: thread.isResolved,
        path: thread.path,
      })),
    };
  }

  private async fetchRemainingThreadPages(
    owner: string,
    name: string,
    identity: PullRequestIdentity,
    firstPageInfo: GraphqlPageInfo,
    threads: Map<string, MutableReviewThread>,
  ): Promise<void> {
    let cursor = nextCursor(firstPageInfo, "initial reviewThreads page");
    const seenCursors = new Set<string>();
    let pages = 1;
    while (cursor !== null) {
      assertFreshCursor(cursor, seenCursors, "reviewThreads");
      assertPageBudget(++pages, "reviewThreads");
      const page = await this.execute(
        "reviewThreads page",
        FETCH_REVIEW_THREADS_PAGE_QUERY,
        { after: cursor, name, owner },
        {
          commentPageSize: this.commentPageSize,
          number: identity.prNumber,
          threadPageSize: this.threadPageSize,
        },
        ThreadPageResponseDataSchema,
      );
      const repository = requireRepository(
        page.repository,
        "reviewThreads page",
      );
      const pullRequest = requirePullRequest(
        repository.pullRequest,
        "reviewThreads page",
      );
      assertIdentity(
        repository.id,
        pullRequest,
        identity,
        "reviewThreads page",
      );
      appendThreadNodes(
        threads,
        pullRequest.reviewThreads.nodes,
        "reviewThreads page",
      );
      cursor = nextCursor(
        pullRequest.reviewThreads.pageInfo,
        "reviewThreads page",
      );
    }
  }

  private async fetchRemainingCommentPages(
    threads: ReadonlyMap<string, MutableReviewThread>,
  ): Promise<void> {
    for (const thread of threads.values()) {
      const seenCursors = new Set<string>();
      let pages = 1;
      while (thread.nextCommentCursor !== null) {
        const cursor = thread.nextCommentCursor;
        assertFreshCursor(cursor, seenCursors, `comments for ${thread.id}`);
        assertPageBudget(++pages, `comments for ${thread.id}`);
        const page = await this.execute(
          `comments for ${thread.id}`,
          FETCH_REVIEW_THREAD_COMMENTS_PAGE_QUERY,
          { after: cursor, threadId: thread.id },
          { commentPageSize: this.commentPageSize },
          CommentPageResponseDataSchema,
        );
        if (page.node === null || page.node.id !== thread.id) {
          throw changedError(`comments for ${thread.id}`);
        }
        appendComments(
          thread,
          page.node.comments.nodes,
          `comments for ${thread.id}`,
        );
        thread.nextCommentCursor = nextCursor(
          page.node.comments.pageInfo,
          `comments for ${thread.id}`,
        );
      }
    }
  }

  private async fetchRemainingReviewPages(
    owner: string,
    name: string,
    identity: PullRequestIdentity,
    firstPageInfo: GraphqlPageInfo,
    reviews: z.infer<typeof ReviewSummarySchema>[],
    seenReviewIds: Set<string>,
  ): Promise<void> {
    let cursor = nextCursor(firstPageInfo, "initial reviews page");
    const seenCursors = new Set<string>();
    let pages = 1;
    while (cursor !== null) {
      assertFreshCursor(cursor, seenCursors, "reviews");
      assertPageBudget(++pages, "reviews");
      const page = await this.execute(
        "reviews page",
        FETCH_PULL_REQUEST_REVIEWS_PAGE_QUERY,
        { after: cursor, name, owner },
        { number: identity.prNumber, reviewPageSize: this.reviewPageSize },
        ReviewPageResponseDataSchema,
      );
      const repository = requireRepository(page.repository, "reviews page");
      const pullRequest = requirePullRequest(
        repository.pullRequest,
        "reviews page",
      );
      assertIdentity(repository.id, pullRequest, identity, "reviews page");
      if (pullRequest.reviews === null) {
        throw responseInvalid("reviews page", "reviews connection was null");
      }
      for (const review of pullRequest.reviews.nodes) {
        if (seenReviewIds.has(review.id)) {
          throw duplicateNode("reviews page", `review ${review.id}`);
        }
        seenReviewIds.add(review.id);
        reviews.push(review);
      }
      cursor = nextCursor(pullRequest.reviews.pageInfo, "reviews page");
    }
  }

  private async validateSnapshotStability(
    owner: string,
    name: string,
    identity: PullRequestIdentity,
    threads: ReadonlyMap<string, MutableReviewThread>,
    reviewCount: number,
  ): Promise<void> {
    const threadIds = [...threads.keys()];
    const validation = await this.execute(
      "snapshot validation",
      VALIDATE_PULL_REQUEST_SNAPSHOT_QUERY,
      { name, owner },
      { number: identity.prNumber },
      SnapshotValidationResponseDataSchema,
      { threadIds },
    );
    const repository = requireRepository(
      validation.repository,
      "snapshot validation",
    );
    const pullRequest = requirePullRequest(
      repository.pullRequest,
      "snapshot validation",
    );
    assertIdentity(repository.id, pullRequest, identity, "snapshot validation");
    if (pullRequest.reviews === null) {
      throw responseInvalid(
        "snapshot validation",
        "reviews connection was null",
      );
    }
    if (
      pullRequest.baseRefOid !== identity.baseRefOid ||
      pullRequest.headRefOid !== identity.headRefOid ||
      pullRequest.mergedAt !== identity.mergedAt ||
      pullRequest.title !== identity.title ||
      pullRequest.updatedAt !== identity.updatedAt ||
      pullRequest.reviewThreads.totalCount !== threads.size ||
      pullRequest.reviews.totalCount !== reviewCount ||
      validation.nodes.length !== threadIds.length
    ) {
      throw changedError("snapshot validation");
    }

    const validatedThreads = new Map(
      validation.nodes.map((node) => {
        if (node === null) throw changedError("snapshot validation");
        return [node.id, node] as const;
      }),
    );
    if (validatedThreads.size !== validation.nodes.length) {
      throw changedError("snapshot validation");
    }
    for (const thread of threads.values()) {
      const validated = validatedThreads.get(thread.id);
      if (
        validated === undefined ||
        validated.path !== thread.path ||
        validated.isResolved !== thread.isResolved ||
        validated.isOutdated !== thread.isOutdated ||
        validated.comments.totalCount !== thread.comments.length
      ) {
        throw changedError("snapshot validation");
      }
    }
  }

  private async execute<T>(
    operation: string,
    query: string,
    stringVariables: Readonly<Record<string, string>>,
    integerVariables: Readonly<Record<string, number>>,
    schema: z.ZodType<T>,
    stringListVariables: Readonly<Record<string, readonly string[]>> = {},
  ): Promise<T> {
    return executeGhGraphql({
      ghRunner: this.ghRunner,
      integerVariables,
      operation,
      query,
      schema,
      stringListVariables,
      stringVariables,
    });
  }
}

export function reviewSummaryThreadId(reviewId: string): string {
  return `review-summary:${GitHubNodeIdSchema.parse(reviewId)}`;
}

function appendThreadNodes(
  target: Map<string, MutableReviewThread>,
  nodes: readonly z.infer<typeof ReviewThreadNodeSchema>[],
  operation: string,
): void {
  for (const node of nodes) {
    if (target.has(node.id)) {
      throw duplicateNode(operation, `thread ${node.id}`);
    }
    const seenCommentIds = new Set<string>();
    const thread: MutableReviewThread = {
      comments: [],
      id: node.id,
      isOutdated: node.isOutdated,
      isResolved: node.isResolved,
      nextCommentCursor: nextCursor(
        node.comments.pageInfo,
        `initial comments for ${node.id}`,
      ),
      path: node.path,
      seenCommentIds,
    };
    appendComments(
      thread,
      node.comments.nodes,
      `initial comments for ${node.id}`,
    );
    target.set(node.id, thread);
  }
}

function appendComments(
  thread: MutableReviewThread,
  comments: readonly GitHubReviewComment[],
  operation: string,
): void {
  for (const comment of comments) {
    if (thread.seenCommentIds.has(comment.id)) {
      throw duplicateNode(operation, `comment ${comment.id}`);
    }
    thread.seenCommentIds.add(comment.id);
    thread.comments.push(comment);
  }
}

function assertIdentity(
  repoId: string,
  pullRequest: { readonly id: string; readonly number: number },
  expected: PullRequestIdentity,
  operation: string,
): void {
  if (
    repoId !== expected.repoId ||
    pullRequest.id !== expected.prId ||
    pullRequest.number !== expected.prNumber
  ) {
    throw changedError(operation);
  }
}

function requirePullRequest<T>(value: T | null, operation: string): T {
  if (value === null) {
    throw new GitHubSnapshotError(
      "PULL_REQUEST_NOT_FOUND",
      operation,
      "pull request was not found or was not accessible",
    );
  }
  return value;
}

function changedError(operation: string): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "PULL_REQUEST_CHANGED",
    operation,
    "repository, pull request, or review data changed during snapshot capture",
  );
}

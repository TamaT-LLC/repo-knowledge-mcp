import { z } from "zod";

import {
  GitHubNodeIdSchema,
  IsoDateTimeSchema,
  RepositoryNameSchema,
} from "./domain-schemas.js";
import { GhRunner, type GhRunnerLike } from "./gh-runner.js";
import {
  GraphqlPageInfoSchema,
  GitHubSnapshotError,
  PAGE_INFO_FIELDS,
  assertConnectionPageBudget,
  assertFreshConnectionCursor,
  assertGraphqlPageSize,
  duplicateGraphqlNode,
  executeGhGraphql,
  nextConnectionCursor,
  requireGraphqlRepository,
} from "./github-graphql.js";
import {
  SyncCursorError,
  compareSyncOrder,
  isAfterSyncBoundary,
  isBeyondSyncBoundaryWindow,
  nextSyncCursor,
  parseIsoTimestampMs,
  resolveSyncBoundary,
  type SyncBoundary,
  type SyncCursor,
} from "./sync-cursor.js";

export const DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE = 50;

const PULL_REQUEST_LIST_FIELDS = `
  id
  number
  updatedAt
`;

export const LIST_UPDATED_PULL_REQUESTS_QUERY = `
query ListUpdatedPullRequests(
  $owner: String!
  $name: String!
  $pageSize: Int!
) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    pullRequests(
      first: $pageSize
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { ${PAGE_INFO_FIELDS} }
      nodes { ${PULL_REQUEST_LIST_FIELDS} }
    }
  }
}`;

export const LIST_UPDATED_PULL_REQUESTS_PAGE_QUERY = `
query ListUpdatedPullRequestsPage(
  $owner: String!
  $name: String!
  $after: String!
  $pageSize: Int!
) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    pullRequests(
      first: $pageSize
      after: $after
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      pageInfo { ${PAGE_INFO_FIELDS} }
      nodes { ${PULL_REQUEST_LIST_FIELDS} }
    }
  }
}`;

const PullRequestListNodeSchema = z
  .object({
    id: GitHubNodeIdSchema,
    number: z.number().int().positive(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

const PullRequestListPageDataSchema = z
  .object({
    repository: z
      .object({
        id: GitHubNodeIdSchema,
        nameWithOwner: RepositoryNameSchema,
        pullRequests: z
          .object({
            nodes: z.array(PullRequestListNodeSchema),
            pageInfo: GraphqlPageInfoSchema,
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();

type PullRequestListNode = z.infer<typeof PullRequestListNodeSchema>;
type PullRequestListPageData = z.infer<typeof PullRequestListPageDataSchema>;

export interface UpdatedPullRequestRef {
  readonly id: string;
  readonly number: number;
  readonly updatedAt: string;
}

export interface SyncRepositoryIdentity {
  readonly id: string;
  readonly nameWithOwner: string;
}

export interface EnumerateUpdatedPullRequestsRequest {
  readonly cursor?: unknown;
  readonly repo: string;
  readonly since?: string;
}

export interface EnumerateUpdatedPullRequestsResult {
  readonly nextCursor: SyncCursor | null;
  readonly pullRequests: readonly UpdatedPullRequestRef[];
  readonly repository: SyncRepositoryIdentity;
}

export interface GitHubPullRequestEnumeratorOptions {
  readonly ghRunner?: GhRunnerLike;
  readonly pageSize?: number;
}

/**
 * Enumerates the PRs a sync run must revisit, ordered deterministically by
 * (updatedAt, PR number) ascending. Every partial or unstable listing fails
 * by throwing, so a successful result always carries a resumable cursor.
 */
export class GitHubPullRequestEnumerator {
  private readonly ghRunner: GhRunnerLike;
  private readonly pageSize: number;

  constructor(options: GitHubPullRequestEnumeratorOptions = {}) {
    this.ghRunner = options.ghRunner ?? new GhRunner();
    this.pageSize = assertGraphqlPageSize(
      options.pageSize ?? DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE,
      "pageSize",
    );
  }

  async enumerateUpdatedPullRequests(
    request: EnumerateUpdatedPullRequestsRequest,
  ): Promise<EnumerateUpdatedPullRequestsResult> {
    const repo = RepositoryNameSchema.parse(request.repo);
    const boundary = resolveSyncBoundary({
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.since === undefined ? {} : { since: request.since }),
    });
    const [owner, name] = repo.split("/") as [string, string];

    const traversal = new PullRequestListTraversal(boundary);
    let repository: SyncRepositoryIdentity | null = null;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let pages = 0;
    do {
      const operation: string =
        cursor === null ? "initial pullRequests page" : "pullRequests page";
      if (cursor !== null) {
        assertFreshConnectionCursor(cursor, seenCursors, "pullRequests");
      }
      assertConnectionPageBudget(++pages, "pullRequests");
      const data: PullRequestListPageData = await executeGhGraphql({
        ghRunner: this.ghRunner,
        integerVariables: { pageSize: this.pageSize },
        operation,
        query:
          cursor === null
            ? LIST_UPDATED_PULL_REQUESTS_QUERY
            : LIST_UPDATED_PULL_REQUESTS_PAGE_QUERY,
        schema: PullRequestListPageDataSchema,
        stringVariables: {
          name,
          owner,
          ...(cursor === null ? {} : { after: cursor }),
        },
      });
      const page = requireGraphqlRepository(data.repository, operation);
      repository = mergeRepositoryIdentity(repository, page, operation);
      const exhausted = !traversal.append(page.pullRequests.nodes, operation);
      // Validate pageInfo even on the boundary-reaching page so a malformed
      // pagination response never passes as a successful enumeration.
      const nextPageCursor = nextConnectionCursor(
        page.pullRequests.pageInfo,
        operation,
      );
      cursor = exhausted ? null : nextPageCursor;
    } while (cursor !== null);

    if (repository === null) {
      throw listChangedError("pullRequests");
    }
    assertCursorRepositoryBinding(boundary, repository);
    const pullRequests = traversal.sortedAscending();
    return {
      nextCursor: resolveNextCursor(boundary, repository, pullRequests),
      pullRequests,
      repository,
    };
  }
}

/**
 * Validates the updatedAt-descending listing while it is consumed. A node
 * appearing twice or arriving out of order means the repository changed
 * during the traversal, so the whole enumeration fails closed.
 */
class PullRequestListTraversal {
  private readonly included: (UpdatedPullRequestRef & {
    readonly updatedAtMs: number;
  })[] = [];
  private previousUpdatedAtMs = Number.POSITIVE_INFINITY;
  private readonly seenIds = new Set<string>();
  private readonly seenNumbers = new Set<number>();

  constructor(private readonly boundary: SyncBoundary) {}

  /** Returns false once every remaining node is older than the boundary. */
  append(nodes: readonly PullRequestListNode[], operation: string): boolean {
    for (const node of nodes) {
      if (this.seenIds.has(node.id)) {
        throw duplicateGraphqlNode(operation, `pull request ${node.id}`);
      }
      if (this.seenNumbers.has(node.number)) {
        throw duplicateGraphqlNode(
          operation,
          `pull request #${String(node.number)}`,
        );
      }
      const updatedAtMs = parseIsoTimestampMs(node.updatedAt);
      if (updatedAtMs > this.previousUpdatedAtMs) {
        throw listChangedError(operation);
      }
      this.seenIds.add(node.id);
      this.seenNumbers.add(node.number);
      this.previousUpdatedAtMs = updatedAtMs;
      if (isBeyondSyncBoundaryWindow(this.boundary, updatedAtMs)) {
        return false;
      }
      if (isAfterSyncBoundary(this.boundary, updatedAtMs, node.number)) {
        this.included.push({
          id: node.id,
          number: node.number,
          updatedAt: node.updatedAt,
          updatedAtMs,
        });
      }
    }
    return true;
  }

  sortedAscending(): readonly UpdatedPullRequestRef[] {
    return [...this.included]
      .sort(compareSyncOrder)
      .map(({ id, number, updatedAt }) => ({ id, number, updatedAt }));
  }
}

function mergeRepositoryIdentity(
  known: SyncRepositoryIdentity | null,
  page: SyncRepositoryIdentity,
  operation: string,
): SyncRepositoryIdentity {
  if (known !== null && known.id !== page.id) {
    throw listChangedError(operation);
  }
  // A rename keeps the node ID stable, so the latest nameWithOwner wins.
  return { id: page.id, nameWithOwner: page.nameWithOwner };
}

function assertCursorRepositoryBinding(
  boundary: SyncBoundary,
  repository: SyncRepositoryIdentity,
): void {
  if (boundary.kind !== "cursor") return;
  if (boundary.cursor.repo_id !== repository.id) {
    throw new SyncCursorError(
      "SYNC_CURSOR_REPOSITORY_MISMATCH",
      "sync cursor belongs to a different repository node ID",
    );
  }
}

function resolveNextCursor(
  boundary: SyncBoundary,
  repository: SyncRepositoryIdentity,
  pullRequests: readonly UpdatedPullRequestRef[],
): SyncCursor | null {
  const last = pullRequests.at(-1);
  if (last !== undefined) return nextSyncCursor(repository.id, last);
  // Nothing new: keep the caller's resume point instead of inventing one.
  return boundary.kind === "cursor" ? boundary.cursor : null;
}

function listChangedError(operation: string): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "PULL_REQUEST_LIST_CHANGED",
    operation,
    "pull request listing changed while it was being enumerated",
  );
}

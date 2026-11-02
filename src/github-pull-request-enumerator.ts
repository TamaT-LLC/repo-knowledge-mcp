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
export const DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS = 3;
/**
 * PRs updated within this window before the run starts are deferred to the
 * next run. Any update landing mid-enumeration carries a GitHub timestamp at
 * or after the run start, so it always falls behind the cutoff; the window
 * also absorbs clock skew between this host and GitHub.
 */
export const DEFAULT_SYNC_UPDATE_SETTLE_MS = 60_000;
/**
 * How far GitHub's `UPDATED_AT` sort key may lag behind a PR's returned
 * `updatedAt` before the traversal stops reading past the sync boundary.
 *
 * GitHub (GraphQL, REST `sort=updated`, the issues `since` filter and search
 * `updated:` all alike) orders PRs by an internal timestamp that some updates
 * never bump, so a PR can be listed far below where its `updatedAt` would
 * place it; the key has never been observed ahead of `updatedAt`. On a real
 * 12k-PR repository the lag was a few minutes to 4.25 hours for PRs updated
 * in recent months, and up to 41 days for two PRs from 2025. A PR whose lag
 * exceeds this window is listed too deep for an incremental run to reach;
 * GitHub's own incremental filters miss it too, and a `--since` replay picks
 * it up. Reading one more week past the boundary costs a few pages.
 */
export const DEFAULT_SYNC_SORT_LAG_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1_000;

const MAX_SYNC_PULL_REQUEST_LIST_ATTEMPTS = 10;
const MAX_SYNC_UPDATE_SETTLE_MS = 24 * 60 * 60 * 1_000;
const MAX_SYNC_SORT_LAG_TOLERANCE_MS = 90 * 24 * 60 * 60 * 1_000;

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
  /** PRs after the boundary left for the next run (updated at/after the cutoff). */
  readonly deferred: number;
  readonly nextCursor: SyncCursor | null;
  readonly pullRequests: readonly UpdatedPullRequestRef[];
  readonly repository: SyncRepositoryIdentity;
}

export interface GitHubPullRequestEnumeratorOptions {
  readonly ghRunner?: GhRunnerLike;
  readonly maxListChangeAttempts?: number;
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly sortLagToleranceMs?: number;
  readonly updateSettleMs?: number;
}

/**
 * Enumerates the PRs a sync run must revisit, ordered deterministically by
 * (updatedAt, PR number) ascending. The run is bounded above by a cutoff
 * fixed when it starts: PRs updated at or after it are deferred to the next
 * run instead of aborting this one, so concurrent PR activity never blocks
 * the checkpoint from advancing. GitHub only approximately orders the listing
 * by `updatedAt`, so the traversal never relies on monotonic order: it
 * collects every node down to the sort-lag window past the boundary, dedupes
 * by node ID and sorts locally. Below the cutoff a PR's `updatedAt` cannot
 * change, so a listing that contradicts itself there fails closed; a
 * repository identity change mid-traversal discards the listing and restarts
 * it from the same boundary a bounded number of times.
 */
export class GitHubPullRequestEnumerator {
  private readonly ghRunner: GhRunnerLike;
  private readonly maxListChangeAttempts: number;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly sortLagToleranceMs: number;
  private readonly updateSettleMs: number;

  constructor(options: GitHubPullRequestEnumeratorOptions = {}) {
    this.ghRunner = options.ghRunner ?? new GhRunner();
    this.maxListChangeAttempts = assertListChangeAttempts(
      options.maxListChangeAttempts ??
        DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS,
    );
    this.now = options.now ?? (() => new Date());
    this.pageSize = assertGraphqlPageSize(
      options.pageSize ?? DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE,
      "pageSize",
    );
    this.updateSettleMs = assertWindowMs(
      options.updateSettleMs ?? DEFAULT_SYNC_UPDATE_SETTLE_MS,
      "updateSettleMs",
      MAX_SYNC_UPDATE_SETTLE_MS,
    );
    this.sortLagToleranceMs = assertWindowMs(
      options.sortLagToleranceMs ?? DEFAULT_SYNC_SORT_LAG_TOLERANCE_MS,
      "sortLagToleranceMs",
      MAX_SYNC_SORT_LAG_TOLERANCE_MS,
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
    // Fixed once per run so every retry shares the same upper bound.
    const cutoffMs = this.now().getTime() - this.updateSettleMs;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.enumerateStablePullRequestList(
          boundary,
          cutoffMs,
          owner,
          name,
        );
      } catch (error) {
        if (
          !isPullRequestListChanged(error) ||
          attempt >= this.maxListChangeAttempts
        ) {
          throw error;
        }
      }
    }
  }

  /** Restarts from the same sync boundary after an incoherent listing. */
  private async enumerateStablePullRequestList(
    boundary: SyncBoundary,
    cutoffMs: number,
    owner: string,
    name: string,
  ): Promise<EnumerateUpdatedPullRequestsResult> {
    const traversal = new PullRequestListTraversal(
      boundary,
      cutoffMs,
      this.sortLagToleranceMs,
    );
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
      deferred: traversal.deferredCount(),
      nextCursor: resolveNextCursor(boundary, repository, pullRequests),
      pullRequests,
      repository,
    };
  }
}

/**
 * Collects the `UPDATED_AT`-descending listing without assuming it is
 * strictly ordered by `updatedAt`.
 *
 * Assumptions about GitHub's listing, checked against real data:
 * - The sort key never runs ahead of `updatedAt` and lags it by at most
 *   `sortLagToleranceMs`. Every node listed after a node N then has
 *   `updatedAt <= N.updatedAt + sortLagToleranceMs`, so the traversal stops
 *   at the first node where that bound falls outside the boundary window.
 *   Using N's own `updatedAt` as the bound for its sort key is conservative:
 *   a lagging node only delays the stop.
 * - A PR's sort key only ever moves forward. An update moving a PR up the
 *   listing shifts later pages down, which repeats nodes (deduped here) but
 *   never skips one; a PR that jumps over the read position was updated at
 *   or after the cutoff and is left to the next run anyway.
 *
 * Nodes at or after the run cutoff are deferred to the next run, whose
 * boundary still lies before their `updatedAt`. A PR observed with a
 * timestamp at or after the cutoff is deferred even if an earlier page showed
 * it older, since it changed during this run. Below the cutoff a repeat must
 * carry the same `updatedAt`; anything else means the listing contradicts
 * itself and the enumeration fails closed.
 */
class PullRequestListTraversal {
  private readonly deferredIds = new Set<string>();
  private readonly included = new Map<
    string,
    UpdatedPullRequestRef & { readonly updatedAtMs: number }
  >();
  private readonly seenIds = new Map<string, number>();
  private readonly seenNumbers = new Map<number, string>();

  constructor(
    private readonly boundary: SyncBoundary,
    private readonly cutoffMs: number,
    private readonly sortLagToleranceMs: number,
  ) {}

  /** Returns false once no remaining node can be after the boundary. */
  append(nodes: readonly PullRequestListNode[], operation: string): boolean {
    for (const node of nodes) {
      const updatedAtMs = parseIsoTimestampMs(node.updatedAt);
      this.recordIdentity(node, operation);
      const seenUpdatedAtMs = this.seenIds.get(node.id);
      this.seenIds.set(
        node.id,
        Math.max(seenUpdatedAtMs ?? updatedAtMs, updatedAtMs),
      );
      if (updatedAtMs >= this.cutoffMs) {
        if (isAfterSyncBoundary(this.boundary, updatedAtMs, node.number)) {
          this.deferredIds.add(node.id);
        }
        this.included.delete(node.id);
        continue;
      }
      if (seenUpdatedAtMs !== undefined && seenUpdatedAtMs !== updatedAtMs) {
        if (seenUpdatedAtMs >= this.cutoffMs) continue;
        throw duplicateGraphqlNode(operation, `pull request ${node.id}`);
      }
      if (
        seenUpdatedAtMs === undefined &&
        isAfterSyncBoundary(this.boundary, updatedAtMs, node.number)
      ) {
        this.included.set(node.id, {
          id: node.id,
          number: node.number,
          updatedAt: node.updatedAt,
          updatedAtMs,
        });
      }
      if (
        isBeyondSyncBoundaryWindow(
          this.boundary,
          updatedAtMs,
          this.sortLagToleranceMs,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  deferredCount(): number {
    return this.deferredIds.size;
  }

  sortedAscending(): readonly UpdatedPullRequestRef[] {
    return [...this.included.values()]
      .sort(compareSyncOrder)
      .map(({ id, number, updatedAt }) => ({ id, number, updatedAt }));
  }

  private recordIdentity(node: PullRequestListNode, operation: string): void {
    const knownId = this.seenNumbers.get(node.number);
    if (knownId !== undefined && knownId !== node.id) {
      throw duplicateGraphqlNode(
        operation,
        `pull request #${String(node.number)}`,
      );
    }
    this.seenNumbers.set(node.number, node.id);
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

function isPullRequestListChanged(
  error: unknown,
): error is GitHubSnapshotError {
  return (
    error instanceof GitHubSnapshotError &&
    error.code === "PULL_REQUEST_LIST_CHANGED"
  );
}

function assertListChangeAttempts(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SYNC_PULL_REQUEST_LIST_ATTEMPTS
  ) {
    throw new TypeError(
      `maxListChangeAttempts must be between 1 and ${String(MAX_SYNC_PULL_REQUEST_LIST_ATTEMPTS)}`,
    );
  }
  return value;
}

function assertWindowMs(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError(`${name} must be between 0 and ${String(max)}`);
  }
  return value;
}

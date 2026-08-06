import { describe, expect, it, vi } from "vitest";

import {
  FETCH_PULL_REQUEST_REVIEWS_PAGE_QUERY,
  FETCH_PULL_REQUEST_SNAPSHOT_QUERY,
  FETCH_REVIEW_THREAD_COMMENTS_PAGE_QUERY,
  FETCH_REVIEW_THREADS_PAGE_QUERY,
  GhCommandError,
  GitHubPullRequestSnapshotClient,
  type GhRunnerLike,
} from "../src/index.js";

const NOW = "2026-08-06T00:00:00.000Z";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPO_ID = "R_repo_node";
const PR_ID = "PR_pull_node";

describe("GitHubPullRequestSnapshotClient", () => {
  it("fetches independent thread, nested comment, and review cursors before creating a complete snapshot", async () => {
    const initialComments = Array.from({ length: 30 }, (_, index) =>
      comment(index + 1),
    );
    const runner = new FixtureGhRunner(({ operation, variables }) => {
      switch (operation) {
        case "initial":
          expect(variables).toMatchObject({
            commentPageSize: 30,
            name: "repository",
            number: 7,
            owner: "owner",
            reviewPageSize: 50,
            threadPageSize: 20,
          });
          return envelope(
            initialData({
              reviews: connection([review("review-1")], true, "review-cursor"),
              threads: connection(
                [
                  thread(
                    "thread-1",
                    connection(initialComments, true, "comment-cursor"),
                  ),
                ],
                true,
                "thread-cursor",
              ),
            }),
          );
        case "threads":
          expect(variables.after).toBe("thread-cursor");
          return envelope(
            pagedRepositoryData({
              reviewThreads: connection(
                [thread("thread-2", connection([comment(40)], false, null))],
                false,
                null,
              ),
            }),
          );
        case "comments":
          expect(variables).toMatchObject({
            after: "comment-cursor",
            commentPageSize: 30,
            threadId: "thread-1",
          });
          return envelope({
            node: {
              __typename: "PullRequestReviewThread",
              comments: connection([comment(31)], false, null),
              id: "thread-1",
            },
          });
        case "reviews":
          expect(variables.after).toBe("review-cursor");
          return envelope(
            pagedRepositoryData({
              reviews: connection([review("review-2")], false, null),
            }),
          );
      }
    });
    const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);
    const client = new GitHubPullRequestSnapshotClient({
      ghRunner: runner,
      nextSnapshotId,
      now: () => new Date(NOW),
    });

    const result = await client.fetchCompleteSnapshot({
      prNumber: 7,
      repo: "owner/repository",
    });

    expect(result.repository).toEqual({
      id: REPO_ID,
      nameWithOwner: "owner/repository",
    });
    expect(result.pullRequest).toEqual({
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: PR_ID,
      mergedAt: NOW,
      number: 7,
      title: "Complete snapshot",
    });
    expect(result.threads.map((value) => value.id)).toEqual([
      "thread-1",
      "thread-2",
    ]);
    expect(result.threads[0]?.comments).toHaveLength(31);
    expect(result.threads[0]?.comments[0]).toMatchObject({
      author: { __typename: "User", id: "U_reviewer", login: "alice" },
      authorAssociation: "MEMBER",
      body: "Comment 1",
      diffHunk: "@@ -1 +1 @@",
      id: "comment-1",
      url: "https://github.com/owner/repository/pull/7#discussion_r1",
    });
    expect(result.reviewSummaries).toEqual([
      expect.objectContaining({
        id: "review-1",
        syntheticThreadId: "review-summary:review-1",
      }),
      expect.objectContaining({
        id: "review-2",
        syntheticThreadId: "review-summary:review-2",
      }),
    ]);
    expect(result.snapshot).toEqual({
      complete: true,
      observed_at: NOW,
      pr_number: 7,
      repo_id: REPO_ID,
      review_summary_ids: ["review-1", "review-2"],
      snapshot_id: SNAPSHOT_ID,
      thread_ids: ["thread-1", "thread-2"],
    });
    expect(nextSnapshotId).toHaveBeenCalledOnce();
    expect(runner.calls.map((call) => call.operation)).toEqual([
      "initial",
      "threads",
      "comments",
      "reviews",
    ]);
  });

  it.each(["initial", "comments"] as const)(
    "discards data when GraphQL returns errors during the %s request",
    async (partialOperation) => {
      const runner = new FixtureGhRunner(({ operation }) => {
        const data =
          operation === "comments"
            ? {
                node: {
                  __typename: "PullRequestReviewThread",
                  comments: connection([comment(31)], false, null),
                  id: "thread-1",
                },
              }
            : initialData({
                threads: connection(
                  [
                    thread(
                      "thread-1",
                      connection(
                        [comment(1)],
                        partialOperation === "comments",
                        partialOperation === "comments" ? "next-comment" : null,
                      ),
                    ),
                  ],
                  false,
                  null,
                ),
              });
        if (operation === partialOperation) {
          return { data, errors: [{ message: "partial failure" }] };
        }
        return envelope(data);
      });
      const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);
      const client = new GitHubPullRequestSnapshotClient({
        ghRunner: runner,
        nextSnapshotId,
      });

      await expect(
        client.fetchCompleteSnapshot({
          prNumber: 7,
          repo: "owner/repository",
        }),
      ).rejects.toMatchObject({ code: "GRAPHQL_PARTIAL_RESPONSE" });
      expect(nextSnapshotId).not.toHaveBeenCalled();
    },
  );

  it("fails closed when an intermediate connection page request fails", async () => {
    const runner = new FixtureGhRunner(({ operation }) => {
      if (operation === "threads") throw new Error("network unavailable");
      return envelope(
        initialData({
          threads: connection([], true, "next-thread-page"),
        }),
      );
    });
    const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);

    await expect(
      new GitHubPullRequestSnapshotClient({
        ghRunner: runner,
        nextSnapshotId,
      }).fetchCompleteSnapshot({
        prNumber: 7,
        repo: "owner/repository",
      }),
    ).rejects.toMatchObject({
      code: "GRAPHQL_REQUEST_FAILED",
      operation: "reviewThreads page",
    });
    expect(nextSnapshotId).not.toHaveBeenCalled();
  });

  it("wraps gh timeout without returning an incomplete snapshot", async () => {
    const timeout = new GhCommandError(
      "GH_TIMEOUT",
      {
        args: ["api", "graphql"],
        maxBufferExceeded: false,
        stderr: "",
        stdout: "",
        timedOut: true,
      },
      "request timed out",
    );
    const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);
    const client = new GitHubPullRequestSnapshotClient({
      ghRunner: { run: () => Promise.reject(timeout) },
      nextSnapshotId,
    });

    const error = await client
      .fetchCompleteSnapshot({ prNumber: 7, repo: "owner/repository" })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      cause: expect.objectContaining({ code: "GH_TIMEOUT" }),
      code: "GRAPHQL_REQUEST_FAILED",
    });
    expect(nextSnapshotId).not.toHaveBeenCalled();
  });

  it("rejects a connection that claims another page without a cursor", async () => {
    const runner = new FixtureGhRunner(() =>
      envelope(
        initialData({
          threads: connection([], true, null),
        }),
      ),
    );
    const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);

    await expect(
      new GitHubPullRequestSnapshotClient({
        ghRunner: runner,
        nextSnapshotId,
      }).fetchCompleteSnapshot({
        prNumber: 7,
        repo: "owner/repository",
      }),
    ).rejects.toMatchObject({ code: "GRAPHQL_PAGINATION_INVALID" });
    expect(nextSnapshotId).not.toHaveBeenCalled();
  });

  it("rejects repository or PR identity changes between pages", async () => {
    const runner = new FixtureGhRunner(({ operation }) => {
      if (operation === "threads") {
        return envelope({
          repository: {
            id: "R_different",
            pullRequest: {
              id: PR_ID,
              number: 7,
              reviewThreads: connection([], false, null),
            },
          },
        });
      }
      return envelope(
        initialData({ threads: connection([], true, "thread-cursor") }),
      );
    });
    const nextSnapshotId = vi.fn(() => SNAPSHOT_ID);

    await expect(
      new GitHubPullRequestSnapshotClient({
        ghRunner: runner,
        nextSnapshotId,
      }).fetchCompleteSnapshot({
        prNumber: 7,
        repo: "owner/repository",
      }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_CHANGED" });
    expect(nextSnapshotId).not.toHaveBeenCalled();
  });
});

type FixtureOperation = "comments" | "initial" | "reviews" | "threads";

interface FixtureRequest {
  readonly operation: FixtureOperation;
  readonly query: string;
  readonly variables: Readonly<Record<string, number | string>>;
}

class FixtureGhRunner implements GhRunnerLike {
  readonly calls: FixtureRequest[] = [];

  constructor(
    private readonly handler: (
      request: FixtureRequest,
    ) => unknown | Promise<unknown>,
  ) {}

  async run(
    args: readonly string[],
  ): Promise<{ stderr: string; stdout: string }> {
    const query = field(args, "query");
    const request: FixtureRequest = {
      operation: operationFromQuery(query),
      query,
      variables: variables(args),
    };
    this.calls.push(request);
    return {
      stderr: "",
      stdout: JSON.stringify(await this.handler(request)),
    };
  }
}

function operationFromQuery(query: string): FixtureOperation {
  if (query === FETCH_PULL_REQUEST_SNAPSHOT_QUERY) return "initial";
  if (query === FETCH_REVIEW_THREADS_PAGE_QUERY) return "threads";
  if (query === FETCH_REVIEW_THREAD_COMMENTS_PAGE_QUERY) return "comments";
  if (query === FETCH_PULL_REQUEST_REVIEWS_PAGE_QUERY) return "reviews";
  throw new Error("Unexpected fixture GraphQL query");
}

function field(args: readonly string[], name: string): string {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-f" && args[index] !== "-F") continue;
    const value = args[index + 1]!;
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  throw new Error(`Missing gh field ${name}`);
}

function variables(
  args: readonly string[],
): Readonly<Record<string, number | string>> {
  const result: Record<string, number | string> = {};
  for (let index = 0; index < args.length - 1; index += 1) {
    const flag = args[index];
    if (flag !== "-f" && flag !== "-F") continue;
    const value = args[index + 1]!;
    const equals = value.indexOf("=");
    const key = value.slice(0, equals);
    if (key === "query") continue;
    const raw = value.slice(equals + 1);
    result[key] = flag === "-F" ? Number(raw) : raw;
  }
  return result;
}

function envelope(data: unknown): unknown {
  return { data };
}

function initialData(
  options: {
    readonly reviews?: unknown;
    readonly threads?: unknown;
  } = {},
): unknown {
  return {
    repository: {
      id: REPO_ID,
      nameWithOwner: "owner/repository",
      pullRequest: {
        baseRefOid: "base-oid",
        headRefOid: "head-oid",
        id: PR_ID,
        mergedAt: NOW,
        number: 7,
        reviewThreads: options.threads ?? connection([], false, null),
        reviews: options.reviews ?? connection([], false, null),
        title: "Complete snapshot",
      },
    },
  };
}

function pagedRepositoryData(connectionValue: {
  readonly reviewThreads?: unknown;
  readonly reviews?: unknown;
}): unknown {
  return {
    repository: {
      id: REPO_ID,
      pullRequest: {
        id: PR_ID,
        number: 7,
        ...connectionValue,
      },
    },
  };
}

function connection<T>(
  nodes: readonly T[],
  hasNextPage: boolean,
  endCursor: string | null,
): unknown {
  return { nodes, pageInfo: { endCursor, hasNextPage } };
}

function thread(id: string, comments: unknown): unknown {
  return {
    comments,
    id,
    isOutdated: false,
    isResolved: true,
    path: "src/index.ts",
  };
}

function comment(index: number): unknown {
  return {
    author: { __typename: "User", id: "U_reviewer", login: "alice" },
    authorAssociation: "MEMBER",
    body: `Comment ${index}`,
    createdAt: NOW,
    diffHunk: "@@ -1 +1 @@",
    id: `comment-${index}`,
    updatedAt: NOW,
    url: `https://github.com/owner/repository/pull/7#discussion_r${index}`,
  };
}

function review(id: string): unknown {
  return {
    author: { __typename: "Bot", id: "BOT_reviewer", login: "review-bot" },
    authorAssociation: "NONE",
    body: `Summary ${id}`,
    createdAt: NOW,
    id,
    state: "COMMENTED",
    submittedAt: NOW,
    updatedAt: NOW,
    url: `https://github.com/owner/repository/pull/7#pullrequestreview-${id}`,
  };
}

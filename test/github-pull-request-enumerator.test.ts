import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE,
  LIST_UPDATED_PULL_REQUESTS_PAGE_QUERY,
  LIST_UPDATED_PULL_REQUESTS_QUERY,
  GitHubPullRequestEnumerator,
  SYNC_CURSOR_VERSION,
  type GhRunnerLike,
  type SyncCursor,
} from "../src/experimental.js";

const REPO_ID = "R_repo_node";
const REPO_NAME = "owner/repository";
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");
const ONE_MINUTE_MS = 60_000;

describe("GitHubPullRequestEnumerator", () => {
  it("enumerates more than 100 PRs across pages in deterministic ascending order", async () => {
    const total = 105;
    // DESC listing: newest first (PR number == minutes offset from BASE_MS).
    const descending = numbersDescending(total).map((number) => node(number));
    const pages = [
      page(descending.slice(0, 100), "cursor-1"),
      page(descending.slice(100), null),
    ];
    const buildRunner = (): FixtureGhRunner => pagedRunner(pages);
    const enumerate = async (
      runner: FixtureGhRunner,
    ): Promise<
      Awaited<
        ReturnType<GitHubPullRequestEnumerator["enumerateUpdatedPullRequests"]>
      >
    > =>
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
        pageSize: 100,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME });

    const first = await enumerate(buildRunner());
    const second = await enumerate(buildRunner());

    expect(first.pullRequests.map((pr) => pr.number)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );
    expect(first.repository).toEqual({ id: REPO_ID, nameWithOwner: REPO_NAME });
    expect(first.nextCursor).toEqual({
      last_pr_number: total,
      last_updated_at: isoAt(total),
      repo_id: REPO_ID,
      version: SYNC_CURSOR_VERSION,
    });
    // Same complete snapshot => same order and same next cursor.
    expect(second).toEqual(first);
  });

  it("sends the documented queries and page size variables", async () => {
    const runner = pagedRunner([
      page([node(2), node(1)], "cursor-1"),
      page([], null),
    ]);

    await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ repo: REPO_NAME });

    expect(runner.calls.map((call) => call.query)).toEqual([
      LIST_UPDATED_PULL_REQUESTS_QUERY,
      LIST_UPDATED_PULL_REQUESTS_PAGE_QUERY,
    ]);
    expect(runner.calls[0]?.variables).toEqual({
      name: "repository",
      owner: "owner",
      pageSize: DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE,
    });
    expect(runner.calls[1]?.variables).toMatchObject({ after: "cursor-1" });
  });

  it("does not lose same-timestamp PRs when resuming from a cursor", async () => {
    const sharedMs = timestampMs(5);
    const runner = pagedRunner([
      page(
        [
          node(7, sharedMs),
          node(6, sharedMs),
          node(5, sharedMs),
          node(4, sharedMs - ONE_MINUTE_MS),
        ],
        "cursor-1",
      ),
      page([node(3, sharedMs - 2 * ONE_MINUTE_MS)], null),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(5, sharedMs),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([6, 7]);
    expect(result.nextCursor).toMatchObject({ last_pr_number: 7 });
    // #4 is strictly older than the cursor timestamp, so page 2 is never fetched.
    expect(runner.calls).toHaveLength(1);
  });

  it("treats --since as exclusive and only enumerates strictly newer PRs", async () => {
    const sinceMs = timestampMs(2);
    const runner = pagedRunner([
      page(
        [
          node(3, sinceMs + ONE_MINUTE_MS),
          node(2, sinceMs),
          node(1, sinceMs - ONE_MINUTE_MS),
        ],
        null,
      ),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({
      repo: REPO_NAME,
      since: new Date(sinceMs).toISOString(),
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([3]);
    expect(result.nextCursor).toMatchObject({
      last_pr_number: 3,
      last_updated_at: new Date(sinceMs + ONE_MINUTE_MS).toISOString(),
    });
  });

  it("returns an empty listing without a cursor for an empty repository", async () => {
    const runner = pagedRunner([page([], null)]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ repo: REPO_NAME });

    expect(result.pullRequests).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("keeps the caller's cursor when no PR is newer than it", async () => {
    const cursor = cursorAt(9, timestampMs(9));
    const runner = pagedRunner([page([node(9)], null)]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ cursor, repo: REPO_NAME });

    expect(result.pullRequests).toEqual([]);
    expect(result.nextCursor).toEqual(cursor);
  });

  it("fails closed when a PR repeats across pages during traversal", async () => {
    const runner = pagedRunner([
      page([node(10)], "cursor-1"),
      page([node(10)], null),
    ]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "DUPLICATE_GRAPHQL_NODE" });
  });

  it("fails closed when the updatedAt ordering regresses mid-traversal", async () => {
    const runner = pagedRunner([
      page([node(10)], "cursor-1"),
      page([node(11)], null),
    ]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_LIST_CHANGED" });
  });

  it("follows a rename when the repository node ID stays stable", async () => {
    const runner = pagedRunner([
      page([node(2)], "cursor-1"),
      page([node(1)], null, { nameWithOwner: "owner/renamed" }),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ repo: REPO_NAME });

    expect(result.repository).toEqual({
      id: REPO_ID,
      nameWithOwner: "owner/renamed",
    });
    expect(result.pullRequests.map((pr) => pr.number)).toEqual([1, 2]);
  });

  it("fails closed when the repository node ID changes mid-traversal", async () => {
    const runner = pagedRunner([
      page([node(2)], "cursor-1"),
      page([node(1)], null, { id: "R_other_repo" }),
    ]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_LIST_CHANGED" });
  });

  it("rejects a cursor issued for a different repository", async () => {
    const runner = pagedRunner([page([node(1)], null)]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({
        cursor: { ...cursorAt(1, timestampMs(1)), repo_id: "R_other_repo" },
        repo: REPO_NAME,
      }),
    ).rejects.toMatchObject({ code: "SYNC_CURSOR_REPOSITORY_MISMATCH" });
  });

  it.each([
    [
      "hasNextPage without an endCursor",
      [page([node(1)], null, { hasNextPageWithoutCursor: true })],
      "GRAPHQL_PAGINATION_INVALID",
    ],
    [
      "a repeated connection cursor",
      [
        page([node(3)], "cursor-1"),
        page([node(2)], "cursor-1"),
        page([node(1)], null),
      ],
      "GRAPHQL_PAGINATION_INVALID",
    ],
  ] as const)(
    "does not return a cursor when pagination reports %s",
    async (_description, pages, code) => {
      await expect(
        new GitHubPullRequestEnumerator({
          ghRunner: pagedRunner([...pages]),
        }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("fails closed when the boundary-reaching page reports hasNextPage without an endCursor", async () => {
    const boundaryMs = timestampMs(5);
    // #4 is strictly older than the cursor boundary, so this page exhausts
    // the traversal; its malformed pageInfo must still be rejected.
    const runner = pagedRunner([
      page(
        [
          node(6, boundaryMs + ONE_MINUTE_MS),
          node(4, boundaryMs - ONE_MINUTE_MS),
        ],
        null,
        {
          hasNextPageWithoutCursor: true,
        },
      ),
    ]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({
        cursor: cursorAt(5, boundaryMs),
        repo: REPO_NAME,
      }),
    ).rejects.toMatchObject({ code: "GRAPHQL_PAGINATION_INVALID" });
  });

  it("discards data when GraphQL reports errors", async () => {
    const runner = new FixtureGhRunner(() => ({
      data: page([node(1)], null),
      errors: [{ message: "partial failure" }],
    }));

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "GRAPHQL_PARTIAL_RESPONSE" });
  });

  it("reports a missing repository", async () => {
    const runner = new FixtureGhRunner(() => ({
      data: { repository: null },
    }));

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });
});

interface FixtureRequest {
  readonly query: string;
  readonly variables: Readonly<Record<string, number | string>>;
}

class FixtureGhRunner implements GhRunnerLike {
  readonly calls: FixtureRequest[] = [];

  constructor(private readonly handler: (request: FixtureRequest) => unknown) {}

  async run(
    args: readonly string[],
  ): Promise<{ stderr: string; stdout: string }> {
    const request: FixtureRequest = {
      query: field(args, "query"),
      variables: variables(args),
    };
    this.calls.push(request);
    return {
      stderr: "",
      stdout: JSON.stringify(await Promise.resolve(this.handler(request))),
    };
  }
}

function pagedRunner(pages: readonly unknown[]): FixtureGhRunner {
  let index = 0;
  return new FixtureGhRunner(() => {
    const current = pages[index];
    if (current === undefined) throw new Error("Fixture ran out of pages");
    index += 1;
    return { data: current };
  });
}

interface PageOverrides {
  readonly hasNextPageWithoutCursor?: boolean;
  readonly id?: string;
  readonly nameWithOwner?: string;
}

function page(
  nodes: readonly unknown[],
  endCursor: string | null,
  overrides: PageOverrides = {},
): unknown {
  return {
    repository: {
      id: overrides.id ?? REPO_ID,
      nameWithOwner: overrides.nameWithOwner ?? REPO_NAME,
      pullRequests: {
        nodes,
        pageInfo: {
          endCursor,
          hasNextPage:
            (overrides.hasNextPageWithoutCursor ?? false) || endCursor !== null,
        },
      },
    },
  };
}

function node(number: number, updatedAtMs = timestampMs(number)): unknown {
  return {
    id: `PR_node_${String(number)}`,
    number,
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

function cursorAt(number: number, updatedAtMs: number): SyncCursor {
  return {
    last_pr_number: number,
    last_updated_at: new Date(updatedAtMs).toISOString(),
    repo_id: REPO_ID,
    version: SYNC_CURSOR_VERSION,
  };
}

function numbersDescending(total: number): number[] {
  return Array.from({ length: total }, (_, index) => total - index);
}

function timestampMs(number: number): number {
  return BASE_MS + number * ONE_MINUTE_MS;
}

function isoAt(number: number): string {
  return new Date(timestampMs(number)).toISOString();
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
    if (equals === -1) throw new Error(`Invalid gh field ${value}`);
    const key = value.slice(0, equals);
    if (key === "query") continue;
    const raw = value.slice(equals + 1);
    result[key] = flag === "-F" ? Number(raw) : raw;
  }
  return result;
}

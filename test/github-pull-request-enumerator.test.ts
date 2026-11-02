import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS,
  DEFAULT_SYNC_PULL_REQUEST_PAGE_SIZE,
  DEFAULT_SYNC_SORT_LAG_TOLERANCE_MS,
  DEFAULT_SYNC_UPDATE_SETTLE_MS,
  LIST_UPDATED_PULL_REQUESTS_PAGE_QUERY,
  LIST_UPDATED_PULL_REQUESTS_QUERY,
  GitHubPullRequestEnumerator,
  SYNC_CURSOR_VERSION,
  GITHUB_SERVER_TIME_ARGS,
  parseGitHubServerDate,
  type GhRunnerLike,
  type SyncCursor,
} from "../src/experimental.js";

const REPO_ID = "R_repo_node";
const REPO_NAME = "owner/repository";
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");
const ONE_SECOND_MS = 1_000;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
// GitHub's time unless a test sets one: well after every fixture timestamp.
const DEFAULT_SERVER_MS = BASE_MS + 30 * ONE_DAY_MS;

describe("GitHubPullRequestEnumerator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads GitHub's server time once, before the first page, across retries", async () => {
    const runner = pagedRunner([
      page([node(11), node(10)], "cursor-1"),
      page([node(10, timestampMs(12))], null),
      page([node(10, timestampMs(12)), node(11)], null),
    ]).withServerTime(timestampMs(30));

    await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(9, timestampMs(9)),
      repo: REPO_NAME,
    });

    expect(runner.log).toEqual([
      "server-time",
      "graphql",
      "graphql",
      "graphql",
    ]);
  });

  it("derives the cutoff from GitHub's server time regardless of the local clock", async () => {
    const serverMs = timestampMs(20);
    const cutoffMs = serverMs - DEFAULT_SYNC_UPDATE_SETTLE_MS;
    const run = async (): Promise<
      Awaited<
        ReturnType<GitHubPullRequestEnumerator["enumerateUpdatedPullRequests"]>
      >
    > =>
      new GitHubPullRequestEnumerator({
        ghRunner: pagedRunner([
          page(
            [node(19, cutoffMs), node(18, cutoffMs - 1_000), node(17)],
            null,
          ),
        ]).withServerTime(serverMs),
      }).enumerateUpdatedPullRequests({
        cursor: cursorAt(16, timestampMs(16)),
        repo: REPO_NAME,
      });

    const results = [];
    for (const localSkewMs of [0, ONE_DAY_MS, -ONE_DAY_MS]) {
      vi.useFakeTimers({ now: serverMs + localSkewMs, toFake: ["Date"] });
      results.push(await run());
      vi.useRealTimers();
    }

    expect(results[0]?.pullRequests.map((pr) => pr.number)).toEqual([17, 18]);
    expect(results[0]?.deferred).toBe(1);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("picks up next run a PR that an update moved into already-read pages", async () => {
    // #13 is updated just before run 1 reads page 1, then unread #8 is
    // updated in the same second (both after GitHub's Date header) and jumps
    // into the already-read pages, so run 1 never sees #8. With the host clock
    // a day ahead, a local-clock cutoff would include #13 and advance the
    // checkpoint to (#13's second, #13), past #8's (same second, #8), losing
    // #8 for good. The server-time cutoff defers #13 instead, so the
    // checkpoint stays before #8's new updatedAt and run 2 collects both.
    const run1ServerMs = timestampMs(30);
    const updatedEightMs = run1ServerMs + ONE_SECOND_MS;
    vi.useFakeTimers({ now: run1ServerMs + ONE_DAY_MS, toFake: ["Date"] });

    const run1 = await new GitHubPullRequestEnumerator({
      ghRunner: pagedRunner([
        page([node(13, updatedEightMs), node(12), node(11)], "cursor-1"),
        // Offset-based page 2 after #8 moved to the top: #11 repeats, #8 is gone.
        page([node(11), node(10), node(9), node(7)], null),
      ]).withServerTime(run1ServerMs),
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(6, timestampMs(6)),
      repo: REPO_NAME,
    });

    expect(run1.pullRequests.map((pr) => pr.number)).toEqual([
      7, 9, 10, 11, 12,
    ]);
    expect(run1.deferred).toBe(1);
    expect(run1.nextCursor).toMatchObject({ last_pr_number: 12 });

    vi.setSystemTime(timestampMs(60) + ONE_DAY_MS);
    const run2 = await new GitHubPullRequestEnumerator({
      ghRunner: pagedRunner([
        page(
          [node(8, updatedEightMs), node(13, updatedEightMs), node(12)],
          "cursor-1",
        ),
        page([node(10), node(9), node(7)], null),
      ]).withServerTime(timestampMs(60)),
    }).enumerateUpdatedPullRequests({
      cursor: run1.nextCursor ?? undefined,
      repo: REPO_NAME,
    });

    expect(run2.pullRequests).toEqual(
      [8, 13].map((number) => ({
        id: `PR_node_${String(number)}`,
        number,
        updatedAt: new Date(updatedEightMs).toISOString(),
      })),
    );
  });

  it("fails closed with a retryable code when the Date header is missing", async () => {
    const runner = pagedRunner([page([node(1)], null)]);
    runner.serverTimeResponse = () =>
      ["HTTP/2.0 200 OK", "Content-Type: application/json", "", "{}"].join(
        "\r\n",
      );

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "GITHUB_SERVER_TIME_UNAVAILABLE" });
    // No page is read without a trustworthy cutoff.
    expect(runner.calls).toHaveLength(0);
  });

  it("fails closed with a retryable code when the server time request fails", async () => {
    const runner = pagedRunner([page([node(1)], null)]);
    runner.serverTimeResponse = () => {
      throw new Error("network down");
    };

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "GITHUB_SERVER_TIME_UNAVAILABLE" });
    expect(runner.calls).toHaveLength(0);
  });

  it("parses only a single well-formed Date header from a 2xx response", () => {
    const response = (status: string, ...headers: string[]): string =>
      [status, ...headers, "", '{"date":"Mon, 01 Jan 2001 00:00:00 GMT"}'].join(
        "\r\n",
      );

    expect(
      parseGitHubServerDate(
        response("HTTP/2.0 200 OK", "date:  Mon, 02 Nov 2026 09:33:22 GMT"),
      ).toISOString(),
    ).toBe("2026-11-02T09:33:22.000Z");
    expect(
      parseGitHubServerDate(
        "HTTP/1.1 200 OK\nDate: Mon, 02 Nov 2026 09:33:22 GMT\n\n{}",
      ).toISOString(),
    ).toBe("2026-11-02T09:33:22.000Z");
    for (const invalid of [
      response("HTTP/2.0 200 OK"),
      response(
        "HTTP/2.0 304 Not Modified",
        "Date: Mon, 02 Nov 2026 09:33:22 GMT",
      ),
      response("HTTP/2.0 200 OK", "Date: 2026-11-02T09:33:22Z"),
      response("HTTP/2.0 200 OK", "Date: Mon, 32 Nov 2026 09:33:22 GMT"),
      response(
        "HTTP/2.0 200 OK",
        "Date: Mon, 02 Nov 2026 09:33:22 GMT",
        "Date: Mon, 02 Nov 2026 09:33:23 GMT",
      ),
      "",
    ]) {
      expect(() => parseGitHubServerDate(invalid)).toThrow(
        expect.objectContaining({ code: "GITHUB_SERVER_TIME_UNAVAILABLE" }),
      );
    }
  });

  it("parses a Date header padded with tabs in linear time", () => {
    const padding = "\t".repeat(200_000);
    const started = performance.now();
    expect(
      parseGitHubServerDate(
        `HTTP/2.0 200 OK\r\nDate:${padding}Mon, 02 Nov 2026 09:33:22 GMT${padding}\r\n\r\n{}`,
      ).toISOString(),
    ).toBe("2026-11-02T09:33:22.000Z");
    expect(() =>
      parseGitHubServerDate(`HTTP/2.0 200 OK\r\ndate:${padding}x\r\n\r\n{}`),
    ).toThrow(
      expect.objectContaining({ code: "GITHUB_SERVER_TIME_UNAVAILABLE" }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

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
      sortLagToleranceMs: 0,
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

  it("defers a PR updated mid-enumeration instead of failing the listing", async () => {
    // #13 was updated after the run started: it resurfaces out of order with
    // a timestamp past the run cutoff, which used to abort the whole sync.
    const runner = pagedRunner([
      page([node(12), node(11)], "cursor-1"),
      page([node(13, timestampMs(40)), node(10), node(9)], null),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(timestampMs(30)),
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(9, timestampMs(9)),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([10, 11, 12]);
    expect(result.deferred).toBe(1);
    // The checkpoint still advances; #13's new updatedAt lies after it, so
    // the next run picks it up.
    expect(result.nextCursor).toMatchObject({
      last_pr_number: 12,
      last_updated_at: isoAt(12),
    });
    expect(runner.calls).toHaveLength(2);
  });

  it("defers PRs updated at or after the settle cutoff fixed at run start", async () => {
    const nowMs = timestampMs(20);
    const cutoffMs = nowMs - DEFAULT_SYNC_UPDATE_SETTLE_MS;
    const runner = pagedRunner([
      page(
        [
          node(21, cutoffMs + 1),
          node(20, cutoffMs),
          node(19, cutoffMs - 1),
          node(18),
        ],
        null,
      ),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(nowMs),
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(17, timestampMs(17)),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([18, 19]);
    expect(result.deferred).toBe(2);
    expect(result.nextCursor).toMatchObject({ last_pr_number: 19 });
  });

  it("does not count deferred PRs that are not after the boundary", async () => {
    const runner = pagedRunner([page([node(5, timestampMs(30))], null)]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(timestampMs(30)),
      updateSettleMs: 0,
    }).enumerateUpdatedPullRequests({
      repo: REPO_NAME,
      since: new Date(timestampMs(31)).toISOString(),
    });

    expect(result.pullRequests).toEqual([]);
    expect(result.deferred).toBe(0);
  });

  it("skips the identical repeat that a page shift produces", async () => {
    // An update moving a PR to the top shifts offset-based pages by one, so
    // the last node of page 1 is served again at the start of page 2.
    const runner = pagedRunner([
      page([node(12), node(11)], "cursor-1"),
      page([node(11), node(10)], null),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ repo: REPO_NAME });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([10, 11, 12]);
    expect(result.deferred).toBe(0);
  });

  it("rejects an invalid update settle window", () => {
    for (const updateSettleMs of [-1, 1.5, 24 * 60 * 60 * 1_000 + 1]) {
      expect(
        () =>
          new GitHubPullRequestEnumerator({
            ghRunner: pagedRunner([]),
            updateSettleMs,
          }),
      ).toThrow(TypeError);
    }
  });

  it("rejects an invalid sort lag tolerance", () => {
    for (const sortLagToleranceMs of [-1, 1.5, 90 * ONE_DAY_MS + 1]) {
      expect(
        () =>
          new GitHubPullRequestEnumerator({
            ghRunner: pagedRunner([]),
            sortLagToleranceMs,
          }),
      ).toThrow(TypeError);
    }
  });

  it("bounds retries when a PR keeps repeating below the cutoff with a different updatedAt", async () => {
    // The server-time cutoff keeps mid-run updates out of this range, so a
    // repeat below it with a new updatedAt means GitHub's own clocks
    // disagree; the listing is restarted, but only a bounded number of times.
    const pages = Array.from(
      { length: DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS },
      (_, index) => [
        page([node(10)], `cursor-${String(index)}`),
        page([node(10, timestampMs(9))], null),
      ],
    ).flat();
    const runner = pagedRunner(pages);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_LIST_CHANGED" });
    expect(runner.calls).toHaveLength(
      DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS * 2,
    );
  });

  it("restarts the listing when a PR repeats below the cutoff with a different updatedAt", async () => {
    const runner = pagedRunner([
      page([node(11), node(10)], "cursor-1"),
      page([node(10, timestampMs(12))], null),
      page([node(10, timestampMs(12)), node(11)], null),
    ]);
    const cursor = cursorAt(9, timestampMs(9));

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(timestampMs(30)),
    }).enumerateUpdatedPullRequests({ cursor, repo: REPO_NAME });

    expect(result.pullRequests).toEqual([
      { id: "PR_node_11", number: 11, updatedAt: isoAt(11) },
      { id: "PR_node_10", number: 10, updatedAt: isoAt(12) },
    ]);
    expect(result.deferred).toBe(0);
    expect(runner.calls.map((call) => call.variables.after ?? null)).toEqual([
      null,
      "cursor-1",
      null,
    ]);
  });

  it("collects PRs that GitHub lists out of updatedAt order", async () => {
    // Anonymized shape of a real listing (orderBy UPDATED_AT DESC) that made
    // every sync fail with PULL_REQUEST_LIST_CHANGED: GitHub sorts by an
    // internal key that can lag the returned updatedAt, so some PRs show up
    // later than their updatedAt implies (+620s, +3s, and one +4h15m14s lag
    // listed below the checkpoint). The listing is static, so retrying never
    // helped. Everything after the checkpoint must be collected exactly once.
    const boundaryMs = BASE_MS;
    const at = (offsetMs: number): number => boundaryMs + offsetMs;
    const runner = pagedRunner([
      page(
        [
          node(21, at(3 * ONE_HOUR_MS)),
          node(20, at(2 * ONE_HOUR_MS)),
          node(19, at(ONE_HOUR_MS)),
          node(22, at(ONE_HOUR_MS + 620 * ONE_SECOND_MS)),
          node(18, at(30 * ONE_MINUTE_MS)),
        ],
        "cursor-1",
      ),
      page(
        [
          node(17, at(10 * ONE_MINUTE_MS)),
          node(16, at(5 * ONE_MINUTE_MS)),
          node(23, at(5 * ONE_MINUTE_MS + 3 * ONE_SECOND_MS)),
          // The first node older than the checkpoint: the old traversal
          // stopped here and would never have reached #24.
          node(15, at(-10 * ONE_MINUTE_MS)),
          node(24, at(-10 * ONE_MINUTE_MS + 15_314 * ONE_SECOND_MS)),
        ],
        "cursor-2",
      ),
      page(
        [
          node(14, at(-2 * ONE_DAY_MS)),
          // Older than the checkpoint by more than the lag tolerance: no
          // later node can be after the checkpoint, so page 4 is not read.
          node(13, at(-DEFAULT_SYNC_SORT_LAG_TOLERANCE_MS - ONE_SECOND_MS)),
        ],
        "cursor-3",
      ),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(at(ONE_DAY_MS)),
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(12, boundaryMs),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([
      16, 23, 17, 18, 19, 22, 20, 21, 24,
    ]);
    expect(result.deferred).toBe(0);
    expect(result.nextCursor).toMatchObject({
      last_pr_number: 24,
      last_updated_at: new Date(
        at(-10 * ONE_MINUTE_MS + 15_314 * ONE_SECOND_MS),
      ).toISOString(),
    });
    expect(runner.calls).toHaveLength(3);
  });

  it("keeps reading while a node is within the lag tolerance of the boundary", async () => {
    const boundaryMs = BASE_MS;
    const runner = pagedRunner([
      page([node(13, boundaryMs + ONE_MINUTE_MS)], "cursor-1"),
      // Exactly at the tolerance: a node lagging by the full tolerance could
      // still follow with an updatedAt equal to the boundary.
      page([node(9, boundaryMs - ONE_HOUR_MS)], "cursor-2"),
      page(
        [node(12, boundaryMs), node(8, boundaryMs - 2 * ONE_HOUR_MS)],
        "cursor-3",
      ),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
      sortLagToleranceMs: ONE_HOUR_MS,
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(11, boundaryMs),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([12, 13]);
    expect(runner.calls).toHaveLength(3);
  });

  it("defers a PR seen below the cutoff and again after it was updated mid-run", async () => {
    const runner = pagedRunner([
      page([node(12), node(11)], "cursor-1"),
      page([node(11, timestampMs(40)), node(10)], null),
    ]);

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner.withServerTime(timestampMs(30)),
    }).enumerateUpdatedPullRequests({
      cursor: cursorAt(9, timestampMs(9)),
      repo: REPO_NAME,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([10, 12]);
    expect(result.deferred).toBe(1);
  });

  it("fails closed when two node IDs claim the same PR number", async () => {
    const runner = pagedRunner([
      page([node(10)], "cursor-1"),
      page([{ ...(node(10) as object), id: "PR_node_other" }], null),
    ]);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "DUPLICATE_GRAPHQL_NODE" });
  });

  it("restarts a changed listing from the same cursor boundary", async () => {
    const runner = pagedRunner([
      page([node(11)], "stale-cursor"),
      page([node(10)], null, { id: "R_other_repo" }),
      page([node(11), node(10), node(9)], null),
    ]);
    const cursor = cursorAt(9, timestampMs(9));

    const result = await new GitHubPullRequestEnumerator({
      ghRunner: runner,
    }).enumerateUpdatedPullRequests({ cursor, repo: REPO_NAME });

    expect(
      result.pullRequests.map((pullRequest) => pullRequest.number),
    ).toEqual([10, 11]);
    expect(result.nextCursor).toMatchObject({ last_pr_number: 11 });
    expect(runner.calls.map((call) => call.variables.after ?? null)).toEqual([
      null,
      "stale-cursor",
      null,
    ]);
  });

  it("bounds repeated retries when every listing attempt changes", async () => {
    const pages = Array.from(
      { length: DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS },
      (_, index) => [
        page([node(11)], `stale-cursor-${String(index)}`),
        page([node(10)], null, { id: "R_other_repo" }),
      ],
    ).flat();
    const runner = pagedRunner(pages);

    await expect(
      new GitHubPullRequestEnumerator({
        ghRunner: runner,
      }).enumerateUpdatedPullRequests({ repo: REPO_NAME }),
    ).rejects.toMatchObject({ code: "PULL_REQUEST_LIST_CHANGED" });
    expect(runner.calls).toHaveLength(
      DEFAULT_SYNC_PULL_REQUEST_LIST_MAX_ATTEMPTS * 2,
    );
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
        maxListChangeAttempts: 1,
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
        sortLagToleranceMs: 0,
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
  /** GraphQL requests only; server time reads are counted separately. */
  readonly calls: FixtureRequest[] = [];
  readonly log: ("graphql" | "server-time")[] = [];
  serverTimeResponse: () => string = () =>
    serverTimeResponse(DEFAULT_SERVER_MS);

  constructor(private readonly handler: (request: FixtureRequest) => unknown) {}

  withServerTime(serverMs: number): this {
    this.serverTimeResponse = () => serverTimeResponse(serverMs);
    return this;
  }

  async run(
    args: readonly string[],
  ): Promise<{ stderr: string; stdout: string }> {
    if (args[0] === "api" && args[1] !== "graphql") {
      expect(args).toEqual(GITHUB_SERVER_TIME_ARGS);
      this.log.push("server-time");
      return { stderr: "", stdout: this.serverTimeResponse() };
    }
    this.log.push("graphql");
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

function serverTimeResponse(serverMs: number): string {
  // Shape of `gh api --include` output; the Date header has 1 s precision.
  return [
    "HTTP/2.0 200 OK",
    "Content-Type: application/json; charset=utf-8",
    `Date: ${new Date(serverMs).toUTCString()}`,
    "",
    '{"resources":{}}',
  ].join("\r\n");
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

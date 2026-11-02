import type { GhCommandResult, GhRunnerLike } from "./gh-runner.js";
import { GitHubSnapshotError } from "./github-graphql.js";

/**
 * `GET /rate_limit` does not count against the primary rate limit, so it is
 * the cheapest request whose response carries GitHub's `Date` header.
 */
export const GITHUB_SERVER_TIME_ARGS: readonly string[] = [
  "api",
  "--include",
  "/rate_limit",
];

const OPERATION = "GitHub server time";
// RFC 9110 IMF-fixdate, the only form GitHub (and RFC-compliant servers) send.
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Reads GitHub's current time from the `Date` header of a `gh api --include`
 * response. The header has one-second precision and is truncated, so the
 * returned instant is at or before the moment GitHub produced the response.
 * Fails closed with a retryable `GITHUB_SERVER_TIME_UNAVAILABLE` instead of
 * falling back to the local clock.
 */
export async function readGitHubServerTime(
  ghRunner: GhRunnerLike,
): Promise<Date> {
  let result: GhCommandResult;
  try {
    result = await ghRunner.run(GITHUB_SERVER_TIME_ARGS);
  } catch (error) {
    throw serverTimeUnavailable("gh api request for /rate_limit failed", {
      cause: error,
    });
  }
  return parseGitHubServerDate(result.stdout);
}

/** Extracts the single `Date` header from `gh api --include` output. */
export function parseGitHubServerDate(stdout: string): Date {
  const headerEnd = stdout.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd === -1 ? stdout : stdout.slice(0, headerEnd);
  const lines = headerBlock.split(/\r?\n/);
  if (!/^HTTP\/\S+ 2\d\d\b/.test(lines[0] ?? "")) {
    throw serverTimeUnavailable("response did not start with a 2xx status");
  }
  const dates = lines
    .slice(1)
    .map((line) => /^date:[ \t]*(.*?)[ \t]*$/i.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (dates.length !== 1) {
    throw serverTimeUnavailable(
      `expected exactly one Date header, found ${String(dates.length)}`,
    );
  }
  const value = dates[0]!;
  const ms = IMF_FIXDATE.test(value) ? Date.parse(value) : Number.NaN;
  // The round trip rejects calendar overflow such as "32 Nov" or a weekday
  // that does not match the date.
  if (!Number.isFinite(ms) || new Date(ms).toUTCString() !== value) {
    throw serverTimeUnavailable("Date header is not a valid IMF-fixdate");
  }
  return new Date(ms);
}

function serverTimeUnavailable(
  message: string,
  options?: ErrorOptions,
): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "GITHUB_SERVER_TIME_UNAVAILABLE",
    OPERATION,
    `could not read GitHub's server time: ${message}`,
    options,
  );
}

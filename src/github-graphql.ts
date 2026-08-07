import { z } from "zod";

import { type GhRunnerLike } from "./gh-runner.js";

export const MAX_GRAPHQL_PAGE_SIZE = 100;
export const MAX_GRAPHQL_CONNECTION_PAGES = 10_000;
export const PAGE_INFO_FIELDS = "hasNextPage endCursor";

export const GraphqlPageInfoSchema = z
  .object({
    endCursor: z.string().min(1).nullable(),
    hasNextPage: z.boolean(),
  })
  .strict();

export type GraphqlPageInfo = z.infer<typeof GraphqlPageInfoSchema>;

const GraphqlEnvelopeSchema = z
  .object({
    data: z.unknown().nullable().optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type GitHubSnapshotErrorCode =
  | "DUPLICATE_GRAPHQL_NODE"
  | "GRAPHQL_PAGINATION_INVALID"
  | "GRAPHQL_PARTIAL_RESPONSE"
  | "GRAPHQL_REQUEST_FAILED"
  | "GRAPHQL_RESPONSE_INVALID"
  | "PULL_REQUEST_CHANGED"
  | "PULL_REQUEST_LIST_CHANGED"
  | "PULL_REQUEST_NOT_FOUND"
  | "REPOSITORY_NOT_FOUND"
  | "SNAPSHOT_INVALID";

export class GitHubSnapshotError extends Error {
  constructor(
    readonly code: GitHubSnapshotErrorCode,
    readonly operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "GitHubSnapshotError";
  }
}

export interface ExecuteGhGraphqlRequest<T> {
  readonly ghRunner: GhRunnerLike;
  readonly integerVariables?: Readonly<Record<string, number>>;
  readonly operation: string;
  readonly query: string;
  readonly schema: z.ZodType<T>;
  readonly stringListVariables?: Readonly<Record<string, readonly string[]>>;
  readonly stringVariables?: Readonly<Record<string, string>>;
}

/** Runs one `gh api graphql` request and fails closed on every partial state. */
export async function executeGhGraphql<T>(
  request: ExecuteGhGraphqlRequest<T>,
): Promise<T> {
  const { operation } = request;
  let result;
  try {
    result = await request.ghRunner.run(
      graphqlArgs(
        request.query,
        request.stringVariables ?? {},
        request.integerVariables ?? {},
        request.stringListVariables ?? {},
      ),
    );
  } catch (error) {
    throw new GitHubSnapshotError(
      "GRAPHQL_REQUEST_FAILED",
      operation,
      "gh api graphql request failed",
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw graphqlResponseInvalid(operation, "gh returned non-JSON data", error);
  }
  const envelope = GraphqlEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw graphqlResponseInvalid(
      operation,
      envelope.error.message,
      envelope.error,
    );
  }
  if ((envelope.data.errors?.length ?? 0) > 0) {
    throw new GitHubSnapshotError(
      "GRAPHQL_PARTIAL_RESPONSE",
      operation,
      "GraphQL returned errors; any accompanying data was discarded",
    );
  }
  if (envelope.data.data === undefined || envelope.data.data === null) {
    throw graphqlResponseInvalid(
      operation,
      "GraphQL response did not contain data",
    );
  }
  const parsed = request.schema.safeParse(envelope.data.data);
  if (!parsed.success) {
    throw graphqlResponseInvalid(operation, parsed.error.message, parsed.error);
  }
  return parsed.data;
}

export function nextConnectionCursor(
  pageInfo: GraphqlPageInfo,
  operation: string,
): string | null {
  if (!pageInfo.hasNextPage) return null;
  if (pageInfo.endCursor === null) {
    throw new GitHubSnapshotError(
      "GRAPHQL_PAGINATION_INVALID",
      operation,
      "hasNextPage was true without an endCursor",
    );
  }
  return pageInfo.endCursor;
}

export function assertFreshConnectionCursor(
  cursor: string,
  seen: Set<string>,
  operation: string,
): void {
  if (seen.has(cursor)) {
    throw new GitHubSnapshotError(
      "GRAPHQL_PAGINATION_INVALID",
      operation,
      "GraphQL repeated a connection cursor",
    );
  }
  seen.add(cursor);
}

export function assertConnectionPageBudget(
  pages: number,
  operation: string,
): void {
  if (pages > MAX_GRAPHQL_CONNECTION_PAGES) {
    throw new GitHubSnapshotError(
      "GRAPHQL_PAGINATION_INVALID",
      operation,
      "GraphQL connection exceeded the page safety limit",
    );
  }
}

export function requireGraphqlRepository<T>(
  value: T | null,
  operation: string,
): T {
  if (value === null) {
    throw new GitHubSnapshotError(
      "REPOSITORY_NOT_FOUND",
      operation,
      "repository was not found or was not accessible",
    );
  }
  return value;
}

export function duplicateGraphqlNode(
  operation: string,
  node: string,
): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "DUPLICATE_GRAPHQL_NODE",
    operation,
    `GraphQL pagination returned a duplicate ${node}`,
  );
}

export function graphqlResponseInvalid(
  operation: string,
  message: string,
  cause?: unknown,
): GitHubSnapshotError {
  return new GitHubSnapshotError(
    "GRAPHQL_RESPONSE_INVALID",
    operation,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function assertGraphqlPageSize(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_GRAPHQL_PAGE_SIZE
  ) {
    throw new TypeError(
      `${name} must be between 1 and ${String(MAX_GRAPHQL_PAGE_SIZE)}`,
    );
  }
  return value;
}

function graphqlArgs(
  query: string,
  stringVariables: Readonly<Record<string, string>>,
  integerVariables: Readonly<Record<string, number>>,
  stringListVariables: Readonly<Record<string, readonly string[]>>,
): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(stringVariables)) {
    args.push("-f", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(integerVariables)) {
    args.push("-F", `${key}=${String(value)}`);
  }
  for (const [key, values] of Object.entries(stringListVariables)) {
    if (values.length === 0) {
      args.push("-F", `${key}[]`);
      continue;
    }
    for (const value of values) args.push("-F", `${key}[]=${value}`);
  }
  return args;
}

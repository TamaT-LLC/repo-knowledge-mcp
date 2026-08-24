import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  SyncCheckpointStore,
  SyncRepoOutputSchema,
  SyncRepoResultSchema,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const REPO_ID = "R_sync_e2e_repository";
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");
const ONE_MINUTE_MS = 60_000;
const PULL_REQUEST_NUMBERS = [1, 2] as const;
const E2E_TIMEOUT_MS = 120_000;

interface JsonRpcReply {
  readonly error?: unknown;
  readonly id?: number;
  readonly result?: unknown;
}

interface SyncEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly storageRoot: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("sync CLI and MCP E2E over a real CLI process and stdio client", () => {
  it("syncs the same window from CLI and MCP with one canonical state and schema", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createSyncEnvironment();

    // 1. Real CLI process performs the initial sync through the fake gh.
    const first = await runCliSync(environment);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    const firstSummary = SyncRepoResultSchema.parse(JSON.parse(first.stdout));
    expect(firstSummary).toMatchObject({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 2,
      jobs_created: 2,
      unchanged: 0,
    });
    expect(firstSummary.next_cursor).toMatchObject({
      last_pr_number: 2,
      last_updated_at: isoAt(2),
      repo_id: REPO_ID,
    });

    const digestAfterCli = await readCanonicalDigest(environment);
    const checkpointAfterCli = await readCheckpoint(environment);
    expect(checkpointAfterCli).toMatchObject({
      cursor: { last_pr_number: 2, repo_id: REPO_ID },
    });

    // 2. A cron-style re-run resumes from the checkpoint and finds nothing.
    const resumed = await runCliSync(environment);
    expect(resumed.exitCode).toBe(0);
    expect(SyncRepoResultSchema.parse(JSON.parse(resumed.stdout))).toEqual({
      discovered: 0,
      failed: 0,
      failures: [],
      ingested: 0,
      jobs_created: 0,
      next_cursor: firstSummary.next_cursor,
      unchanged: 0,
    });

    // 3. The MCP stdio server replays the same window through sync_repo.
    const replies = await runMcpSyncRepo(environment, {
      repo: REPOSITORY,
      since: isoAt(0),
    });
    const syncReply = replies.find((reply) => reply.id === 2);
    expect(syncReply).toBeDefined();
    expect(syncReply).not.toHaveProperty("error");
    const result = syncReply!.result as {
      readonly isError?: boolean;
      readonly structuredContent?: unknown;
    };
    expect(result.isError).not.toBe(true);
    const structured = SyncRepoOutputSchema.parse(result.structuredContent);
    expect(structured.ok).toBe(true);
    // Identical summary schema and identical resume point across surfaces.
    expect(structured.result).toEqual({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 0,
      jobs_created: 0,
      next_cursor: firstSummary.next_cursor,
      unchanged: 2,
    });

    // 4. Duplicate syncing the same window left canonical state untouched.
    await expect(readCanonicalDigest(environment)).resolves.toBe(
      digestAfterCli,
    );
    await expect(readCheckpoint(environment)).resolves.toEqual(
      checkpointAfterCli,
    );
  });

  it("fails closed with an operator diagnostic when --since reaches the checkpoint", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const environment = await createSyncEnvironment();
    const first = await runCliSync(environment);
    expect(first.exitCode).toBe(0);
    const digestAfterFirst = await readCanonicalDigest(environment);

    const rejected = await runCliSync(environment, ["--since", isoAt(2)]);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("SYNC_SINCE_BEYOND_CHECKPOINT");
    expect(rejected.stderr).toContain("Run without --since");
    await expect(readCanonicalDigest(environment)).resolves.toBe(
      digestAfterFirst,
    );
  });
});

async function createSyncEnvironment(): Promise<SyncEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "rkm-sync-e2e-"));
  temporaryDirectories.push(root);
  const storageRoot = join(root, "home");
  const binDirectory = join(root, "bin");
  await mkdir(storageRoot, { mode: 0o700, recursive: true });
  await mkdir(binDirectory, { recursive: true });
  const ghPath = join(binDirectory, "gh");
  await writeFile(ghPath, fakeGhSource(), "utf8");
  await chmod(ghPath, 0o755);
  return {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      REPO_KNOWLEDGE_HOME: storageRoot,
    },
    storageRoot,
  };
}

async function runCliSync(
  environment: SyncEnvironment,
  extraArguments: readonly string[] = [],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const result = await execa(
    process.execPath,
    ["dist/bin.js", "sync", REPOSITORY, ...extraArguments],
    { cwd: process.cwd(), env: environment.env, reject: false },
  );
  return {
    exitCode: result.exitCode ?? -1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/** Drives the packaged stdio server with a newline-delimited JSON-RPC client. */
async function runMcpSyncRepo(
  environment: SyncEnvironment,
  toolArguments: Record<string, unknown>,
): Promise<JsonRpcReply[]> {
  const messages = [
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "sync-e2e", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: toolArguments, name: "sync_repo" },
    },
  ];
  const result = await execa(process.execPath, ["dist/bin.js", "serve"], {
    cwd: process.cwd(),
    env: environment.env,
    input: `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    reject: false,
  });
  expect(result.stderr).toBe("");
  const replies = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcReply);
  // Every stdout frame must remain valid JSON-RPC even while sync runs.
  expect(replies.every((reply) => "id" in reply || "method" in reply)).toBe(
    true,
  );
  return replies;
}

async function readCanonicalDigest(
  environment: SyncEnvironment,
): Promise<string> {
  const snapshot = await new CanonicalTransactionStore(
    await repositoryDirectory(environment),
  ).readSnapshot();
  return snapshot.canonicalDigest;
}

async function readCheckpoint(environment: SyncEnvironment): Promise<unknown> {
  return new SyncCheckpointStore(await repositoryDirectory(environment)).read();
}

async function repositoryDirectory(
  environment: SyncEnvironment,
): Promise<string> {
  const reposRoot = join(environment.storageRoot, "repos");
  const entries = await readdir(reposRoot);
  expect(entries).toHaveLength(1);
  return join(reposRoot, entries[0]!);
}

function isoAt(prNumber: number): string {
  return new Date(BASE_MS + prNumber * ONE_MINUTE_MS).toISOString();
}

/**
 * Deterministic `gh` stand-in: answers exactly the GraphQL operations a sync
 * run issues (repository resolution, updated-PR listing, snapshot fetch, and
 * snapshot validation) without any network access.
 */
function fakeGhSource(): string {
  const fixture = {
    prNumbers: PULL_REQUEST_NUMBERS,
    repoId: REPO_ID,
    repository: REPOSITORY,
    times: Object.fromEntries(
      PULL_REQUEST_NUMBERS.map((prNumber) => [prNumber, isoAt(prNumber)]),
    ),
  };
  return `#!/usr/bin/env node
const FIXTURE = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "graphql") {
  process.stderr.write("fake gh: unsupported invocation\\n");
  process.exit(1);
}
const values = {};
const lists = {};
let query = "";
for (let index = 2; index < args.length; index += 1) {
  const flag = args[index];
  if (flag !== "-f" && flag !== "-F") continue;
  const pair = args[index + 1] ?? "";
  index += 1;
  const equals = pair.indexOf("=");
  const key = equals < 0 ? pair : pair.slice(0, equals);
  const value = equals < 0 ? "" : pair.slice(equals + 1);
  if (key === "query") query = value;
  else if (key.endsWith("[]")) (lists[key.slice(0, -2)] ??= []).push(value);
  else values[key] = value;
}
const closedPage = { endCursor: null, hasNextPage: false };
const comment = (n) => ({
  author: { __typename: "User", id: "U_reviewer", login: "alice" },
  authorAssociation: "MEMBER",
  body: "Guard the input on PR " + n,
  createdAt: FIXTURE.times[n],
  diffHunk: "@@ -1 +1 @@",
  id: "comment-" + n,
  updatedAt: FIXTURE.times[n],
  url: "https://github.com/" + FIXTURE.repository + "/pull/" + n + "#comment-" + n,
});
const identity = (n) => ({
  baseRefOid: "base-" + n,
  headRefOid: "head-" + n,
  id: "PR_node_" + n,
  mergedAt: null,
  number: n,
  title: "Sync fixture " + n,
  updatedAt: FIXTURE.times[n],
});
let data;
if (query.includes("query ResolveRepository")) {
  data = {
    repository: { id: FIXTURE.repoId, nameWithOwner: FIXTURE.repository },
  };
} else if (query.includes("query ListUpdatedPullRequests")) {
  data = {
    repository: {
      id: FIXTURE.repoId,
      nameWithOwner: FIXTURE.repository,
      pullRequests: {
        nodes: [...FIXTURE.prNumbers]
          .sort((a, b) => b - a)
          .map((n) => ({
            id: "PR_node_" + n,
            number: n,
            updatedAt: FIXTURE.times[n],
          })),
        pageInfo: closedPage,
      },
    },
  };
} else if (query.includes("query FetchPullRequestSnapshot")) {
  const n = Number(values.number);
  data = {
    repository: {
      id: FIXTURE.repoId,
      nameWithOwner: FIXTURE.repository,
      pullRequest: {
        ...identity(n),
        reviewThreads: {
          nodes: [
            {
              comments: { nodes: [comment(n)], pageInfo: closedPage },
              id: "thread-" + n,
              isOutdated: false,
              isResolved: false,
              path: "src/thread-" + n + ".ts",
            },
          ],
          pageInfo: closedPage,
        },
        reviews: { nodes: [], pageInfo: closedPage },
      },
    },
  };
} else if (query.includes("query ValidatePullRequestSnapshot")) {
  const n = Number(values.number);
  data = {
    nodes: (lists.threadIds ?? []).map((threadId) =>
      threadId === "thread-" + n
        ? {
            __typename: "PullRequestReviewThread",
            comments: { totalCount: 1 },
            id: threadId,
            isOutdated: false,
            isResolved: false,
            path: "src/thread-" + n + ".ts",
          }
        : null,
    ),
    repository: {
      id: FIXTURE.repoId,
      pullRequest: {
        ...identity(n),
        reviewThreads: { totalCount: 1 },
        reviews: { totalCount: 0 },
      },
    },
  };
} else {
  process.stderr.write("fake gh: unsupported query\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ data }) + "\\n");
`;
}

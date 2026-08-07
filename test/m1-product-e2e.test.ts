import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  AdminPlaneService,
  CanonicalTransactionStore,
  DefaultRepositoryApplicationFactory,
  KnowledgeReadService,
  ModelPlaneKnowledgeService,
  parseDistillationPrompt,
  parseRepoKnowledgeConfig,
  type CompleteGitHubPullRequestSnapshot,
  type CompleteSnapshotFetcher,
  type GitHubReviewActor,
  type LlmProviderAdapter,
  type RepositoryResolution,
  type StructuredCompletionRequest,
  type StructuredCompletionResponse,
} from "../src/index.js";

const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const SNAPSHOT_ID = "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMPT = parseDistillationPrompt(
  "---\nprompt_version: distill-v1\n---\nExtract durable repository rules.",
);
const NOW = "2026-08-06T00:00:00.000Z";
const temporaryDirectories: string[] = [];
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout")!;

afterEach(async () => {
  Object.defineProperty(process, "stdin", originalStdin);
  Object.defineProperty(process, "stdout", originalStdout);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("M1 product acceptance E2E", () => {
  it("ingests twice with provider disabled and preserves one pending job", async () => {
    const root = await temporaryDirectory();
    const adapter = new GoldenProviderAdapter();
    const factory = new DefaultRepositoryApplicationFactory({
      adapter,
      config: config(),
      prompt: PROMPT,
      repositoryContext: { language: "TypeScript" },
      snapshotClient: new SnapshotQueue([snapshot(), snapshot()]),
    });
    const store = new CanonicalTransactionStore(root);
    const operations = await factory.create({
      repository: resolution(root),
      repositoryStore: store,
    });

    const first = await operations.ingestPullRequest({ pr_number: 7 });
    const before = await store.readSnapshot();
    const second = await operations.ingestPullRequest({ pr_number: 7 });
    const after = await store.readSnapshot();

    expect(first).toMatchObject({
      distilled: 0,
      jobs_created: 1,
      pending: 1,
    });
    expect(second).toMatchObject({
      distilled: 0,
      jobs_created: 0,
      pending: 0,
      unchanged: 1,
    });
    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    expect(after.domain.distillJobs).toHaveLength(1);
    expect(after.domain.distillJobs[0]?.state).toBe("pending");
    expect(adapter.requests).toEqual([]);
  });

  it("runs fake-provider ingest through proposed approval and get_rules", async () => {
    const root = await temporaryDirectory();
    const adapter = new GoldenProviderAdapter();
    const store = new CanonicalTransactionStore(root);
    const factory = new DefaultRepositoryApplicationFactory({
      adapter,
      config: config({ provider: true }),
      prompt: PROMPT,
      repositoryContext: { language: "TypeScript" },
      snapshotClient: new SnapshotQueue([snapshot()]),
    });
    const operations = await factory.create({
      repository: resolution(root),
      repositoryStore: store,
    });

    const ingest = await operations.ingestPullRequest({ pr_number: 7 });
    const proposed = (await operations.listKnowledge({ status: "proposed" }))
      .knowledge;

    expect(ingest).toMatchObject({ distilled: 1, pending: 0 });
    expect(proposed).toHaveLength(1);
    expect(adapter.requests).toHaveLength(2);
    installTerminal(`approve ${proposed[0]!.id}`);
    await expect(
      operations.admin.approve(proposed[0]!.id),
    ).resolves.toMatchObject({ confirmed: true });

    const rules = await readService(store).getRules({
      filePaths: ["src/thread-1.ts"],
    });
    expect(rules).toMatchObject({
      matched_count: 1,
      rules: [
        expect.objectContaining({
          id: proposed[0]!.id,
          rule: "Keep canonical writes atomic",
        }),
      ],
      truncated: false,
    });
  });

  it("runs host-assisted extract/finalize through approval and get_rules", async () => {
    const root = await temporaryDirectory();
    const store = new CanonicalTransactionStore(root);
    const factory = new DefaultRepositoryApplicationFactory({
      config: config({ hostAssisted: true }),
      prompt: PROMPT,
      repositoryContext: { language: "TypeScript" },
      snapshotClient: new SnapshotQueue([snapshot()]),
    });
    const operations = await factory.create({
      repository: resolution(root),
      repositoryStore: store,
    });
    const ingest = await operations.ingestPullRequest({ pr_number: 7 });

    expect(ingest).toMatchObject({ distilled: 0, pending: 1 });
    const prepared = await operations.prepareDistillation({ limit: 1 });
    if (
      prepared.state !== "prepared" ||
      prepared.jobs[0]?.phase !== "extract"
    ) {
      throw new Error("host-assisted fixture did not produce an extract job");
    }
    const job = prepared.jobs[0];
    const extracted = await operations.submitExtract({
      candidates: [candidate()],
      job_id: job.job_id,
      lease_generation: job.lease_generation,
      lease_token: job.lease_token,
      phase: "extract",
      request_schema_version: 1,
      skip_reason: null,
      submission_id: "host-extract-submission",
      thread_fingerprint: job.thread_fingerprint,
    });
    if (extracted.state !== "merge_decision_required") {
      throw new Error("host-assisted extract unexpectedly skipped");
    }
    const finalized = await operations.submitFinalize({
      candidate_set_sha256: extracted.candidate_set_sha256,
      decisions: extracted.candidates.map((entry) => ({
        candidate_id: entry.candidate_id,
        relation: "different" as const,
      })),
      finalize_token: extracted.finalize_handle.finalize_token,
      job_id: job.job_id,
      lease_generation: job.lease_generation,
      lease_token: job.lease_token,
      phase: "finalize",
      request_schema_version: 1,
      submission_id: "host-finalize-submission",
    });
    expect(finalized).toMatchObject({
      accepted: true,
      created_proposed: [expect.stringMatching(/^kn_/u)],
    });

    const proposedId = finalized.created_proposed[0]!;
    installTerminal(`approve ${proposedId}`);
    await expect(operations.admin.approve(proposedId)).resolves.toMatchObject({
      confirmed: true,
    });
    await expect(
      readService(store).getRules({ filePaths: ["src/thread-1.ts"] }),
    ).resolves.toMatchObject({
      matched_count: 1,
      rules: [expect.objectContaining({ id: proposedId })],
    });
  });

  it("serializes concurrent MCP proposal and CLI active writes", async () => {
    const root = await temporaryDirectory();
    const store = new CanonicalTransactionStore(root);
    const model = new ModelPlaneKnowledgeService({
      nextKnowledgeId: () => "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      nextTransactionId: () => "txn_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: () => new Date(NOW),
      repo: REPOSITORY,
      repoId: REPOSITORY_ID,
      repository: store,
    });
    const admin = new AdminPlaneService({
      nextKnowledgeId: () => "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      nextTransactionId: () => "txn_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      now: () => new Date(NOW),
      repo: REPOSITORY,
      repoId: REPOSITORY_ID,
      repository: store,
    });
    installTerminal("add --active");

    const [mcp, cli] = await Promise.all([
      model.addKnowledge({
        category: "architecture",
        detail: "MCP proposal detail",
        rule: "MCP writes stay proposed",
        scope: ["src/**"],
        severity: "should",
      }),
      admin.addActive({
        category: "test",
        detail: "CLI active detail",
        rule: "CLI writes require confirmation",
        scope: ["test/**"],
        severity: "must",
      }),
    ]);
    const snapshot = await store.readSnapshot();

    expect(mcp.status).toBe("proposed");
    expect(cli).toMatchObject({ confirmed: true });
    expect(snapshot.domain.knowledge).toHaveLength(2);
    expect(
      snapshot.domain.knowledge.map((entry) => entry.status).sort(),
    ).toEqual(["active", "proposed"]);
    expect(snapshot.canonicalDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
});

class SnapshotQueue implements CompleteSnapshotFetcher {
  constructor(private readonly values: CompleteGitHubPullRequestSnapshot[]) {}

  async fetchCompleteSnapshot(): Promise<CompleteGitHubPullRequestSnapshot> {
    const value = this.values.shift();
    if (value === undefined) throw new Error("snapshot fixture exhausted");
    return value;
  }
}

class GoldenProviderAdapter implements LlmProviderAdapter {
  readonly provider = "anthropic";
  readonly requests: StructuredCompletionRequest[] = [];

  async completeStructured(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResponse> {
    this.requests.push(request);
    const outputText = request.system.includes("Classify each candidate")
      ? mergeResponse(request.input)
      : JSON.stringify({ candidates: [candidate()], skip_reason: null });
    return {
      model: request.model ?? "claude-golden",
      outputText,
      provider: this.provider,
      responseId: `golden-${String(this.requests.length)}`,
    };
  }
}

function mergeResponse(input: string): string {
  const match =
    /<untrusted_merge_data[^>]*>\n(.+)\n<\/untrusted_merge_data>/su.exec(input);
  if (match?.[1] === undefined) throw new Error("merge input was malformed");
  const value = JSON.parse(match[1]) as {
    candidates: Array<{ candidate_id: string }>;
  };
  return JSON.stringify({
    decisions: value.candidates.map((entry) => ({
      candidate_id: entry.candidate_id,
      relation: "different",
      target_id: null,
    })),
  });
}

function candidate() {
  return {
    category: "architecture" as const,
    confidence: 0.99,
    detail: "Use one recoverable transaction for canonical artifacts.",
    evidence_comment_ids: ["comment-1"],
    rule: "Keep canonical writes atomic",
    scope: ["src/**"],
    severity: "must" as const,
  };
}

function config(
  options: {
    readonly hostAssisted?: boolean;
    readonly provider?: boolean;
  } = {},
) {
  return parseRepoKnowledgeConfig({
    ...(options.hostAssisted === true
      ? {
          hostAssistedDistillation: {
            allowReviewContentTransmission: true,
            enabled: true,
          },
        }
      : {}),
    ...(options.provider === true
      ? {
          llm: {
            allowCloudTransmission: true,
            mode: "anthropic",
            model: "claude-golden",
          },
        }
      : {}),
    trust: { trustedActorIds: ["U_trusted"] },
  });
}

function resolution(root: string): RepositoryResolution {
  return {
    absolutePath: root,
    aliases: [],
    currentName: REPOSITORY,
    path: "repos/R_repository",
    repoId: REPOSITORY_ID,
    source: "tool-repo",
  };
}

function snapshot(): CompleteGitHubPullRequestSnapshot {
  const actor: GitHubReviewActor = {
    __typename: "User",
    id: "U_trusted",
    login: "alice",
  };
  return {
    pullRequest: {
      baseRefOid: "base-oid",
      headRefOid: "head-oid",
      id: "PR_node",
      mergedAt: null,
      number: 7,
      title: "M1 E2E fixture",
    },
    repository: { id: REPOSITORY_ID, nameWithOwner: REPOSITORY },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: NOW,
      pr_number: 7,
      repo_id: REPOSITORY_ID,
      review_summary_ids: [],
      snapshot_id: SNAPSHOT_ID,
      thread_ids: ["thread-1"],
    },
    threads: [
      {
        comments: [
          {
            author: actor,
            authorAssociation: "MEMBER",
            body: "Please keep canonical writes atomic.",
            createdAt: NOW,
            diffHunk: "@@ -1 +1 @@",
            id: "comment-1",
            updatedAt: NOW,
            url: "https://github.com/owner/repository/pull/7#comment-1",
          },
        ],
        id: "thread-1",
        isOutdated: false,
        isResolved: false,
        path: "src/thread-1.ts",
      },
    ],
  };
}

function readService(store: CanonicalTransactionStore): KnowledgeReadService {
  return new KnowledgeReadService({
    repo: REPOSITORY,
    repoId: REPOSITORY_ID,
    repository: store,
  });
}

function installTerminal(answer: string): void {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true });
  const output = new Writable({
    write(chunk, _encoding, callback) {
      callback();
      if (String(chunk).includes("admin> ")) input.write(`${answer}\n`);
    },
  });
  Object.defineProperties(output, {
    columns: { value: 80 },
    isTTY: { value: true },
  });
  Object.defineProperty(process, "stdin", {
    configurable: true,
    enumerable: true,
    value: input,
  });
  Object.defineProperty(process, "stdout", {
    configurable: true,
    enumerable: true,
    value: output,
  });
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-m1-e2e-"));
  temporaryDirectories.push(path);
  return path;
}

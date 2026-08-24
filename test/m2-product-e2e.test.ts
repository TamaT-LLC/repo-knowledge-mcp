import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  DefaultRepositoryApplicationFactory,
  KnowledgeReadService,
  RecordOutcomeMutationService,
  SyncCheckpointStore,
  compareSyncOrder,
  computeTrustPolicyDigest,
  isAfterSyncBoundary,
  nextSyncCursor,
  parseDistillationPrompt,
  parseIsoTimestampMs,
  parseRepoKnowledgeConfig,
  resolveSyncBoundary,
  type CompleteGitHubPullRequestSnapshot,
  type CompleteSnapshotFetcher,
  type EnumerateUpdatedPullRequestsRequest,
  type EnumerateUpdatedPullRequestsResult,
  type GitHubReviewActor,
  type LlmProviderAdapter,
  type RepositoryResolution,
  type RepoKnowledgeConfig,
  type StructuredCompletionRequest,
  type StructuredCompletionResponse,
  type SyncPullRequestEnumerator,
  type UpdatedPullRequestRef,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const REPOSITORY_ID = "R_repository";
const PROMPT = parseDistillationPrompt(
  "---\nprompt_version: distill-v1\n---\nExtract durable repository rules.",
);
const BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");
const ONE_MINUTE_MS = 60_000;
const OUTCOME_AT = "2026-08-06T00:00:00.000Z";
const VIOLATED_EVENT_KEY = "codex:m2-e2e:observed-violation";
const APPLIED_EVENT_ID = "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW";
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

describe("M2 product acceptance E2E", () => {
  it("keeps a cron-style provider-disabled sync idempotent and observable in stats", async () => {
    const root = await temporaryDirectory();
    const adapter = new GoldenProviderAdapter();
    const store = new CanonicalTransactionStore(root);
    const operations = await createFactory({
      adapter,
      prNumbers: [1, 2],
    }).create({ repository: resolution(root), repositoryStore: store });

    const first = await operations.syncRepo({});
    const digestAfterFirst = (await store.readSnapshot()).canonicalDigest;
    const resumed = await operations.syncRepo({});
    const after = await store.readSnapshot();

    expect(first).toMatchObject({
      discovered: 2,
      failed: 0,
      failures: [],
      ingested: 2,
      jobs_created: 2,
      unchanged: 0,
    });
    expect(first.next_cursor).toMatchObject({ last_pr_number: 2 });
    // The cron re-run resumes from the durable checkpoint and finds nothing.
    expect(resumed).toMatchObject({ discovered: 0, ingested: 0 });
    expect(after.canonicalDigest).toBe(digestAfterFirst);
    expect(after.domain.distillJobs.map((job) => job.state)).toEqual([
      "pending",
      "pending",
    ]);
    expect(adapter.requests).toEqual([]);
    await expect(new SyncCheckpointStore(root).read()).resolves.toMatchObject({
      cursor: { last_pr_number: 2 },
    });

    const stats = await operations.stats({});
    expect(stats).toMatchObject({
      jobs: { by_state: expect.objectContaining({ pending: 2 }), total: 2 },
      knowledge: { total: 0 },
      operations: { failed_jobs: 0, pending_jobs: 2 },
      outcomes: { total: 0 },
      stats_schema_version: 1,
    });
    expect(stats.sync.last_checkpoint).toMatchObject({ last_pr_number: 2 });
  });

  it("runs sync, ingest, distill, approve, get_rules, record_outcome, and stats as one flow", async () => {
    const root = await temporaryDirectory();
    const adapter = new GoldenProviderAdapter();
    const store = new CanonicalTransactionStore(root);
    const operations = await createFactory({
      adapter,
      prNumbers: [1],
      provider: true,
    }).create({ repository: resolution(root), repositoryStore: store });

    // 1. Cron-style sync discovers PR 1 and distills it inline.
    const synced = await operations.syncRepo({});
    expect(synced).toMatchObject({
      discovered: 1,
      failed: 0,
      ingested: 1,
      jobs_created: 1,
    });
    expect(adapter.requests).toHaveLength(2);

    // 2. A direct re-ingest of the synced PR stays an idempotent no-op.
    await expect(
      operations.ingestPullRequest({ pr_number: 1 }),
    ).resolves.toMatchObject({ jobs_created: 0, unchanged: 1 });
    expect(adapter.requests).toHaveLength(2);

    // 3. The distilled candidate lands as proposed with its grounded example.
    const proposed = (await operations.listKnowledge({ status: "proposed" }))
      .knowledge;
    expect(proposed).toHaveLength(1);
    const knowledgeId = proposed[0]!.id;

    // 4. A human approves it on a TTY; only then get_rules serves it.
    installTerminal(`approve ${knowledgeId}`);
    await expect(operations.admin.approve(knowledgeId)).resolves.toMatchObject({
      confirmed: true,
    });
    const read = readService(store);
    await expect(
      read.getRules({ filePaths: ["src/ipc/handler.ts"] }),
    ).resolves.toMatchObject({
      matched_count: 1,
      rules: [
        expect.objectContaining({
          id: knowledgeId,
          rule: "Handle the Result of invoke and surface failures to the UI",
          violation_count: 0,
        }),
      ],
      truncated: false,
    });
    const detail = await read.getKnowledge({ id: knowledgeId });
    expect(detail.knowledge.code_example).toMatchObject({
      evidence_comment_ids: ["comment-1"],
      generated_example: true,
      language: "typescript",
    });
    // Retrieval alone has no outcome side effect.
    await expect(operations.stats({})).resolves.toMatchObject({
      outcomes: { total: 0 },
    });

    // 5. The normal host path derives an id from one stable work-result key.
    const outcomes = new RecordOutcomeMutationService({
      repo: REPOSITORY,
      repoId: REPOSITORY_ID,
      repository: store,
    });
    const violated = {
      at: OUTCOME_AT,
      context: { file_paths: ["src/ipc/handler.ts"] },
      event_key: VIOLATED_EVENT_KEY,
      knowledge_id: knowledgeId,
      note: "the completed implementation violated the returned rule",
      outcome: "violated",
      result_observed: true,
    } as const;
    await expect(outcomes.recordOutcome(violated)).resolves.toMatchObject({
      replayed: false,
      violation_count: 1,
    });
    await expect(outcomes.recordOutcome(violated)).resolves.toMatchObject({
      replayed: true,
      violation_count: 1,
    });
    await expect(
      outcomes.recordOutcome({
        at: OUTCOME_AT,
        event_id: APPLIED_EVENT_ID,
        knowledge_id: knowledgeId,
        outcome: "applied",
      }),
    ).resolves.toMatchObject({ applied_count: 1, violation_count: 1 });

    // 6. The recorded violation is visible to the next get_rules call.
    await expect(
      read.getRules({ filePaths: ["src/ipc/handler.ts"] }),
    ).resolves.toMatchObject({
      rules: [expect.objectContaining({ violation_count: 1 })],
    });

    // 7. stats aggregates the same canonical state for cron monitoring.
    const stats = await operations.stats({});
    expect(stats).toMatchObject({
      evidence: { eligible_for_count: 1, total: 1 },
      jobs: { by_state: expect.objectContaining({ done: 1 }), total: 1 },
      knowledge: {
        by_status: expect.objectContaining({ active: 1, proposed: 0 }),
        total: 1,
      },
      outcomes: {
        by_type: {
          applied: 1,
          false_positive: 0,
          not_applicable: 0,
          violated: 1,
        },
        total: 2,
      },
      repo: REPOSITORY,
      stats_schema_version: 1,
    });
    expect(stats.sync.last_checkpoint).toMatchObject({ last_pr_number: 1 });
  });

  it("serves an eligible trusted-human non-must rule without a TTY review", async () => {
    const root = await temporaryDirectory();
    const adapter = new GoldenProviderAdapter("should");
    const store = new CanonicalTransactionStore(root);
    const operations = await createFactory({
      adapter,
      config: autoActivationConfig(),
      prNumbers: [1],
      provider: true,
    }).create({ repository: resolution(root), repositoryStore: store });

    await expect(operations.syncRepo({})).resolves.toMatchObject({
      discovered: 1,
      failed: 0,
      ingested: 1,
      jobs_created: 1,
    });
    await expect(
      operations.listKnowledge({ status: "active" }),
    ).resolves.toMatchObject({
      knowledge: [
        expect.objectContaining({
          rule: "Handle the Result of invoke and surface failures to the UI",
          severity: "should",
          status: "active",
        }),
      ],
    });
    await expect(
      operations.listKnowledge({ status: "proposed" }),
    ).resolves.toMatchObject({ knowledge: [] });
    await expect(
      readService(store).getRules({ filePaths: ["src/ipc/handler.ts"] }),
    ).resolves.toMatchObject({
      matched_count: 1,
      rules: [expect.objectContaining({ severity: "should" })],
    });
  });

  it("converges provider-disabled sync plus later distill to the enabled sync state", async () => {
    const disabledRoot = await temporaryDirectory();
    const enabledRoot = await temporaryDirectory();
    const disabledStore = new CanonicalTransactionStore(disabledRoot);
    const enabledStore = new CanonicalTransactionStore(enabledRoot);

    // Path A: provider disabled at sync time, jobs drained by a later distill.
    const disabledOperations = await createFactory({
      adapter: new GoldenProviderAdapter(),
      prNumbers: [1],
    }).create({
      repository: resolution(disabledRoot),
      repositoryStore: disabledStore,
    });
    await disabledOperations.syncRepo({});
    expect(
      (await disabledStore.readSnapshot()).domain.distillJobs.map(
        (job) => job.state,
      ),
    ).toEqual(["pending"]);
    const laterOperations = await createFactory({
      adapter: new GoldenProviderAdapter(),
      prNumbers: [1],
      provider: true,
    }).create({
      repository: resolution(disabledRoot),
      repositoryStore: disabledStore,
    });
    await expect(laterOperations.distill()).resolves.toMatchObject({
      distilled: 1,
      pending: 0,
    });

    // Path B: provider enabled while the same window syncs.
    const enabledOperations = await createFactory({
      adapter: new GoldenProviderAdapter(),
      prNumbers: [1],
      provider: true,
    }).create({
      repository: resolution(enabledRoot),
      repositoryStore: enabledStore,
    });
    await enabledOperations.syncRepo({});

    // Both paths end in one consistent canonical state: identical rule
    // content, identical deterministic fingerprints, identical aggregates.
    const disabledSnapshot = await disabledStore.readSnapshot();
    const enabledSnapshot = await enabledStore.readSnapshot();
    expect(comparableDomain(disabledSnapshot)).toEqual(
      comparableDomain(enabledSnapshot),
    );
    const disabledStats = await disabledOperations.stats({});
    const enabledStats = await enabledOperations.stats({});
    expect(comparableStats(disabledStats)).toEqual(
      comparableStats(enabledStats),
    );
  }, 15_000);
});

type StoreSnapshot = Awaited<
  ReturnType<CanonicalTransactionStore["readSnapshot"]>
>;

function comparableDomain(snapshot: StoreSnapshot): unknown {
  return {
    evidence: snapshot.domain.evidence.map((evidence) => ({
      comment_ids: evidence.comment_ids,
      content_fingerprint: evidence.content_fingerprint,
      eligible_for_count: evidence.eligible_for_count,
      // The knowledge ULID is time-generated, so only its shape is compared.
      occurrence_key: evidence.occurrence_key.replace(
        /^kn_[0-9A-HJKMNP-TV-Z]{26}/u,
        "kn_<ulid>",
      ),
      pr_number: evidence.pr_number,
      sources: evidence.sources,
      state_fingerprint: evidence.state_fingerprint,
      status: evidence.status,
      thread_id: evidence.thread_id,
    })),
    jobs: snapshot.domain.distillJobs.map((job) => ({
      distillation_key: job.distillation_key,
      state: job.state,
      thread_id: job.thread_id,
    })),
    knowledge: snapshot.domain.knowledge.map((knowledge) => ({
      category: knowledge.category,
      detail: knowledge.detail,
      evidenceCount: knowledge.evidenceCount,
      rule: knowledge.rule,
      scope: knowledge.scope,
      severity: knowledge.severity,
      sources: knowledge.sources,
      status: knowledge.status,
      violationCount: knowledge.violationCount,
    })),
  };
}

function comparableStats(stats: {
  readonly evidence: unknown;
  readonly jobs: unknown;
  readonly knowledge: unknown;
  readonly outcomes: unknown;
}): unknown {
  return {
    evidence: stats.evidence,
    jobs: stats.jobs,
    knowledge: stats.knowledge,
    outcomes: stats.outcomes,
  };
}

function createFactory(options: {
  readonly adapter: LlmProviderAdapter;
  readonly config?: RepoKnowledgeConfig;
  readonly prNumbers: readonly number[];
  readonly provider?: boolean;
}): DefaultRepositoryApplicationFactory {
  return new DefaultRepositoryApplicationFactory({
    adapter: options.adapter,
    config: options.config ?? config(options.provider === true),
    enumerator: new FixtureEnumerator(options.prNumbers.map(pullRequestRef)),
    prompt: PROMPT,
    repositoryContext: { language: "TypeScript" },
    snapshotClient: new FixtureSnapshotFetcher(),
  });
}

/** Replays the deterministic (updatedAt, number) boundary over fixed PRs. */
class FixtureEnumerator implements SyncPullRequestEnumerator {
  constructor(
    private readonly pullRequests: readonly UpdatedPullRequestRef[],
  ) {}

  async enumerateUpdatedPullRequests(
    request: EnumerateUpdatedPullRequestsRequest,
  ): Promise<EnumerateUpdatedPullRequestsResult> {
    const boundary = resolveSyncBoundary({
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.since === undefined ? {} : { since: request.since }),
    });
    const included = this.pullRequests
      .filter((pullRequest) =>
        isAfterSyncBoundary(
          boundary,
          parseIsoTimestampMs(pullRequest.updatedAt),
          pullRequest.number,
        ),
      )
      .sort((first, second) =>
        compareSyncOrder(
          {
            number: first.number,
            updatedAtMs: parseIsoTimestampMs(first.updatedAt),
          },
          {
            number: second.number,
            updatedAtMs: parseIsoTimestampMs(second.updatedAt),
          },
        ),
      );
    const last = included.at(-1);
    return {
      nextCursor:
        last !== undefined
          ? nextSyncCursor(REPOSITORY_ID, last)
          : boundary.kind === "cursor"
            ? boundary.cursor
            : null,
      pullRequests: included,
      repository: { id: REPOSITORY_ID, nameWithOwner: REPOSITORY },
    };
  }
}

/** Serves the same deterministic complete snapshot on every fetch. */
class FixtureSnapshotFetcher implements CompleteSnapshotFetcher {
  async fetchCompleteSnapshot(request: {
    readonly prNumber: number;
  }): Promise<CompleteGitHubPullRequestSnapshot> {
    return snapshot(request.prNumber);
  }
}

class GoldenProviderAdapter implements LlmProviderAdapter {
  readonly provider = "anthropic";
  readonly requests: StructuredCompletionRequest[] = [];

  constructor(private readonly severity: "must" | "should" = "must") {}

  async completeStructured(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResponse> {
    this.requests.push(request);
    const outputText = request.system.includes("Classify each candidate")
      ? mergeResponse(request.input)
      : JSON.stringify({
          candidates: [candidate(this.severity)],
          skip_reason: null,
        });
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

/** Grounded M2 candidate: every example token appears in the cited comment. */
function candidate(severity: "must" | "should" = "must") {
  return {
    category: "error-handling" as const,
    code_example: {
      content:
        'const result = await invoke("save_profile");\nif (result.isErr()) showToast(result.error);',
      evidence_comment_ids: ["comment-1"],
      generated_example: true as const,
      language: "typescript" as const,
    },
    confidence: 0.9,
    detail:
      'The diff shows invoke("save_profile") discarding its Result; surface the failure branch to the UI.',
    evidence_comment_ids: ["comment-1"],
    rule: "Handle the Result of invoke and surface failures to the UI",
    scope: ["src/ipc/**"],
    severity,
  };
}

function config(provider: boolean) {
  return parseRepoKnowledgeConfig({
    ...(provider
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

function autoActivationConfig(): RepoKnowledgeConfig {
  const base = parseRepoKnowledgeConfig({
    llm: {
      allowCloudTransmission: true,
      mode: "anthropic",
      model: "claude-golden",
    },
    trust: {
      autoActivateTrustedHuman: true,
      trustedActorIds: ["U_trusted"],
    },
  });
  const trustPolicyDigest = computeTrustPolicyDigest(base.trust);
  const artifactDigest = `sha256:${"a".repeat(64)}`;
  return parseRepoKnowledgeConfig({
    ...base,
    trustedHumanAutoActivationEligibility: {
      m2Pilot: {
        completedAt: "2026-08-23T00:20:00.000Z",
        decision: "go",
        reportDigest: artifactDigest,
      },
      qualityGate: {
        baselineArtifactDigest: artifactDigest,
        reportDigest: artifactDigest,
        source: "live_measurement",
        status: "pass",
        thresholdsVersion: "m2-live-thresholds-v1",
        trustPolicyDigest,
      },
      schemaVersion: 1,
    },
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

function pullRequestRef(prNumber: number): UpdatedPullRequestRef {
  return {
    id: `PR_node_${String(prNumber)}`,
    number: prNumber,
    updatedAt: isoAt(prNumber),
  };
}

function snapshot(prNumber: number): CompleteGitHubPullRequestSnapshot {
  const actor: GitHubReviewActor = {
    __typename: "User",
    id: "U_trusted",
    login: "alice",
  };
  const threadId = `thread-${String(prNumber)}`;
  return {
    pullRequest: {
      baseRefOid: `base-${String(prNumber)}`,
      headRefOid: `head-${String(prNumber)}`,
      id: `PR_node_${String(prNumber)}`,
      mergedAt: null,
      number: prNumber,
      title: `M2 E2E fixture ${String(prNumber)}`,
    },
    repository: { id: REPOSITORY_ID, nameWithOwner: REPOSITORY },
    reviewSummaries: [],
    snapshot: {
      complete: true,
      observed_at: isoAt(prNumber),
      pr_number: prNumber,
      repo_id: REPOSITORY_ID,
      review_summary_ids: [],
      snapshot_id: snapshotId(prNumber),
      thread_ids: [threadId],
    },
    threads: [
      {
        comments: [
          {
            author: actor,
            authorAssociation: "MEMBER",
            body: 'invoke("save_profile") returns a Result; check isErr() and route result.error into showToast so the UI sees the failure.',
            createdAt: isoAt(prNumber),
            diffHunk: '+  await invoke("save_profile");',
            id: `comment-${String(prNumber)}`,
            updatedAt: isoAt(prNumber),
            url: `https://github.com/${REPOSITORY}/pull/${String(prNumber)}#comment-${String(prNumber)}`,
          },
        ],
        id: threadId,
        isOutdated: false,
        isResolved: false,
        path: `src/ipc/thread-${String(prNumber)}.ts`,
      },
    ],
  };
}

function snapshotId(prNumber: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const suffix = alphabet[prNumber];
  if (suffix === undefined) throw new Error("snapshot fixture out of range");
  return `snap_01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`;
}

function isoAt(prNumber: number): string {
  return new Date(BASE_MS + prNumber * ONE_MINUTE_MS).toISOString();
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
  const path = await mkdtemp(join(tmpdir(), "rkm-m2-e2e-"));
  temporaryDirectories.push(path);
  return path;
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  CommentObservationSchema,
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DistillJobCoordinator,
  HostAssistedDistillationService,
  PullRequestSnapshotSchema,
  RuntimeFinalizeContextStore,
  ThreadObservationSchema,
  computeDistillationInputDigest,
  computeCandidateSetSha256,
  computeMatchSetDigest,
  computePromptDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  computeTrustPolicyDigest,
  createDistillationJobEventRecord,
  createDomainId,
  parseRepoKnowledgeConfig,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistillJobCoordinatorOptions,
  type DomainExtractCandidate,
  type HostAssistedFinalizeJob,
  type HostAssistedMergeCandidateSearch,
  type RepoKnowledgeConfig,
} from "../src/experimental.js";

const REPO_ID = "repo-host-assisted";
const REPOSITORY = "owner/repo";
const REPOSITORY_CONTEXT = { language: "TypeScript" } as const;
const PROMPT_DIGEST = computePromptDigest("host-assisted prompt v1");
const START = Date.parse("2026-08-06T00:00:00.000Z");
const CANDIDATE_ID = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("HostAssistedDistillationService", () => {
  it("hashes candidate sets independent of array order and rejects duplicates", () => {
    const first = extractCandidate("comment-1");
    const second = {
      ...extractCandidate("comment-2"),
      candidate_id: "cand_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    };

    expect(computeCandidateSetSha256([first, second])).toBe(
      computeCandidateSetSha256([second, first]),
    );
    expect(() => computeCandidateSetSha256([first, first])).toThrow(
      expect.objectContaining({ code: "EXTRACT_RECEIPT_UNAVAILABLE" }),
    );
    expect(() => computeCandidateSetSha256([])).toThrow(
      expect.objectContaining({ code: "EXTRACT_RECEIPT_UNAVAILABLE" }),
    );
  });

  it.each([
    ["default settings", {}],
    ["enabled only", { hostAssistedDistillation: { enabled: true } }],
    [
      "transmission consent only",
      {
        hostAssistedDistillation: {
          allowReviewContentTransmission: true,
        },
      },
    ],
  ])(
    "returns metadata without raw review data for %s",
    async (_name, value) => {
      const root = await createRepository();
      const config = parseRepoKnowledgeConfig(value);
      await seedPendingJob(root, config, {
        body: "SENSITIVE_REVIEW_BODY",
        diffHunk: "SENSITIVE_DIFF_HUNK",
      });

      const result = await service(root, config).prepare();
      const serialized = JSON.stringify(result);

      expect(result.state).toBe("disabled");
      expect(result.jobs).toHaveLength(1);
      expect(serialized).not.toContain("SENSITIVE_REVIEW_BODY");
      expect(serialized).not.toContain("SENSITIVE_DIFF_HUNK");
      expect(serialized).not.toContain("lease_token");
      const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
      expect(snapshot.domain.distillJobs[0]!.state).toBe("pending");
    },
  );

  it("leases one job by default and omits every per-comment diff hunk", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    const first = await seedPendingJob(root, config, {
      body: "Prefer deterministic iteration.",
      diffHunk: "@@ sensitive first diff @@",
      offset: 0,
      prNumber: 1,
    });
    await seedPendingJob(root, config, {
      body: "Prefer explicit error handling.",
      diffHunk: "@@ sensitive second diff @@",
      offset: 1_000,
      prNumber: 2,
    });

    const result = await service(root, config, {
      leaseTokens: ["lease-token-1"],
      now: () => new Date(START + 2_000),
    }).prepare();

    expect(result).toMatchObject({ state: "prepared", blocked_jobs: [] });
    if (result.state !== "prepared") throw new Error("expected prepared");
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job).toMatchObject({
      job_id: first.jobId,
      lease_generation: 1,
      lease_token: "lease-token-1",
      phase: "extract",
      thread_fingerprint: first.contentFingerprint,
    });
    if (job.phase !== "extract") throw new Error("expected extract job");
    expect(job.comments[0]).toMatchObject({
      body: "Prefer deterministic iteration.",
      id: first.commentId,
    });
    expect(job.comments[0]).not.toHaveProperty("diff_hunk");
    expect(job.path).toBe("src/index.ts");
    expect(job.output_schema).toBe(DISTILLATION_OUTPUT_JSON_SCHEMA);
    expect(job.review_content_characters).toBeLessThanOrEqual(30_000);

    const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
    expect(
      snapshot.domain.distillJobs.filter(
        (candidate) => candidate.state === "processing",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.domain.distillJobs.filter(
        (candidate) => candidate.state === "pending",
      ),
    ).toHaveLength(1);
  });

  it("returns diff hunks only with explicit diff opt-in", async () => {
    const root = await createRepository();
    const config = enabledConfig({ includeDiffHunk: true });
    await seedPendingJob(root, config, {
      body: "Use a stable comparator.",
      diffHunk: "@@ -1 +1 @@\n-old\n+new",
    });

    const result = await service(root, config, {
      leaseTokens: ["diff-lease-token"],
      now: () => new Date(START + 1_000),
    }).prepare();

    if (result.state !== "prepared" || result.jobs[0]?.phase !== "extract") {
      throw new Error("expected an extract job");
    }
    expect(result.jobs[0].comments[0]!.diff_hunk).toBe(
      "@@ -1 +1 @@\n-old\n+new",
    );
  });

  it.each([
    {
      body: "ghp_0123456789abcdefghij0123456789",
      diffHunk: "@@ safe diff @@",
      expectedKind: "github_token",
      expectedPath: "$.comments[0].body",
      label: "review body",
      secret: "ghp_0123456789abcdefghij0123456789",
    },
    {
      body: "Use a stable comparator.",
      diffHunk: "-----BEGIN SYNTHETIC PRIVATE KEY-----",
      expectedKind: "private_key_block",
      expectedPath: "$.comments[0].diff_hunk",
      label: "diff hunk",
      secret: "-----BEGIN SYNTHETIC PRIVATE KEY-----",
    },
  ])(
    "blocks sensitive $label content before leasing or returning it",
    async (sample) => {
      const root = await createRepository();
      const config = enabledConfig({ includeDiffHunk: true });
      await seedPendingJob(root, config, {
        body: sample.body,
        diffHunk: sample.diffHunk,
      });

      const result = await service(root, config, {
        leaseTokens: ["must-not-be-issued"],
        now: () => new Date(START + 1_000),
      }).prepare();
      const serialized = JSON.stringify(result);

      expect(result).toMatchObject({
        blocked_jobs: [
          {
            reason: "sensitive_content_detected",
            sensitive_content_findings: [
              { kind: sample.expectedKind, path: sample.expectedPath },
            ],
          },
        ],
        jobs: [],
        state: "prepared",
      });
      expect(serialized).not.toContain(sample.secret);
      expect(serialized).not.toContain("must-not-be-issued");
      const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
      expect(snapshot.domain.distillJobs[0]).toMatchObject({
        lease_generation: 0,
        state: "pending",
      });
    },
  );

  it("does not lease or expose a job whose review payload exceeds the cap", async () => {
    const root = await createRepository();
    const config = enabledConfig({
      includeDiffHunk: true,
      maxCharactersPerJob: 32,
    });
    await seedPendingJob(root, config, {
      body: "OVERSIZED_SECRET_REVIEW_BODY",
      diffHunk: "OVERSIZED_SECRET_DIFF",
    });

    const result = await service(root, config, {
      leaseTokens: ["must-not-be-issued"],
      now: () => new Date(START + 1_000),
    }).prepare();
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      blocked_jobs: [
        {
          max_characters_per_job: 32,
          reason: "max_characters_exceeded",
        },
      ],
      jobs: [],
      state: "prepared",
    });
    expect(serialized).not.toContain("OVERSIZED_SECRET_REVIEW_BODY");
    expect(serialized).not.toContain("OVERSIZED_SECRET_DIFF");
    expect(serialized).not.toContain("must-not-be-issued");
    const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
    expect(snapshot.domain.distillJobs[0]!.state).toBe("pending");
  });

  it("does not expose source data when the prompt context no longer matches the job", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    await seedPendingJob(root, config, {
      body: "CONTEXT_CHANGED_SECRET_BODY",
      diffHunk: "CONTEXT_CHANGED_SECRET_DIFF",
    });

    const result = await service(root, config, {
      leaseTokens: ["must-not-be-issued"],
      now: () => new Date(START + 1_000),
      promptDigest: computePromptDigest("host-assisted prompt v2"),
    }).prepare();
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      blocked_jobs: [{ reason: "distillation_context_changed" }],
      jobs: [],
      state: "prepared",
    });
    expect(serialized).not.toContain("CONTEXT_CHANGED_SECRET_BODY");
    expect(serialized).not.toContain("CONTEXT_CHANGED_SECRET_DIFF");
    expect(serialized).not.toContain("must-not-be-issued");
  });

  it("applies an explicit limit and rejects values above the public bound", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    for (let index = 0; index < 3; index += 1) {
      await seedPendingJob(root, config, {
        body: `Review body ${String(index)}`,
        offset: index * 1_000,
        prNumber: index + 1,
      });
    }
    const host = service(root, config, {
      leaseTokens: ["limit-token-1", "limit-token-2"],
      now: () => new Date(START + 4_000),
    });

    await expect(host.prepare({ limit: 11 })).rejects.toMatchObject({
      code: "INVALID_PREPARE_LIMIT",
    });
    const result = await host.prepare({ limit: 2 });

    expect(result.state).toBe("prepared");
    expect(result.jobs).toHaveLength(2);
  });

  it("resumes an expired awaiting-finalize job after restart without re-extracting", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    const fixture = await seedPendingJob(root, config, {
      body: "Prefer deterministic ordering in repository services.",
    });
    let now = START + 1_000;
    const originalCoordinator = new DistillJobCoordinator(
      new CanonicalTransactionStore(root),
      coordinatorOptions({
        leaseDurationMs: 1_000,
        leaseTokens: ["original-lease-token"],
        now: () => new Date(now),
      }),
    );
    const originalLease = await originalCoordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPO_ID,
    });
    expect(originalLease).not.toBeNull();
    await originalCoordinator.markAwaitingFinalize(originalLease!);
    const candidates = [extractCandidate(fixture.commentId)];
    await appendExtractReceipt(root, fixture.jobId, candidates, now + 100);
    await writeKnowledge(root);

    now += 200;
    const contexts = new RuntimeFinalizeContextStore({
      nextToken: () => "restart-finalize-token",
      now: () => new Date(now),
    });
    const restarted = service(root, config, {
      finalizeContexts: contexts,
      leaseDurationMs: 5_000,
      leaseTokens: ["resumed-lease-token"],
      now: () => new Date(now),
    });

    const result = await restarted.prepare();

    if (result.state !== "prepared" || result.jobs[0]?.phase !== "finalize") {
      throw new Error("expected a resumed finalize job");
    }
    const resumed = result.jobs[0] as HostAssistedFinalizeJob;
    expect(resumed).toMatchObject({
      candidates,
      job_id: fixture.jobId,
      lease_generation: 2,
      lease_token: "resumed-lease-token",
      phase: "finalize",
      thread_fingerprint: fixture.contentFingerprint,
    });
    expect(resumed).not.toHaveProperty("comments");
    expect(resumed).not.toHaveProperty("output_schema");
    expect(resumed.finalize_handle).toEqual({
      expires_at: resumed.expires_at,
      finalize_token: "restart-finalize-token",
      lease_generation: 2,
    });
    expect(
      resumed.possible_matches[0]!.possible_matches.map(
        (match) => match.knowledge_id,
      ),
    ).toContain(KNOWLEDGE_ID);
    expect(resumed.candidate_set_sha256).toBe(
      computeCandidateSetSha256(candidates),
    );

    const context = contexts.find("restart-finalize-token");
    expect(context).toMatchObject({
      candidate_set_sha256: resumed.candidate_set_sha256,
      content_fingerprint: fixture.contentFingerprint,
      distillation_key: fixture.distillationKey,
      job_id: fixture.jobId,
      lease_generation: 2,
      match_set_digest: resumed.match_set_digest,
      source_snapshot_id: fixture.snapshotId,
    });
    const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
    expect(snapshot.domain.distillJobs[0]).toMatchObject({
      lease_generation: 2,
      state: "awaiting_finalize",
    });
    expect(JSON.stringify(snapshot.records)).not.toContain(
      "restart-finalize-token",
    );
    expect(
      await readFile(join(root, "events", "distillation.jsonl"), "utf8"),
    ).not.toContain("restart-finalize-token");
  });

  it("blocks a sensitive candidate before returning a finalize job", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    const fixture = await seedPendingJob(root, config, {
      body: "Prefer deterministic ordering in repository services.",
    });
    let now = START + 1_000;
    const coordinator = new DistillJobCoordinator(
      new CanonicalTransactionStore(root),
      coordinatorOptions({
        leaseTokens: ["original-lease-token"],
        now: () => new Date(now),
      }),
    );
    const lease = await coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPO_ID,
    });
    await coordinator.markAwaitingFinalize(lease!);
    const secret = "candidate-owner@example.com";
    const baseCandidate = extractCandidate(fixture.commentId);
    await appendExtractReceipt(
      root,
      fixture.jobId,
      [
        {
          ...baseCandidate,
          candidate: { ...baseCandidate.candidate, rule: secret },
        },
      ],
      now + 100,
    );
    now += 200;
    const contexts = new RuntimeFinalizeContextStore({
      nextToken: () => "must-not-be-issued",
      now: () => new Date(now),
    });

    const result = await service(root, config, {
      finalizeContexts: contexts,
      leaseTokens: ["must-not-be-issued"],
      now: () => new Date(now),
    }).prepare();

    expect(result).toMatchObject({
      blocked_jobs: [
        {
          reason: "sensitive_content_detected",
          sensitive_content_findings: [
            {
              kind: "email_address",
              path: "$.candidates[0].candidate.rule",
            },
          ],
        },
      ],
      jobs: [],
      state: "prepared",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(contexts.size).toBe(0);
  });

  it("blocks a sensitive possible match before issuing a finalize handle", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    const fixture = await seedPendingJob(root, config, {
      body: "Prefer deterministic ordering in repository services.",
    });
    let now = START + 1_000;
    const coordinator = new DistillJobCoordinator(
      new CanonicalTransactionStore(root),
      coordinatorOptions({
        leaseTokens: ["original-lease-token"],
        now: () => new Date(now),
      }),
    );
    const lease = await coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPO_ID,
    });
    await coordinator.markAwaitingFinalize(lease!);
    await appendExtractReceipt(
      root,
      fixture.jobId,
      [extractCandidate(fixture.commentId)],
      now + 100,
    );
    const secret = "knowledge-owner@example.com";
    await writeKnowledge(root, {
      rule: `Prefer deterministic ordering in repository services. Contact ${secret}`,
    });
    now += 200;
    const contexts = new RuntimeFinalizeContextStore({
      nextToken: () => "must-not-be-issued",
      now: () => new Date(now),
    });

    const result = await service(root, config, {
      finalizeContexts: contexts,
      leaseTokens: ["resumed-lease-token"],
      now: () => new Date(now),
    }).prepare();

    expect(result).toMatchObject({
      blocked_jobs: [
        {
          reason: "sensitive_content_detected",
          sensitive_content_findings: [
            {
              kind: "email_address",
              path: "$.possible_matches[0].possible_matches[0].rule",
            },
          ],
        },
      ],
      jobs: [],
      state: "prepared",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(contexts.size).toBe(0);
    const snapshot = await new CanonicalTransactionStore(root).readSnapshot();
    expect(snapshot.domain.distillJobs[0]?.state).toBe("failed");
  });

  it("does not issue a finalize handle when ingest changes the source during match search", async () => {
    const root = await createRepository();
    const config = enabledConfig();
    const fixture = await seedPendingJob(root, config, {
      body: "Original review source.",
    });
    let now = START + 1_000;
    const coordinator = new DistillJobCoordinator(
      new CanonicalTransactionStore(root),
      coordinatorOptions({
        leaseTokens: ["original-lease-token"],
        now: () => new Date(now),
      }),
    );
    const lease = await coordinator.acquireLease({
      job_id: fixture.jobId,
      repo_id: REPO_ID,
    });
    await coordinator.markAwaitingFinalize(lease!);
    const candidates = [extractCandidate(fixture.commentId)];
    await appendExtractReceipt(root, fixture.jobId, candidates, now + 100);
    const contexts = new RuntimeFinalizeContextStore({
      nextToken: () => "must-not-be-issued",
      now: () => new Date(now),
    });
    const mergeCandidateSearch: HostAssistedMergeCandidateSearch = {
      search: async (request) => {
        await appendChangedSource(root, fixture, now + 200);
        const possibleMatches = request.candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          possible_matches: [],
        }));
        return {
          candidates: request.candidates,
          match_set_digest: computeMatchSetDigest(possibleMatches),
          possible_matches: possibleMatches,
        };
      },
    };

    now += 150;
    const result = await service(root, config, {
      finalizeContexts: contexts,
      leaseTokens: ["resumed-lease-token"],
      mergeCandidateSearch,
      now: () => new Date(now),
    }).prepare();

    expect(result).toMatchObject({
      blocked_jobs: [{ reason: "distillation_context_changed" }],
      jobs: [],
      state: "prepared",
    });
    expect(contexts.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain("must-not-be-issued");
  });
});

interface SeedJobOptions {
  readonly body: string;
  readonly diffHunk?: string;
  readonly offset?: number;
  readonly prNumber?: number;
}

interface SeededJob {
  readonly commentId: string;
  readonly contentFingerprint: string;
  readonly distillationKey: string;
  readonly jobId: string;
  readonly prNumber: number;
  readonly snapshotId: string;
  readonly threadId: string;
}

async function seedPendingJob(
  root: string,
  config: RepoKnowledgeConfig,
  options: SeedJobOptions,
): Promise<SeededJob> {
  const offset = options.offset ?? 0;
  const prNumber = options.prNumber ?? 1;
  const timestamp = START + offset;
  const observedAt = new Date(timestamp).toISOString();
  const snapshotId = createDomainId("snapshot", timestamp);
  const transactionId = createDomainId("transaction", timestamp);
  const jobId = createDomainId("job", timestamp);
  const threadId = `thread-${String(prNumber)}`;
  const commentId = `comment-${String(prNumber)}`;
  const normalizedComment = {
    body: options.body,
    createdAt: observedAt,
    ...(options.diffHunk === undefined ? {} : { diffHunk: options.diffHunk }),
    id: commentId,
    updatedAt: observedAt,
  };
  const normalizedActor = {
    actor_id: "actor-alice",
    actor_kind: "user" as const,
    authorAssociation: "MEMBER",
    login: "alice",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  const path = "src/index.ts";
  const contentFingerprint = computeThreadContentFingerprint(threadId, path, [
    normalizedComment,
  ]);
  const distillationInputDigest = computeDistillationInputDigest({
    normalizedActors: [normalizedActor],
    normalizedComments: [normalizedComment],
    path,
    repositoryContext: REPOSITORY_CONTEXT,
    threadId,
  });
  const distillationKey = computeThreadDistillationKey({
    distillationInputDigest,
    outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    promptDigest: PROMPT_DIGEST,
    trustPolicyDigest: computeTrustPolicyDigest(config.trust),
  });
  const snapshot = PullRequestSnapshotSchema.parse({
    complete: true,
    observed_at: observedAt,
    pr_number: prNumber,
    repo_id: REPO_ID,
    review_summary_ids: [],
    snapshot_id: snapshotId,
    thread_ids: [threadId],
  });
  const thread = ThreadObservationSchema.parse({
    comment_ids: [commentId],
    content_fingerprint: contentFingerprint,
    is_outdated: false,
    is_resolved: false,
    observation_id: createDomainId("observation", timestamp),
    observation_type: "thread",
    observed_at: observedAt,
    path,
    pr_number: prNumber,
    repo_id: REPO_ID,
    snapshot_id: snapshotId,
    state_fingerprint: `sha256:${"a".repeat(64)}`,
    thread_id: threadId,
  });
  const comment = CommentObservationSchema.parse({
    actor: {
      actor_id: "actor-alice",
      actor_kind: "user",
      author_association: "MEMBER",
      login: "alice",
      provider: "human",
      trust: "trusted",
    },
    body: options.body,
    comment_id: commentId,
    created_at: observedAt,
    ...(options.diffHunk === undefined ? {} : { diff_hunk: options.diffHunk }),
    observation_id: createDomainId("observation", timestamp + 1),
    observation_type: "comment",
    observed_at: observedAt,
    snapshot_id: snapshotId,
    thread_id: threadId,
    updated_at: observedAt,
    url: `https://github.com/${REPOSITORY}/pull/${String(
      prNumber,
    )}#discussion_r${String(prNumber)}`,
  });
  const records: CanonicalJsonlRecord[] = [
    canonicalRecord("PullRequestSnapshot", snapshot, snapshotId, transactionId),
    canonicalRecord(
      "ThreadObservation",
      thread,
      thread.observation_id,
      transactionId,
    ),
    canonicalRecord(
      "CommentObservation",
      comment,
      comment.observation_id,
      transactionId,
    ),
    createDistillationJobEventRecord({
      eventId: createDomainId("event", timestamp),
      payload: {
        distillation_key: distillationKey,
        job_id: jobId,
        repo_id: REPO_ID,
        thread_id: threadId,
      },
      recordedAt: observedAt,
      transactionId,
      type: "DistillationJobCreated",
    }),
  ];
  await new CanonicalTransactionStore(root).commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath:
        record.record_type === "DistillationJobCreated"
          ? "events/distillation.jsonl"
          : "raw/host-assisted-fixture.jsonl",
    })),
    createdAt: observedAt,
    fileWrites: [],
    transactionId,
  });
  return {
    commentId,
    contentFingerprint,
    distillationKey,
    jobId,
    prNumber,
    snapshotId,
    threadId,
  };
}

async function appendChangedSource(
  root: string,
  fixture: SeededJob,
  timestamp: number,
): Promise<void> {
  const observedAt = new Date(timestamp).toISOString();
  const snapshotId = createDomainId("snapshot", timestamp);
  const transactionId = createDomainId("transaction", timestamp);
  const changedBody = "Changed review source during match search.";
  const normalizedComment = {
    body: changedBody,
    createdAt: new Date(START).toISOString(),
    id: fixture.commentId,
    updatedAt: observedAt,
  };
  const contentFingerprint = computeThreadContentFingerprint(
    fixture.threadId,
    "src/index.ts",
    [normalizedComment],
  );
  const snapshot = PullRequestSnapshotSchema.parse({
    complete: true,
    observed_at: observedAt,
    pr_number: fixture.prNumber,
    repo_id: REPO_ID,
    review_summary_ids: [],
    snapshot_id: snapshotId,
    thread_ids: [fixture.threadId],
  });
  const thread = ThreadObservationSchema.parse({
    comment_ids: [fixture.commentId],
    content_fingerprint: contentFingerprint,
    is_outdated: false,
    is_resolved: false,
    observation_id: createDomainId("observation", timestamp),
    observation_type: "thread",
    observed_at: observedAt,
    path: "src/index.ts",
    pr_number: fixture.prNumber,
    repo_id: REPO_ID,
    snapshot_id: snapshotId,
    state_fingerprint: `sha256:${"a".repeat(64)}`,
    thread_id: fixture.threadId,
  });
  const comment = CommentObservationSchema.parse({
    actor: {
      actor_id: "actor-alice",
      actor_kind: "user",
      author_association: "MEMBER",
      login: "alice",
      provider: "human",
      trust: "trusted",
    },
    body: changedBody,
    comment_id: fixture.commentId,
    created_at: normalizedComment.createdAt,
    observation_id: createDomainId("observation", timestamp + 1),
    observation_type: "comment",
    observed_at: observedAt,
    snapshot_id: snapshotId,
    thread_id: fixture.threadId,
    updated_at: observedAt,
    url: `https://github.com/${REPOSITORY}/pull/${String(
      fixture.prNumber,
    )}#discussion_r${String(fixture.prNumber)}`,
  });
  const records: CanonicalJsonlRecord[] = [
    canonicalRecord(
      "PullRequestSnapshot",
      snapshot,
      snapshotId,
      transactionId,
      observedAt,
    ),
    canonicalRecord(
      "ThreadObservation",
      thread,
      thread.observation_id,
      transactionId,
      observedAt,
    ),
    canonicalRecord(
      "CommentObservation",
      comment,
      comment.observation_id,
      transactionId,
      observedAt,
    ),
  ];
  await new CanonicalTransactionStore(root).commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath: "raw/host-assisted-fixture.jsonl",
    })),
    createdAt: observedAt,
    fileWrites: [],
    transactionId,
  });
}

async function appendExtractReceipt(
  root: string,
  jobId: string,
  candidates: readonly DomainExtractCandidate[],
  timestamp: number,
): Promise<void> {
  const committedAt = new Date(timestamp).toISOString();
  const transactionId = createDomainId("transaction", timestamp);
  const receiptId = createDomainId("receipt", timestamp);
  const record: CanonicalJsonlRecord = {
    payload: {
      committed_at: committedAt,
      job_id: jobId,
      phase: "extract",
      receipt_id: receiptId,
      request_sha256: `sha256:${"b".repeat(64)}`,
      stable_response: {
        candidates,
        state: "merge_decision_required",
      },
      submission_id: "extract-submission-1",
    },
    record_id: receiptId,
    record_type: "SubmissionReceipt",
    recorded_at: committedAt,
    schema_version: 1,
    transaction_id: transactionId,
  };
  await new CanonicalTransactionStore(root).commit({
    appendRecords: [{ record, targetPath: "events/submissions.jsonl" }],
    createdAt: committedAt,
    fileWrites: [],
    transactionId,
  });
}

function extractCandidate(commentId: string): DomainExtractCandidate {
  return {
    candidate: {
      category: "test",
      confidence: 0.95,
      detail: "Use deterministic ordering for stable repository behavior.",
      evidence_comment_ids: [commentId],
      rule: "Prefer deterministic ordering in repository services.",
      scope: ["src/**"],
      severity: "should",
    },
    candidate_id: CANDIDATE_ID,
  };
}

async function writeKnowledge(
  root: string,
  options: { readonly rule?: string } = {},
): Promise<void> {
  const relativePath = `knowledge/${KNOWLEDGE_ID}.md`;
  await mkdir(join(root, "knowledge"), { recursive: true });
  await writeFile(
    join(root, relativePath),
    serializeKnowledgeDocument(
      relativePath,
      {
        category: "test",
        created_at: new Date(START).toISOString(),
        id: KNOWLEDGE_ID,
        repo_id: REPO_ID,
        revision: 1,
        rule:
          options.rule ??
          "Prefer deterministic ordering in repository services.",
        schema_version: 1,
        scope: ["src/**"],
        severity: "should",
        status: "active",
        updated_at: new Date(START).toISOString(),
      },
      "Use stable comparators so repository output remains reproducible.\n",
    ),
  );
}

interface ServiceTestOptions {
  readonly finalizeContexts?: RuntimeFinalizeContextStore;
  readonly leaseDurationMs?: number;
  readonly leaseTokens?: readonly string[];
  readonly mergeCandidateSearch?: HostAssistedMergeCandidateSearch;
  readonly now?: () => Date;
  readonly promptDigest?: string;
}

function service(
  root: string,
  config: RepoKnowledgeConfig,
  options: ServiceTestOptions = {},
): HostAssistedDistillationService {
  return new HostAssistedDistillationService({
    config,
    coordinatorOptions: coordinatorOptions(options),
    ...(options.finalizeContexts === undefined
      ? {}
      : { finalizeContexts: options.finalizeContexts }),
    ...(options.mergeCandidateSearch === undefined
      ? {}
      : { mergeCandidateSearch: options.mergeCandidateSearch }),
    promptDigest: options.promptDigest ?? PROMPT_DIGEST,
    repository: {
      absolutePath: root,
      aliases: [],
      currentName: REPOSITORY,
      path: "repo-host-assisted",
      repoId: REPO_ID,
      source: "tool-repo",
    },
    repositoryContext: REPOSITORY_CONTEXT,
  });
}

function coordinatorOptions(
  options: Pick<ServiceTestOptions, "leaseDurationMs" | "leaseTokens" | "now">,
): DistillJobCoordinatorOptions {
  const tokens = [...(options.leaseTokens ?? [])];
  return {
    ...(options.leaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: options.leaseDurationMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(tokens.length === 0
      ? {}
      : {
          nextLeaseToken: () => {
            const token = tokens.shift();
            if (token === undefined) throw new Error("lease token exhausted");
            return token;
          },
        }),
  };
}

function enabledConfig(
  overrides: Partial<{
    includeDiffHunk: boolean;
    maxCharactersPerJob: number;
  }> = {},
): RepoKnowledgeConfig {
  return parseRepoKnowledgeConfig({
    hostAssistedDistillation: {
      allowReviewContentTransmission: true,
      enabled: true,
      includeDiffHunk: overrides.includeDiffHunk ?? false,
      maxCharactersPerJob: overrides.maxCharactersPerJob ?? 30_000,
    },
  });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rkm-host-assisted-"));
  temporaryRepositories.push(root);
  return root;
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  recordId: string,
  transactionId: string,
  recordedAt = new Date(START).toISOString(),
): CanonicalJsonlRecord<T> {
  return {
    payload,
    record_id: recordId,
    record_type: recordType,
    recorded_at: recordedAt,
    schema_version: 1,
    transaction_id: transactionId,
  };
}

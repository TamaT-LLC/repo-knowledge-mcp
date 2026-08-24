import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  CommentObservationSchema,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  PullRequestSnapshotSchema,
  RuntimeFinalizeContextStore,
  SubmitDistillationService,
  ThreadObservationSchema,
  computeDistillationInputDigest,
  computePromptDigest,
  computeThreadContentFingerprint,
  computeThreadDistillationKey,
  computeTrustPolicyDigest,
  createDistillationJobEventRecord,
  createDomainId,
  hashLeaseToken,
  parseRepoKnowledgeConfig,
  serializeKnowledgeDocument,
  type CanonicalJsonlRecord,
  type DistilledCandidate,
  type RepoKnowledgeConfig,
  type SubmitDistillationContextOptions,
  type SubmitExtractMergeResponse,
  type SubmitFinalizeRequest,
} from "../src/experimental.js";

const REPO_ID = "repo-submit-finalize";
const REPOSITORY_CONTEXT = { language: "TypeScript" } as const;
const PROMPT_DIGEST = computePromptDigest("submit finalize prompt v1");
const PROMPT_VERSION = "distill-v1";
const START = Date.parse("2026-08-06T00:00:00.000Z");
const LEASE_TOKEN = "plaintext-finalize-lease-token";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OUTSIDE_KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SubmitDistillationService finalize", () => {
  it("commits finalizer artifacts and receipt atomically, then replays after expiry and restart", async () => {
    const fixture = await createPreparedFixture();
    const request = finalizeRequest(fixture);

    const response = await fixture.service.submitFinalize(request);

    expect(response).toMatchObject({
      accepted: true,
      created_active: [],
      created_proposed: [expect.stringMatching(/^kn_/u)],
      merged_evidence: [expect.stringMatching(/^ev_/u)],
      revision_proposals: [],
    });
    const committed = await fixture.store.readSnapshot();
    expect(committed.domain.distillJobs[0]?.state).toBe("done");
    expect(committed.domain.submissionReceipts).toHaveLength(2);
    expect(committed.domain.evidence).toHaveLength(1);
    expect(committed.domain.knowledge).toHaveLength(1);
    const finalRecords = committed.records.filter((entry) =>
      [
        "DistillationJobSucceeded",
        "EvidenceCreated",
        "SubmissionReceipt",
      ].includes(entry.record.record_type),
    );
    const finalizeReceipt = finalRecords.find(
      (entry) =>
        entry.record.record_type === "SubmissionReceipt" &&
        (entry.record.payload as { phase?: string }).phase === "finalize",
    );
    expect(finalizeReceipt).toBeDefined();
    const finalizeTransactionId = finalizeReceipt!.record.transaction_id;
    expect(
      finalRecords
        .filter(
          (entry) =>
            entry.record.record_type !== "SubmissionReceipt" ||
            (entry.record.payload as { phase?: string }).phase === "finalize",
        )
        .map((entry) => entry.record.transaction_id),
    ).toEqual([
      finalizeTransactionId,
      finalizeTransactionId,
      finalizeTransactionId,
    ]);
    expect(
      fixture.contexts.find(fixture.extract.finalize_handle.finalize_token),
    ).toBeUndefined();

    fixture.clock.value = fixture.leaseExpiresAt + 60_000;
    const restarted = submitService(
      new CanonicalTransactionStore(fixture.root),
      runtimeContexts([], fixture.clock),
      fixture.clock,
      fixture.config,
    );
    await expect(restarted.submitFinalize(request)).resolves.toEqual(response);
    await expect(
      restarted.submitFinalize({
        ...request,
        submission_id: "finalize-equivalent-submission",
      }),
    ).resolves.toEqual(response);

    const replayed = await fixture.store.readSnapshot();
    expect(replayed.domain.submissionReceipts).toHaveLength(2);
    expect(replayed.domain.evidence).toHaveLength(1);
    const canonicalBytes = await Promise.all([
      readFile(join(fixture.root, "events", "distillation.jsonl")),
      readFile(join(fixture.root, "events", "submissions.jsonl")),
      readFile(join(fixture.root, "index.sqlite")),
    ]);
    for (const plaintext of [
      LEASE_TOKEN,
      fixture.extract.finalize_handle.finalize_token,
    ]) {
      expect(
        canonicalBytes.some((bytes) => bytes.includes(Buffer.from(plaintext))),
      ).toBe(false);
    }
  });

  it("auto-activates an eligible trusted-human non-must candidate on the host-assisted path", async () => {
    const fixture = await createPreparedFixture({
      candidateSeverity: "should",
      config: autoActivationConfig(),
    });

    const response = await fixture.service.submitFinalize(
      finalizeRequest(fixture),
    );

    expect(response).toMatchObject({
      accepted: true,
      created_active: [expect.stringMatching(/^kn_/u)],
      created_proposed: [],
      revision_proposals: [],
    });
    const committed = await fixture.store.readSnapshot();
    expect(committed.domain.knowledge).toEqual([
      expect.objectContaining({ severity: "should", status: "active" }),
    ]);
  });

  it("distinguishes changed idempotency keys from a phase already committed", async () => {
    const fixture = await createPreparedFixture();
    const request = finalizeRequest(fixture);
    await fixture.service.submitFinalize(request);
    const changedDecision = {
      candidate_id: fixture.extract.candidates[0]!.candidate_id,
      relation: "same" as const,
      target_id: OUTSIDE_KNOWLEDGE_ID,
    };

    await expect(
      fixture.service.submitFinalize({
        ...request,
        decisions: [changedDecision],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      fixture.service.submitFinalize({
        ...request,
        decisions: [changedDecision],
        submission_id: "finalize-different-request",
      }),
    ).rejects.toMatchObject({ code: "PHASE_ALREADY_COMMITTED" });
  });

  it("serializes concurrent equivalent submissions into one finalize commit", async () => {
    const fixture = await createPreparedFixture();
    const request = finalizeRequest(fixture);

    const [first, second] = await Promise.all([
      fixture.service.submitFinalize(request),
      fixture.service.submitFinalize({
        ...request,
        submission_id: "parallel-equivalent-submission",
      }),
    ]);

    expect(second).toEqual(first);
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.submissionReceipts).toHaveLength(2);
    expect(snapshot.domain.evidence).toHaveLength(1);
    expect(snapshot.domain.knowledge).toHaveLength(1);
    expect(snapshot.domain.distillJobs[0]?.state).toBe("done");
  });

  it("rejects edited review content as DISTILLATION_SOURCE_CHANGED without writing", async () => {
    const fixture = await createPreparedFixture();
    await ingestEditedSource(fixture, "Edited review body after extract.");

    await expect(
      fixture.service.submitFinalize(finalizeRequest(fixture)),
    ).rejects.toMatchObject({ code: "DISTILLATION_SOURCE_CHANGED" });
    await expectUnfinalized(fixture.store);
  });

  it.each([
    {
      label: "prompt",
      override: { promptDigest: computePromptDigest("changed prompt") },
    },
    {
      label: "schema",
      override: { outputSchemaDigest: `sha256:${"9".repeat(64)}` },
    },
    {
      label: "trust policy",
      override: {
        config: parseRepoKnowledgeConfig({
          hostAssistedDistillation: {
            allowReviewContentTransmission: true,
            enabled: true,
          },
          trust: { autoActivateTrustedHuman: true },
        }),
      },
    },
  ])(
    "rejects a changed $label context without writing",
    async ({ override }) => {
      const fixture = await createPreparedFixture();
      const changed = submitService(
        fixture.store,
        fixture.contexts,
        fixture.clock,
        override.config ?? fixture.config,
        override,
      );

      await expect(
        changed.submitFinalize(finalizeRequest(fixture)),
      ).rejects.toMatchObject({ code: "DISTILLATION_CONTEXT_CHANGED" });
      await expectUnfinalized(fixture.store);
    },
  );

  it("returns latest matches and a fresh token when the match set changes", async () => {
    const fixture = await createPreparedFixture({
      finalizeTokens: ["original-finalize-token", "refreshed-finalize-token"],
    });
    await writeKnowledge(fixture.root);
    const firstRequest = finalizeRequest(fixture);

    let changed: unknown;
    try {
      await fixture.service.submitFinalize(firstRequest);
    } catch (error) {
      changed = error;
    }
    expect(changed).toMatchObject({
      code: "MERGE_CANDIDATES_CHANGED",
      retry: {
        candidate_set_sha256: fixture.extract.candidate_set_sha256,
        finalize_handle: {
          finalize_token: "refreshed-finalize-token",
          lease_generation: 1,
        },
        possible_matches: [
          {
            possible_matches: [
              expect.objectContaining({ knowledge_id: KNOWLEDGE_ID }),
            ],
          },
        ],
        state: "merge_decision_required",
      },
    });
    expect(fixture.contexts.find(firstRequest.finalize_token)).toBeUndefined();
    await expectUnfinalized(fixture.store, 1);
    const retry = (
      changed as {
        retry: { finalize_handle: { finalize_token: string } };
      }
    ).retry;

    await expect(
      fixture.service.submitFinalize({
        ...firstRequest,
        decisions: [
          {
            candidate_id: fixture.extract.candidates[0]!.candidate_id,
            relation: "same",
            target_id: KNOWLEDGE_ID,
          },
        ],
        finalize_token: retry.finalize_handle.finalize_token,
        submission_id: "finalize-after-match-refresh",
      }),
    ).resolves.toMatchObject({ accepted: true, created_proposed: [] });
  });

  it.each([
    {
      label: "missing decision",
      decisions: [],
    },
    {
      label: "duplicate decision",
      decisions: "duplicate" as const,
    },
    {
      label: "unknown target",
      decisions: "unknown-target" as const,
    },
  ])("rejects $label without a partial commit", async ({ decisions }) => {
    const fixture = await createPreparedFixture();
    const candidateId = fixture.extract.candidates[0]!.candidate_id;
    const resolved =
      decisions === "duplicate"
        ? [different(candidateId), different(candidateId)]
        : decisions === "unknown-target"
          ? [
              {
                candidate_id: candidateId,
                relation: "same" as const,
                target_id: OUTSIDE_KNOWLEDGE_ID,
              },
            ]
          : decisions;

    await expect(
      fixture.service.submitFinalize({
        ...finalizeRequest(fixture),
        decisions: resolved,
      }),
    ).rejects.toMatchObject({ code: "FINALIZE_REQUEST_INVALID" });
    await expectUnfinalized(fixture.store);
  });

  it("rejects candidate, token, and lease binding mismatches without writing", async () => {
    const fixture = await createPreparedFixture();
    const request = finalizeRequest(fixture);

    await expect(
      fixture.service.submitFinalize({
        ...request,
        candidate_set_sha256: "0".repeat(64),
        submission_id: "wrong-candidate-set",
      }),
    ).rejects.toMatchObject({ code: "FINALIZE_REQUEST_INVALID" });
    await expect(
      fixture.service.submitFinalize({
        ...request,
        finalize_token: "unknown-finalize-token",
        submission_id: "unknown-token",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_FINALIZE_TOKEN" });
    await expect(
      fixture.service.submitFinalize({
        ...request,
        lease_token: "wrong-lease-token",
        submission_id: "wrong-lease",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LEASE_TOKEN" });
    await expectUnfinalized(fixture.store);

    fixture.clock.value = fixture.leaseExpiresAt + 1;
    await expect(
      fixture.service.submitFinalize({
        ...request,
        submission_id: "expired-token",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_FINALIZE_TOKEN" });
    await expectUnfinalized(fixture.store);
  });

  it("recovers a crash after prepared with both receipt and finalizer artifacts", async () => {
    const fixture = await createPreparedFixture();
    let failed = false;
    const crashingStore = new CanonicalTransactionStore(fixture.root, {
      faultInjector(point) {
        if (!failed && point === "after_prepared") {
          failed = true;
          throw new Error("simulated submit-finalize crash");
        }
      },
    });
    const crashing = submitService(
      crashingStore,
      fixture.contexts,
      fixture.clock,
      fixture.config,
    );
    const request = finalizeRequest(fixture);

    await expect(crashing.submitFinalize(request)).rejects.toThrow(
      "simulated submit-finalize crash",
    );

    const recoveredStore = new CanonicalTransactionStore(fixture.root);
    const recovered = await recoveredStore.readSnapshot();
    expect(recovered.domain.distillJobs[0]?.state).toBe("done");
    expect(recovered.domain.submissionReceipts).toHaveLength(2);
    expect(recovered.domain.evidence).toHaveLength(1);
    expect(recovered.domain.knowledge).toHaveLength(1);
    const restarted = submitService(
      recoveredStore,
      runtimeContexts([], fixture.clock),
      fixture.clock,
      fixture.config,
    );
    await expect(restarted.submitFinalize(request)).resolves.toMatchObject({
      accepted: true,
    });
  });
});

interface Clock {
  value: number;
}

interface PreparedFixture {
  readonly clock: Clock;
  readonly commentId: string;
  readonly config: RepoKnowledgeConfig;
  readonly contexts: RuntimeFinalizeContextStore;
  readonly contentFingerprint: string;
  readonly extract: SubmitExtractMergeResponse;
  readonly jobId: string;
  readonly leaseExpiresAt: number;
  readonly root: string;
  readonly service: SubmitDistillationService;
  readonly snapshotId: string;
  readonly store: CanonicalTransactionStore;
  readonly threadId: string;
}

async function createPreparedFixture(
  options: {
    readonly candidateSeverity?: "must" | "should";
    readonly config?: RepoKnowledgeConfig;
    readonly finalizeTokens?: readonly string[];
  } = {},
): Promise<PreparedFixture> {
  const root = await mkdtemp(join(tmpdir(), "rkm-submit-finalize-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "knowledge"), { recursive: true });
  const clock = { value: START + 2_000 };
  const leaseExpiresAt = START + 60_000;
  const config =
    options.config ??
    parseRepoKnowledgeConfig({
      hostAssistedDistillation: {
        allowReviewContentTransmission: true,
        enabled: true,
      },
    });
  const snapshotId = createDomainId("snapshot", START);
  const transactionId = createDomainId("transaction", START);
  const jobId = createDomainId("job", START);
  const threadId = "thread-submit-finalize";
  const commentId = "comment-submit-finalize";
  const body = "Prefer one atomic receipt and knowledge commit.";
  const normalizedComment = {
    body,
    createdAt: new Date(START).toISOString(),
    id: commentId,
    updatedAt: new Date(START).toISOString(),
  };
  const normalizedActor = {
    actor_id: "actor-alice",
    actor_kind: "user" as const,
    authorAssociation: "MEMBER",
    login: "alice",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  const contentFingerprint = computeThreadContentFingerprint(
    threadId,
    "src/index.ts",
    [normalizedComment],
  );
  const distillationKey = computeThreadDistillationKey({
    distillationInputDigest: computeDistillationInputDigest({
      normalizedActors: [normalizedActor],
      normalizedComments: [normalizedComment],
      path: "src/index.ts",
      repositoryContext: REPOSITORY_CONTEXT,
      threadId,
    }),
    outputSchemaDigest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
    promptDigest: PROMPT_DIGEST,
    trustPolicyDigest: computeTrustPolicyDigest(config.trust),
  });
  const snapshot = PullRequestSnapshotSchema.parse({
    complete: true,
    observed_at: new Date(START).toISOString(),
    pr_number: 1,
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
    observation_id: createDomainId("observation", START),
    observation_type: "thread",
    observed_at: new Date(START).toISOString(),
    path: "src/index.ts",
    pr_number: 1,
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
    body,
    comment_id: commentId,
    created_at: new Date(START).toISOString(),
    observation_id: createDomainId("observation", START + 1),
    observation_type: "comment",
    observed_at: new Date(START).toISOString(),
    snapshot_id: snapshotId,
    thread_id: threadId,
    updated_at: new Date(START).toISOString(),
    url: "https://github.com/owner/repo/pull/1#discussion_r1",
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
      eventId: createDomainId("event", START),
      payload: {
        distillation_key: distillationKey,
        job_id: jobId,
        repo_id: REPO_ID,
        thread_id: threadId,
      },
      recordedAt: new Date(START).toISOString(),
      transactionId,
      type: "DistillationJobCreated",
    }),
    createDistillationJobEventRecord({
      eventId: createDomainId("event", START + 1),
      payload: {
        job_id: jobId,
        lease_expires_at: new Date(leaseExpiresAt).toISOString(),
        lease_generation: 1,
        lease_token_hash: hashLeaseToken(LEASE_TOKEN),
      },
      recordedAt: new Date(START + 1_000).toISOString(),
      transactionId,
      type: "DistillationJobLeased",
    }),
  ];
  const store = new CanonicalTransactionStore(root);
  await store.commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath: "events/seed.jsonl",
    })),
    createdAt: new Date(START + 1_000).toISOString(),
    fileWrites: [],
    transactionId,
  });
  const contexts = runtimeContexts(
    options.finalizeTokens ?? ["original-finalize-token"],
    clock,
  );
  const service = submitService(store, contexts, clock, config);
  const extractResponse = await service.submitExtract({
    candidates: [candidate(commentId, options.candidateSeverity)],
    job_id: jobId,
    lease_generation: 1,
    lease_token: LEASE_TOKEN,
    phase: "extract",
    request_schema_version: 1,
    skip_reason: null,
    submission_id: "extract-submission",
    thread_fingerprint: contentFingerprint,
  });
  if (extractResponse.state !== "merge_decision_required") {
    throw new Error("fixture extract unexpectedly skipped");
  }
  return {
    clock,
    commentId,
    config,
    contexts,
    contentFingerprint,
    extract: extractResponse,
    jobId,
    leaseExpiresAt,
    root,
    service,
    snapshotId,
    store,
    threadId,
  };
}

function submitService(
  store: CanonicalTransactionStore,
  contexts: RuntimeFinalizeContextStore,
  clock: Clock,
  config: RepoKnowledgeConfig,
  overrides: Partial<SubmitDistillationContextOptions> = {},
): SubmitDistillationService {
  return new SubmitDistillationService({
    distillationContext: {
      config,
      promptDigest: PROMPT_DIGEST,
      promptVersion: PROMPT_VERSION,
      repositoryContext: REPOSITORY_CONTEXT,
      ...overrides,
    },
    finalizeContexts: contexts,
    now: () => new Date(clock.value),
    repoId: REPO_ID,
    repository: store,
  });
}

function runtimeContexts(
  values: readonly string[],
  clock: Clock,
): RuntimeFinalizeContextStore {
  const tokens = [...values];
  return new RuntimeFinalizeContextStore({
    nextToken: () => {
      const token = tokens.shift();
      if (token === undefined) throw new Error("finalize token exhausted");
      return token;
    },
    now: () => new Date(clock.value),
  });
}

function finalizeRequest(fixture: PreparedFixture): SubmitFinalizeRequest {
  return {
    candidate_set_sha256: fixture.extract.candidate_set_sha256,
    decisions: [different(fixture.extract.candidates[0]!.candidate_id)],
    finalize_token: fixture.extract.finalize_handle.finalize_token,
    job_id: fixture.jobId,
    lease_generation: 1,
    lease_token: LEASE_TOKEN,
    phase: "finalize",
    request_schema_version: 1,
    submission_id: "finalize-submission",
  };
}

function different(candidateId: string) {
  return { candidate_id: candidateId, relation: "different" as const };
}

function candidate(
  commentId: string,
  severity: "must" | "should" = "must",
): DistilledCandidate {
  return {
    category: "architecture",
    confidence: 0.95,
    detail: "Stable ordering prevents a receipt and write from diverging.",
    evidence_comment_ids: [commentId],
    rule: "Commit finalizer artifacts and receipts atomically.",
    scope: ["src/**"],
    severity,
  };
}

function autoActivationConfig(): RepoKnowledgeConfig {
  const base = parseRepoKnowledgeConfig({
    hostAssistedDistillation: {
      allowReviewContentTransmission: true,
      enabled: true,
    },
    trust: {
      autoActivateTrustedHuman: true,
      trustedActorIds: ["actor-alice"],
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

async function ingestEditedSource(
  fixture: PreparedFixture,
  body: string,
): Promise<void> {
  const observedAt = new Date(START + 3_000).toISOString();
  const snapshotId = createDomainId("snapshot", START + 3_000);
  const transactionId = createDomainId("transaction", START + 3_000);
  const normalizedComment = {
    body,
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
    pr_number: 1,
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
    observation_id: createDomainId("observation", START + 3_000),
    observation_type: "thread",
    observed_at: observedAt,
    path: "src/index.ts",
    pr_number: 1,
    repo_id: REPO_ID,
    snapshot_id: snapshotId,
    state_fingerprint: `sha256:${"b".repeat(64)}`,
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
    body,
    comment_id: fixture.commentId,
    created_at: new Date(START).toISOString(),
    observation_id: createDomainId("observation", START + 3_001),
    observation_type: "comment",
    observed_at: observedAt,
    snapshot_id: snapshotId,
    thread_id: fixture.threadId,
    updated_at: observedAt,
    url: "https://github.com/owner/repo/pull/1#discussion_r1",
  });
  await fixture.store.commit({
    appendRecords: [
      canonicalRecord(
        "PullRequestSnapshot",
        snapshot,
        snapshotId,
        transactionId,
      ),
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
    ].map((record) => ({ record, targetPath: "events/edited.jsonl" })),
    createdAt: observedAt,
    fileWrites: [],
    transactionId,
  });
}

async function writeKnowledge(root: string): Promise<void> {
  const path = `knowledge/${KNOWLEDGE_ID}.md`;
  await writeFile(
    join(root, path),
    serializeKnowledgeDocument(
      path,
      {
        activation: { origin: "automatic", pinned: false },
        category: "architecture",
        created_at: new Date(START).toISOString(),
        id: KNOWLEDGE_ID,
        origin: { type: "distilled" },
        related_ids: [],
        repo_id: REPO_ID,
        revision: 1,
        rule: "Commit finalizer artifacts and receipts atomically.",
        schema_version: 1,
        scope: ["src/**"],
        severity: "must",
        status: "active",
        updated_at: new Date(START).toISOString(),
      },
      "Stable ordering prevents a receipt and write from diverging.\n",
    ),
  );
}

async function expectUnfinalized(
  store: CanonicalTransactionStore,
  expectedKnowledge = 0,
): Promise<void> {
  const snapshot = await store.readSnapshot();
  expect(snapshot.domain.distillJobs[0]?.state).toBe("awaiting_finalize");
  expect(snapshot.domain.submissionReceipts).toHaveLength(1);
  expect(snapshot.domain.evidence).toHaveLength(0);
  expect(snapshot.domain.knowledge).toHaveLength(expectedKnowledge);
}

function canonicalRecord<T>(
  recordType: string,
  payload: T,
  recordId: string,
  transactionId: string,
): CanonicalJsonlRecord<T> {
  return {
    payload,
    record_id: recordId,
    record_type: recordType,
    recorded_at: new Date(START).toISOString(),
    schema_version: 1,
    transaction_id: transactionId,
  };
}

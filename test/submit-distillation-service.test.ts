import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CanonicalTransactionStore,
  CommentObservationSchema,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  HostAssistedDistillationService,
  PullRequestSnapshotSchema,
  RuntimeFinalizeContextStore,
  SubmitDistillationService,
  ThreadObservationSchema,
  computeDistillationInputDigest,
  computePromptDigest,
  computeRequestSha256,
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
  type KnowledgeEvidence,
  type RepoKnowledgeConfig,
  type SubmitExtractRequest,
} from "../src/experimental.js";

const REPO_ID = "repo-submit-extract";
const REPOSITORY_NAME = "owner/repo";
const REPOSITORY_CONTEXT = { language: "TypeScript" } as const;
const PROMPT_DIGEST = computePromptDigest("submit extract prompt v1");
const START = Date.parse("2026-08-06T00:00:00.000Z");
const LEASE_TOKEN = "plaintext-lease-token-must-not-persist";
const KNOWLEDGE_ID = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("SubmitDistillationService extract", () => {
  it("commits one canonical receipt and rehydrates every replay with a fresh handle", async () => {
    const fixture = await createFixture();
    const tokens = [
      "plaintext-finalize-token-one",
      "plaintext-finalize-token-two",
      "plaintext-finalize-token-three",
    ];
    const contexts = runtimeContexts(tokens, START + 2_000);
    const submitter = service(fixture.store, contexts, START + 2_000);
    const request = extractRequest(fixture);

    const first = await submitter.submitExtract(request);
    // Runtime matches are regenerated, while receipt candidates remain stable.
    await writeKnowledge(fixture.root);
    const second = await submitter.submitExtract(request);
    const equivalent = await submitter.submitExtract({
      ...request,
      submission_id: "submission-equivalent",
    });

    expect(first).toMatchObject({
      candidates: [
        {
          candidate: { evidence_comment_ids: [fixture.commentId] },
          candidate_id: expect.stringMatching(/^cand_/u),
        },
      ],
      finalize_handle: {
        finalize_token: "plaintext-finalize-token-one",
        lease_generation: 1,
      },
      possible_matches: [
        {
          candidate_id: expect.stringMatching(/^cand_/u),
          possible_matches: [],
        },
      ],
      state: "merge_decision_required",
    });
    expect(second).toMatchObject({
      candidates:
        first.state === "merge_decision_required" ? first.candidates : [],
      finalize_handle: {
        finalize_token: "plaintext-finalize-token-two",
      },
      possible_matches: [
        {
          possible_matches: [
            expect.objectContaining({ knowledge_id: KNOWLEDGE_ID }),
          ],
        },
      ],
    });
    expect(equivalent).toMatchObject({
      candidates:
        first.state === "merge_decision_required" ? first.candidates : [],
      finalize_handle: {
        finalize_token: "plaintext-finalize-token-three",
      },
    });

    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.submissionReceipts).toHaveLength(1);
    expect(snapshot.domain.distillJobs[0]?.state).toBe("awaiting_finalize");
    const receipt = snapshot.domain.submissionReceipts[0]!;
    expect(receipt).toMatchObject({
      job_id: fixture.jobId,
      phase: "extract",
      request_sha256: `sha256:${computeRequestSha256(request)}`,
      stable_response: { state: "merge_decision_required" },
      submission_id: request.submission_id,
    });
    expect(JSON.stringify(receipt)).not.toContain("finalize_token");
    if (
      first.state !== "merge_decision_required" ||
      second.state !== "merge_decision_required"
    ) {
      throw new Error("expected merge responses");
    }
    expect(
      contexts.find(second.finalize_handle.finalize_token)?.request_sha256,
    ).toBe(receipt.request_sha256);

    const canonicalBytes = await Promise.all([
      readFile(join(fixture.root, "events", "distillation.jsonl")),
      readFile(join(fixture.root, "events", "submissions.jsonl")),
      readFile(join(fixture.root, "index.sqlite")),
    ]);
    for (const plaintext of [LEASE_TOKEN, ...tokens]) {
      expect(
        canonicalBytes.some((bytes) => bytes.includes(Buffer.from(plaintext))),
      ).toBe(false);
    }
  });

  it("distinguishes submission reuse, phase reuse, invalid evidence, and expired replay", async () => {
    const fixture = await createFixture();
    const submitter = service(
      fixture.store,
      runtimeContexts(["initial-finalize-token"], START + 2_000),
      START + 2_000,
    );
    const request = extractRequest(fixture);
    await submitter.submitExtract(request);

    await expect(
      submitter.submitExtract({
        ...request,
        candidates: [candidate(fixture.commentId, "Changed rule")],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      submitter.submitExtract({
        ...request,
        candidates: [candidate(fixture.commentId, "Changed rule")],
        submission_id: "different-submission",
      }),
    ).rejects.toMatchObject({ code: "PHASE_ALREADY_COMMITTED" });

    const expiredSubmitter = service(
      fixture.store,
      runtimeContexts(["must-not-be-issued"], START + 120_000),
      START + 120_000,
    );
    await expect(expiredSubmitter.submitExtract(request)).rejects.toMatchObject(
      {
        code: "RESUME_REQUIRED",
      },
    );

    const invalidFixture = await createFixture({ offset: 300_000 });
    const invalidSubmitter = service(
      invalidFixture.store,
      runtimeContexts(["must-not-be-issued"], START + 302_000),
      START + 302_000,
    );
    await expect(
      invalidSubmitter.submitExtract({
        ...extractRequest(invalidFixture),
        candidates: [candidate("comment-outside-current-thread")],
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_COMMENTS_INVALID" });
    await expect(
      invalidSubmitter.submitExtract({
        ...extractRequest(invalidFixture),
        candidates: [
          {
            ...candidate(invalidFixture.commentId),
            code_example: codeExample("comment-outside-current-thread"),
          },
        ],
        submission_id: "code-example-outside-thread",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_COMMENTS_INVALID" });
    await expect(
      invalidSubmitter.submitExtract({
        ...extractRequest(invalidFixture),
        candidates: [
          {
            ...candidate(invalidFixture.commentId),
            code_example: {
              ...codeExample(invalidFixture.commentId),
              content: "superMagicFramework.doEverything();",
            },
          },
        ],
        submission_id: "code-example-ungrounded-content",
      }),
    ).rejects.toMatchObject({
      code: "EVIDENCE_COMMENTS_INVALID",
      message: expect.stringContaining(
        "code_example content references tokens absent from its cited evidence: doEverything, superMagicFramework",
      ),
    });
    await expect(
      invalidSubmitter.submitExtract({
        ...extractRequest(invalidFixture),
        skip_reason: "typo",
      }),
    ).rejects.toMatchObject({ code: "EXTRACT_REQUEST_INVALID" });
    await expect(
      invalidSubmitter.submitExtract({
        ...extractRequest(invalidFixture),
        submission_id: "source-changed-submission",
        thread_fingerprint: `sha256:${"d".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "DISTILLATION_SOURCE_CHANGED" });
    const invalidSnapshot = await invalidFixture.store.readSnapshot();
    expect(invalidSnapshot.domain.submissionReceipts).toHaveLength(0);
    expect(invalidSnapshot.domain.distillJobs[0]?.state).toBe("processing");
  });

  it("commits a candidate whose grounded code example cites current comments", async () => {
    const fixture = await createFixture({ offset: 900_000 });
    const submitter = service(
      fixture.store,
      runtimeContexts(["grounded-example-token"], START + 902_000),
      START + 902_000,
    );

    const response = await submitter.submitExtract({
      ...extractRequest(fixture),
      candidates: [
        {
          ...candidate(fixture.commentId),
          code_example: codeExample(fixture.commentId),
        },
      ],
      submission_id: "submission-grounded-example",
    });

    expect(response).toMatchObject({
      candidates: [
        {
          candidate: {
            code_example: {
              content: "await store.commit(transaction);",
              evidence_comment_ids: [fixture.commentId],
              generated_example: true,
              language: "typescript",
            },
          },
        },
      ],
      state: "merge_decision_required",
    });
    const snapshot = await fixture.store.readSnapshot();
    const receipt = snapshot.domain.submissionReceipts[0]!;
    expect(receipt.stable_response).toMatchObject({
      candidates: [
        {
          candidate: {
            code_example: { generated_example: true },
          },
        },
      ],
      state: "merge_decision_required",
    });
  });

  it("preserves evidence for insufficient_context and emits no finalize token", async () => {
    const fixture = await createFixture({ withEvidence: true });
    const contexts = runtimeContexts(["must-not-be-issued"], START + 2_000);
    const request = skipRequest(fixture, "insufficient_context");
    const response = await service(
      fixture.store,
      contexts,
      START + 2_000,
    ).submitExtract(request);

    expect(response).toEqual({
      skip_reason: "insufficient_context",
      staled_knowledge_ids: [],
      state: "skipped",
      withdrawn_evidence_ids: [],
    });
    expect("finalize_handle" in response).toBe(false);
    expect(contexts.size).toBe(0);
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.distillJobs[0]?.state).toBe("skipped");
    expect(snapshot.domain.evidence).toEqual([
      expect.objectContaining({
        evidence_id: fixture.evidenceId,
        status: "active",
      }),
    ]);
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_ID)
        ?.status,
    ).toBe("active");

    await expect(
      service(
        fixture.store,
        runtimeContexts([], START + 120_000),
        START + 120_000,
      ).submitExtract(request),
    ).resolves.toEqual(response);
  });

  it("atomically withdraws definitive non-knowledge evidence and stales automatic knowledge", async () => {
    const fixture = await createFixture({
      offset: 600_000,
      withEvidence: true,
    });
    const response = await service(
      fixture.store,
      runtimeContexts([], START + 602_000),
      START + 602_000,
    ).submitExtract(skipRequest(fixture, "typo"));

    expect(response).toEqual({
      skip_reason: "typo",
      staled_knowledge_ids: [KNOWLEDGE_ID],
      state: "skipped",
      withdrawn_evidence_ids: [fixture.evidenceId],
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.evidence[0]?.status).toBe("withdrawn");
    expect(
      snapshot.domain.knowledge.find((item) => item.id === KNOWLEDGE_ID)
        ?.status,
    ).toBe("stale");
    const transactionIds = snapshot.records
      .filter((item) =>
        [
          "DistillationJobSkipped",
          "EvidenceWithdrawn",
          "SubmissionReceipt",
        ].includes(item.record.record_type),
      )
      .map((item) => item.record.transaction_id);
    expect(new Set(transactionIds).size).toBe(1);
    const document = snapshot.knowledge.find(
      (item) => item.frontmatter.id === KNOWLEDGE_ID,
    )!;
    expect(document.frontmatter.last_automatic_update).toMatchObject({
      transaction_id: transactionIds[0],
    });
  });

  it("resumes the committed candidate receipt after a process restart without re-extracting", async () => {
    const fixture = await createFixture({ offset: 900_000 });
    const request = extractRequest(fixture);
    await service(
      fixture.store,
      runtimeContexts(["discarded-process-token"], START + 902_000),
      START + 902_000,
    ).submitExtract(request);

    const resumedContexts = runtimeContexts(
      ["finalize-token-after-restart"],
      START + 903_000,
    );
    const restarted = new HostAssistedDistillationService({
      config: fixture.config,
      coordinatorOptions: {
        nextLeaseToken: () => "lease-token-after-restart",
        now: () => new Date(START + 903_000),
      },
      finalizeContexts: resumedContexts,
      promptDigest: PROMPT_DIGEST,
      repository: {
        absolutePath: fixture.root,
        aliases: [],
        currentName: REPOSITORY_NAME,
        path: "repo-submit-extract",
        repoId: REPO_ID,
        source: "tool-repo",
      },
      repositoryContext: REPOSITORY_CONTEXT,
    });

    const result = await restarted.prepare();

    expect(result).toMatchObject({
      blocked_jobs: [],
      jobs: [
        {
          candidates: [{ candidate: { rule: request.candidates[0]!.rule } }],
          finalize_handle: {
            finalize_token: "finalize-token-after-restart",
            lease_generation: 2,
          },
          lease_token: "lease-token-after-restart",
          phase: "finalize",
        },
      ],
      state: "prepared",
    });
    const snapshot = await fixture.store.readSnapshot();
    expect(snapshot.domain.submissionReceipts).toHaveLength(1);
    expect(snapshot.domain.distillJobs[0]).toMatchObject({
      lease_generation: 2,
      state: "awaiting_finalize",
    });
  });
});

interface FixtureOptions {
  readonly offset?: number;
  readonly withEvidence?: boolean;
}

interface Fixture {
  readonly commentId: string;
  readonly config: RepoKnowledgeConfig;
  readonly contentFingerprint: string;
  readonly evidenceId: string;
  readonly jobId: string;
  readonly root: string;
  readonly store: CanonicalTransactionStore;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const offset = options.offset ?? 0;
  const timestamp = START + offset;
  const observedAt = new Date(timestamp).toISOString();
  const root = await mkdtemp(join(tmpdir(), "rkm-submit-extract-"));
  temporaryRepositories.push(root);
  await mkdir(join(root, "knowledge"), { recursive: true });
  const config = parseRepoKnowledgeConfig({
    hostAssistedDistillation: {
      allowReviewContentTransmission: true,
      enabled: true,
    },
  });
  const snapshotId = createDomainId("snapshot", timestamp);
  const transactionId = createDomainId("transaction", timestamp);
  const jobId = createDomainId("job", timestamp);
  const threadId = `thread-submit-${String(offset)}`;
  const commentId = `comment-submit-${String(offset)}`;
  const body =
    "Route every write through store.commit(transaction) so canonical writes stay deterministic.";
  const normalizedComment = {
    body,
    createdAt: observedAt,
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
    observed_at: observedAt,
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
    observation_id: createDomainId("observation", timestamp),
    observation_type: "thread",
    observed_at: observedAt,
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
    created_at: observedAt,
    observation_id: createDomainId("observation", timestamp + 1),
    observation_type: "comment",
    observed_at: observedAt,
    snapshot_id: snapshotId,
    thread_id: threadId,
    updated_at: observedAt,
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
    createDistillationJobEventRecord({
      eventId: createDomainId("event", timestamp + 1),
      payload: {
        job_id: jobId,
        lease_expires_at: new Date(timestamp + 60_000).toISOString(),
        lease_generation: 1,
        lease_token_hash: hashLeaseToken(LEASE_TOKEN),
      },
      recordedAt: new Date(timestamp + 1_000).toISOString(),
      transactionId,
      type: "DistillationJobLeased",
    }),
  ];
  let evidenceId = "";
  if (options.withEvidence === true) {
    await writeKnowledge(root);
    evidenceId = createDomainId("evidence", timestamp);
    records.push(
      canonicalRecord(
        "EvidenceCreated",
        evidenceRecord(
          evidenceId,
          commentId,
          contentFingerprint,
          threadId,
          new Date(timestamp - 1).toISOString(),
        ),
        createDomainId("event", timestamp + 2),
        transactionId,
      ),
    );
  }
  const store = new CanonicalTransactionStore(root);
  await store.commit({
    appendRecords: records.map((record) => ({
      record,
      targetPath: "events/seed.jsonl",
    })),
    createdAt: new Date(timestamp + 1_000).toISOString(),
    fileWrites: [],
    transactionId,
  });
  return {
    commentId,
    config,
    contentFingerprint,
    evidenceId,
    jobId,
    root,
    store,
  };
}

function extractRequest(fixture: Fixture): SubmitExtractRequest {
  return {
    candidates: [candidate(fixture.commentId)],
    job_id: fixture.jobId,
    lease_generation: 1,
    lease_token: LEASE_TOKEN,
    phase: "extract",
    request_schema_version: 1,
    skip_reason: null,
    submission_id: "submission-extract-1",
    thread_fingerprint: fixture.contentFingerprint,
  };
}

function skipRequest(
  fixture: Fixture,
  skipReason: SubmitExtractRequest["skip_reason"],
): SubmitExtractRequest {
  return {
    ...extractRequest(fixture),
    candidates: [],
    skip_reason: skipReason,
  };
}

function candidate(
  commentId: string,
  rule = "Use deterministic canonical writes.",
): DistilledCandidate {
  return {
    category: "architecture",
    confidence: 0.95,
    detail: "Stable ordering and atomic receipts prevent duplicate writes.",
    evidence_comment_ids: [commentId],
    rule,
    scope: ["src/**"],
    severity: "must",
  };
}

function codeExample(
  commentId: string,
): NonNullable<DistilledCandidate["code_example"]> {
  return {
    content: "await store.commit(transaction);",
    evidence_comment_ids: [commentId],
    generated_example: true,
    language: "typescript",
  };
}

function service(
  store: CanonicalTransactionStore,
  contexts: RuntimeFinalizeContextStore,
  now: number,
): SubmitDistillationService {
  return new SubmitDistillationService({
    finalizeContexts: contexts,
    now: () => new Date(now),
    repoId: REPO_ID,
    repository: store,
  });
}

function runtimeContexts(
  values: readonly string[],
  now: number,
): RuntimeFinalizeContextStore {
  const tokens = [...values];
  return new RuntimeFinalizeContextStore({
    nextToken: () => {
      const token = tokens.shift();
      if (token === undefined) throw new Error("finalize token exhausted");
      return token;
    },
    now: () => new Date(now),
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
        rule: "Use deterministic canonical writes.",
        schema_version: 1,
        scope: ["src/**"],
        severity: "must",
        status: "active",
        updated_at: new Date(START).toISOString(),
      },
      "Stable ordering and atomic receipts prevent duplicate writes.\n",
    ),
  );
}

function evidenceRecord(
  evidenceId: string,
  commentId: string,
  contentFingerprint: string,
  threadId: string,
  observedAt: string,
): KnowledgeEvidence {
  const actor = {
    actor_id: "actor-alice",
    actor_kind: "user" as const,
    comment_id: commentId,
    login: "alice",
    provider: "human" as const,
    trust: "trusted" as const,
  };
  return {
    actors: [actor],
    author_association: "MEMBER",
    comment_ids: [commentId],
    content_fingerprint: contentFingerprint,
    eligible_for_count: true,
    evidence_id: evidenceId,
    knowledge_id: KNOWLEDGE_ID,
    observed_at: observedAt,
    occurrence_key: `${KNOWLEDGE_ID}:${threadId}`,
    originator: actor,
    path: "src/index.ts",
    pr_number: 1,
    repo_id: REPO_ID,
    sources: ["human"],
    state_fingerprint: `sha256:${"a".repeat(64)}`,
    status: "active",
    thread_id: threadId,
    url: "https://github.com/owner/repo/pull/1#discussion_r1",
  };
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

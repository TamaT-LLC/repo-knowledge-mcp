import { describe, expect, it, vi } from "vitest";

import {
  computeMatchSetDigest,
  computeRequestSha256,
  verifyRequestBoundToken,
  type ExtractRequest,
  type FinalizeRequest,
  type PossibleKnowledgeMatch,
  type PossibleMatchSet,
} from "../src/experimental.js";
import {
  InMemoryReceiptStore,
  ReceiptReplayEngine,
  type ExtractReceipt,
  type FinalizeReceipt,
  type ReplayJob,
} from "../src/receipt-replay.js";

const CANDIDATE_ID = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_LATEST = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_NEWER = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
type RuntimeMatchSet = PossibleMatchSet<PossibleKnowledgeMatch>;

const NOW = new Date("2026-08-06T09:00:00.000Z");
const TOKEN_SECRET = Buffer.from(
  "receipt-replay-test-secret-with-at-least-32-bytes",
  "utf8",
);

describe("acceptance test 55", () => {
  it("rehydrates extract replay with current matches and a fresh finalize token", async () => {
    const request = extractRequest();
    const receiptStore = new InMemoryReceiptStore();
    const candidates = [extractCandidate()];
    const receipt = extractReceipt(request, {
      candidates,
      state: "merge_decision_required",
    });
    receiptStore.add(receipt);
    let currentMatches: RuntimeMatchSet[] = possibleMatches(KNOWLEDGE_LATEST);
    let tokenSequence = 0;
    const engine = new ReceiptReplayEngine({
      loadJob: () => activeJob(),
      nextTokenId: () => {
        tokenSequence += 1;
        return `replay-token-${tokenSequence}`;
      },
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: () => currentMatches,
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    const first = await engine.replay(request);
    expect(first.kind).toBe("extract_replay");
    if (first.kind !== "extract_replay") {
      throw new Error("Expected extract replay");
    }
    expect(first.response).toMatchObject({
      candidates,
      match_set_digest: computeMatchSetDigest(currentMatches),
      possible_matches: currentMatches,
      state: "merge_decision_required",
    });
    expect("finalize_token" in first.response).toBe(true);
    if (!("finalize_token" in first.response)) {
      throw new Error("Expected finalize token");
    }
    const firstToken = first.response.finalize_token;
    expect(
      verifyRequestBoundToken(
        firstToken,
        { kind: "finalize", requestSha256: receipt.requestSha256 },
        TOKEN_SECRET,
      ).token_id,
    ).toBe("replay-token-1");

    currentMatches = possibleMatches(KNOWLEDGE_NEWER);
    const second = await engine.replay(request);
    expect(second.kind).toBe("extract_replay");
    if (second.kind !== "extract_replay") {
      throw new Error("Expected extract replay");
    }
    expect(second.response).toMatchObject({
      match_set_digest: computeMatchSetDigest(currentMatches),
      possible_matches: currentMatches,
    });
    expect("finalize_token" in second.response).toBe(true);
    if (!("finalize_token" in second.response)) {
      throw new Error("Expected finalize token");
    }
    expect(second.response.finalize_token).not.toBe(firstToken);
  });
});

describe("acceptance test 56", () => {
  it("replays a zero-candidate extract as skipped without a finalize token", async () => {
    const request = extractRequest({ candidates: [] });
    const receiptStore = new InMemoryReceiptStore();
    receiptStore.add(
      extractReceipt(request, {
        skip_reason: "insufficient_context",
        staled_knowledge_ids: [],
        state: "skipped",
        withdrawn_evidence_ids: [],
      }),
    );
    const loadJob = vi.fn<() => ReplayJob>();
    const searchPossibleMatches = vi.fn<() => RuntimeMatchSet[]>();
    const nextTokenId = vi.fn<() => string>();
    const engine = new ReceiptReplayEngine({
      loadJob,
      nextTokenId,
      now: () => NOW,
      receiptStore,
      searchPossibleMatches,
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    const result = await engine.replay(request);

    expect(result).toEqual({
      kind: "extract_replay",
      response: {
        skip_reason: "insufficient_context",
        staled_knowledge_ids: [],
        state: "skipped",
        withdrawn_evidence_ids: [],
      },
    });
    if (result.kind !== "extract_replay") {
      throw new Error("Expected extract replay");
    }
    expect("finalize_token" in result.response).toBe(false);
    expect(loadJob).not.toHaveBeenCalled();
    expect(searchPossibleMatches).not.toHaveBeenCalled();
    expect(nextTokenId).not.toHaveBeenCalled();
  });

  it("rejects an empty merge-decision receipt instead of issuing a token", () => {
    const request = extractRequest({ candidates: [] });
    const receiptStore = new InMemoryReceiptStore();

    expect(() =>
      receiptStore.add(
        extractReceipt(request, {
          candidates: [],
          state: "merge_decision_required",
        }),
      ),
    ).toThrow("merge_decision_required receipts must contain a candidate");
  });
});

describe("phase-specific replay", () => {
  it("returns a finalize stable response before authorization checks", async () => {
    const request = finalizeRequest();
    const receiptStore = new InMemoryReceiptStore();
    receiptStore.add(
      finalizeReceipt(request, {
        knowledge_ids: ["knowledge-1"],
        state: "finalized",
      }),
    );
    const validateAuthorization = vi.fn(() => {
      throw new Error("authorization must not run for a receipt replay");
    });
    const loadJob = vi.fn<() => ReplayJob>();
    const engine = new ReceiptReplayEngine({
      loadJob,
      nextTokenId: vi.fn<() => string>(),
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: vi.fn<() => RuntimeMatchSet[]>(),
      tokenSecret: TOKEN_SECRET,
      validateAuthorization,
    });

    await expect(engine.replay(request)).resolves.toEqual({
      kind: "finalize_replay",
      response: {
        knowledge_ids: ["knowledge-1"],
        state: "finalized",
      },
    });
    expect(validateAuthorization).not.toHaveBeenCalled();
    expect(loadJob).not.toHaveBeenCalled();
  });

  it("validates authorization only after confirming there is no receipt", async () => {
    const receiptStore = new InMemoryReceiptStore();
    const validateAuthorization = vi.fn();
    const engine = new ReceiptReplayEngine({
      loadJob: vi.fn<() => ReplayJob>(),
      nextTokenId: vi.fn<() => string>(),
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: vi.fn<() => RuntimeMatchSet[]>(),
      tokenSecret: TOKEN_SECRET,
      validateAuthorization,
    });
    const request = extractRequest();

    await expect(engine.replay(request)).resolves.toEqual({
      kind: "receipt_miss",
      requestSha256: computeRequestSha256(request),
    });
    expect(validateAuthorization).toHaveBeenCalledOnce();
    expect(validateAuthorization).toHaveBeenCalledWith(request);
  });
});

describe("extract job and lease branches", () => {
  it("returns the matching finalize receipt when the job is finalized", async () => {
    const extract = extractRequest();
    const finalize = finalizeRequest({ submission_id: "finalize-submission" });
    const receiptStore = new InMemoryReceiptStore();
    receiptStore.add(
      extractReceipt(extract, {
        candidates: [extractCandidate()],
        state: "merge_decision_required",
      }),
    );
    receiptStore.add(
      finalizeReceipt(finalize, {
        knowledge_ids: ["knowledge-final"],
        state: "finalized",
      }),
    );
    const engine = new ReceiptReplayEngine({
      loadJob: () => activeJob({ status: "finalized" }),
      nextTokenId: vi.fn<() => string>(),
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: vi.fn<() => RuntimeMatchSet[]>(),
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    await expect(engine.replay(extract)).resolves.toEqual({
      kind: "finalize_replay",
      response: {
        knowledge_ids: ["knowledge-final"],
        state: "finalized",
      },
    });
  });

  it("returns JOB_ALREADY_FINALIZED when no finalize receipt is available", async () => {
    const request = extractRequest();
    const receiptStore = storeWithMergeReceipt(request);
    const engine = new ReceiptReplayEngine({
      loadJob: () => activeJob({ status: "finalized" }),
      nextTokenId: vi.fn<() => string>(),
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: vi.fn<() => RuntimeMatchSet[]>(),
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    await expect(engine.replay(request)).rejects.toMatchObject({
      code: "JOB_ALREADY_FINALIZED",
    });
  });

  it("returns RESUME_REQUIRED without searching when the lease is expired", async () => {
    const request = extractRequest();
    const receiptStore = storeWithMergeReceipt(request);
    const searchPossibleMatches = vi.fn<() => RuntimeMatchSet[]>();
    const nextTokenId = vi.fn<() => string>();
    const engine = new ReceiptReplayEngine({
      loadJob: () => activeJob({ leaseExpiresAt: "2026-08-06T08:59:59.999Z" }),
      nextTokenId,
      now: () => NOW,
      receiptStore,
      searchPossibleMatches,
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    await expect(engine.replay(request)).rejects.toMatchObject({
      code: "RESUME_REQUIRED",
    });
    expect(searchPossibleMatches).not.toHaveBeenCalled();
    expect(nextTokenId).not.toHaveBeenCalled();
  });
});

describe("receipt request hash", () => {
  it("rejects the same submission_id with a different request hash before lease checks", async () => {
    const original = extractRequest();
    const receiptStore = storeWithMergeReceipt(original);
    const loadJob = vi.fn<() => ReplayJob>();
    const engine = new ReceiptReplayEngine({
      loadJob,
      nextTokenId: vi.fn<() => string>(),
      now: () => NOW,
      receiptStore,
      searchPossibleMatches: vi.fn<() => RuntimeMatchSet[]>(),
      tokenSecret: TOKEN_SECRET,
      validateAuthorization: vi.fn(),
    });

    await expect(
      engine.replay(
        extractRequest({ thread_fingerprint: "changed-fingerprint" }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(loadJob).not.toHaveBeenCalled();
  });
});

function storeWithMergeReceipt(request: ExtractRequest): InMemoryReceiptStore {
  const receiptStore = new InMemoryReceiptStore();
  receiptStore.add(
    extractReceipt(request, {
      candidates: [extractCandidate()],
      state: "merge_decision_required",
    }),
  );
  return receiptStore;
}

function extractReceipt(
  request: ExtractRequest,
  stableResponse: ExtractReceipt["stableResponse"],
): ExtractReceipt {
  return {
    jobId: request.job_id,
    phase: "extract",
    requestSha256: computeRequestSha256(request),
    stableResponse,
    submissionId: request.submission_id,
  };
}

function finalizeReceipt(
  request: FinalizeRequest,
  stableResponse: unknown,
): FinalizeReceipt {
  return {
    jobId: request.job_id,
    phase: "finalize",
    requestSha256: computeRequestSha256(request),
    stableResponse,
    submissionId: request.submission_id,
  };
}

function activeJob(overrides: Partial<ReplayJob> = {}): ReplayJob {
  return {
    id: "job-1",
    leaseExpiresAt: "2026-08-06T09:05:00.000Z",
    leaseGeneration: 7,
    status: "awaiting_finalize",
    ...overrides,
  };
}

function extractRequest(
  overrides: Partial<ExtractRequest> = {},
): ExtractRequest {
  return {
    candidates: [{ candidate_ids: [CANDIDATE_ID] }],
    job_id: "job-1",
    lease_generation: 7,
    lease_token: "lease-token",
    phase: "extract",
    request_schema_version: 1,
    skip_reason: null,
    submission_id: "extract-submission",
    thread_fingerprint: "thread-fingerprint",
    ...overrides,
  };
}

function finalizeRequest(
  overrides: Partial<FinalizeRequest> = {},
): FinalizeRequest {
  return {
    candidate_set_sha256: "candidate-set-sha256",
    decisions: [{ candidate_id: CANDIDATE_ID, decision: "merge" }],
    finalize_token: "finalize-token",
    job_id: "job-1",
    lease_generation: 7,
    lease_token: "lease-token",
    phase: "finalize",
    request_schema_version: 1,
    submission_id: "finalize-submission",
    ...overrides,
  };
}

function possibleMatches(knowledgeId: string): RuntimeMatchSet[] {
  return [
    {
      candidate_id: CANDIDATE_ID,
      possible_matches: [
        {
          category: "other",
          detail: "Prefer current facts.",
          etag: "a".repeat(64),
          knowledge_id: knowledgeId,
          revision: 1,
          rule: "Prefer facts",
          scope: [],
          severity: "should",
          status: "active",
        },
      ],
    },
  ];
}

function extractCandidate() {
  return {
    candidate: {
      category: "other" as const,
      confidence: 0.8,
      detail: "Prefer facts that are current.",
      evidence_comment_ids: ["comment-1"],
      rule: "Prefer facts",
      scope: [],
      severity: "should" as const,
    },
    candidate_id: CANDIDATE_ID,
  };
}

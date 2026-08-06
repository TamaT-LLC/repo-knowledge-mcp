import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SubmissionIdempotencyStore,
  buildRequestHashPayload,
  computeRequestSha256,
  issueRequestBoundToken,
  verifyRequestBoundToken,
  type ExtractRequest,
  type FinalizeRequest,
} from "../src/request-integrity.js";

const TOKEN_SECRET = Buffer.from(
  "request-integrity-test-secret-with-at-least-32-bytes",
  "utf8",
);

describe("acceptance test 57", () => {
  it("keeps request_sha256 stable when only submission_id changes", () => {
    const first = extractRequest({ submission_id: "submission-1" });
    const second = extractRequest({ submission_id: "submission-2" });

    expect(computeRequestSha256(first)).toBe(computeRequestSha256(second));

    const store = new SubmissionIdempotencyStore();
    expect(store.register(first).state).toBe("accepted");
    expect(store.register(second)).toMatchObject({
      originalSubmissionId: "submission-1",
      state: "replay",
    });
  });
});

describe("acceptance test 58", () => {
  it("rejects changed decisions under the same submission_id", () => {
    const store = new SubmissionIdempotencyStore();
    store.register(finalizeRequest());

    expectIntegrityCode(
      () =>
        store.register(
          finalizeRequest({
            decisions: [
              {
                candidate_id: "candidate-1",
                decision: "create",
                evidence_comment_ids: ["comment-1"],
              },
            ],
          }),
        ),
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});

describe("request_sha256 input", () => {
  it("includes every extract field except submission_id and the plaintext token", () => {
    const request = extractRequest();

    expect(buildRequestHashPayload(request)).toEqual({
      candidates: request.candidates,
      job_id: request.job_id,
      lease_generation: request.lease_generation,
      lease_token_hash: sha256(request.lease_token),
      phase: "extract",
      request_schema_version: 1,
      thread_fingerprint: request.thread_fingerprint,
    });
  });

  it("includes every finalize field except submission_id and the plaintext token", () => {
    const request = finalizeRequest();

    expect(buildRequestHashPayload(request)).toEqual({
      candidate_set_sha256: request.candidate_set_sha256,
      decisions: request.decisions,
      finalize_token_hash: sha256(request.finalize_token),
      job_id: request.job_id,
      lease_generation: request.lease_generation,
      lease_token_hash: sha256(request.lease_token),
      phase: "finalize",
      request_schema_version: 1,
    });
  });

  it("changes when any defined hashed field changes", () => {
    const base = finalizeRequest();
    const baseHash = computeRequestSha256(base);
    const variants: FinalizeRequest[] = [
      finalizeRequest({ job_id: "job-2" }),
      finalizeRequest({ lease_generation: 8 }),
      finalizeRequest({ candidate_set_sha256: "different-candidate-set" }),
      finalizeRequest({
        decisions: [{ candidate_id: "candidate-1", decision: "create" }],
      }),
      finalizeRequest({ finalize_token: "different-plaintext-token" }),
      finalizeRequest({ lease_token: "different-plaintext-lease-token" }),
      { ...base, request_schema_version: 2 as 1 },
    ];

    for (const variant of variants) {
      expect(computeRequestSha256(variant)).not.toBe(baseHash);
    }
    expect(computeRequestSha256(extractRequest())).not.toBe(baseHash);
  });

  it("sorts and deduplicates declared set arrays before hashing", () => {
    const first = extractRequest({
      candidates: [
        {
          candidate_ids: ["candidate-z", "candidate-a", "candidate-z"],
          evidence_comment_ids: ["comment-z", "comment-a", "comment-z"],
          scope: ["repository", "global", "repository"],
          sources: ["review", "issue", "review"],
        },
      ],
    });
    const second = extractRequest({
      candidates: [
        {
          candidate_ids: ["candidate-a", "candidate-z"],
          evidence_comment_ids: ["comment-a", "comment-z"],
          scope: ["global", "repository"],
          sources: ["issue", "review"],
        },
      ],
    });

    expect(computeRequestSha256(first)).toBe(computeRequestSha256(second));
  });
});

describe("request-bound token", () => {
  it("authenticates token claims and their request_sha256 binding", () => {
    const requestSha256 = computeRequestSha256(extractRequest());
    const token = issueRequestBoundToken(
      {
        kind: "finalize",
        requestSha256,
        tokenId: "token-1",
      },
      TOKEN_SECRET,
    );

    expect(
      verifyRequestBoundToken(
        token,
        { kind: "finalize", requestSha256 },
        TOKEN_SECRET,
      ),
    ).toEqual({
      kind: "finalize",
      request_sha256: requestSha256,
      token_id: "token-1",
      token_schema_version: 1,
    });

    expectIntegrityCode(
      () =>
        verifyRequestBoundToken(
          token,
          { kind: "finalize", requestSha256: "0".repeat(64) },
          TOKEN_SECRET,
        ),
      "TOKEN_REQUEST_MISMATCH",
    );
    expectIntegrityCode(
      () =>
        verifyRequestBoundToken(
          token,
          { kind: "lease", requestSha256 },
          TOKEN_SECRET,
        ),
      "TOKEN_KIND_MISMATCH",
    );
  });

  it("rejects a token whose signed bytes were changed", () => {
    const requestSha256 = computeRequestSha256(extractRequest());
    const token = issueRequestBoundToken(
      { kind: "lease", requestSha256, tokenId: "token-1" },
      TOKEN_SECRET,
    );
    const replacement = token.endsWith("A") ? "B" : "A";
    const tampered = `${token.slice(0, -1)}${replacement}`;

    expectIntegrityCode(
      () =>
        verifyRequestBoundToken(
          tampered,
          { kind: "lease", requestSha256 },
          TOKEN_SECRET,
        ),
      "INVALID_TOKEN",
    );
  });
});

describe("RESUME finalize submission", () => {
  it("requires a new submission_id after a new token changes request_sha256", () => {
    const oldToken = issueRequestBoundToken(
      {
        kind: "finalize",
        requestSha256: "a".repeat(64),
        tokenId: "before-resume",
      },
      TOKEN_SECRET,
    );
    const newToken = issueRequestBoundToken(
      {
        kind: "finalize",
        requestSha256: "b".repeat(64),
        tokenId: "after-resume",
      },
      TOKEN_SECRET,
    );
    const beforeResume = finalizeRequest({ finalize_token: oldToken });
    const afterResume = finalizeRequest({ finalize_token: newToken });
    const store = new SubmissionIdempotencyStore();
    store.register(beforeResume);

    expect(computeRequestSha256(afterResume)).not.toBe(
      computeRequestSha256(beforeResume),
    );
    expectIntegrityCode(
      () => store.register(afterResume),
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(
      store.register({
        ...afterResume,
        submission_id: "submission-after-resume",
      }).state,
    ).toBe("accepted");
  });
});

function extractRequest(
  overrides: Partial<ExtractRequest> = {},
): ExtractRequest {
  return {
    candidates: [
      {
        candidate_ids: ["candidate-1"],
        evidence_comment_ids: ["comment-1"],
        sources: ["review"],
      },
    ],
    job_id: "job-1",
    lease_generation: 7,
    lease_token: "plaintext-lease-token",
    phase: "extract",
    request_schema_version: 1,
    submission_id: "submission-1",
    thread_fingerprint: "thread-fingerprint-1",
    ...overrides,
  };
}

function finalizeRequest(
  overrides: Partial<FinalizeRequest> = {},
): FinalizeRequest {
  return {
    candidate_set_sha256: "candidate-set-sha256",
    decisions: [
      {
        candidate_id: "candidate-1",
        decision: "merge",
        evidence_comment_ids: ["comment-1"],
      },
    ],
    finalize_token: "plaintext-finalize-token",
    job_id: "job-1",
    lease_generation: 7,
    lease_token: "plaintext-lease-token",
    phase: "finalize",
    request_schema_version: 1,
    submission_id: "submission-1",
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectIntegrityCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected request integrity error: ${code}`);
}

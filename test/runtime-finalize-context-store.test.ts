import { describe, expect, it } from "vitest";

import {
  RuntimeFinalizeContextStore,
  computeMatchSetDigest,
  hashFinalizeToken,
  type PossibleMatchBinding,
} from "../src/index.js";

const NOW = Date.parse("2026-08-06T00:00:00.000Z");
const EXPIRES_AT = "2026-08-06T00:05:00.000Z";
const CANDIDATE_ID = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const POSSIBLE_MATCHES: readonly PossibleMatchBinding[] = [
  { candidate_id: CANDIDATE_ID, possible_matches: [] },
];

describe("RuntimeFinalizeContextStore", () => {
  it("retains only a token hash and returns an immutable bound context", () => {
    const plaintext = "plaintext-finalize-token";
    const store = new RuntimeFinalizeContextStore({
      nextToken: () => plaintext,
      now: () => new Date(NOW),
    });

    const issued = store.issue(contextInput());

    expect(issued.handle).toEqual({
      expires_at: EXPIRES_AT,
      finalize_token: plaintext,
      lease_generation: 2,
    });
    expect(issued.context.token_hash).toBe(hashFinalizeToken(plaintext));
    expect(store.find(plaintext)).toBe(issued.context);
    expect(JSON.stringify(issued.context)).not.toContain(plaintext);
    expect(Object.isFrozen(issued.context)).toBe(true);
    expect(Object.isFrozen(issued.context.possible_matches)).toBe(true);
  });

  it("evicts expired handles and never returns an expired context", () => {
    let now = NOW;
    const store = new RuntimeFinalizeContextStore({
      nextToken: () => "short-lived-token",
      now: () => new Date(now),
    });
    store.issue(contextInput());

    now = Date.parse(EXPIRES_AT);

    expect(store.find("short-lived-token")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(() =>
      store.issue({
        ...contextInput(),
        expires_at: "2026-08-06T00:10:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code: "FINALIZE_TOKEN_COLLISION" }));
  });

  it("rejects a mismatched match-set digest and active token collisions", () => {
    const store = new RuntimeFinalizeContextStore({
      nextToken: () => "repeated-token",
      now: () => new Date(NOW),
    });

    expect(() =>
      store.issue({ ...contextInput(), match_set_digest: "0".repeat(64) }),
    ).toThrow(expect.objectContaining({ code: "FINALIZE_CONTEXT_INVALID" }));

    store.issue(contextInput());
    expect(() => store.issue(contextInput())).toThrow(
      expect.objectContaining({ code: "FINALIZE_TOKEN_COLLISION" }),
    );
  });
});

function contextInput() {
  return {
    candidate_set_sha256: "1".repeat(64),
    content_fingerprint: `sha256:${"2".repeat(64)}`,
    distillation_key: `sha256:${"3".repeat(64)}`,
    expires_at: EXPIRES_AT,
    job_id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    lease_generation: 2,
    match_set_digest: computeMatchSetDigest(POSSIBLE_MATCHES),
    possible_matches: POSSIBLE_MATCHES,
    source_snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  } as const;
}

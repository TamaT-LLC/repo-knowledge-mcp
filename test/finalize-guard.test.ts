import { describe, expect, it, vi } from "vitest";

import {
  FinalizeGuard,
  computeContentFingerprint,
  computeDistillationKey,
  computeMatchSetDigest,
  type DistillationKeyInput,
  type FinalizeContext,
  type FinalizeGuardDependencies,
  type FinalizeJob,
  type FingerprintComment,
} from "../src/finalize-guard.js";
import type { PossibleMatchBinding } from "../src/experimental.js";

const CANDIDATE_ID = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_1 = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_2 = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const KNOWLEDGE_NEW = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ETAG_A = "a".repeat(64);
const ETAG_B = "b".repeat(64);

const BASE_COMMENTS: readonly FingerprintComment[] = [
  {
    body: "Use deterministic ordering.",
    createdAt: "2026-08-06T00:00:00.000Z",
    id: "comment-1",
    resolved: false,
  },
];
const BASE_DISTILLATION_INPUT: DistillationKeyInput = {
  prompt: "Distill durable repository rules.",
  schema: { candidateVersion: 1 },
  trustPolicy: {
    trustedActorIds: ["actor-2", "actor-1"],
    trustedLogins: ["zoe", "alice"],
  },
};
const BASE_MATCHES: readonly PossibleMatchBinding[] = [
  {
    candidate_id: CANDIDATE_ID,
    possible_matches: [
      {
        etag: ETAG_B,
        knowledge_id: KNOWLEDGE_2,
        revision: 2,
        status: "proposed",
      },
      {
        etag: ETAG_A,
        knowledge_id: KNOWLEDGE_1,
        revision: 1,
        status: "active",
      },
    ],
  },
];

describe("acceptance test 59", () => {
  it("rejects an old finalize after comment body edit and re-ingest", async () => {
    const context = finalizeContext();
    const harness = createHarness({
      comments: [
        {
          ...BASE_COMMENTS[0]!,
          body: "Use locale-independent deterministic ordering.",
        },
      ],
      sourceSnapshotId: "snapshot-after-edit",
    });

    await expect(harness.guard.finalize(context)).rejects.toMatchObject({
      code: "DISTILLATION_SOURCE_CHANGED",
    });
    expect(harness.canonicalWrite).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "lock:start",
      "ensureRecovered",
      "ensureProjectionCurrent",
      "jobState",
      "source",
      "lock:end",
    ]);
  });
});

describe("acceptance test 60", () => {
  it.each([
    [
      "prompt",
      {
        ...BASE_DISTILLATION_INPUT,
        prompt: "A changed prompt.",
      },
    ],
    [
      "schema",
      {
        ...BASE_DISTILLATION_INPUT,
        schema: { candidateVersion: 2 },
      },
    ],
    [
      "trust policy",
      {
        ...BASE_DISTILLATION_INPUT,
        trustPolicy: {
          trustedActorIds: ["actor-3"],
          trustedLogins: ["mallory"],
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, DistillationKeyInput]>)(
    "rejects an old finalize after %s changes",
    async (_label, distillationInput) => {
      const harness = createHarness({ distillationInput });

      await expect(
        harness.guard.finalize(finalizeContext()),
      ).rejects.toMatchObject({
        code: "DISTILLATION_CONTEXT_CHANGED",
      });
      expect(harness.canonicalWrite).not.toHaveBeenCalled();
      expect(harness.events).toEqual([
        "lock:start",
        "ensureRecovered",
        "ensureProjectionCurrent",
        "jobState",
        "source",
        "context",
        "lock:end",
      ]);
    },
  );
});

describe("match-set binding", () => {
  it("rejects changed possible matches before canonical write", async () => {
    const harness = createHarness({
      matches: [
        {
          candidate_id: CANDIDATE_ID,
          possible_matches: [
            {
              etag: ETAG_A,
              knowledge_id: KNOWLEDGE_NEW,
              revision: 1,
              status: "active",
            },
          ],
        },
      ],
    });

    await expect(
      harness.guard.finalize(finalizeContext()),
    ).rejects.toMatchObject({
      code: "MERGE_CANDIDATES_CHANGED",
    });
    expect(harness.canonicalWrite).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "lock:start",
      "ensureRecovered",
      "ensureProjectionCurrent",
      "jobState",
      "source",
      "context",
      "matchSet",
      "lock:end",
    ]);
  });
});

describe("job-state binding", () => {
  it("stops before source validation and write when the job is not awaiting finalize", async () => {
    const harness = createHarness({
      job: finalizeJob({ status: "finalized" }),
    });

    await expect(
      harness.guard.finalize(finalizeContext()),
    ).rejects.toMatchObject({
      code: "FINALIZE_JOB_INVALID",
    });
    expect(harness.canonicalWrite).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "lock:start",
      "ensureRecovered",
      "ensureProjectionCurrent",
      "jobState",
      "lock:end",
    ]);
  });
});

describe("source snapshot provenance", () => {
  it("allows a resolved-only snapshot change when content and context still match", async () => {
    const context = finalizeContext({ source_snapshot_id: "snapshot-before" });
    const harness = createHarness({
      comments: [{ ...BASE_COMMENTS[0]!, resolved: true }],
      sourceSnapshotId: "snapshot-after-resolved-change",
    });

    await expect(harness.guard.finalize(context)).resolves.toEqual({
      commitId: "commit-1",
    });
    expect(harness.canonicalWrite).toHaveBeenCalledWith(context, [
      {
        candidate_id: CANDIDATE_ID,
        possible_matches: [
          {
            etag: ETAG_A,
            knowledge_id: KNOWLEDGE_1,
            revision: 1,
            status: "active",
          },
          {
            etag: ETAG_B,
            knowledge_id: KNOWLEDGE_2,
            revision: 2,
            status: "proposed",
          },
        ],
      },
    ]);
    expect(harness.events).toEqual([
      "lock:start",
      "ensureRecovered",
      "ensureProjectionCurrent",
      "jobState",
      "source",
      "context",
      "matchSet",
      "canonicalWrite",
      "lock:end",
    ]);
  });
});

interface HarnessOptions {
  readonly comments?: readonly FingerprintComment[];
  readonly distillationInput?: DistillationKeyInput;
  readonly job?: FinalizeJob;
  readonly matches?: readonly PossibleMatchBinding[];
  readonly sourceSnapshotId?: string;
}

interface WriteResult {
  readonly commitId: string;
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const comments = options.comments ?? BASE_COMMENTS;
  const distillationInput =
    options.distillationInput ?? BASE_DISTILLATION_INPUT;
  const matches = options.matches ?? BASE_MATCHES;
  const canonicalWrite = vi.fn(() => {
    events.push("canonicalWrite");
    return { commitId: "commit-1" };
  });
  const dependencies: FinalizeGuardDependencies<WriteResult> = {
    canonicalWrite,
    computeCurrentDistillationKey: () => {
      events.push("context");
      return computeDistillationKey(distillationInput);
    },
    ensureProjectionCurrent: () => {
      events.push("ensureProjectionCurrent");
    },
    ensureRecovered: () => {
      events.push("ensureRecovered");
    },
    loadCurrentSource: () => {
      events.push("source");
      return {
        content_fingerprint: computeContentFingerprint(comments),
        source_snapshot_id: options.sourceSnapshotId ?? "snapshot-original",
      };
    },
    loadJob: () => {
      events.push("jobState");
      return options.job ?? finalizeJob();
    },
    searchPossibleMatches: () => {
      events.push("matchSet");
      return matches;
    },
    withRepoLock: async (operation) => {
      events.push("lock:start");
      try {
        return await operation();
      } finally {
        events.push("lock:end");
      }
    },
  };

  return {
    canonicalWrite,
    events,
    guard: new FinalizeGuard(dependencies),
  };
}

function finalizeContext(
  overrides: Partial<FinalizeContext> = {},
): FinalizeContext {
  return {
    candidate_set_sha256: "candidate-set-sha256",
    content_fingerprint: computeContentFingerprint(BASE_COMMENTS),
    distillation_key: computeDistillationKey(BASE_DISTILLATION_INPUT),
    expires_at: "2026-08-06T09:10:00.000Z",
    job_id: "job-1",
    lease_generation: 7,
    match_set_digest: computeMatchSetDigest(BASE_MATCHES),
    possible_matches: BASE_MATCHES,
    request_sha256: `sha256:${"a".repeat(64)}`,
    source_snapshot_id: "snapshot-original",
    token_hash: "finalize-token-hash",
    ...overrides,
  };
}

function finalizeJob(overrides: Partial<FinalizeJob> = {}): FinalizeJob {
  return {
    candidate_set_sha256: "candidate-set-sha256",
    id: "job-1",
    lease_generation: 7,
    status: "awaiting_finalize",
    ...overrides,
  };
}

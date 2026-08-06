import { describe, expect, it, vi } from "vitest";

import {
  ProviderDistillationPipeline,
  type CanonicalSkipFinalizeResult,
  type DistillationProvenance,
  type MergeCandidateSearchRequest,
  type MergeClassificationRequest,
  type ProviderDistillationExtractedResult,
  type ProviderDistillationRunRequest,
} from "../src/index.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const CANDIDATE_ID = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("ProviderDistillationPipeline", () => {
  it("runs extract, candidate search, classification, and canonical finalize", async () => {
    const extracted = extractedResult();
    const extractor = { run: vi.fn(async () => extracted) };
    const search = {
      search: vi.fn(async (input: MergeCandidateSearchRequest) => ({
        candidates: input.candidates,
        match_set_digest: "0".repeat(64),
        possible_matches: input.candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          possible_matches: [],
        })),
      })),
    };
    const classifier = {
      classify: vi.fn(async (input: MergeClassificationRequest) => ({
        decisions: input.candidates.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          relation: "different" as const,
        })),
        model: "merge-model",
        provider: "anthropic",
      })),
    };
    const finalizer = {
      finalize: vi.fn(async () => ({
        accepted: true,
        created_proposed: ["kn_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        merged_evidence: ["ev_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
        revision_proposals: [],
      })),
      skip: vi.fn(),
    };
    const pipeline = new ProviderDistillationPipeline({
      classifier,
      extractor,
      finalizer,
      nextCandidateId: () => CANDIDATE_ID,
      now: () => new Date("2026-08-06T01:00:00.000Z"),
      search,
    });

    const result = await pipeline.run(runRequest());

    expect(result).toMatchObject({
      stable_response: { accepted: true },
      state: "finalized",
    });
    expect(search.search).toHaveBeenCalledWith({
      candidates: [expect.objectContaining({ candidate_id: CANDIDATE_ID })],
      threadId: "thread-1",
    });
    expect(classifier.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [expect.objectContaining({ candidate_id: CANDIDATE_ID })],
      }),
    );
    expect(finalizer.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        content_fingerprint: HASH_A,
        distillation_key: HASH_B,
        expected_match_set_digest: "0".repeat(64),
        thread_id: "thread-1",
      }),
    );
    expect(extractor.run.mock.invocationCallOrder[0]).toBeLessThan(
      search.search.mock.invocationCallOrder[0]!,
    );
    expect(search.search.mock.invocationCallOrder[0]).toBeLessThan(
      classifier.classify.mock.invocationCallOrder[0]!,
    );
    expect(classifier.classify.mock.invocationCallOrder[0]).toBeLessThan(
      finalizer.finalize.mock.invocationCallOrder[0]!,
    );
  });

  it("routes zero candidates directly to the atomic skip finalizer", async () => {
    const extractor = {
      run: vi.fn(async () =>
        extractedResult({ candidates: [], skip_reason: "typo" }),
      ),
    };
    const skipResult: CanonicalSkipFinalizeResult = {
      manual_review: null,
      reassociated_evidence_ids: [],
      stable_response: {
        skip_reason: "typo",
        staled_knowledge_ids: [],
        state: "skipped",
        withdrawn_evidence_ids: [],
      },
    };
    const search = { search: vi.fn() };
    const classifier = { classify: vi.fn() };
    const finalizer = {
      finalize: vi.fn(),
      skip: vi.fn(async () => skipResult),
    };
    const pipeline = new ProviderDistillationPipeline({
      classifier,
      extractor,
      finalizer,
      search,
    });

    const result = await pipeline.run(runRequest());

    expect(result).toEqual({ result: skipResult, state: "skipped" });
    expect(finalizer.skip).toHaveBeenCalledWith({
      content_fingerprint: HASH_A,
      distillation_key: HASH_B,
      lease: extractedResult().lease,
      skip_reason: "typo",
      thread_id: "thread-1",
    });
    expect(search.search).not.toHaveBeenCalled();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(finalizer.finalize).not.toHaveBeenCalled();
  });
});

function extractedResult(
  output: ProviderDistillationExtractedResult["output"] = {
    candidates: [
      {
        category: "test",
        confidence: 0.9,
        detail: "Pipeline detail",
        evidence_comment_ids: ["comment-1"],
        rule: "Connect the provider pipeline",
        scope: ["src/**"],
        severity: "should",
      },
    ],
    skip_reason: null,
  },
): ProviderDistillationExtractedResult {
  return {
    job: {
      attempts: 1,
      distillation_key: HASH_B,
      job_id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      lease_expires_at: "2026-08-06T02:00:00.000Z",
      lease_generation: 1,
      lease_token_hash: HASH_C,
      repo_id: "repo-1",
      state: "awaiting_finalize",
      thread_id: "thread-1",
      updated_at: "2026-08-06T00:00:00.000Z",
      validation_failures: 0,
    },
    lease: {
      job_id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      lease_generation: 1,
      lease_token: "lease-token",
    },
    output,
    provenance: provenance(),
    state: "extracted",
  };
}

function provenance(): DistillationProvenance {
  return {
    distillation_key: HASH_B,
    model: "extract-model",
    output_schema_digest: HASH_C,
    output_schema_version: "distillation-output-v1",
    prompt_digest: HASH_D,
    prompt_version: "distill-v1",
    provider: "anthropic",
    trust_policy_digest: HASH_C,
  };
}

function runRequest(): ProviderDistillationRunRequest {
  return {
    job_id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    repositoryContext: { language: "TypeScript" },
    thread: {
      contentFingerprint: HASH_A,
      distillationInputDigest: HASH_C,
      distillationKey: HASH_B,
      normalizedActors: [
        {
          actor_id: "actor-1",
          actor_kind: "user",
          authorAssociation: "MEMBER",
          login: "alice",
          provider: "human",
          trust: "trusted",
        },
      ],
      normalizedComments: [
        {
          body: "Please connect the pipeline",
          createdAt: "2026-08-06T00:00:00.000Z",
          id: "comment-1",
          updatedAt: "2026-08-06T00:00:00.000Z",
        },
      ],
      path: "src/pipeline.ts",
      threadId: "thread-1",
    },
  };
}

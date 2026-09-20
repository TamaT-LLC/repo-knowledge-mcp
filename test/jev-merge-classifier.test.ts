import { describe, expect, it, vi } from "vitest";

import {
  FallbackMergeRelationClassifier,
  JevMergeRelationClassifier,
  MergeClassifierError,
  SensitiveContentTransmissionError,
  TypeSafeJevClient,
  parseRepoKnowledgeConfig,
  resolveTypeSafeApiKey,
  resolveTypeSafeCredential,
  type ExtractCandidate,
  type JevClient,
  type JevClientRequest,
  type JevClientResponse,
  type MergeRelationClassifier,
  type PossibleKnowledgeMatch,
  type PossibleMatchSet,
} from "../src/experimental.js";

const REPOSITORY = "owner/repository";
const CANDIDATE_A = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CANDIDATE_B = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CANDIDATE_C = "cand_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const KNOWLEDGE_A = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KNOWLEDGE_B = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const KNOWLEDGE_C = "kn_01ARZ3NDEKTSV4RRFFQ69G5FAX";

describe("JevMergeRelationClassifier", () => {
  it("maps typed choices back to supplied knowledge IDs and handles empty match sets locally", async () => {
    const client = new FakeJevClient({
      answers: {
        candidate_0: choiceAnswer("same_0", [
          "different",
          "same_0",
          "overlaps_0",
        ]),
        candidate_1: choiceAnswer("overlaps_1", [
          "different",
          "same_0",
          "overlaps_0",
          "same_1",
          "overlaps_1",
        ]),
      },
      model: "jev-1.13.0",
      requestId: "request-1",
    });
    const classifier = new JevMergeRelationClassifier({
      client,
      config: enabledConfig(),
      repository: { currentName: REPOSITORY },
    });

    const result = await classifier.classify({
      candidates: [
        candidate(CANDIDATE_A, "Rule A"),
        candidate(CANDIDATE_B, "Rule B"),
        candidate(CANDIDATE_C, "Rule C"),
      ],
      possible_matches: [
        matchSet(CANDIDATE_A, [KNOWLEDGE_A]),
        matchSet(CANDIDATE_B, [KNOWLEDGE_B, KNOWLEDGE_C]),
        matchSet(CANDIDATE_C, []),
      ],
    });

    expect(result).toMatchObject({
      decisions: [
        {
          candidate_id: CANDIDATE_A,
          relation: "same",
          target_id: KNOWLEDGE_A,
        },
        {
          candidate_id: CANDIDATE_B,
          relation: "overlaps",
          target_id: KNOWLEDGE_C,
        },
        { candidate_id: CANDIDATE_C, relation: "different" },
      ],
      model: "jev-1.13.0",
      provider: "typesafe",
      response_id: "request-1",
    });
    expect(result.decision_metadata).toEqual([
      expect.objectContaining({ candidate_id: CANDIDATE_A, source: "jev" }),
      expect.objectContaining({ candidate_id: CANDIDATE_B, source: "jev" }),
      expect.objectContaining({
        candidate_id: CANDIDATE_C,
        source: "local-no-match",
      }),
    ]);
    expect(client.requests).toHaveLength(1);
    expect(Object.keys(client.requests[0]!.questions)).toEqual([
      "candidate_0",
      "candidate_1",
    ]);
    expect(JSON.stringify(client.requests[0]!.state)).not.toContain("etag");
    expect(JSON.stringify(client.requests[0]!.state)).not.toContain(
      "evidence_comment_ids",
    );
  });

  it("returns different without a credential or API call when no matches exist", async () => {
    const classifier = new JevMergeRelationClassifier({
      config: enabledConfig(),
      repository: { currentName: REPOSITORY },
    });

    await expect(
      classifier.classify({
        candidates: [candidate(CANDIDATE_A, "Rule A")],
        possible_matches: [matchSet(CANDIDATE_A, [])],
      }),
    ).resolves.toMatchObject({
      decisions: [{ candidate_id: CANDIDATE_A, relation: "different" }],
      provider: "typesafe",
    });
  });

  it("does not call Jev without both mode and explicit transmission consent", async () => {
    const client = new FakeJevClient({ answers: {}, model: "jev-latest" });
    const classifier = new JevMergeRelationClassifier({
      client,
      config: parseRepoKnowledgeConfig({
        mergeClassifier: { mode: "jev" },
      }),
      repository: { currentName: REPOSITORY },
    });

    await expect(
      classifier.classify({
        candidates: [candidate(CANDIDATE_A, "Rule A")],
        possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
      }),
    ).rejects.toMatchObject({
      code: "MERGE_CLASSIFIER_TRANSMISSION_DENIED",
    });
    expect(client.requests).toEqual([]);
  });

  it("rejects sensitive state before calling Jev", async () => {
    const client = new FakeJevClient({ answers: {}, model: "jev-latest" });
    const classifier = new JevMergeRelationClassifier({
      client,
      config: enabledConfig(),
      repository: { currentName: REPOSITORY },
    });

    await expect(
      classifier.classify({
        candidates: [
          candidate(CANDIDATE_A, "Rule A", {
            detail: "Contact maintainer@example.com",
          }),
        ],
        possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
      }),
    ).rejects.toMatchObject({
      code: "SENSITIVE_CONTENT_DETECTED",
      findings: [
        {
          kind: "email_address",
          path: "$.candidates[0].detail",
        },
      ],
    });
    expect(client.requests).toEqual([]);
  });

  it("rejects answers whose probability options do not match the question", async () => {
    const client = new FakeJevClient({
      answers: {
        candidate_0: choiceAnswer("same_9", ["different", "same_9"]),
      },
      model: "jev-latest",
    });
    const classifier = new JevMergeRelationClassifier({
      client,
      config: enabledConfig(),
      repository: { currentName: REPOSITORY },
    });

    await expect(
      classifier.classify({
        candidates: [candidate(CANDIDATE_A, "Rule A")],
        possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
      }),
    ).rejects.toMatchObject({ code: "JEV_RESPONSE_INVALID" });
  });
});

describe("Jev client and fallback", () => {
  it("pins the API endpoint and model in the TypeSafe SDK adapter", async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            answers: {
              merge: choiceAnswer("different", ["different", "same_0"]),
            },
            model: "jev-1.13.0",
            usage: { input_tokens: 10, output_tokens: 0 },
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-typesafe-request-id": "request-sdk",
            },
            status: 200,
          },
        ),
      ),
    );
    const client = new TypeSafeJevClient({
      apiKey: "typesafe-test-key",
      fetch,
      model: "jev-latest",
    });

    const response = await client.classify({
      questions: {
        merge: {
          criteria: { different: "Different", same_0: "Same" },
          instructions: "Classify",
        },
      },
      state: { candidate: "Rule" },
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      model: "jev-latest",
    });
    expect(response.requestId).toBe("request-sdk");
  });

  it("uses the current provider after a non-sensitive Jev failure", async () => {
    const primary: MergeRelationClassifier = {
      async classify() {
        throw new MergeClassifierError("JEV_REQUEST_FAILED", "fixture failure");
      },
    };
    const fallback = vi.fn(async () => ({
      decisions: [
        { candidate_id: CANDIDATE_A, relation: "different" as const },
      ],
      model: "provider-model",
      provider: "anthropic",
    }));
    const classifier = new FallbackMergeRelationClassifier({
      fallback: { classify: fallback },
      primary,
      primaryProvider: "typesafe",
    });

    const result = await classifier.classify({
      candidates: [candidate(CANDIDATE_A, "Rule A")],
      possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
    });

    expect(fallback).toHaveBeenCalledOnce();
    expect(result.fallback).toEqual({
      from_provider: "typesafe",
      reason: "JEV_REQUEST_FAILED",
    });
  });

  it("reclassifies only low-confidence same decisions with the provider", async () => {
    const primary: MergeRelationClassifier = {
      async classify() {
        return {
          decision_metadata: [
            {
              candidate_id: CANDIDATE_A,
              confidence: 0.4,
              probabilities: {
                different: 0.1,
                overlaps_0: 0.2,
                same_0: 0.7,
              },
              selected_probability: 0.7,
              source: "jev",
            },
            {
              candidate_id: CANDIDATE_B,
              confidence: 0.3,
              probabilities: {
                different: 0.1,
                overlaps_0: 0.8,
                same_0: 0.1,
              },
              selected_probability: 0.8,
              source: "jev",
            },
          ],
          decisions: [
            {
              candidate_id: CANDIDATE_A,
              relation: "same",
              target_id: KNOWLEDGE_A,
            },
            {
              candidate_id: CANDIDATE_B,
              relation: "overlaps",
              target_id: KNOWLEDGE_B,
            },
          ],
          model: "jev-1.13.0",
          provider: "typesafe",
          response_id: "jev-request",
        };
      },
    };
    const fallback = vi.fn(async () => ({
      decisions: [
        { candidate_id: CANDIDATE_A, relation: "different" as const },
      ],
      model: "provider-model",
      provider: "anthropic",
    }));
    const classifier = new FallbackMergeRelationClassifier({
      fallback: { classify: fallback },
      minimumSameConfidence: 0.9,
      primary,
      primaryProvider: "typesafe",
    });

    const result = await classifier.classify({
      candidates: [
        candidate(CANDIDATE_A, "Rule A"),
        candidate(CANDIDATE_B, "Rule B"),
      ],
      possible_matches: [
        matchSet(CANDIDATE_A, [KNOWLEDGE_A]),
        matchSet(CANDIDATE_B, [KNOWLEDGE_B]),
      ],
    });

    expect(fallback).toHaveBeenCalledWith({
      candidates: [candidate(CANDIDATE_A, "Rule A")],
      possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
    });
    expect(result).toMatchObject({
      decision_metadata: [
        expect.objectContaining({ candidate_id: CANDIDATE_B, source: "jev" }),
      ],
      decisions: [
        { candidate_id: CANDIDATE_A, relation: "different" },
        {
          candidate_id: CANDIDATE_B,
          relation: "overlaps",
          target_id: KNOWLEDGE_B,
        },
      ],
      fallback: {
        candidate_ids: [CANDIDATE_A],
        from_provider: "typesafe",
        model: "provider-model",
        provider: "anthropic",
        reason: "PRIMARY_SAME_CONFIDENCE_BELOW_THRESHOLD",
      },
      model: "jev-1.13.0",
      provider: "typesafe",
      response_id: "jev-request",
    });
  });

  it("keeps a same decision at the configured confidence threshold", async () => {
    const fallback = vi.fn();
    const expected = {
      decision_metadata: [
        {
          candidate_id: CANDIDATE_A,
          confidence: 0.9,
          probabilities: { different: 0.05, same_0: 0.95 },
          selected_probability: 0.95,
          source: "jev" as const,
        },
      ],
      decisions: [
        {
          candidate_id: CANDIDATE_A,
          relation: "same" as const,
          target_id: KNOWLEDGE_A,
        },
      ],
      model: "jev-1.13.0",
      provider: "typesafe",
    };
    const classifier = new FallbackMergeRelationClassifier({
      fallback: { classify: fallback },
      minimumSameConfidence: 0.9,
      primary: { classify: async () => expected },
      primaryProvider: "typesafe",
    });

    await expect(
      classifier.classify({
        candidates: [candidate(CANDIDATE_A, "Rule A")],
        possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
      }),
    ).resolves.toBe(expected);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not fall back after sensitive content is detected", async () => {
    const sensitive = new SensitiveContentTransmissionError(
      "jev_merge_payload",
      [{ kind: "email_address", path: "$.candidate.detail" }],
    );
    const fallback = vi.fn();
    const classifier = new FallbackMergeRelationClassifier({
      fallback: { classify: fallback },
      primary: {
        async classify() {
          throw sensitive;
        },
      },
      primaryProvider: "typesafe",
    });

    await expect(
      classifier.classify({
        candidates: [candidate(CANDIDATE_A, "Rule A")],
        possible_matches: [matchSet(CANDIDATE_A, [KNOWLEDGE_A])],
      }),
    ).rejects.toBe(sensitive);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("resolves only a non-empty TYPESAFE_API_KEY", () => {
    expect(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: "  secret  " })).toBe(
      "secret",
    );
    expect(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: "  " })).toBeNull();
    expect(
      resolveTypeSafeApiKey({ TYPESAFE_BASE_URL: "https://evil.test" }),
    ).toBeNull();
  });

  it("prefers the environment and falls back to macOS Keychain", () => {
    const readKeychain = vi.fn(() => "persisted-key");

    expect(
      resolveTypeSafeCredential({
        environment: { TYPESAFE_API_KEY: "environment-key" },
        platform: "darwin",
        readMacOsKeychain: readKeychain,
      }),
    ).toEqual({ apiKey: "environment-key", source: "environment" });
    expect(readKeychain).not.toHaveBeenCalled();

    expect(
      resolveTypeSafeCredential({
        environment: {},
        platform: "darwin",
        readMacOsKeychain: readKeychain,
      }),
    ).toEqual({ apiKey: "persisted-key", source: "macos-keychain" });
    expect(readKeychain).toHaveBeenCalledOnce();
  });

  it("does not inspect macOS Keychain on other platforms", () => {
    const readKeychain = vi.fn(() => "persisted-key");
    expect(
      resolveTypeSafeCredential({
        environment: {},
        platform: "linux",
        readMacOsKeychain: readKeychain,
      }),
    ).toBeNull();
    expect(readKeychain).not.toHaveBeenCalled();
  });
});

function enabledConfig() {
  return parseRepoKnowledgeConfig({
    mergeClassifier: {
      allowCloudTransmission: true,
      mode: "jev",
      model: "jev-latest",
    },
  });
}

function candidate(
  candidateId: string,
  rule: string,
  overrides: Partial<ExtractCandidate["candidate"]> = {},
): ExtractCandidate {
  return {
    candidate: {
      category: "test",
      confidence: 0.8,
      detail: "A reusable repository rule.",
      evidence_comment_ids: ["comment-1"],
      rule,
      scope: ["src/**/*.ts"],
      severity: "should",
      ...overrides,
    },
    candidate_id: candidateId,
  };
}

function matchSet(
  candidateId: string,
  knowledgeIds: readonly string[],
): PossibleMatchSet<PossibleKnowledgeMatch> {
  return {
    candidate_id: candidateId,
    possible_matches: knowledgeIds.map((knowledgeId) => ({
      category: "test",
      detail: `Existing detail for ${knowledgeId}`,
      etag: "a".repeat(64),
      knowledge_id: knowledgeId,
      revision: 1,
      rule: `Existing ${knowledgeId}`,
      scope: ["src/**"],
      severity: "should",
      status: "active",
    })),
  };
}

function choiceAnswer(choice: string, options: readonly string[]) {
  return {
    choice,
    confidence: 0.9,
    probabilities: Object.fromEntries(
      options.map((option) => [
        option,
        option === choice ? 0.9 : 0.1 / (options.length - 1),
      ]),
    ),
    type: "choice" as const,
  };
}

class FakeJevClient implements JevClient {
  readonly requests: JevClientRequest[] = [];

  constructor(private readonly response: JevClientResponse) {}

  classify(request: JevClientRequest): Promise<JevClientResponse> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

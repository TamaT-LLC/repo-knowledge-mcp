import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  parseDistillationPrompt,
} from "../src/distillation-prompt.js";
import { TrustConfigSchema } from "../src/domain-schemas.js";
import {
  BASELINE_SEARCH_DERIVATION_VERSION,
  GoldenBaselineCaptureError,
  MINIMUM_QUALITY_GATE_THREADS,
  OUTCOME_RANKING_POLICY,
  captureProviderGoldenBaseline,
  computeRankingPolicyDigest,
  computeTrustPolicyDigest,
  createRecordedPredictionProvider,
  evaluateGoldenFixture,
  evaluateProviderBaselineArtifact,
  findSensitiveContent,
  isProviderGoldenBaselineArtifact,
  parseAnonymizedThreadCorpus,
  type BaselinePredictionProvider,
  type DistillationPromptTemplate,
} from "../src/experimental.js";

const CORPUS_URL = new URL(
  "./fixtures/golden/m2-anonymized-corpus.json",
  import.meta.url,
);
const RECORDED_URL = new URL(
  "./fixtures/golden/m2-recorded-predictions.json",
  import.meta.url,
);
const ARTIFACT_URL = new URL(
  "./fixtures/golden/m2-provider-baseline.json",
  import.meta.url,
);
const PROMPT_URL = new URL("../prompts/distill.md", import.meta.url);

async function loadJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

async function loadPrompt(): Promise<DistillationPromptTemplate> {
  return parseDistillationPrompt(await readFile(PROMPT_URL));
}

async function replayCapture(): Promise<unknown> {
  const provider = createRecordedPredictionProvider(
    await loadJson(RECORDED_URL),
  );
  return captureProviderGoldenBaseline({
    corpus: await loadJson(CORPUS_URL),
    measuredAt: provider.recorded.recorded_at,
    predictionProvider: provider,
    prompt: await loadPrompt(),
    transmission: { cloudConsent: false, mode: "replay" },
    trust: TrustConfigSchema.parse({}),
  });
}

describe("anonymized corpus fixture", () => {
  it("holds at least 50 anonymized threads with valid expectations", async () => {
    const corpus = parseAnonymizedThreadCorpus(await loadJson(CORPUS_URL));

    expect(corpus.threads.length).toBeGreaterThanOrEqual(
      MINIMUM_QUALITY_GATE_THREADS,
    );
    expect(corpus.corpus_id).toBe("m2-anonymized-corpus-2026-08-07");
    expect(corpus.searches.length).toBeGreaterThanOrEqual(6);
    const knowledgeThreads = corpus.threads.filter(
      (thread) => thread.expected.is_knowledge,
    );
    expect(knowledgeThreads.length).toBeGreaterThanOrEqual(40);
    const categories = new Set(
      knowledgeThreads.map((thread) => thread.expected.category),
    );
    expect(categories.size).toBe(9);
  });

  it("rejects every supported credential format and non-anonymized identity", () => {
    const samples: readonly {
      readonly body: string;
      readonly kind: string;
    }[] = [
      { body: "my key is sk-ant-abc12345DEF", kind: "provider_api_key" },
      {
        body: "openai key sk-proj-abcDEF123456789012345678",
        kind: "provider_api_key",
      },
      {
        body: "legacy openai key sk-abcDEF12345678901234",
        kind: "provider_api_key",
      },
      {
        body: "token ghp_0123456789abcdefghij0123456789",
        kind: "github_token",
      },
      {
        body: "fine grained github_pat_11ABCDEFG0123456789abcdef",
        kind: "github_token",
      },
      { body: "slack xoxb-1234567890-abcdefghij", kind: "slack_token" },
      { body: "aws AKIAIOSFODNN7EXAMPLE", kind: "aws_access_key_id" },
      {
        body: "google AIzaSyA1234567890abcdefghijklmnopqrstuvw",
        kind: "google_api_key",
      },
      { body: "-----BEGIN RSA PRIVATE KEY-----", kind: "private_key_block" },
      { body: "Authorization: Bearer abcdef", kind: "authorization_header" },
      {
        body: 'api_key = "abcdefghij0123456789"',
        kind: "generic_secret_assignment",
      },
      {
        body: "password: hunter2hunter2hunter2",
        kind: "generic_secret_assignment",
      },
      { body: "email me at somebody@example.com", kind: "email_address" },
    ];

    for (const sample of samples) {
      const findings = findSensitiveContent({ body: sample.body });
      expect(
        findings.map((finding) => finding.kind),
        `expected ${sample.kind} for: ${sample.body}`,
      ).toContain(sample.kind);
    }
    expect(findSensitiveContent({ body: "no secrets here" })).toEqual([]);
  });

  it("refuses to parse a corpus containing sensitive content without echoing it", async () => {
    const corpus = (await loadJson(CORPUS_URL)) as {
      threads: { comments: { body: string }[] }[];
    };
    const secret = "sk-ant-secret1234567890";
    corpus.threads[0]!.comments[0]!.body = `use ${secret} here`;

    expect(() => parseAnonymizedThreadCorpus(corpus)).toThrowError(
      /BASELINE_SENSITIVE_CONTENT/u,
    );
    try {
      parseAnonymizedThreadCorpus(corpus);
      expect.unreachable("corpus must be rejected");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("provider_api_key");
    }
  });
});

describe("provider baseline capture", () => {
  it("requires explicit cloud consent before any live transmission", async () => {
    const calls: string[] = [];
    const provider: BaselinePredictionProvider = {
      predict: (request) => {
        calls.push(request.threadId);
        return Promise.reject(new Error("must not be called"));
      },
    };

    await expect(
      captureProviderGoldenBaseline({
        corpus: await loadJson(CORPUS_URL),
        measuredAt: "2026-08-07T00:00:00.000Z",
        predictionProvider: provider,
        prompt: await loadPrompt(),
        transmission: { cloudConsent: false, mode: "live" },
        trust: TrustConfigSchema.parse({}),
      }),
    ).rejects.toMatchObject({ code: "BASELINE_CLOUD_CONSENT_REQUIRED" });
    expect(calls).toEqual([]);
  });

  it("replays recorded predictions into exactly the committed artifact", async () => {
    const artifact = await replayCapture();

    expect(artifact).toEqual(await loadJson(ARTIFACT_URL));
  });

  it("records full model, prompt, schema, and policy provenance", async () => {
    const { artifact } = evaluateProviderBaselineArtifact(
      await loadJson(ARTIFACT_URL),
    );
    const prompt = await loadPrompt();

    expect(artifact.provenance).toEqual({
      model: "fixture-baseline-m2-v1",
      output_schema_digest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      output_schema_version: DISTILLATION_OUTPUT_SCHEMA_VERSION,
      prompt_digest: prompt.promptDigest,
      prompt_version: prompt.promptVersion,
      provider: "fixture-replay",
      ranking_policy_digest: computeRankingPolicyDigest(),
      ranking_policy_version: OUTCOME_RANKING_POLICY.version,
      search_derivation_version: BASELINE_SEARCH_DERIVATION_VERSION,
      trust_policy_digest: computeTrustPolicyDigest(
        TrustConfigSchema.parse({}),
      ),
    });
    expect(artifact.transmission).toEqual({
      cloud_consent: false,
      mode: "replay",
    });
  });

  it("produces predictions, not expected-value copies", async () => {
    const { artifact, report } = evaluateProviderBaselineArtifact(
      await loadJson(ARTIFACT_URL),
    );

    const divergent = artifact.fixture.cases.filter(
      (entry) =>
        entry.expected.is_knowledge !== entry.prediction.is_knowledge ||
        entry.expected.category !== entry.prediction.category ||
        entry.expected.severity !== entry.prediction.severity,
    );
    expect(divergent.length).toBeGreaterThan(0);
    const perfect = Object.values(report.metrics).every(
      (metric) => metric.value === 1,
    );
    expect(perfect).toBe(false);
  });

  it("recomputes an identical metric report from the recorded artifact", async () => {
    const input = await loadJson(ARTIFACT_URL);

    const first = evaluateProviderBaselineArtifact(input);
    const second = evaluateProviderBaselineArtifact(
      await loadJson(ARTIFACT_URL),
    );

    expect(JSON.stringify(first.report)).toBe(JSON.stringify(second.report));
    expect(first.report).toEqual(evaluateGoldenFixture(first.artifact.fixture));
  });

  it("fails when a recorded prediction is missing for a corpus thread", async () => {
    const recorded = (await loadJson(RECORDED_URL)) as {
      responses: Record<string, unknown>;
    };
    delete recorded.responses["m2-t01"];
    const provider = createRecordedPredictionProvider(recorded);

    await expect(
      captureProviderGoldenBaseline({
        corpus: await loadJson(CORPUS_URL),
        measuredAt: provider.recorded.recorded_at,
        predictionProvider: provider,
        prompt: await loadPrompt(),
        transmission: { cloudConsent: false, mode: "replay" },
        trust: TrustConfigSchema.parse({}),
      }),
    ).rejects.toBeInstanceOf(GoldenBaselineCaptureError);
  });

  it("refuses to persist an artifact whose predictions carry sensitive content", async () => {
    const recorded = (await loadJson(RECORDED_URL)) as {
      responses: Record<
        string,
        { output: { candidates: { detail: string }[] } }
      >;
    };
    recorded.responses["m2-t01"]!.output.candidates[0]!.detail =
      "contact reviewer at leaked@example.com";
    const provider = createRecordedPredictionProvider(recorded);

    await expect(
      captureProviderGoldenBaseline({
        corpus: await loadJson(CORPUS_URL),
        measuredAt: provider.recorded.recorded_at,
        predictionProvider: provider,
        prompt: await loadPrompt(),
        transmission: { cloudConsent: false, mode: "replay" },
        trust: TrustConfigSchema.parse({}),
      }),
    ).rejects.toMatchObject({ code: "BASELINE_SENSITIVE_CONTENT" });
  });

  it("detects the artifact envelope for CLI dispatch", async () => {
    expect(isProviderGoldenBaselineArtifact(await loadJson(ARTIFACT_URL))).toBe(
      true,
    );
    expect(isProviderGoldenBaselineArtifact(await loadJson(CORPUS_URL))).toBe(
      false,
    );
  });
});

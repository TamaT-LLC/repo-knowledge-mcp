import { z } from "zod";

import { canonicalizeJson, compareCodeUnits, sha256Jcs } from "./canonical.js";
import { computeTrustPolicyDigest } from "./config.js";
import {
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  DISTILLATION_OUTPUT_SCHEMA_DIGEST,
  DISTILLATION_OUTPUT_SCHEMA_VERSION,
  buildDistillationUserInput,
  type DistillationPromptActor,
  type DistillationPromptComment,
  type DistillationPromptTemplate,
} from "./distillation-prompt.js";
import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  type DistillationOutput,
  type TrustConfig,
} from "./domain-schemas.js";
import { computeThreadContentFingerprint } from "./github-snapshot-normalizer.js";
import {
  GoldenFixtureSchema,
  evaluateGoldenFixture,
  type GoldenEvaluationReport,
  type GoldenFixture,
} from "./golden-evaluator.js";
import {
  SensitiveContentError,
  findSensitiveContent,
  parseAnonymizedThreadCorpus,
  type AnonymizedCorpusSearch,
  type AnonymizedCorpusThread,
  type AnonymizedThreadCorpus,
} from "./golden-corpus.js";
import {
  OUTCOME_RANKING_POLICY,
  computeKnowledgeSearchScore,
} from "./knowledge-search.js";
import type { LlmProviderAdapter } from "./llm-provider.js";
import { parseDistillationOutput } from "./provider-distillation-service.js";

export const PROVIDER_GOLDEN_BASELINE_ARTIFACT_KIND =
  "provider_golden_baseline";

/**
 * Version of the deterministic search-ranking derivation that turns recorded
 * predictions into a recorded ranking (lexical overlap ordered by the
 * production knowledge-search score). Changing the derivation must bump this.
 */
export const BASELINE_SEARCH_DERIVATION_VERSION = "baseline-search-v1";

/** Every baseline prediction counts as exactly one supporting evidence. */
const BASELINE_EVIDENCE_COUNT = 1;

const ZERO_OUTCOME_COUNTS = {
  appliedCount: 0,
  falsePositiveCount: 0,
  notApplicableCount: 0,
  violationCount: 0,
} as const;

export interface BaselinePredictionRequest {
  readonly input: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly model?: string;
  readonly system: string;
  readonly threadId: string;
}

export interface BaselinePredictionResponse {
  readonly model: string;
  readonly outputText: string;
  readonly provider: string;
  readonly responseId?: string;
}

/** Thread-aware provider boundary so replay can serve recorded predictions. */
export interface BaselinePredictionProvider {
  predict(
    request: BaselinePredictionRequest,
  ): Promise<BaselinePredictionResponse>;
}

export type GoldenBaselineCaptureErrorCode =
  | "BASELINE_CLOUD_CONSENT_REQUIRED"
  | "BASELINE_CORPUS_MISMATCH"
  | "BASELINE_PROVIDER_INCONSISTENT"
  | "BASELINE_RECORDED_PREDICTION_MISSING";

export class GoldenBaselineCaptureError extends Error {
  constructor(
    readonly code: GoldenBaselineCaptureErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GoldenBaselineCaptureError";
  }
}

export const RecordedPredictionsSchema = z
  .object({
    corpus_id: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    recorded_at: IsoDateTimeSchema,
    responses: z.record(
      NonEmptyStringSchema,
      z
        .object({
          output: z.record(z.string(), z.unknown()),
          response_id: NonEmptyStringSchema.optional(),
        })
        .strict(),
    ),
    schema_version: z.literal(1),
  })
  .strict();

export type RecordedPredictions = z.infer<typeof RecordedPredictionsSchema>;

/** Wraps a live adapter; the thread id never leaves the process. */
export function createAdapterPredictionProvider(
  adapter: LlmProviderAdapter,
): BaselinePredictionProvider {
  return {
    predict: async (request) =>
      adapter.completeStructured({
        input: request.input,
        jsonSchema: request.jsonSchema,
        ...(request.model === undefined ? {} : { model: request.model }),
        system: request.system,
      }),
  };
}

/** Replays recorded provider predictions without any network access. */
export function createRecordedPredictionProvider(
  input: unknown,
): BaselinePredictionProvider & { readonly recorded: RecordedPredictions } {
  const recorded = RecordedPredictionsSchema.parse(input);
  return {
    predict: (request) => {
      const entry = recorded.responses[request.threadId];
      if (entry === undefined) {
        return Promise.reject(
          new GoldenBaselineCaptureError(
            "BASELINE_RECORDED_PREDICTION_MISSING",
            `no recorded prediction for thread ${request.threadId}`,
          ),
        );
      }
      return Promise.resolve({
        model: recorded.model,
        outputText: canonicalizeJson(entry.output),
        provider: recorded.provider,
        ...(entry.response_id === undefined
          ? {}
          : { responseId: entry.response_id }),
      });
    },
    recorded,
  };
}

const BaselineProvenanceSchema = z
  .object({
    model: NonEmptyStringSchema,
    output_schema_digest: Sha256DigestSchema,
    output_schema_version: NonEmptyStringSchema,
    prompt_digest: Sha256DigestSchema,
    prompt_version: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    ranking_policy_digest: Sha256DigestSchema,
    ranking_policy_version: NonEmptyStringSchema,
    search_derivation_version: NonEmptyStringSchema,
    trust_policy_digest: Sha256DigestSchema,
  })
  .strict();

export const ProviderGoldenBaselineArtifactSchema = z
  .object({
    artifact_kind: z.literal(PROVIDER_GOLDEN_BASELINE_ARTIFACT_KIND),
    corpus_digest: Sha256DigestSchema,
    corpus_id: NonEmptyStringSchema,
    fixture: GoldenFixtureSchema,
    measured_at: IsoDateTimeSchema,
    provenance: BaselineProvenanceSchema,
    schema_version: z.literal(1),
    transmission: z
      .object({
        cloud_consent: z.boolean(),
        mode: z.enum(["live", "replay"]),
      })
      .strict(),
  })
  .strict();

export type ProviderGoldenBaselineArtifact = z.infer<
  typeof ProviderGoldenBaselineArtifactSchema
>;

export interface CaptureProviderGoldenBaselineRequest {
  readonly corpus: unknown;
  /** ISO timestamp recorded in the artifact; replay passes `recorded_at`. */
  readonly measuredAt: string;
  readonly model?: string;
  readonly predictionProvider: BaselinePredictionProvider;
  readonly prompt: DistillationPromptTemplate;
  readonly transmission: {
    readonly cloudConsent: boolean;
    readonly mode: "live" | "replay";
  };
  readonly trust: TrustConfig;
}

interface ThreadPrediction {
  readonly output: DistillationOutput;
  readonly thread: AnonymizedCorpusThread;
}

/**
 * Sends every anonymized corpus thread through the distillation prompt and
 * records the provider predictions as a deterministic golden fixture with
 * full model/prompt/schema/policy provenance. Live transmission is fail-closed
 * behind explicit cloud consent; replay mode never touches the network.
 */
export async function captureProviderGoldenBaseline(
  request: CaptureProviderGoldenBaselineRequest,
): Promise<ProviderGoldenBaselineArtifact> {
  const corpus = parseAnonymizedThreadCorpus(request.corpus);
  if (
    request.transmission.mode === "live" &&
    !request.transmission.cloudConsent
  ) {
    throw new GoldenBaselineCaptureError(
      "BASELINE_CLOUD_CONSENT_REQUIRED",
      "live provider capture requires explicit cloud transmission consent",
    );
  }
  IsoDateTimeSchema.parse(request.measuredAt);

  const predictions: ThreadPrediction[] = [];
  let provider: string | null = null;
  let model: string | null = null;
  for (const thread of corpus.threads) {
    const comments = promptComments(thread);
    const input = buildDistillationUserInput({
      repositoryContext: {
        corpus_id: corpus.corpus_id,
        corpus_kind: corpus.corpus_kind,
      },
      thread: {
        contentFingerprint: computeThreadContentFingerprint(
          thread.id,
          thread.path,
          comments,
        ),
        normalizedActors: thread.comments.map(promptActor),
        normalizedComments: comments,
        path: thread.path,
        threadId: thread.id,
      },
    });
    const response = await request.predictionProvider.predict({
      input,
      jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
      ...(request.model === undefined ? {} : { model: request.model }),
      system: request.prompt.instructions,
      threadId: thread.id,
    });
    if (provider === null) {
      provider = NonEmptyStringSchema.parse(response.provider);
      model = NonEmptyStringSchema.parse(response.model);
    } else if (response.provider !== provider || response.model !== model) {
      throw new GoldenBaselineCaptureError(
        "BASELINE_PROVIDER_INCONSISTENT",
        "every baseline prediction must come from one provider and model",
      );
    }
    const output = parseDistillationOutput(response.outputText, comments);
    const outputFindings = findSensitiveContent(output);
    if (outputFindings.length > 0) {
      throw new SensitiveContentError(
        `provider prediction for thread ${thread.id}`,
        outputFindings,
      );
    }
    predictions.push({ output, thread });
  }
  if (provider === null || model === null) {
    throw new GoldenBaselineCaptureError(
      "BASELINE_CORPUS_MISMATCH",
      "the corpus produced no predictions",
    );
  }

  const fixture = buildBaselineFixture(corpus, predictions);
  const artifact = ProviderGoldenBaselineArtifactSchema.parse({
    artifact_kind: PROVIDER_GOLDEN_BASELINE_ARTIFACT_KIND,
    corpus_digest: `sha256:${sha256Jcs(corpus)}`,
    corpus_id: corpus.corpus_id,
    fixture,
    measured_at: request.measuredAt,
    provenance: {
      model,
      output_schema_digest: DISTILLATION_OUTPUT_SCHEMA_DIGEST,
      output_schema_version: DISTILLATION_OUTPUT_SCHEMA_VERSION,
      prompt_digest: request.prompt.promptDigest,
      prompt_version: request.prompt.promptVersion,
      provider,
      ranking_policy_digest: computeRankingPolicyDigest(),
      ranking_policy_version: OUTCOME_RANKING_POLICY.version,
      search_derivation_version: BASELINE_SEARCH_DERIVATION_VERSION,
      trust_policy_digest: computeTrustPolicyDigest(request.trust),
    },
    schema_version: 1,
    transmission: {
      cloud_consent: request.transmission.cloudConsent,
      mode: request.transmission.mode,
    },
  });
  const findings = findSensitiveContent(artifact);
  if (findings.length > 0) {
    throw new SensitiveContentError("baseline artifact", findings);
  }
  return artifact;
}

export interface ProviderBaselineEvaluation {
  readonly artifact: ProviderGoldenBaselineArtifact;
  readonly report: GoldenEvaluationReport;
}

/** Recomputes the metric report from an already recorded baseline artifact. */
export function evaluateProviderBaselineArtifact(
  input: unknown,
): ProviderBaselineEvaluation {
  const artifact = ProviderGoldenBaselineArtifactSchema.parse(input);
  const findings = findSensitiveContent(artifact);
  if (findings.length > 0) {
    throw new SensitiveContentError("baseline artifact", findings);
  }
  return { artifact, report: evaluateGoldenFixture(artifact.fixture) };
}

/** Detects the artifact envelope without validating the whole document. */
export function isProviderGoldenBaselineArtifact(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { artifact_kind?: unknown }).artifact_kind ===
      PROVIDER_GOLDEN_BASELINE_ARTIFACT_KIND
  );
}

/** Hashes the machine-trackable outcome ranking policy (RFC 8785 JSON). */
export function computeRankingPolicyDigest(): string {
  return `sha256:${sha256Jcs(OUTCOME_RANKING_POLICY)}`;
}

function promptComments(
  thread: AnonymizedCorpusThread,
): DistillationPromptComment[] {
  return thread.comments.map((comment) => ({
    body: comment.body,
    createdAt: comment.created_at,
    ...(comment.diff_hunk === undefined ? {} : { diffHunk: comment.diff_hunk }),
    id: comment.id,
    updatedAt: comment.updated_at,
  }));
}

function promptActor(
  comment: AnonymizedCorpusThread["comments"][number],
): DistillationPromptActor {
  return {
    actor_id: null,
    actor_kind: comment.actor.actor_kind,
    authorAssociation: null,
    login: comment.actor.role,
    provider: comment.actor.provider,
    trust: comment.actor.trust,
  };
}

function buildBaselineFixture(
  corpus: AnonymizedThreadCorpus,
  predictions: readonly ThreadPrediction[],
): GoldenFixture {
  const mergeGroups = assignPredictedMergeGroups(predictions);
  const cases = predictions.map((prediction) => {
    const primary = primaryCandidate(prediction.output);
    return {
      expected: prediction.thread.expected,
      id: prediction.thread.id,
      prediction:
        primary === null
          ? {
              category: null,
              is_knowledge: false,
              merge_group: null,
              scope: [],
              severity: null,
            }
          : {
              category: primary.category,
              is_knowledge: true,
              merge_group: mergeGroups.get(prediction.thread.id) ?? null,
              scope: [...primary.scope],
              severity: primary.severity,
            },
      scope_checks: prediction.thread.scope_checks,
      tags: prediction.thread.tags,
    };
  });
  const searches = corpus.searches.map((search) => ({
    id: search.id,
    ranking: deriveSearchRanking(search, predictions),
    relevance: search.relevance,
  }));
  return GoldenFixtureSchema.parse({
    cases,
    fixture_id: `${corpus.corpus_id}-provider-baseline`,
    schema_version: 1,
    searches,
  });
}

type PredictedCandidate = DistillationOutput["candidates"][number];

function primaryCandidate(
  output: DistillationOutput,
): PredictedCandidate | null {
  let primary: PredictedCandidate | null = null;
  for (const candidate of output.candidates) {
    if (primary === null || candidate.confidence > primary.confidence) {
      primary = candidate;
    }
  }
  return primary;
}

/**
 * Groups predicted rules whose normalized text is identical. The grouping is
 * a pure function of the recorded predictions, so pairwise merge metrics can
 * be recomputed from the artifact alone.
 */
function assignPredictedMergeGroups(
  predictions: readonly ThreadPrediction[],
): Map<string, string> {
  const keyToThreadIds = new Map<string, string[]>();
  for (const prediction of predictions) {
    const primary = primaryCandidate(prediction.output);
    if (primary === null) continue;
    const key = normalizeMergeKey(primary.rule);
    const threadIds = keyToThreadIds.get(key) ?? [];
    threadIds.push(prediction.thread.id);
    keyToThreadIds.set(key, threadIds);
  }
  const assignments = new Map<string, string>();
  let groupNumber = 0;
  for (const threadIds of keyToThreadIds.values()) {
    if (threadIds.length < 2) continue;
    groupNumber += 1;
    const name = `predicted-merge-${String(groupNumber).padStart(2, "0")}`;
    for (const threadId of threadIds) assignments.set(threadId, name);
  }
  return assignments;
}

function normalizeMergeKey(rule: string): string {
  return rule
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function deriveSearchRanking(
  search: AnonymizedCorpusSearch,
  predictions: readonly ThreadPrediction[],
): string[] {
  const queryTokens = tokenize(search.query);
  const matched = predictions
    .flatMap((prediction) => {
      const primary = primaryCandidate(prediction.output);
      if (primary === null) return [];
      const candidateTokens = tokenize(`${primary.rule} ${primary.detail}`);
      let overlap = 0;
      for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
      }
      if (overlap === 0) return [];
      return [
        { id: prediction.thread.id, overlap, severity: primary.severity },
      ];
    })
    .sort(
      (left, right) =>
        right.overlap - left.overlap || compareCodeUnits(left.id, right.id),
    )
    .map((entry, textRank) => ({
      id: entry.id,
      score: computeKnowledgeSearchScore(
        textRank,
        entry.severity,
        BASELINE_EVIDENCE_COUNT,
        ZERO_OUTCOME_COUNTS,
      ),
      textRank,
    }));
  return matched
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.textRank - right.textRank ||
        compareCodeUnits(left.id, right.id),
    )
    .map((entry) => entry.id);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

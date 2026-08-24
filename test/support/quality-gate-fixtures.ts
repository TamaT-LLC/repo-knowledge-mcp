import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TrustConfigSchema,
  captureProviderGoldenBaseline,
  computeBaselineIdentityDigest,
  createRecordedPredictionProvider,
  loadDistillationPrompt,
  type DistillationPromptTemplate,
  type ProviderGoldenBaselineArtifact,
  type TrustConfig,
} from "../../src/experimental.js";

export const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

const GOLDEN_FIXTURE_DIRECTORY = join(
  repositoryRoot,
  "test",
  "fixtures",
  "golden",
);

const QUALITY_GATE_FIXTURE_PATHS = {
  artifact: join(GOLDEN_FIXTURE_DIRECTORY, "m2-provider-baseline.json"),
  corpus: join(GOLDEN_FIXTURE_DIRECTORY, "m2-anonymized-corpus.json"),
  prompt: join(repositoryRoot, "prompts", "distill.md"),
  recorded: join(GOLDEN_FIXTURE_DIRECTORY, "m2-recorded-predictions.json"),
  thresholds: join(GOLDEN_FIXTURE_DIRECTORY, "m2-quality-thresholds.json"),
} as const;

export interface QualityGateFixtureSet {
  readonly artifact: unknown;
  readonly corpus: unknown;
  readonly prompt: DistillationPromptTemplate;
  readonly recordedPredictions: unknown;
  readonly thresholds: unknown;
  readonly trust: TrustConfig;
}

/** Loads the committed offline quality gate inputs exactly as CI uses them. */
export async function loadQualityGateFixtures(): Promise<QualityGateFixtureSet> {
  return {
    artifact: await readJson(QUALITY_GATE_FIXTURE_PATHS.artifact),
    corpus: await readJson(QUALITY_GATE_FIXTURE_PATHS.corpus),
    prompt: await loadDistillationPrompt(QUALITY_GATE_FIXTURE_PATHS.prompt),
    recordedPredictions: await readJson(QUALITY_GATE_FIXTURE_PATHS.recorded),
    thresholds: await readJson(QUALITY_GATE_FIXTURE_PATHS.thresholds),
    trust: TrustConfigSchema.parse({}),
  };
}

export interface DegradedQualityGateScenario {
  readonly artifact: ProviderGoldenBaselineArtifact;
  readonly recordedPredictions: unknown;
  readonly thresholds: unknown;
}

const DEGRADED_KNOWLEDGE_THREADS = 3;

interface RecordedPredictionsShape {
  readonly recorded_at: string;
  readonly responses: Record<
    string,
    { output: { candidates: readonly unknown[]; skip_reason: string | null } }
  >;
}

interface CorpusShape {
  readonly threads: readonly {
    readonly expected: { readonly is_knowledge: boolean };
    readonly id: string;
  }[];
}

/**
 * Builds a self-consistent gate input set whose recomputed extraction recall
 * sits below the reviewed minimum: recorded predictions for three true
 * knowledge threads are blanked, the baseline artifact is re-captured from
 * the tampered recording, and the thresholds are re-bound to that artifact so
 * only the metric comparison (not an integrity check) can fail.
 */
export async function buildDegradedQualityGateScenario(
  fixtures: QualityGateFixtureSet,
): Promise<DegradedQualityGateScenario> {
  const recorded = structuredClone(
    fixtures.recordedPredictions,
  ) as RecordedPredictionsShape;
  const corpus = fixtures.corpus as CorpusShape;
  let blanked = 0;
  for (const thread of corpus.threads) {
    if (blanked >= DEGRADED_KNOWLEDGE_THREADS) break;
    if (!thread.expected.is_knowledge) continue;
    const entry = recorded.responses[thread.id];
    if (entry === undefined || entry.output.candidates.length === 0) continue;
    entry.output = { candidates: [], skip_reason: "pr_specific" };
    blanked += 1;
  }
  if (blanked < DEGRADED_KNOWLEDGE_THREADS) {
    throw new Error("fixture corpus lacks enough predicted knowledge threads");
  }
  const artifact = await captureProviderGoldenBaseline({
    corpus: fixtures.corpus,
    measuredAt: recorded.recorded_at,
    predictionProvider: createRecordedPredictionProvider(recorded),
    prompt: fixtures.prompt,
    transmission: { cloudConsent: false, mode: "replay" },
    trust: fixtures.trust,
  });
  const thresholds = {
    ...(fixtures.thresholds as Record<string, unknown>),
    baseline: {
      artifact_digest: computeBaselineIdentityDigest(artifact),
      artifact_kind: artifact.artifact_kind,
      corpus_digest: artifact.corpus_digest,
      corpus_id: artifact.corpus_id,
      measured_at: artifact.measured_at,
    },
  };
  return { artifact, recordedPredictions: recorded, thresholds };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

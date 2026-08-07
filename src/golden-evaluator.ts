import picomatch from "picomatch";
import { z } from "zod";

import {
  KnowledgeCategorySchema,
  ScopePatternSchema,
  SeveritySchema,
  type Severity,
} from "./domain-schemas.js";

const GoldenExpectedSchema = z
  .object({
    category: KnowledgeCategorySchema.nullable(),
    is_knowledge: z.boolean(),
    merge_group: z.string().min(1).nullable(),
    scope: z.array(z.string()),
    severity: SeveritySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.is_knowledge &&
      (value.category === null || value.severity === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "knowledge fixtures require category and severity",
      });
    }
    if (!value.is_knowledge && value.merge_group !== null) {
      context.addIssue({
        code: "custom",
        message: "non-knowledge fixtures cannot belong to a merge group",
      });
    }
  });

const GoldenPredictionSchema = z
  .object({
    category: z.string().nullable(),
    is_knowledge: z.boolean(),
    merge_group: z.string().min(1).nullable(),
    scope: z.array(z.string()),
    severity: z.string().nullable(),
  })
  .strict();

const GoldenCaseSchema = z
  .object({
    expected: GoldenExpectedSchema,
    id: z.string().min(1),
    prediction: GoldenPredictionSchema,
    scope_checks: z.array(
      z
        .object({
          matches: z.boolean(),
          path: z.string().min(1),
        })
        .strict(),
    ),
    tags: z.array(z.string().min(1)),
  })
  .strict();

const GoldenSearchCaseSchema = z
  .object({
    id: z.string().min(1),
    ranking: z.array(z.string().min(1)),
    relevance: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, id] of value.ranking.entries()) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate ranking id ${id}`,
          path: ["ranking", index],
        });
      }
      seen.add(id);
    }
  });

export const GoldenFixtureSchema = z
  .object({
    cases: z.array(GoldenCaseSchema).min(1),
    fixture_id: z.string().min(1),
    schema_version: z.literal(1),
    searches: z.array(GoldenSearchCaseSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.cases.map((entry) => entry.id),
      "cases",
      context,
    );
    addDuplicateIssues(
      value.searches.map((entry) => entry.id),
      "searches",
      context,
    );
  });

export type GoldenFixture = z.infer<typeof GoldenFixtureSchema>;

export interface GoldenMetric {
  readonly denominator: number;
  readonly numerator: number;
  readonly value: number;
}

export interface GoldenEvaluationReport {
  readonly counts: {
    readonly cases: number;
    readonly knowledge_cases: number;
    readonly search_queries: number;
  };
  readonly fixture_id: string;
  readonly metrics: {
    readonly category_macro_f1: GoldenMetric;
    readonly extraction_precision: GoldenMetric;
    readonly extraction_recall: GoldenMetric;
    readonly merge_pairwise_precision: GoldenMetric;
    readonly merge_pairwise_recall: GoldenMetric;
    readonly scope_expected_file_match_rate: GoldenMetric;
    readonly scope_valid_glob_rate: GoldenMetric;
    readonly search_mrr: GoldenMetric;
    readonly search_ndcg: GoldenMetric;
    readonly severity_weighted_accuracy: GoldenMetric;
  };
  readonly schema_version: 1;
}

/** Evaluates a recorded prediction corpus without calling a model or network. */
export function evaluateGoldenFixture(input: unknown): GoldenEvaluationReport {
  const fixture = GoldenFixtureSchema.parse(input);
  const extraction = extractionCounts(fixture);
  const category = categoryMacroF1(fixture);
  const severity = severityWeightedAccuracy(fixture);
  const merge = mergePairwiseCounts(fixture);
  const scope = scopeMetrics(fixture);
  const search = searchMetrics(fixture);

  return {
    counts: {
      cases: fixture.cases.length,
      knowledge_cases: fixture.cases.filter(
        (entry) => entry.expected.is_knowledge,
      ).length,
      search_queries: fixture.searches.length,
    },
    fixture_id: fixture.fixture_id,
    metrics: {
      category_macro_f1: metric(category.sum, category.labels),
      extraction_precision: ratioMetric(
        extraction.truePositive,
        extraction.truePositive + extraction.falsePositive,
      ),
      extraction_recall: ratioMetric(
        extraction.truePositive,
        extraction.truePositive + extraction.falseNegative,
      ),
      merge_pairwise_precision: ratioMetric(
        merge.truePositive,
        merge.truePositive + merge.falsePositive,
      ),
      merge_pairwise_recall: ratioMetric(
        merge.truePositive,
        merge.truePositive + merge.falseNegative,
      ),
      scope_expected_file_match_rate: metric(
        scope.correctMatches,
        scope.matchChecks,
      ),
      scope_valid_glob_rate: metric(scope.validGlobs, scope.totalGlobs),
      search_mrr: metric(search.reciprocalRankSum, fixture.searches.length),
      search_ndcg: metric(search.ndcgSum, fixture.searches.length),
      severity_weighted_accuracy: metric(
        severity.correctWeight,
        severity.totalWeight,
      ),
    },
    schema_version: 1,
  };
}

function extractionCounts(fixture: GoldenFixture): {
  falseNegative: number;
  falsePositive: number;
  truePositive: number;
} {
  let falseNegative = 0;
  let falsePositive = 0;
  let truePositive = 0;
  for (const entry of fixture.cases) {
    if (entry.expected.is_knowledge && entry.prediction.is_knowledge) {
      truePositive += 1;
    } else if (entry.expected.is_knowledge) {
      falseNegative += 1;
    } else if (entry.prediction.is_knowledge) {
      falsePositive += 1;
    }
  }
  return { falseNegative, falsePositive, truePositive };
}

function categoryMacroF1(fixture: GoldenFixture): {
  labels: number;
  sum: number;
} {
  const cases = fixture.cases.filter(
    (entry) => entry.expected.is_knowledge && entry.expected.category !== null,
  );
  const labels = [...new Set(cases.map((entry) => entry.expected.category!))];
  let sum = 0;
  for (const label of labels) {
    let falseNegative = 0;
    let falsePositive = 0;
    let truePositive = 0;
    for (const entry of cases) {
      const expected = entry.expected.category === label;
      const predicted =
        entry.prediction.is_knowledge && entry.prediction.category === label;
      if (expected && predicted) truePositive += 1;
      else if (expected) falseNegative += 1;
      else if (predicted) falsePositive += 1;
    }
    const denominator = 2 * truePositive + falsePositive + falseNegative;
    sum += denominator === 0 ? 1 : (2 * truePositive) / denominator;
  }
  return { labels: labels.length, sum };
}

function severityWeightedAccuracy(fixture: GoldenFixture): {
  correctWeight: number;
  totalWeight: number;
} {
  const weights: Readonly<Record<Severity, number>> = {
    consider: 1,
    must: 3,
    should: 2,
  };
  let correctWeight = 0;
  let totalWeight = 0;
  for (const entry of fixture.cases) {
    if (!entry.expected.is_knowledge || entry.expected.severity === null)
      continue;
    const weight = weights[entry.expected.severity];
    totalWeight += weight;
    if (
      entry.prediction.is_knowledge &&
      entry.prediction.severity === entry.expected.severity
    ) {
      correctWeight += weight;
    }
  }
  return { correctWeight, totalWeight };
}

function mergePairwiseCounts(fixture: GoldenFixture): {
  falseNegative: number;
  falsePositive: number;
  truePositive: number;
} {
  const cases = fixture.cases.filter((entry) => entry.expected.is_knowledge);
  let falseNegative = 0;
  let falsePositive = 0;
  let truePositive = 0;
  for (let left = 0; left < cases.length; left += 1) {
    for (let right = left + 1; right < cases.length; right += 1) {
      const first = cases[left]!;
      const second = cases[right]!;
      const expectedSame =
        first.expected.merge_group !== null &&
        first.expected.merge_group === second.expected.merge_group;
      const predictedSame =
        first.prediction.is_knowledge &&
        second.prediction.is_knowledge &&
        first.prediction.merge_group !== null &&
        first.prediction.merge_group === second.prediction.merge_group;
      if (expectedSame && predictedSame) truePositive += 1;
      else if (expectedSame) falseNegative += 1;
      else if (predictedSame) falsePositive += 1;
    }
  }
  return { falseNegative, falsePositive, truePositive };
}

function scopeMetrics(fixture: GoldenFixture): {
  correctMatches: number;
  matchChecks: number;
  totalGlobs: number;
  validGlobs: number;
} {
  let correctMatches = 0;
  let matchChecks = 0;
  let totalGlobs = 0;
  let validGlobs = 0;
  for (const entry of fixture.cases) {
    if (!entry.prediction.is_knowledge) continue;
    for (const pattern of entry.prediction.scope) {
      totalGlobs += 1;
      if (isValidGlob(pattern)) validGlobs += 1;
    }
    for (const check of entry.scope_checks) {
      matchChecks += 1;
      if (matchesScope(entry.prediction.scope, check.path) === check.matches) {
        correctMatches += 1;
      }
    }
  }
  return { correctMatches, matchChecks, totalGlobs, validGlobs };
}

function searchMetrics(fixture: GoldenFixture): {
  ndcgSum: number;
  reciprocalRankSum: number;
} {
  let ndcgSum = 0;
  let reciprocalRankSum = 0;
  for (const query of fixture.searches) {
    reciprocalRankSum += rankingReciprocalRank(query.ranking, query.relevance);
    ndcgSum += rankingNdcg(query.ranking, query.relevance);
  }
  return { ndcgSum, reciprocalRankSum };
}

/** Reciprocal rank of the first relevant id; 0 when nothing relevant ranks. */
export function rankingReciprocalRank(
  ranking: readonly string[],
  relevance: Readonly<Record<string, number>>,
): number {
  const firstRelevant = ranking.findIndex((id) => (relevance[id] ?? 0) > 0);
  return firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;
}

/** NDCG of a ranking against graded relevance; 1 for a gradeless query. */
export function rankingNdcg(
  ranking: readonly string[],
  relevance: Readonly<Record<string, number>>,
): number {
  const actualGrades = ranking.map((id) => relevance[id] ?? 0);
  const idealGrades = Object.values(relevance)
    .sort((left, right) => right - left)
    .slice(0, ranking.length);
  const ideal = discountedGain(idealGrades);
  return ideal === 0 ? 1 : discountedGain(actualGrades) / ideal;
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce(
    (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
    0,
  );
}

function isValidGlob(pattern: string): boolean {
  if (!ScopePatternSchema.safeParse(pattern).success) return false;
  try {
    picomatch(pattern, { dot: true, nocase: false });
    return true;
  } catch {
    return false;
  }
}

function matchesScope(patterns: readonly string[], path: string): boolean {
  if (patterns.length === 0) return true;
  for (const pattern of patterns) {
    if (!isValidGlob(pattern)) continue;
    if (picomatch(pattern, { dot: true, nocase: false })(path)) return true;
  }
  return false;
}

function ratioMetric(numerator: number, denominator: number): GoldenMetric {
  return metric(numerator, denominator, denominator === 0 ? 1 : undefined);
}

/** Rounded numerator/denominator metric shared with the outcome ranking report. */
export function goldenMetric(
  numerator: number,
  denominator: number,
  emptyValue = 0,
): GoldenMetric {
  return metric(numerator, denominator, emptyValue);
}

function metric(
  numerator: number,
  denominator: number,
  emptyValue = 0,
): GoldenMetric {
  return {
    denominator,
    numerator: round(numerator),
    value: round(denominator === 0 ? emptyValue : numerator / denominator),
  };
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function addDuplicateIssues(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `duplicate ${path} id ${value}`,
        path: [path, index, "id"],
      });
    }
    seen.add(value);
  }
}

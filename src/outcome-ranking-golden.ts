import { z } from "zod";

import { compareCodeUnits } from "./canonical.js";
import { SeveritySchema } from "./domain-schemas.js";
import {
  goldenMetric,
  rankingNdcg,
  rankingReciprocalRank,
  type GoldenMetric,
} from "./golden-evaluator.js";
import {
  computeKnowledgeSearchScore,
  OUTCOME_RANKING_POLICY,
  type KnowledgeOutcomeCounts,
} from "./knowledge-search.js";

export const OUTCOME_RANKING_BASELINE_POLICY_VERSION = "m1-baseline";

const OutcomeRankingCandidateSchema = z
  .object({
    applied_count: z.number().int().nonnegative(),
    evidence_count: z.number().int().nonnegative(),
    false_positive_count: z.number().int().nonnegative(),
    id: z.string().min(1),
    not_applicable_count: z.number().int().nonnegative(),
    severity: SeveritySchema,
    text_rank: z.number().int().nonnegative(),
    violation_count: z.number().int().nonnegative(),
  })
  .strict();

const OutcomeRankingRubricSchema = z
  .object({
    description: z.string().min(1),
    higher: z.string().min(1),
    id: z.string().min(1),
    lower: z.string().min(1),
  })
  .strict();

const OutcomeRankingQuerySchema = z
  .object({
    candidates: z.array(OutcomeRankingCandidateSchema).min(1),
    id: z.string().min(1),
    relevance: z.record(z.string().min(1), z.number().int().nonnegative()),
    rubric: z.array(OutcomeRankingRubricSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = new Set<string>();
    const textRanks = new Set<number>();
    for (const [index, candidate] of value.candidates.entries()) {
      if (candidateIds.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate candidate id ${candidate.id}`,
          path: ["candidates", index, "id"],
        });
      }
      candidateIds.add(candidate.id);
      if (textRanks.has(candidate.text_rank)) {
        context.addIssue({
          code: "custom",
          message: `duplicate text_rank ${String(candidate.text_rank)}`,
          path: ["candidates", index, "text_rank"],
        });
      }
      textRanks.add(candidate.text_rank);
    }
    const rubricIds = new Set<string>();
    for (const [index, entry] of value.rubric.entries()) {
      if (rubricIds.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate rubric id ${entry.id}`,
          path: ["rubric", index, "id"],
        });
      }
      rubricIds.add(entry.id);
      if (entry.higher === entry.lower) {
        context.addIssue({
          code: "custom",
          message: "rubric higher and lower must differ",
          path: ["rubric", index],
        });
      }
      for (const side of ["higher", "lower"] as const) {
        if (!candidateIds.has(entry[side])) {
          context.addIssue({
            code: "custom",
            message: `rubric ${side} ${entry[side]} is not a candidate`,
            path: ["rubric", index, side],
          });
        }
      }
    }
  });

export const OutcomeRankingFixtureSchema = z
  .object({
    fixture_id: z.string().min(1),
    fixture_kind: z.literal("outcome_ranking"),
    queries: z.array(OutcomeRankingQuerySchema).min(1),
    schema_version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, query] of value.queries.entries()) {
      if (seen.has(query.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate queries id ${query.id}`,
          path: ["queries", index, "id"],
        });
      }
      seen.add(query.id);
    }
  });

export type OutcomeRankingFixture = z.infer<typeof OutcomeRankingFixtureSchema>;

type OutcomeRankingQuery = OutcomeRankingFixture["queries"][number];
type OutcomeRankingCandidate = OutcomeRankingQuery["candidates"][number];

export interface OutcomeRankingRubricResult {
  readonly baseline_pass: boolean;
  readonly description: string;
  readonly id: string;
  readonly outcome_pass: boolean;
}

export interface OutcomeRankingQueryReport {
  readonly baseline_ranking: readonly string[];
  readonly id: string;
  readonly outcome_ranking: readonly string[];
  readonly rubric: readonly OutcomeRankingRubricResult[];
}

export interface OutcomeRankingPolicyMetrics {
  readonly policy_version: string;
  readonly rubric_pass_rate: GoldenMetric;
  readonly search_mrr: GoldenMetric;
  readonly search_ndcg: GoldenMetric;
}

export interface OutcomeRankingReport {
  readonly baseline: OutcomeRankingPolicyMetrics;
  readonly counts: {
    readonly queries: number;
    readonly rubric_checks: number;
  };
  readonly delta: {
    readonly rubric_pass_rate: number;
    readonly search_mrr: number;
    readonly search_ndcg: number;
  };
  readonly fixture_id: string;
  readonly outcome: OutcomeRankingPolicyMetrics;
  readonly policy: typeof OUTCOME_RANKING_POLICY;
  readonly queries: readonly OutcomeRankingQueryReport[];
  readonly schema_version: 1;
}

/**
 * Compares the M1 baseline ranking against the M2 outcome-aware ranking on the
 * same recorded candidates, reporting MRR/NDCG and human rubric pass rates for
 * both policies so a policy change surfaces as a report diff.
 */
export function evaluateOutcomeRankingFixture(
  input: unknown,
): OutcomeRankingReport {
  const fixture = OutcomeRankingFixtureSchema.parse(input);
  let baselineMrr = 0;
  let baselineNdcg = 0;
  let baselineRubricPassed = 0;
  let outcomeMrr = 0;
  let outcomeNdcg = 0;
  let outcomeRubricPassed = 0;
  let rubricChecks = 0;

  const queries = fixture.queries.map((query): OutcomeRankingQueryReport => {
    const baselineRanking = rankCandidates(query, "baseline");
    const outcomeRanking = rankCandidates(query, "outcome");
    baselineMrr += rankingReciprocalRank(baselineRanking, query.relevance);
    baselineNdcg += rankingNdcg(baselineRanking, query.relevance);
    outcomeMrr += rankingReciprocalRank(outcomeRanking, query.relevance);
    outcomeNdcg += rankingNdcg(outcomeRanking, query.relevance);

    const rubric = query.rubric.map((entry): OutcomeRankingRubricResult => {
      const baselinePass = ranksHigher(baselineRanking, entry);
      const outcomePass = ranksHigher(outcomeRanking, entry);
      rubricChecks += 1;
      if (baselinePass) baselineRubricPassed += 1;
      if (outcomePass) outcomeRubricPassed += 1;
      return {
        baseline_pass: baselinePass,
        description: entry.description,
        id: entry.id,
        outcome_pass: outcomePass,
      };
    });

    return {
      baseline_ranking: baselineRanking,
      id: query.id,
      outcome_ranking: outcomeRanking,
      rubric,
    };
  });

  const queryCount = fixture.queries.length;
  const baseline: OutcomeRankingPolicyMetrics = {
    policy_version: OUTCOME_RANKING_BASELINE_POLICY_VERSION,
    rubric_pass_rate: goldenMetric(baselineRubricPassed, rubricChecks, 1),
    search_mrr: goldenMetric(baselineMrr, queryCount),
    search_ndcg: goldenMetric(baselineNdcg, queryCount),
  };
  const outcome: OutcomeRankingPolicyMetrics = {
    policy_version: OUTCOME_RANKING_POLICY.version,
    rubric_pass_rate: goldenMetric(outcomeRubricPassed, rubricChecks, 1),
    search_mrr: goldenMetric(outcomeMrr, queryCount),
    search_ndcg: goldenMetric(outcomeNdcg, queryCount),
  };

  return {
    baseline,
    counts: { queries: queryCount, rubric_checks: rubricChecks },
    delta: {
      rubric_pass_rate: roundDelta(
        outcome.rubric_pass_rate.value - baseline.rubric_pass_rate.value,
      ),
      search_mrr: roundDelta(
        outcome.search_mrr.value - baseline.search_mrr.value,
      ),
      search_ndcg: roundDelta(
        outcome.search_ndcg.value - baseline.search_ndcg.value,
      ),
    },
    fixture_id: fixture.fixture_id,
    outcome,
    policy: OUTCOME_RANKING_POLICY,
    queries,
    schema_version: 1,
  };
}

function rankCandidates(
  query: OutcomeRankingQuery,
  policy: "baseline" | "outcome",
): string[] {
  return query.candidates
    .map((candidate) => ({
      candidate,
      score: computeKnowledgeSearchScore(
        candidate.text_rank,
        candidate.severity,
        candidate.evidence_count,
        outcomeCounts(candidate, policy),
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.text_rank - right.candidate.text_rank ||
        compareCodeUnits(left.candidate.id, right.candidate.id),
    )
    .map((entry) => entry.candidate.id);
}

function outcomeCounts(
  candidate: OutcomeRankingCandidate,
  policy: "baseline" | "outcome",
): KnowledgeOutcomeCounts {
  if (policy === "baseline") {
    return {
      appliedCount: 0,
      falsePositiveCount: 0,
      notApplicableCount: 0,
      violationCount: candidate.violation_count,
    };
  }
  return {
    appliedCount: candidate.applied_count,
    falsePositiveCount: candidate.false_positive_count,
    notApplicableCount: candidate.not_applicable_count,
    violationCount: candidate.violation_count,
  };
}

function ranksHigher(
  ranking: readonly string[],
  entry: { readonly higher: string; readonly lower: string },
): boolean {
  return ranking.indexOf(entry.higher) < ranking.indexOf(entry.lower);
}

function roundDelta(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

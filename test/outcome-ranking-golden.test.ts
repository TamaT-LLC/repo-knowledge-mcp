import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  OUTCOME_RANKING_BASELINE_POLICY_VERSION,
  OUTCOME_RANKING_POLICY,
  OutcomeRankingFixtureSchema,
  evaluateOutcomeRankingFixture,
  type OutcomeRankingFixture,
} from "../src/index.js";

const FIXTURE_PATH = new URL(
  "./fixtures/golden/m2-outcome-ranking-golden.json",
  import.meta.url,
);

describe("M2 outcome ranking golden report", () => {
  it("compares MRR/NDCG and the human rubric across both policies", async () => {
    const report = evaluateOutcomeRankingFixture(await loadFixture());

    expect(report).toMatchObject({
      counts: { queries: 5, rubric_checks: 6 },
      fixture_id: "m2-outcome-ranking-baseline-2026-08-07",
      schema_version: 1,
    });
    expect(report.policy).toEqual(OUTCOME_RANKING_POLICY);
    expect(report.baseline.policy_version).toBe(
      OUTCOME_RANKING_BASELINE_POLICY_VERSION,
    );
    expect(report.outcome.policy_version).toBe(OUTCOME_RANKING_POLICY.version);
    expect(report.baseline.search_ndcg.value).toBeLessThan(1);
    expect(report.outcome.search_ndcg.value).toBe(1);
    expect(report.delta.search_ndcg).toBeGreaterThan(0);
    expect(report.baseline.rubric_pass_rate).toMatchObject({
      denominator: 6,
      numerator: 4,
    });
    expect(report.outcome.rubric_pass_rate).toMatchObject({
      denominator: 6,
      numerator: 6,
    });
  });

  it("reorders mixed applied/violated/false_positive candidates within bounds", async () => {
    const report = evaluateOutcomeRankingFixture(await loadFixture());
    const mixed = queryReport(report, "mixed-applied-violated-false-positive");

    expect(mixed.baseline_ranking).toEqual([
      "kn_top_match",
      "kn_false_positive_heavy",
      "kn_applied_proven",
    ]);
    expect(mixed.outcome_ranking).toEqual([
      "kn_top_match",
      "kn_applied_proven",
      "kn_false_positive_heavy",
    ]);
    expect(mixed.rubric).toEqual([
      expect.objectContaining({
        baseline_pass: false,
        id: "applied-beats-false-positive",
        outcome_pass: true,
      }),
    ]);
  });

  it("keeps the M1 order for zero-outcome and bounded-flood queries", async () => {
    const report = evaluateOutcomeRankingFixture(await loadFixture());

    for (const id of [
      "zero-outcomes-keeps-m1-order",
      "applied-boost-is-bounded",
      "applied-below-min-sample-is-inert",
    ]) {
      const query = queryReport(report, id);
      expect(query.outcome_ranking).toEqual(query.baseline_ranking);
    }
  });

  it("is deterministic for the same recorded event aggregates", async () => {
    const fixture = await loadFixture();

    expect(evaluateOutcomeRankingFixture(fixture)).toEqual(
      evaluateOutcomeRankingFixture(structuredClone(fixture)),
    );
  });

  it("rejects rubric entries that reference unknown candidates", async () => {
    const fixture = structuredClone(await loadFixture());
    fixture.queries[0]!.rubric[0]!.higher = "kn_missing";

    expect(() => OutcomeRankingFixtureSchema.parse(fixture)).toThrow(
      /rubric higher kn_missing is not a candidate/u,
    );
  });

  it("rejects duplicate candidate ids and text ranks", async () => {
    const duplicateId = structuredClone(await loadFixture());
    duplicateId.queries[0]!.candidates[1]!.id =
      duplicateId.queries[0]!.candidates[0]!.id;
    const duplicateRank = structuredClone(await loadFixture());
    duplicateRank.queries[0]!.candidates[1]!.text_rank =
      duplicateRank.queries[0]!.candidates[0]!.text_rank;

    expect(() => OutcomeRankingFixtureSchema.parse(duplicateId)).toThrow(
      /duplicate candidate id/u,
    );
    expect(() => OutcomeRankingFixtureSchema.parse(duplicateRank)).toThrow(
      /duplicate text_rank/u,
    );
  });
});

async function loadFixture(): Promise<OutcomeRankingFixture> {
  return OutcomeRankingFixtureSchema.parse(
    JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as unknown,
  );
}

function queryReport(
  report: ReturnType<typeof evaluateOutcomeRankingFixture>,
  id: string,
): ReturnType<typeof evaluateOutcomeRankingFixture>["queries"][number] {
  const query = report.queries.find((entry) => entry.id === id);
  if (query === undefined) throw new Error(`query report ${id} not found`);
  return query;
}

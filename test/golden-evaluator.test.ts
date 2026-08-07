import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GoldenFixtureSchema,
  evaluateGoldenFixture,
  type GoldenFixture,
} from "../src/index.js";

const FIXTURE_PATH = new URL(
  "./fixtures/golden/m1-golden.json",
  import.meta.url,
);

describe("M1 golden evaluator", () => {
  it("measures the 50-thread baseline across every required metric", async () => {
    const fixture = await loadFixture();

    const report = evaluateGoldenFixture(fixture);

    expect(report).toMatchObject({
      counts: { cases: 50, knowledge_cases: 40, search_queries: 6 },
      fixture_id: "m1-anonymized-baseline-2026-08-06",
      schema_version: 1,
    });
    expect(Object.keys(report.metrics).sort()).toEqual([
      "category_macro_f1",
      "extraction_precision",
      "extraction_recall",
      "merge_pairwise_precision",
      "merge_pairwise_recall",
      "scope_expected_file_match_rate",
      "scope_valid_glob_rate",
      "search_mrr",
      "search_ndcg",
      "severity_weighted_accuracy",
    ]);
    expect(
      Object.values(report.metrics).every((metric) => metric.value === 1),
    ).toBe(true);
    for (const tag of [
      "edited",
      "external-contributor",
      "multiple-rules",
      "nested-pagination",
      "prompt-injection",
      "reply",
      "resolved-rejected",
      "retracted",
      "short-query",
      "unknown-bot",
    ]) {
      expect(fixture.cases.some((entry) => entry.tags.includes(tag))).toBe(
        true,
      );
    }
  });

  it("reports degradation without requiring exact model output equality", async () => {
    const fixture = structuredClone(await loadFixture());
    fixture.cases[0]!.prediction.is_knowledge = false;
    fixture.cases[1]!.prediction.category = "other";
    fixture.cases[2]!.prediction.severity = "consider";
    fixture.cases[3]!.prediction.merge_group = "wrong-cluster";
    fixture.cases[5]!.prediction.scope = ["!unsupported/**"];
    fixture.searches[0]!.ranking = ["golden-03", "golden-01", "golden-02"];

    const report = evaluateGoldenFixture(fixture);

    expect(report.metrics.extraction_recall.value).toBeLessThan(1);
    expect(report.metrics.category_macro_f1.value).toBeLessThan(1);
    expect(report.metrics.severity_weighted_accuracy.value).toBeLessThan(1);
    expect(report.metrics.merge_pairwise_recall.value).toBeLessThan(1);
    expect(report.metrics.scope_valid_glob_rate.value).toBeLessThan(1);
    expect(report.metrics.scope_expected_file_match_rate.value).toBeLessThan(1);
    expect(report.metrics.search_mrr.value).toBeLessThan(1);
    expect(report.metrics.search_ndcg.value).toBeLessThan(1);
  });

  it("rejects duplicate case identities before measuring", async () => {
    const fixture = structuredClone(await loadFixture());
    fixture.cases[1]!.id = fixture.cases[0]!.id;

    expect(() => GoldenFixtureSchema.parse(fixture)).toThrow(
      /duplicate cases id/u,
    );
  });

  it("rejects duplicate result identities before measuring search quality", async () => {
    const fixture = structuredClone(await loadFixture());
    fixture.searches[0]!.ranking[1] = fixture.searches[0]!.ranking[0]!;

    expect(() => GoldenFixtureSchema.parse(fixture)).toThrow(
      /duplicate ranking id/u,
    );
  });
});

async function loadFixture(): Promise<GoldenFixture> {
  return GoldenFixtureSchema.parse(
    JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as unknown,
  );
}

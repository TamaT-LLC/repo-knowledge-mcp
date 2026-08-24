import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PilotHumanRubricSchema,
  PilotRubricEvaluationSchema,
  validatePilotRubricEvaluation,
  type PilotHumanRubric,
  type PilotRubricEvaluation,
} from "../src/experimental.js";
import { repositoryRoot } from "./support/quality-gate-fixtures.js";

const RUBRIC_FIXTURE_PATH = join(
  repositoryRoot,
  "docs",
  "testing",
  "m2-pilot-human-rubric.json",
);

async function loadCommittedRubric(): Promise<PilotHumanRubric> {
  const raw = JSON.parse(
    await readFile(RUBRIC_FIXTURE_PATH, "utf8"),
  ) as unknown;
  return PilotHumanRubricSchema.parse(raw);
}

function completeEvaluation(rubric: PilotHumanRubric): PilotRubricEvaluation {
  return PilotRubricEvaluationSchema.parse({
    checkpoint_id: rubric.checkpoints[0]!.id,
    evaluated_at: "2026-08-10T09:00:00.000Z",
    evaluation_kind: "m2_pilot_rubric_evaluation",
    evaluator: "maintainer-a",
    results: rubric.queries.map((query) => ({
      criteria: query.criteria.map((criterion) => ({
        criterion_id: criterion.id,
        met: true,
      })),
      query_id: query.id,
      score: rubric.scale[0]!.score,
    })),
    rubric_id: rubric.rubric_id,
    schema_version: 1,
  });
}

describe("pilot human rubric fixture", () => {
  it("commits a valid rubric with a fixed query set and multiple checkpoints", async () => {
    const rubric = await loadCommittedRubric();

    expect(rubric.rubric_id).toBe("m2-pilot-human-rubric-v1");
    expect(rubric.queries.length).toBeGreaterThanOrEqual(5);
    expect(rubric.checkpoints.map((checkpoint) => checkpoint.day)).toEqual([
      1, 7, 14,
    ]);
    expect(rubric.scale.map((level) => level.score)).toEqual([1, 2, 3, 4]);
  });

  it("rejects a rubric with duplicate query ids or a single checkpoint", async () => {
    const rubric = await loadCommittedRubric();
    const duplicated = {
      ...rubric,
      queries: [rubric.queries[0]!, rubric.queries[0]!],
    };
    expect(PilotHumanRubricSchema.safeParse(duplicated).success).toBe(false);

    const singleCheckpoint = {
      ...rubric,
      checkpoints: [rubric.checkpoints[0]!],
    };
    expect(PilotHumanRubricSchema.safeParse(singleCheckpoint).success).toBe(
      false,
    );
  });

  it("rejects a scale whose met-ratio floors decrease as the score increases", async () => {
    const rubric = await loadCommittedRubric();
    const inverted = {
      ...rubric,
      scale: rubric.scale.map((level, index) => ({
        ...level,
        minimum_criteria_met_ratio: index === 0 ? 1 : 0,
      })),
    };

    const parsed = PilotHumanRubricSchema.safeParse(inverted);

    expect(parsed.success).toBe(false);
  });
});

describe("validatePilotRubricEvaluation", () => {
  it("accepts a complete evaluation of every query and criterion", async () => {
    const rubric = await loadCommittedRubric();

    expect(
      validatePilotRubricEvaluation(rubric, completeEvaluation(rubric)),
    ).toEqual([]);
  });

  it("flags unknown checkpoints, unknown queries, and off-scale scores", async () => {
    const rubric = await loadCommittedRubric();
    const evaluation = completeEvaluation(rubric);
    const broken: PilotRubricEvaluation = {
      ...evaluation,
      checkpoint_id: "cp-day-99",
      results: [
        { ...evaluation.results[0]!, score: 99 },
        { ...evaluation.results[1]!, query_id: "q-unknown" },
        ...evaluation.results.slice(2),
      ],
    };

    const issues = validatePilotRubricEvaluation(rubric, broken);

    expect(issues).toContain("unknown checkpoint cp-day-99");
    expect(issues).toContain("unknown query q-unknown");
    expect(
      issues.some((issue) =>
        issue.includes("score 99 outside the rubric scale"),
      ),
    ).toBe(true);
    expect(issues.some((issue) => issue.includes("was not evaluated"))).toBe(
      true,
    );
  });

  it("flags incomplete or duplicated criterion judgements", async () => {
    const rubric = await loadCommittedRubric();
    const evaluation = completeEvaluation(rubric);
    const firstResult = evaluation.results[0]!;
    const broken: PilotRubricEvaluation = {
      ...evaluation,
      results: [
        { ...firstResult, criteria: [firstResult.criteria[0]!] },
        ...evaluation.results.slice(1),
      ],
    };

    const issues = validatePilotRubricEvaluation(rubric, broken);

    expect(
      issues.some((issue) => issue.includes("does not judge criterion")),
    ).toBe(true);

    const duplicated: PilotRubricEvaluation = {
      ...evaluation,
      results: [
        {
          ...firstResult,
          criteria: [firstResult.criteria[0]!, firstResult.criteria[0]!],
        },
        ...evaluation.results.slice(1),
      ],
    };
    expect(
      validatePilotRubricEvaluation(rubric, duplicated).some((issue) =>
        issue.includes("more than once"),
      ),
    ).toBe(true);
  });

  it("rejects a top score whose criteria are not all met", async () => {
    const rubric = await loadCommittedRubric();
    const topScore = Math.max(...rubric.scale.map((level) => level.score));
    const evaluation = completeEvaluation(rubric);
    const firstResult = evaluation.results[0]!;
    const inconsistent: PilotRubricEvaluation = {
      ...evaluation,
      results: [
        {
          ...firstResult,
          // Every criterion judged not met, yet the top score is claimed.
          criteria: firstResult.criteria.map((criterion) => ({
            ...criterion,
            met: false,
          })),
          score: topScore,
        },
        ...evaluation.results.slice(1),
      ],
    };

    const issues = validatePilotRubricEvaluation(rubric, inconsistent);

    expect(
      issues.some(
        (issue) =>
          issue.includes(`score ${String(topScore)}`) &&
          issue.includes("criteria met"),
      ),
    ).toBe(true);
  });

  it("accepts a strict low score even when every criterion is met, but rejects an unbacked mid score", async () => {
    const rubric = await loadCommittedRubric();
    const scores = rubric.scale
      .map((level) => level.score)
      .sort((left, right) => left - right);
    const evaluation = completeEvaluation(rubric);
    const firstResult = evaluation.results[0]!;

    // All criteria met with the lowest score: judging strictly is allowed.
    expect(validatePilotRubricEvaluation(rubric, evaluation)).toEqual([]);

    // Score 3 requires at least half of the criteria met; none are.
    const unbacked: PilotRubricEvaluation = {
      ...evaluation,
      results: [
        {
          ...firstResult,
          criteria: firstResult.criteria.map((criterion) => ({
            ...criterion,
            met: false,
          })),
          score: scores[2]!,
        },
        ...evaluation.results.slice(1),
      ],
    };
    const issues = validatePilotRubricEvaluation(rubric, unbacked);
    expect(issues.some((issue) => issue.includes("requires at least"))).toBe(
      true,
    );
  });

  it("flags a rubric id mismatch", async () => {
    const rubric = await loadCommittedRubric();
    const evaluation = {
      ...completeEvaluation(rubric),
      rubric_id: "some-other-rubric",
    };

    expect(validatePilotRubricEvaluation(rubric, evaluation)[0]).toContain(
      "targets rubric some-other-rubric",
    );
  });
});

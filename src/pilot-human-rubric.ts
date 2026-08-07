import { z } from "zod";

import { IsoDateTimeSchema } from "./domain-schemas.js";

export const PILOT_HUMAN_RUBRIC_KIND = "m2_pilot_human_rubric";
export const PILOT_RUBRIC_EVALUATION_KIND = "m2_pilot_rubric_evaluation";

const PilotRubricScaleLevelSchema = z
  .object({
    description: z.string().min(1),
    label: z.string().min(1),
    score: z.number().int(),
  })
  .strict();

const PilotRubricCheckpointSchema = z
  .object({
    day: z.number().int().positive(),
    description: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

const PilotRubricCriterionSchema = z
  .object({
    description: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

const PilotRubricQuerySchema = z
  .object({
    criteria: z.array(PilotRubricCriterionSchema).min(1),
    id: z.string().min(1),
    intent: z.string().min(1),
    query: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, criterion] of value.criteria.entries()) {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate criterion id ${criterion.id}`,
          path: ["criteria", index, "id"],
        });
      }
      seen.add(criterion.id);
    }
  });

/**
 * Fixed query set plus evaluation criteria for the human "ranking feels
 * right" judgement (§19 M2 completion). The rubric follows the pairwise
 * outcome-ranking rubric style but targets live rankings whose candidates
 * are unknown ahead of time, so each query carries reviewable criteria and
 * every checkpoint reuses the identical query set for comparability.
 */
export const PilotHumanRubricSchema = z
  .object({
    checkpoints: z.array(PilotRubricCheckpointSchema).min(2),
    queries: z.array(PilotRubricQuerySchema).min(1),
    rubric_id: z.string().min(1),
    rubric_kind: z.literal(PILOT_HUMAN_RUBRIC_KIND),
    scale: z.array(PilotRubricScaleLevelSchema).min(2),
    schema_version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    assertUniqueIds(
      value.queries.map((query) => query.id),
      "queries",
      context,
    );
    assertUniqueIds(
      value.checkpoints.map((checkpoint) => checkpoint.id),
      "checkpoints",
      context,
    );
    const days = value.checkpoints.map((checkpoint) => checkpoint.day);
    if (new Set(days).size !== days.length) {
      context.addIssue({
        code: "custom",
        message: "checkpoint days must be unique",
        path: ["checkpoints"],
      });
    }
    const scores = value.scale.map((level) => level.score);
    if (new Set(scores).size !== scores.length) {
      context.addIssue({
        code: "custom",
        message: "scale scores must be unique",
        path: ["scale"],
      });
    }
  });

export type PilotHumanRubric = z.infer<typeof PilotHumanRubricSchema>;

const PilotRubricCriterionResultSchema = z
  .object({
    criterion_id: z.string().min(1),
    met: z.boolean(),
  })
  .strict();

const PilotRubricQueryResultSchema = z
  .object({
    criteria: z.array(PilotRubricCriterionResultSchema).min(1),
    notes: z.string().min(1).optional(),
    query_id: z.string().min(1),
    score: z.number().int(),
  })
  .strict();

/** One human evaluation pass of the whole rubric at one checkpoint. */
export const PilotRubricEvaluationSchema = z
  .object({
    checkpoint_id: z.string().min(1),
    evaluated_at: IsoDateTimeSchema,
    evaluation_kind: z.literal(PILOT_RUBRIC_EVALUATION_KIND),
    evaluator: z.string().min(1),
    results: z.array(PilotRubricQueryResultSchema).min(1),
    rubric_id: z.string().min(1),
    schema_version: z.literal(1),
  })
  .strict();

export type PilotRubricEvaluation = z.infer<typeof PilotRubricEvaluationSchema>;

/**
 * Cross-validates one evaluation against its rubric: the evaluation must
 * reference the same rubric, an existing checkpoint, every query exactly
 * once with every criterion exactly once, and scores on the declared scale.
 * Returns human-readable issues; an empty list means the evaluation counts.
 */
export function validatePilotRubricEvaluation(
  rubric: PilotHumanRubric,
  evaluation: PilotRubricEvaluation,
): readonly string[] {
  const issues: string[] = [];
  if (evaluation.rubric_id !== rubric.rubric_id) {
    issues.push(
      `evaluation targets rubric ${evaluation.rubric_id} but the rubric is ${rubric.rubric_id}`,
    );
  }
  if (
    !rubric.checkpoints.some(
      (checkpoint) => checkpoint.id === evaluation.checkpoint_id,
    )
  ) {
    issues.push(`unknown checkpoint ${evaluation.checkpoint_id}`);
  }
  const validScores = new Set(rubric.scale.map((level) => level.score));
  const queriesById = new Map(rubric.queries.map((query) => [query.id, query]));
  const evaluatedQueryIds = new Set<string>();
  for (const result of evaluation.results) {
    if (evaluatedQueryIds.has(result.query_id)) {
      issues.push(`query ${result.query_id} is evaluated more than once`);
      continue;
    }
    evaluatedQueryIds.add(result.query_id);
    const query = queriesById.get(result.query_id);
    if (query === undefined) {
      issues.push(`unknown query ${result.query_id}`);
      continue;
    }
    if (!validScores.has(result.score)) {
      issues.push(
        `query ${result.query_id} has score ${String(result.score)} outside the rubric scale`,
      );
    }
    validateCriterionResults(query.id, query.criteria, result.criteria, issues);
  }
  for (const query of rubric.queries) {
    if (!evaluatedQueryIds.has(query.id)) {
      issues.push(`query ${query.id} was not evaluated`);
    }
  }
  return issues;
}

function validateCriterionResults(
  queryId: string,
  criteria: readonly { readonly id: string }[],
  results: readonly { readonly criterion_id: string }[],
  issues: string[],
): void {
  const expected = new Set(criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.criterion_id)) {
      issues.push(
        `query ${queryId} judges criterion ${result.criterion_id} more than once`,
      );
      continue;
    }
    seen.add(result.criterion_id);
    if (!expected.has(result.criterion_id)) {
      issues.push(
        `query ${queryId} judges unknown criterion ${result.criterion_id}`,
      );
    }
  }
  for (const criterionId of expected) {
    if (!seen.has(criterionId)) {
      issues.push(`query ${queryId} does not judge criterion ${criterionId}`);
    }
  }
}

function assertUniqueIds(
  ids: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate ${path} id ${id}`,
        path: [path, index, "id"],
      });
    }
    seen.add(id);
  }
}

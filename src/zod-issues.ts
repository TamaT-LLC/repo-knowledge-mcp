import type { z } from "zod";

export interface CustomIssue {
  readonly message: string;
  readonly path?: PropertyKey[];
}

/**
 * Adds a custom issue from a `.check()` callback.
 *
 * Fills in the fields that `.superRefine()`'s `addIssue` used to fill in:
 * the checked value as `input`, and `continue: true`. Without `continue`, the
 * issue would abort the remaining checks on this schema and on every schema
 * that contains it. `addIssue` also set `inst`, which Zod reads only to find
 * an error map for an issue without a message; every issue here has one.
 */
export function addCustomIssue(
  context: z.core.ParsePayload,
  issue: CustomIssue,
): void {
  context.issues.push({
    code: "custom",
    continue: true,
    input: context.value,
    message: issue.message,
    ...(issue.path === undefined ? {} : { path: issue.path }),
  });
}

/**
 * Reports each repeated ID as `duplicate <label> id <id>` at
 * `[field, index, "id"]`, where `index` is the repeat's position.
 *
 * A loop that checks other rules on the same entry keeps its own duplicate
 * check, so that its issues stay in the same order.
 */
export function addDuplicateIdIssues(
  context: z.core.ParsePayload,
  field: string,
  ids: readonly string[],
  label: string = field,
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      addCustomIssue(context, {
        message: `duplicate ${label} id ${id}`,
        path: [field, index, "id"],
      });
    }
    seen.add(id);
  }
}

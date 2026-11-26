import type { z } from "zod";

export interface CustomIssue {
  readonly message: string;
  readonly path?: PropertyKey[];
}

/**
 * Adds a custom issue from a `.check()` callback.
 *
 * Fills in the fields that `.superRefine()`'s `addIssue` used to fill in:
 * the checked value as `input`, and `continue: true` so later checks still run.
 * `addIssue` also set `inst`, which Zod reads only to find an error map for an
 * issue without a message; every issue here has one.
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

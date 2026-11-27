// Setup for `npm run test:compiled`: every schema marked with compileWhenHot
// is compiled on its first parse, so the whole suite runs the compiled path.
// Each call also runs the runtime parser and fails on any difference, so a
// compiled schema that disagrees is caught even where a test does not look at
// the result closely.
import { inspect, isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { enableCompileWhenHot } from "../../src/zod-compile-when-hot.js";

type SafeParseResult = ReturnType<z.ZodType["safeParse"]>;

/** What a caller can observe of one call: its value, or what it threw. */
function settle<T>(
  run: () => T,
): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** A ZodError compares by its issues; anything else as it is. */
function issuesOf(error: unknown): unknown {
  return error instanceof z.ZodError ? error.issues : error;
}

/**
 * Runs the compiled and the runtime call, fails if a caller could tell them
 * apart, and otherwise behaves like the compiled call.
 */
function agree<T>(
  method: string,
  data: unknown,
  compiled: () => T,
  runtime: () => T,
  view: (value: T) => unknown = (value) => value,
): T {
  const actual = settle(compiled);
  const expected = settle(runtime);
  const seen = (outcome: typeof actual) =>
    outcome.ok
      ? { ok: true, value: view(outcome.value) }
      : { ok: false, error: issuesOf(outcome.error) };
  if (!isDeepStrictEqual(seen(actual), seen(expected))) {
    throw new Error(
      `compiled ${method} disagrees with the runtime one for ${inspect(data)}`,
    );
  }
  if (actual.ok) return actual.value;
  throw actual.error;
}

const safeParseView = (result: SafeParseResult) =>
  result.success
    ? { success: true, data: result.data }
    : { success: false, issues: result.error.issues };

enableCompileWhenHot({
  afterUses: 0,
  compile(schema) {
    // compileWhenHot calls this while the schema still has its runtime methods.
    const runtime = {
      parse: schema.parse,
      safeParse: schema.safeParse,
      validate: schema.validate,
      standard: schema["~standard"],
    };
    // strict: a marked schema that Zod cannot compile fails here instead of
    // quietly keeping the runtime parser.
    const compiled = z.compile(schema, { strict: true });
    return {
      parse: (data, params) =>
        agree(
          "parse",
          data,
          () => compiled.parse(data, params),
          () => runtime.parse(data, params),
        ),
      safeParse: (data, params) =>
        agree(
          "safeParse",
          data,
          () => compiled.safeParse(data, params),
          () => runtime.safeParse(data, params),
          safeParseView,
        ),
      validate: ((data, params) =>
        agree(
          "validate",
          data,
          () => compiled.validate(data, params),
          () => runtime.validate(data, params),
        )) as z.ZodType["validate"],
      // What the MCP SDK calls; its error text is built from these issues.
      "~standard": {
        ...compiled["~standard"],
        validate: ((value, options) =>
          agree(
            "~standard.validate",
            value,
            () => compiled["~standard"].validate(value, options),
            () => runtime.standard.validate(value, options),
          )) as z.ZodType["~standard"]["validate"],
      },
    };
  },
});

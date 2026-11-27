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

type Parsers = Pick<z.ZodType, "parse" | "safeParse" | "validate"> & {
  readonly "~standard": Pick<z.ZodType["~standard"], "validate">;
};

enableCompileWhenHot({
  afterUses: 0,
  compile(schema, runtime) {
    // strict: a marked schema that Zod cannot compile fails here instead of
    // quietly keeping the runtime parser.
    const compiled: Parsers = z.compile(schema, { strict: true });
    /** One entry point, run on both parsers and compared. */
    const checked =
      <A extends [unknown, ...unknown[]], R>(
        method: string,
        pick: (parsers: Parsers) => (...args: A) => R,
        view?: (value: R) => unknown,
      ) =>
      (...args: A): R =>
        agree(
          method,
          args[0],
          () => pick(compiled)(...args),
          () => pick(runtime)(...args),
          view,
        );
    return {
      parse: checked("parse", (parsers) => parsers.parse),
      safeParse: checked(
        "safeParse",
        (parsers) => parsers.safeParse,
        safeParseView,
      ),
      validate: checked(
        "validate",
        (parsers) => parsers.validate,
      ) as z.ZodType["validate"],
      // What the MCP SDK calls; its error text is built from these issues.
      "~standard": {
        validate: checked(
          "~standard.validate",
          (parsers) => parsers["~standard"].validate,
        ),
      },
    };
  },
});

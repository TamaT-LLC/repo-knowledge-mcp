// Setup for `npm run test:compiled`: every schema marked with compileWhenHot
// is compiled on its first parse, so the whole suite runs the compiled path.
// Each call also runs the runtime parser and fails on any difference, so a
// compiled schema that disagrees is caught even where a test does not look at
// the result closely.
import { inspect, isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  enableCompileWhenHot,
  type Parsers,
} from "../../src/zod-compile-when-hot.js";

type SafeParseResult = ReturnType<z.ZodType["safeParse"]>;
const DEPTH = { depth: Number.POSITIVE_INFINITY };

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
  const seen = (outcome: typeof actual) => {
    // Two Promises compare equal below, so an async result is not compared.
    if (outcome.ok && outcome.value instanceof Promise) {
      throw new Error(`${method} returned a Promise for ${inspect(data)}`);
    }
    return outcome.ok
      ? { ok: true, value: view(outcome.value) }
      : { ok: false, error: issuesOf(outcome.error) };
  };
  const [a, b] = [seen(actual), seen(expected)];
  // isDeepStrictEqual ignores key order, which output serialised as JSON keeps.
  if (!isDeepStrictEqual(a, b) || inspect(a, DEPTH) !== inspect(b, DEPTH)) {
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
  compile(schema, runtime) {
    // strict: a marked schema that Zod cannot compile fails here instead of
    // quietly keeping the runtime parser.
    const compiled: Parsers = z.compile(schema, { strict: true });
    /** One entry point, run on both parsers and compared. */
    const checked =
      <A extends [unknown, ...unknown[]], R>(
        method: string,
        compiledCall: (...args: A) => R,
        runtimeCall: (...args: A) => R,
        view?: (value: R) => unknown,
      ) =>
      (...args: A): R =>
        agree(
          method,
          args[0],
          () => compiledCall(...args),
          () => runtimeCall(...args),
          view,
        );
    return {
      parse: checked("parse", compiled.parse, runtime.parse),
      safeParse: checked(
        "safeParse",
        compiled.safeParse,
        runtime.safeParse,
        safeParseView,
      ),
      validate: checked(
        "validate",
        compiled.validate,
        runtime.validate,
      ) as z.ZodType["validate"],
      // What the MCP SDK calls; its error text is built from these issues.
      "~standard": {
        validate: checked(
          "~standard.validate",
          compiled["~standard"].validate,
          runtime["~standard"].validate,
        ),
      },
    };
  },
});

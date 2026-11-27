import { z } from "zod";

/**
 * Uses of one schema (`parse`, `safeParse`, `validate` or
 * `~standard.validate`) after which it is compiled. Measured over this
 * repository's test inputs (with the inputs recorded through a wrapper, so the
 * figures are a guide rather than exact), compiling cost about 0.02–7 ms per
 * schema and later parses were roughly 1.5–18× faster; the break-even was
 * about 320 parses at the median and 490 at the 75th percentile. One threshold
 * for every schema bounds the loss to one compile, in a process that has
 * already parsed that schema this often.
 */
const DEFAULT_COMPILE_AFTER_USES = 500;

/**
 * The entry points a caller validates through: the three methods this code
 * calls, and `~standard`, which the MCP SDK calls for tool input and output.
 */
type StandardValidate = z.ZodType["~standard"]["validate"];
export interface Parsers
  extends Pick<z.ZodType, "parse" | "safeParse" | "validate"> {
  readonly "~standard": { readonly validate: StandardValidate };
}

interface CompileWhenHotOptions {
  readonly afterUses?: number;
  /**
   * Replaces `z.compile` in tests. `runtime` holds the schema's own parsers,
   * which the schema also has at the moment this is called.
   */
  readonly compile?: (schema: z.ZodType, runtime: Parsers) => Parsers;
}

const pending: z.ZodType[] = [];
const installed = new WeakSet<z.ZodType>();
let enabled: Required<CompileWhenHotOptions> | undefined;

/**
 * Marks a schema to be compiled once it is used often, which only takes
 * effect in a process that calls `enableCompileWhenHot`. A process that never
 * does (a library user, the default test run) keeps the runtime parser.
 * Returns the same schema.
 *
 * Mark a schema when both hold:
 * - It is validated on its own: this code calls its `parse`, `safeParse` or
 *   `validate`, directly or through a helper, or passes it to the MCP SDK as a
 *   tool's input or output schema. A schema reached only as part of another
 *   one needs no mark: compiling the parent compiles it too.
 * - Compiling it was measured to make it at least 1.5× faster, and a process
 *   can use it 500 times (not a dev tool or a setup step that parses a few
 *   times per run).
 *
 * A schema left unmarked on purpose says why where it is defined.
 */
export function compileWhenHot<T extends z.ZodType>(schema: T): T {
  if (enabled === undefined) pending.push(schema);
  else install(schema, enabled);
  return schema;
}

/** Turns on `compileWhenHot` for every marked schema; call it from an entry point. */
export function enableCompileWhenHot(
  options: CompileWhenHotOptions = {},
): void {
  enabled = {
    afterUses: options.afterUses ?? DEFAULT_COMPILE_AFTER_USES,
    compile: options.compile ?? ((schema) => z.compile(schema)),
  };
  for (const schema of pending.splice(0)) install(schema, enabled);
}

/**
 * Replaces the schema's own `parse`, `safeParse`, `validate` and
 * `~standard.validate` with versions that share one use count and, at the
 * threshold, hand over to a compiled copy. The schema object itself, its
 * metadata and its JSON Schema (including `~standard.jsonSchema`, which the
 * MCP SDK lists tools with) are unchanged.
 */
function install(
  schema: z.ZodType,
  { afterUses, compile }: Required<CompileWhenHotOptions>,
): void {
  if (installed.has(schema)) return;
  installed.add(schema);
  const target = schema as {
    -readonly [K in keyof z.ZodType]: z.ZodType[K];
  };
  const standard = schema["~standard"];
  const runtime: Parsers = {
    parse: schema.parse,
    safeParse: schema.safeParse,
    validate: schema.validate,
    "~standard": standard,
  };
  const use = (parsers: Parsers) => {
    target.parse = parsers.parse;
    target.safeParse = parsers.safeParse;
    target.validate = parsers.validate;
    // Only `validate` changes hands; vendor, version and jsonSchema stay the
    // original schema's, so the tool listing cannot change.
    target["~standard"] = {
      ...standard,
      validate: parsers["~standard"].validate,
    };
  };
  let uses = 0;
  let compiled: Parsers | undefined;
  const next = (): Parsers => {
    if (compiled !== undefined) return compiled;
    uses += 1;
    if (uses <= afterUses) return runtime;
    // The compiled copy falls back to the schema's current methods on invalid
    // input, so compile while those are still the runtime ones.
    use(runtime);
    compiled = compile(schema, runtime);
    use(compiled);
    return compiled;
  };
  use({
    parse: (data, params) => next().parse(data, params),
    safeParse: (data, params) => next().safeParse(data, params),
    validate: ((data, params) =>
      next().validate(data, params)) as Parsers["validate"],
    "~standard": {
      validate: ((value, options) =>
        next()["~standard"].validate(value, options)) as StandardValidate,
    },
  });
}

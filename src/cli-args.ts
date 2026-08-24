import {
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  KnowledgeStatusSchema,
  NonEmptyStringSchema,
  SeveritySchema,
  type KnowledgeRevisionPatch,
} from "./domain-schemas.js";
import {
  REPO_KNOWLEDGE_CLI_EXIT,
  RepoKnowledgeCliError,
} from "./cli-errors.js";
import type {
  CliRedistillRequest,
  CliRepositorySelection,
  ParsedCliCommand,
} from "./cli-types.js";
import { parseRepositoryName } from "./repository-resolver.js";
import { StatsBucketSchema } from "./stats-read-service.js";

export function parseRepoKnowledgeCliArguments(
  argv: readonly string[],
  stdinIsTTY: boolean,
): ParsedCliCommand {
  if (argv.length === 0) {
    return stdinIsTTY ? { kind: "help" } : { kind: "serve", selection: {} };
  }
  const name = argv[0]!;
  if (name === "help" || name === "--help" || name === "-h") {
    if (argv.length !== 1) throw usage("help does not accept arguments");
    return { kind: "help" };
  }
  if (name === "record_outcome") {
    throw unavailable(`${name} is deferred to a later milestone`);
  }
  if (argv.slice(1).includes("--help") || argv.slice(1).includes("-h")) {
    return { kind: "help" };
  }

  switch (name) {
    case "setup":
      return parseSetup(argv.slice(1));
    case "serve":
      return parseServe(argv.slice(1));
    case "sync":
      return parseSync(argv.slice(1));
    case "stats":
      return parseStats(argv.slice(1));
    case "doctor":
      return parseDoctor(argv.slice(1));
    case "ingest":
      return parseIngest(argv.slice(1));
    case "distill":
      return parseRepositoryOnly("distill", argv.slice(1));
    case "list":
      return parseList(argv.slice(1));
    case "review":
      return parseRepositoryOnly("review", argv.slice(1));
    case "reindex":
      return parseRepositoryOnly("reindex", argv.slice(1));
    case "redistill":
      return parseRedistill(argv.slice(1));
    case "reconcile":
      return parseReconcile(argv.slice(1));
    case "export":
      return parseExport(argv.slice(1));
    case "approve":
    case "reject":
      return parseAdminId(name, argv.slice(1));
    case "edit":
      return parseEdit(argv.slice(1));
    case "approve-revision":
      return parseApproveRevision(argv.slice(1));
    case "add":
      return parseAddActive(argv.slice(1));
    default:
      throw usage(`unknown command ${name}`);
  }
}

interface ParsedOptions {
  readonly booleans: ReadonlySet<string>;
  readonly positionals: readonly string[];
  readonly repeated: ReadonlyMap<string, readonly string[]>;
  readonly values: ReadonlyMap<string, string>;
}

interface OptionDefinition {
  readonly booleans?: readonly string[];
  readonly repeated?: readonly string[];
  readonly values?: readonly string[];
}

const REPOSITORY_OPTION_DEFINITION = {
  values: ["repo", "workspace"],
} as const;

function parseSetup(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    booleans: ["all-history", "json"],
    values: ["repo", "workspace", "since"],
  });
  assertPositionalCount(parsed, 0, 1, "setup");
  const positionalRepo = parsed.positionals[0];
  const optionRepo = parsed.values.get("repo");
  if (positionalRepo !== undefined && optionRepo !== undefined) {
    throw usage(
      "repository must not be supplied both positionally and by --repo",
    );
  }
  const since = parsed.values.get("since");
  if (since !== undefined && parsed.booleans.has("all-history")) {
    throw usage("setup accepts only one of --since or --all-history");
  }
  const repo = positionalRepo ?? optionRepo;
  const workspacePath = parsed.values.get("workspace");
  return {
    ...(parsed.booleans.has("json") ? { json: true as const } : {}),
    kind: "setup",
    request: {
      ...(parsed.booleans.has("all-history") ? { allHistory: true } : {}),
      ...(repo === undefined ? {} : { repo: parseCliRepository(repo) }),
      ...(since === undefined
        ? {}
        : { since: parseSchema(IsoDateTimeSchema, since, "since") }),
      ...(workspacePath === undefined
        ? {}
        : { workspacePath: parseNonEmpty(workspacePath, "workspace") }),
    },
  };
}

function parseServe(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 0, 0, "serve");
  return { kind: "serve", selection: selection(parsed) };
}

function parseSync(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    values: ["repo", "workspace", "since"],
  });
  assertPositionalCount(parsed, 0, 1, "sync");
  const since = parsed.values.get("since");
  return {
    kind: "sync",
    selection: selection(parsed, parsed.positionals[0]),
    ...(since === undefined
      ? {}
      : { since: parseSchema(IsoDateTimeSchema, since, "since") }),
  };
}

function parseStats(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    values: ["repo", "workspace", "bucket", "since", "until"],
  });
  assertPositionalCount(parsed, 0, 1, "stats");
  const bucket = parsed.values.get("bucket");
  const since = parsed.values.get("since");
  const until = parsed.values.get("until");
  return {
    kind: "stats",
    request: {
      ...(bucket === undefined
        ? {}
        : { bucket: parseSchema(StatsBucketSchema, bucket, "bucket") }),
      ...(since === undefined
        ? {}
        : { since: parseSchema(IsoDateTimeSchema, since, "since") }),
      ...(until === undefined
        ? {}
        : { until: parseSchema(IsoDateTimeSchema, until, "until") }),
    },
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseDoctor(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 0, 1, "doctor");
  return {
    kind: "doctor",
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseIngest(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 1, 2, "ingest");
  const positionalRepo =
    parsed.positionals.length === 2 ? parsed.positionals[0] : undefined;
  const pr = parsed.positionals.at(-1)!;
  if (!/^[1-9][0-9]*$/u.test(pr)) {
    throw usage("ingest PR number must be a positive integer");
  }
  const prNumber = Number(pr);
  if (!Number.isSafeInteger(prNumber)) {
    throw usage("ingest PR number exceeds the safe integer range");
  }
  return {
    kind: "ingest",
    prNumber,
    selection: selection(parsed, positionalRepo),
  };
}

function parseRepositoryOnly(
  kind: "distill" | "reindex" | "review",
  args: readonly string[],
): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 0, 1, kind);
  return {
    kind,
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseList(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    values: ["repo", "workspace", "status"],
  });
  assertPositionalCount(parsed, 0, 1, "list");
  const rawStatus = parsed.values.get("status");
  return {
    kind: "list",
    selection: selection(parsed, parsed.positionals[0]),
    ...(rawStatus === undefined
      ? {}
      : { status: parseSchema(KnowledgeStatusSchema, rawStatus, "status") }),
  };
}

function parseRedistill(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    booleans: ["all", "failed", "outdated"],
    values: ["repo", "workspace", "author", "prompt-version"],
  });
  assertPositionalCount(parsed, 0, 1, "redistill");
  const selectors = [
    parsed.booleans.has("all"),
    parsed.values.has("author"),
    parsed.values.has("prompt-version"),
    parsed.booleans.has("failed"),
    parsed.booleans.has("outdated"),
  ].filter(Boolean).length;
  if (selectors !== 1) {
    throw usage(
      "redistill requires exactly one of --all, --author, --prompt-version, --failed, or --outdated",
    );
  }
  let request: CliRedistillRequest;
  if (parsed.booleans.has("all")) {
    request = { selector: "all" };
  } else if (parsed.booleans.has("failed")) {
    request = { selector: "failed" };
  } else if (parsed.booleans.has("outdated")) {
    request = { selector: "outdated" };
  } else if (parsed.values.has("author")) {
    request = {
      author: parseNonEmpty(parsed.values.get("author")!, "author"),
      selector: "author",
    };
  } else {
    request = {
      prompt_version: parseNonEmpty(
        parsed.values.get("prompt-version")!,
        "prompt-version",
      ),
      selector: "prompt-version",
    };
  }
  return {
    kind: "redistill",
    request,
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseReconcile(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    booleans: ["write-derived-metadata"],
    values: ["repo", "workspace"],
  });
  assertPositionalCount(parsed, 0, 1, "reconcile");
  if (!parsed.booleans.has("write-derived-metadata")) {
    throw usage("reconcile requires --write-derived-metadata");
  }
  return {
    kind: "reconcile",
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseExport(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    booleans: ["bootstrap"],
    values: ["repo", "workspace"],
  });
  assertPositionalCount(parsed, 0, 1, "export");
  if (!parsed.booleans.has("bootstrap")) {
    throw usage("export requires --bootstrap in M1");
  }
  return {
    kind: "export-bootstrap",
    selection: selection(parsed, parsed.positionals[0]),
  };
}

function parseAdminId(
  kind: "approve" | "reject",
  args: readonly string[],
): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 1, 1, kind);
  return {
    id: parseSchema(KnowledgeIdSchema, parsed.positionals[0], "knowledge ID"),
    kind,
    selection: selection(parsed),
  };
}

function parseApproveRevision(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, REPOSITORY_OPTION_DEFINITION);
  assertPositionalCount(parsed, 1, 1, "approve-revision");
  return {
    kind: "approve-revision",
    proposalId: parseNonEmpty(parsed.positionals[0]!, "proposal ID"),
    selection: selection(parsed),
  };
}

function parseEdit(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    repeated: ["scope"],
    values: ["repo", "workspace", "category", "detail", "rule", "severity"],
  });
  assertPositionalCount(parsed, 1, 1, "edit");
  const patch: Record<string, unknown> = {};
  setParsedPatchValue(
    patch,
    "category",
    parsed.values.get("category"),
    KnowledgeCategorySchema,
  );
  setParsedPatchValue(
    patch,
    "detail",
    parsed.values.get("detail"),
    NonEmptyStringSchema,
  );
  setParsedPatchValue(
    patch,
    "rule",
    parsed.values.get("rule"),
    NonEmptyStringSchema,
  );
  setParsedPatchValue(
    patch,
    "severity",
    parsed.values.get("severity"),
    SeveritySchema,
  );
  const scopes = parsed.repeated.get("scope");
  if (scopes !== undefined) patch.scope = scopes;
  if (Object.keys(patch).length === 0) {
    throw usage("edit requires at least one patch option");
  }
  return {
    id: parseSchema(KnowledgeIdSchema, parsed.positionals[0], "knowledge ID"),
    kind: "edit",
    patch: patch as KnowledgeRevisionPatch,
    selection: selection(parsed),
  };
}

function parseAddActive(args: readonly string[]): ParsedCliCommand {
  const parsed = parseOptions(args, {
    booleans: ["active"],
    repeated: ["scope", "related-id"],
    values: ["repo", "workspace", "category", "detail", "rule", "severity"],
  });
  assertPositionalCount(parsed, 0, 0, "add");
  if (!parsed.booleans.has("active")) {
    throw usage("M1 admin add requires --active");
  }
  const required = (name: string): string => {
    const value = parsed.values.get(name);
    if (value === undefined) throw usage(`add --active requires --${name}`);
    return value;
  };
  return {
    input: {
      category: parseSchema(
        KnowledgeCategorySchema,
        required("category"),
        "category",
      ),
      detail: parseNonEmpty(required("detail"), "detail"),
      ...(parsed.repeated.has("related-id")
        ? {
            related_ids: parsed.repeated
              .get("related-id")!
              .map((id) => parseSchema(KnowledgeIdSchema, id, "related-id")),
          }
        : {}),
      rule: parseNonEmpty(required("rule"), "rule"),
      scope: parsed.repeated.get("scope") ?? [],
      severity: parseSchema(SeveritySchema, required("severity"), "severity"),
    },
    kind: "add-active",
    selection: selection(parsed),
  };
}

function parseOptions(
  args: readonly string[],
  definition: OptionDefinition,
): ParsedOptions {
  const allowedBooleans = new Set(definition.booleans ?? []);
  const allowedRepeated = new Set(definition.repeated ?? []);
  const allowedValues = new Set(definition.values ?? []);
  const booleans = new Set<string>();
  const repeated = new Map<string, string[]>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !token.startsWith("--")) {
      if (token.startsWith("-") && !positionalOnly) {
        throw usage(`unsupported short option ${token}`);
      }
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    const name = token.slice(2, equal < 0 ? undefined : equal);
    if (name.length === 0) throw usage("empty option name");
    if (allowedBooleans.has(name)) {
      if (equal >= 0) throw usage(`--${name} does not accept a value`);
      if (booleans.has(name)) throw usage(`--${name} was repeated`);
      booleans.add(name);
      continue;
    }
    if (!allowedValues.has(name) && !allowedRepeated.has(name)) {
      throw usage(`unknown option --${name}`);
    }
    const value =
      equal >= 0
        ? token.slice(equal + 1)
        : requireOptionValue(args, ++index, name);
    if (value.length === 0) throw usage(`--${name} requires a value`);
    if (allowedRepeated.has(name)) {
      const existing = repeated.get(name) ?? [];
      existing.push(value);
      repeated.set(name, existing);
      continue;
    }
    if (values.has(name)) throw usage(`--${name} was repeated`);
    values.set(name, value);
  }
  return { booleans, positionals, repeated, values };
}

function requireOptionValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw usage(`--${name} requires a value`);
  }
  return value;
}

function selection(
  parsed: Pick<ParsedOptions, "values">,
  positionalRepo?: string,
): CliRepositorySelection {
  const optionRepo = parsed.values.get("repo");
  const workspace = parsed.values.get("workspace");
  if (positionalRepo !== undefined && optionRepo !== undefined) {
    throw usage(
      "repository must not be supplied both positionally and by --repo",
    );
  }
  if ((positionalRepo !== undefined || optionRepo !== undefined) && workspace) {
    throw usage("--workspace cannot be combined with a repository selector");
  }
  const repo = positionalRepo ?? optionRepo;
  return {
    ...(repo === undefined ? {} : { repo: parseCliRepository(repo) }),
    ...(workspace === undefined
      ? {}
      : { workspacePath: parseNonEmpty(workspace, "workspace") }),
  };
}

function parseCliRepository(value: string): string {
  try {
    return parseRepositoryName(value);
  } catch (error) {
    throw usage("repository must use strict owner/name form", error);
  }
}

function assertPositionalCount(
  parsed: ParsedOptions,
  minimum: number,
  maximum: number,
  command: string,
): void {
  if (
    parsed.positionals.length < minimum ||
    parsed.positionals.length > maximum
  ) {
    const expectation =
      minimum === maximum
        ? String(minimum)
        : `${String(minimum)}-${String(maximum)}`;
    throw usage(`${command} expects ${expectation} positional argument(s)`);
  }
}

function parseNonEmpty(value: string, field: string): string {
  return parseSchema(NonEmptyStringSchema, value, field);
}

function parseSchema<T>(
  schema: {
    safeParse(value: unknown): { data?: T; error?: Error; success: boolean };
  },
  value: unknown,
  field: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw usage(`${field} is invalid`, parsed.error);
  }
  return parsed.data as T;
}

function setParsedPatchValue<T>(
  patch: Record<string, unknown>,
  name: string,
  value: string | undefined,
  schema: {
    safeParse(value: unknown): { data?: T; error?: Error; success: boolean };
  },
): void {
  if (value !== undefined) patch[name] = parseSchema(schema, value, name);
}

function usage(message: string, cause?: unknown): RepoKnowledgeCliError {
  return new RepoKnowledgeCliError(
    "CLI_ARGUMENT_INVALID",
    message,
    REPO_KNOWLEDGE_CLI_EXIT.usage,
    cause === undefined ? undefined : { cause },
  );
}

function unavailable(message: string): RepoKnowledgeCliError {
  return new RepoKnowledgeCliError(
    "CLI_COMMAND_UNAVAILABLE",
    message,
    REPO_KNOWLEDGE_CLI_EXIT.usage,
  );
}

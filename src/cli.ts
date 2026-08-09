import {
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  KnowledgeIdSchema,
  KnowledgeStatusSchema,
  NonEmptyStringSchema,
  SeveritySchema,
  type KnowledgeRevisionPatch,
  type KnowledgeStatus,
} from "./domain-schemas.js";
import type { AdminPlaneService } from "./admin-plane-service.js";
import type { RepoKnowledgeDoctorLike } from "./doctor-service.js";
import type {
  KnowledgeMutationServiceResolutionInput,
  KnowledgeMutationServiceResolver,
} from "./mcp-mutation-tools.js";
import { REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION } from "./mcp-server.js";
import { parseRepositoryName } from "./repository-resolver.js";
import {
  StatsBucketSchema,
  StatsReadError,
  type RepositoryStats,
  type RepositoryStatsRequest,
  type StatsReadErrorCode,
} from "./stats-read-service.js";
import type { SyncRepoSummary } from "./sync-repo-service.js";
import type {
  GuidedSetupPrompt,
  GuidedSetupRequest,
  GuidedSetupResult,
  SetupConfirmationRequest,
  SetupTextInputRequest,
} from "./setup-service.js";

export const REPO_KNOWLEDGE_CLI_HELP = `Usage: repo-knowledge <command> [options]

Commands:
  serve                         Start the MCP stdio server
  setup [repo] [--since <iso> | --all-history]
                                Configure private storage, repository, privacy,
                                trust candidates, and the initial sync
  sync [repo] [--since <iso>]   Incrementally sync updated pull requests
  stats [repo] [--bucket <mode>] [--since <iso>] [--until <iso>]
                                Print versioned machine-readable repository
                                aggregates as one JSON document on stdout
  ingest [repo] <pr>            Ingest one complete pull-request snapshot
  distill [repo]                Consume provider-enabled pending jobs
  list [repo] [--status value]  List canonical knowledge
  reindex [repo]                Rebuild index.sqlite from canonical files
  redistill [repo] <selector>   Queue canonical review threads again
  reconcile [repo] --write-derived-metadata
                                Write an explicit derived metadata snapshot
  export [repo] --bootstrap     Print the one-line MCP bootstrap instruction
  approve <id>                  Approve proposed or stale knowledge (TTY only)
  reject <id>                   Reject proposed or stale knowledge (TTY only)
  edit <id> <patch options>     Edit canonical knowledge (TTY only)
  approve-revision <id>         Apply a pending revision proposal (TTY only)
  add --active <fields>         Add active manual knowledge (TTY only)
  doctor [repo]                 Diagnose installation and canonical state

Repository selection:
  --repo <owner/name>           Select a GitHub repository
  --workspace <path>            Select an allowed mapped workspace

Redistill selectors (choose exactly one):
  --all | --author <login> | --prompt-version <version> | --failed |
  --outdated                    Queue only threads whose current prompt,
                                output schema, or trust policy digest has no
                                distill job yet; existing jobs are never reset

Sync options:
  --since <iso-datetime>        Initial boundary for a first sync; with a stored
                                checkpoint it must be strictly older than the
                                checkpoint boundary

Setup options:
  --workspace <path>            Resolve and register the workspace Git remote
  --since <iso-datetime>        Override the default 90-day initial window
  --all-history                 Sync all accessible pull-request history

Sync exits 0 when every discovered pull request synced, 1 on any failure,
and 2 on usage errors, so cron can alert on non-zero exits.

Stats options:
  --bucket <total|day>          Aggregation mode; "total" (default) returns one
                                aggregate, "day" returns zero-filled UTC day
                                buckets and requires --since and --until
  --since <iso-datetime>        Inclusive window start (ISO 8601 with offset)
  --until <iso-datetime>        Exclusive window end (ISO 8601 with offset)

Stats exits 0 on success (including zero stats for an empty repository),
1 on read failures, and 2 on usage errors including invalid windows.

record_outcome remains deferred to a later milestone.
`;

export const REPO_KNOWLEDGE_CLI_EXIT = Object.freeze({
  failure: 1,
  success: 0,
  usage: 2,
});

export interface RepoKnowledgeCliIo {
  confirm?(request: SetupConfirmationRequest): Promise<boolean>;
  input?(request: SetupTextInputRequest): Promise<string>;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  writeStderr(value: string): void;
  writeStdout(value: string): void;
}

export interface RepoKnowledgeServeRequest {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export interface CliDistillResult {
  readonly distilled: number;
  readonly pending: number;
  readonly reason?: string;
}

export interface CliKnowledgeSummary {
  readonly applied_count: number;
  readonly evidence_count: number;
  readonly id: string;
  readonly revision: number;
  readonly rule: string;
  readonly severity: string;
  readonly status: KnowledgeStatus;
  readonly violation_count: number;
}

export interface CliListKnowledgeRequest {
  readonly status?: KnowledgeStatus;
}

export interface CliListKnowledgeResult {
  readonly knowledge: readonly CliKnowledgeSummary[];
  readonly repo: string;
  readonly revision_proposals: readonly {
    readonly knowledge_id: string;
    readonly proposal_id: string;
    readonly updated_at: string;
  }[];
}

export interface CliReindexResult {
  readonly evidence: number;
  readonly jobs: number;
  readonly knowledge: number;
  readonly repo: string;
  readonly submissions: number;
}

export type CliRedistillRequest =
  | { readonly selector: "all" }
  | { readonly author: string; readonly selector: "author" }
  | { readonly selector: "failed" }
  | { readonly selector: "outdated" }
  | { readonly prompt_version: string; readonly selector: "prompt-version" };

export interface CliRedistillResult {
  readonly created_jobs: number;
  readonly reclassified_comments: number;
  readonly reset_jobs: number;
  readonly selected_threads: number;
  readonly unchanged: number;
}

export interface CliReconcileResult {
  readonly repo: string;
  readonly transaction_id: string | null;
  readonly unchanged: number;
  readonly written: number;
}

export interface CliAdminOperations {
  addActive: AdminPlaneService["addActive"];
  approve: AdminPlaneService["approve"];
  approveRevision: AdminPlaneService["approveRevision"];
  edit: AdminPlaneService["edit"];
  reject: AdminPlaneService["reject"];
}

export interface CliRepositoryOperations {
  readonly admin: CliAdminOperations;
  distill(): Promise<CliDistillResult>;
  listKnowledge(
    request?: CliListKnowledgeRequest,
  ): Promise<CliListKnowledgeResult>;
  reconcileDerivedMetadata(): Promise<CliReconcileResult>;
  redistill(request: CliRedistillRequest): Promise<CliRedistillResult>;
  reindex(): Promise<CliReindexResult>;
  /** Versioned read-only aggregation; canonical data is never modified. */
  stats(request?: RepositoryStatsRequest): Promise<RepositoryStats>;
}

export interface CliRepositoryOperationsResolver {
  resolve(
    input: KnowledgeMutationServiceResolutionInput,
  ): Promise<CliRepositoryOperations>;
}

export interface RunRepoKnowledgeCliOptions {
  readonly argv: readonly string[];
  readonly doctor: RepoKnowledgeDoctorLike;
  readonly io: RepoKnowledgeCliIo;
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly operationsResolver: CliRepositoryOperationsResolver;
  serve(request: RepoKnowledgeServeRequest): Promise<void> | void;
  setup(
    request: GuidedSetupRequest,
    prompt: GuidedSetupPrompt,
  ): Promise<GuidedSetupResult>;
}

export type ParsedCliCommand =
  | { readonly kind: "help" }
  | {
      readonly kind: "setup";
      readonly request: GuidedSetupRequest;
    }
  | {
      readonly kind: "doctor";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "serve";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "sync";
      readonly selection: CliRepositorySelection;
      readonly since?: string;
    }
  | {
      readonly kind: "stats";
      readonly request: RepositoryStatsRequest;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "ingest";
      readonly prNumber: number;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "distill";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "list";
      readonly selection: CliRepositorySelection;
      readonly status?: KnowledgeStatus;
    }
  | {
      readonly kind: "reindex";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "redistill";
      readonly request: CliRedistillRequest;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "reconcile";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "export-bootstrap";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly id: string;
      readonly kind: "approve" | "reject";
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly id: string;
      readonly kind: "edit";
      readonly patch: KnowledgeRevisionPatch;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly kind: "approve-revision";
      readonly proposalId: string;
      readonly selection: CliRepositorySelection;
    }
  | {
      readonly input: Parameters<AdminPlaneService["addActive"]>[0];
      readonly kind: "add-active";
      readonly selection: CliRepositorySelection;
    };

export interface CliRepositorySelection {
  readonly repo?: string;
  readonly workspacePath?: string;
}

export type RepoKnowledgeCliErrorCode =
  "CLI_ARGUMENT_INVALID" | "CLI_COMMAND_UNAVAILABLE" | "CLI_TTY_REQUIRED";

export class RepoKnowledgeCliError extends Error {
  constructor(
    readonly code: RepoKnowledgeCliErrorCode,
    message: string,
    readonly exitCode: number = REPO_KNOWLEDGE_CLI_EXIT.usage,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RepoKnowledgeCliError";
  }
}

export async function runRepoKnowledgeCli(
  options: RunRepoKnowledgeCliOptions,
): Promise<number> {
  try {
    const command = parseRepoKnowledgeCliArguments(
      options.argv,
      options.io.stdinIsTTY,
    );
    return (
      (await executeCliCommand(command, options)) ??
      REPO_KNOWLEDGE_CLI_EXIT.success
    );
  } catch (error) {
    const diagnostic = cliDiagnostic(error);
    options.io.writeStderr(`${diagnostic.code}: ${diagnostic.message}\n`);
    return diagnostic.exitCode;
  }
}

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

async function executeCliCommand(
  command: ParsedCliCommand,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | void> {
  switch (command.kind) {
    case "help":
      options.io.writeStdout(REPO_KNOWLEDGE_CLI_HELP);
      return;
    case "serve":
      await options.serve({
        ...(command.selection.repo === undefined
          ? {}
          : { startupRepo: command.selection.repo }),
        ...(command.selection.workspacePath === undefined
          ? {}
          : { startupWorkspace: command.selection.workspacePath }),
      });
      return;
    case "setup": {
      if (
        !options.io.stdinIsTTY ||
        !options.io.stdoutIsTTY ||
        options.io.confirm === undefined ||
        options.io.input === undefined
      ) {
        throw new RepoKnowledgeCliError(
          "CLI_TTY_REQUIRED",
          "setup requires real TTY stdin and stdout",
          REPO_KNOWLEDGE_CLI_EXIT.failure,
        );
      }
      writeJson(
        options.io,
        await options.setup(command.request, {
          confirm: (request) => options.io.confirm!(request),
          input: (request) => options.io.input!(request),
        }),
      );
      return;
    }
    case "sync": {
      const service = await options.mutationServiceResolver.resolve(
        command.selection,
      );
      const summary = await service.syncRepo(
        command.since === undefined ? {} : { since: command.since },
      );
      writeJson(options.io, summary);
      if (summary.failed === 0) return;
      // Machine-readable summary stays on stdout; the operator diagnostic and
      // the non-zero exit code make partial failures visible to cron.
      options.io.writeStderr(syncFailureDiagnostic(summary));
      return REPO_KNOWLEDGE_CLI_EXIT.failure;
    }
    case "stats": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(options.io, await service.stats(command.request));
      return;
    }
    case "doctor": {
      const result = await options.doctor.run(command.selection);
      writeJson(options.io, result);
      return result.ok
        ? REPO_KNOWLEDGE_CLI_EXIT.success
        : REPO_KNOWLEDGE_CLI_EXIT.failure;
    }
    case "ingest": {
      const service = await options.mutationServiceResolver.resolve(
        command.selection,
      );
      writeJson(
        options.io,
        await service.ingestPullRequest({ pr_number: command.prNumber }),
      );
      return;
    }
    case "distill": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(options.io, await service.distill());
      return;
    }
    case "list": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(
        options.io,
        await service.listKnowledge(
          command.status === undefined ? {} : { status: command.status },
        ),
      );
      return;
    }
    case "reindex": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(options.io, await service.reindex());
      return;
    }
    case "redistill": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(options.io, await service.redistill(command.request));
      return;
    }
    case "reconcile": {
      const service = await options.operationsResolver.resolve(
        command.selection,
      );
      writeJson(options.io, await service.reconcileDerivedMetadata());
      return;
    }
    case "export-bootstrap":
      options.io.writeStdout(`${REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION}\n`);
      return;
    case "approve":
    case "reject":
    case "edit":
    case "approve-revision":
    case "add-active":
      await executeAdminCommand(command, options);
      return;
  }
}

async function executeAdminCommand(
  command: Extract<
    ParsedCliCommand,
    {
      readonly kind:
        "add-active" | "approve" | "approve-revision" | "edit" | "reject";
    }
  >,
  options: RunRepoKnowledgeCliOptions,
): Promise<void> {
  if (!options.io.stdinIsTTY || !options.io.stdoutIsTTY) {
    throw new RepoKnowledgeCliError(
      "CLI_TTY_REQUIRED",
      "admin commands require real TTY stdin and stdout",
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );
  }
  const service = await options.operationsResolver.resolve(command.selection);
  switch (command.kind) {
    case "approve":
      writeJson(options.io, await service.admin.approve(command.id));
      return;
    case "reject":
      writeJson(options.io, await service.admin.reject(command.id));
      return;
    case "edit":
      writeJson(
        options.io,
        await service.admin.edit(command.id, command.patch),
      );
      return;
    case "approve-revision":
      writeJson(
        options.io,
        await service.admin.approveRevision(command.proposalId),
      );
      return;
    case "add-active":
      writeJson(options.io, await service.admin.addActive(command.input));
      return;
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
    booleans: ["all-history"],
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
  kind: "distill" | "reindex",
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

function writeJson(io: RepoKnowledgeCliIo, value: unknown): void {
  io.writeStdout(`${JSON.stringify(value)}\n`);
}

/**
 * Operator diagnostic for a partially failed sync run. The checkpoint stops
 * at the last contiguous success, so a plain re-run retries the failed pull
 * request before anything newer.
 */
function syncFailureDiagnostic(summary: SyncRepoSummary): string {
  const first = summary.failures[0];
  const firstFailure =
    first === undefined
      ? ""
      : ` First failure: PR #${String(first.pr_number)}: ${safeDiagnosticMessage(first.message)}.`;
  return (
    `SYNC_PARTIAL_FAILURE: ${String(summary.failed)} of ${String(summary.discovered)} ` +
    "discovered pull request(s) failed; the checkpoint stays at the last contiguous " +
    `success, so re-running sync retries the failed pull request first.${firstFailure}\n`
  );
}

/**
 * Window-shaped stats rejections are operator argument mistakes, so they exit
 * with the usage code; canonical or checkpoint failures stay read failures.
 */
const STATS_USAGE_ERROR_CODES: ReadonlySet<StatsReadErrorCode> = new Set([
  "INVALID_STATS_REQUEST",
  "INVALID_STATS_WINDOW",
  "STATS_WINDOW_REQUIRED",
  "STATS_WINDOW_TOO_LARGE",
]);

function cliDiagnostic(error: unknown): {
  readonly code: string;
  readonly exitCode: number;
  readonly message: string;
} {
  if (error instanceof RepoKnowledgeCliError) {
    return {
      code: error.code,
      exitCode: error.exitCode,
      message: safeDiagnosticMessage(error.message.replace(/^.*?:\s*/u, "")),
    };
  }
  if (error instanceof StatsReadError) {
    return {
      code: error.code,
      exitCode: STATS_USAGE_ERROR_CODES.has(error.code)
        ? REPO_KNOWLEDGE_CLI_EXIT.usage
        : REPO_KNOWLEDGE_CLI_EXIT.failure,
      message: safeDiagnosticMessage(error.message.replace(/^.*?:\s*/u, "")),
    };
  }
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
      ? error.code
      : "CLI_OPERATION_FAILED";
  return {
    code,
    exitCode: REPO_KNOWLEDGE_CLI_EXIT.failure,
    message: safeDiagnosticMessage(
      error instanceof Error ? error.message : "CLI operation failed",
    ),
  };
}

function safeDiagnosticMessage(value: string): string {
  const flattened = value.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
  return flattened.slice(0, 4_096) || "operation failed";
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

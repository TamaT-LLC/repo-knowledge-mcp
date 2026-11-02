import type { TerminalActivityUpdate } from "./terminal-progress.js";
import type { GuidedSetupPrompt } from "./setup-service.js";
import { parseRepoKnowledgeCliArguments } from "./cli-args.js";
import {
  cliDiagnostic,
  runCliActivity,
  safeDiagnosticMessage,
  syncFailureDiagnostic,
} from "./cli-diagnostics.js";
import {
  REPO_KNOWLEDGE_CLI_EXIT,
  RepoKnowledgeCliError,
} from "./cli-errors.js";
import { renderGuidedSetupSummary } from "./cli-render.js";
import {
  assertReviewTerminal,
  executeReviewSession,
} from "./cli-review-session.js";
import type {
  ParsedCliCommand,
  RepoKnowledgeCliIo,
  RunRepoKnowledgeCliOptions,
} from "./cli-types.js";
import { REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION } from "./mcp-server.js";
import { SyncRepoError } from "./sync-repo-service.js";
import type { SyncScheduleSpec } from "./sync-schedule.js";

export { parseRepoKnowledgeCliArguments } from "./cli-args.js";
export {
  REPO_KNOWLEDGE_CLI_EXIT,
  RepoKnowledgeCliError,
  type RepoKnowledgeCliErrorCode,
} from "./cli-errors.js";
export type {
  CliAdminOperations,
  CliDistillResult,
  CliKnowledgeSummary,
  CliListKnowledgeRequest,
  CliListKnowledgeResult,
  CliReconcileResult,
  CliRedistillRequest,
  CliRedistillResult,
  CliReindexResult,
  CliRepositoryOperations,
  CliRepositoryOperationsResolver,
  CliRepositorySelection,
  ParsedCliCommand,
  RepoKnowledgeCliIo,
  RepoKnowledgeServeRequest,
  RunRepoKnowledgeCliOptions,
} from "./cli-types.js";

export const REPO_KNOWLEDGE_CLI_HELP = `Usage: repo-knowledge <command> [options]

Commands:
  serve                         Start the MCP stdio server
  setup [repo] [--json] [--since <iso> | --all-history]
                                Configure private storage, repository, privacy,
                                trust candidates, and the initial sync
  sync [repo] [--since <iso>] [--max-prs <n>]
                                Incrementally sync updated pull requests
  schedule install <repo> [--interval <minutes>] [--max-prs <n>] [--dry-run]
                                Run sync for a repository on an OS schedule
                                (launchd on macOS; prints a crontab line on
                                Linux and never edits the crontab)
  schedule uninstall <repo> [--dry-run]
                                Remove the repository's sync schedule
  schedule status [repo]        List installed sync schedules as JSON
  schedule print <repo> [--format launchd|cron] [--interval <minutes>]
                     [--max-prs <n>]
                                Print the launchd plist or crontab line only
  stats [repo] [--bucket <mode>] [--since <iso>] [--until <iso>]
                                Print versioned machine-readable repository
                                aggregates as one JSON document on stdout
  ingest [repo] <pr>            Ingest one complete pull-request snapshot
  distill [repo]                Consume provider-enabled pending jobs
  list [repo] [--status value]  List canonical knowledge
  review [repo]                 Review pending candidates in one TTY session
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
  --max-prs <n>                 Process at most n pull requests (oldest first);
                                rerun while the summary reports has_more

Setup options:
  --workspace <path>            Resolve and register the workspace Git remote
  --since <iso-datetime>        Override the default 90-day initial window
  --all-history                 Sync all accessible pull-request history
  --json                        Print the setup result as one JSON document;
                                progress remains disabled for machine use

Sync exits 0 when every discovered pull request synced, 1 on any failure,
2 on usage errors, and 75 when another sync of the same repository is
already running (nothing changed; the next scheduled run continues).

Schedule options:
  --interval <minutes>          Minutes between runs (default 60, 5-1440);
                                cron accepts only divisors of 60 minutes or
                                whole hours dividing 24
  --max-prs <n>                 Bound each scheduled run (see sync)
  --dry-run                     Show what install/uninstall would do without
                                writing files or calling launchctl

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

/** Parses a CLI invocation, reports diagnostics, and closes its output resources. */
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
  } finally {
    options.io.close?.();
  }
}

/** Dispatches parsed commands, initializing storage only for commands that need it. */
async function executeCliCommand(
  command: ParsedCliCommand,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
  switch (command.kind) {
    case "help":
      options.io.writeStdout(REPO_KNOWLEDGE_CLI_HELP);
      return;
    case "serve":
      return executeServeCommand(command, options);
    case "setup":
      return executeSetupCommand(command, options);
    case "sync":
      return executeSyncCommand(command, options);
    case "schedule":
      return executeScheduleCommand(command, options);

    case "stats":
    case "distill":
    case "list":
    case "reindex":
    case "redistill":
    case "reconcile":
      return executeRepositoryCommand(command, options);
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

    case "review": {
      assertReviewTerminal(options.io);
      const service = await runCliActivity(
        options.io,
        "review.open",
        "Opening the review inbox",
        () => options.operationsResolver.resolve(command.selection),
      );
      return executeReviewSession(service, options.io);
    }

    case "export-bootstrap": {
      const { repo, workspacePath } = command.selection;
      const selection =
        repo !== undefined
          ? { repo }
          : workspacePath !== undefined
            ? { workspace_path: workspacePath }
            : undefined;
      const instruction =
        selection === undefined
          ? REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION
          : `Before modifying code, call the repo-knowledge MCP \`get_rules\` tool with ${JSON.stringify(selection)} and the files you expect to change.`;
      options.io.writeStdout(`${instruction}\n`);
      return;
    }
    default:
      await executeAdminCommand(command, options);
      return;
  }
}

/** Resolves a selected repository and dispatches its read or maintenance command. */
async function executeRepositoryCommand(
  command: Extract<
    ParsedCliCommand,
    {
      readonly kind:
        | "stats"
        | "distill"
        | "list"
        | "reindex"
        | "redistill"
        | "reconcile";
    }
  >,
  options: RunRepoKnowledgeCliOptions,
): Promise<undefined> {
  const service = await options.operationsResolver.resolve(command.selection);
  switch (command.kind) {
    case "stats":
      writeJson(options.io, await service.stats(command.request));
      return;
    case "distill":
      writeJson(options.io, await service.distill());
      return;
    case "list":
      writeJson(
        options.io,
        await service.listKnowledge(
          command.status === undefined ? {} : { status: command.status },
        ),
      );
      return;
    case "reindex":
      writeJson(options.io, await service.reindex());
      return;
    case "redistill":
      writeJson(options.io, await service.redistill(command.request));
      return;
    case "reconcile":
      writeJson(options.io, await service.reconcileDerivedMetadata());
      return;
  }
}

/** Starts the MCP server with the explicit repository or workspace selection. */
async function executeServeCommand(
  command: Extract<ParsedCliCommand, { readonly kind: "serve" }>,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
  await options.serve({
    ...(command.selection.repo === undefined
      ? {}
      : { startupRepo: command.selection.repo }),
    ...(command.selection.workspacePath === undefined
      ? {}
      : { startupWorkspace: command.selection.workspacePath }),
  });
  return;
}

/** Runs interactive setup, keeping privacy notices on stderr and JSON results on stdout. */
async function executeSetupCommand(
  command: Extract<ParsedCliCommand, { readonly kind: "setup" }>,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
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
  const prompt: GuidedSetupPrompt = {
    confirm: (request) => options.io.confirm!(request),
    input: (request) => options.io.input!(request),
    notice: (message) => options.io.writeStderr(`${message}\n`),
    ...(command.json !== true && options.io.activity !== undefined
      ? {
          progress: (update: TerminalActivityUpdate) =>
            options.io.activity!(update),
        }
      : {}),
  };
  const result = await options.setup(command.request, prompt);
  if (command.json) {
    writeJson(options.io, result);
  } else {
    options.io.writeStdout(renderGuidedSetupSummary(result));
  }
  return;
}

async function executeSyncCommand(
  command: Extract<ParsedCliCommand, { readonly kind: "sync" }>,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
  const service = await options.mutationServiceResolver.resolve(
    command.selection,
  );
  let summary: Awaited<ReturnType<typeof service.syncRepo>>;
  try {
    summary = await service.syncRepo({
      ...(command.maxPullRequests === undefined
        ? {}
        : { maxPullRequests: command.maxPullRequests }),
      ...(command.since === undefined ? {} : { since: command.since }),
    });
  } catch (error) {
    if (
      !(error instanceof SyncRepoError) ||
      error.code !== "SYNC_ALREADY_RUNNING"
    ) {
      throw error;
    }
    // Overlapping scheduled runs are expected: keep the JSONL log structured
    // and use a dedicated exit code instead of a generic failure.
    writeJson(options.io, { reason: error.code, skipped: true });
    options.io.writeStderr(
      `${error.code}: ${safeDiagnosticMessage(error.message.replace(/^.*?:\s*/u, ""))}\n`,
    );
    return REPO_KNOWLEDGE_CLI_EXIT.alreadyRunning;
  }
  writeJson(options.io, summary);
  if (summary.failed === 0) return;
  // Machine-readable summary stays on stdout; the operator diagnostic and
  // the non-zero exit code make partial failures visible to cron.
  options.io.writeStderr(syncFailureDiagnostic(summary));
  return REPO_KNOWLEDGE_CLI_EXIT.failure;
}

async function executeScheduleCommand(
  command: Extract<ParsedCliCommand, { readonly kind: "schedule" }>,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
  const scheduler = options.scheduler;
  if (scheduler === undefined) {
    throw new RepoKnowledgeCliError(
      "CLI_COMMAND_UNAVAILABLE",
      "schedule is unavailable in this runtime",
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );
  }
  switch (command.action) {
    case "print":
      options.io.writeStdout(
        await scheduler.render(scheduleSpec(command), command.format),
      );
      return;
    case "install": {
      const result = await scheduler.install(scheduleSpec(command), {
        dryRun: command.dryRun === true,
      });
      writeJson(options.io, result);
      if (result.scheduler === "cron") {
        options.io.writeStderr(`${result.next_step}\n${result.crontab_line}\n`);
      }
      for (const warning of result.warnings) {
        options.io.writeStderr(`warning: ${warning}\n`);
      }
      return;
    }
    case "uninstall": {
      const result = await scheduler.uninstall(command.repo, {
        dryRun: command.dryRun === true,
      });
      writeJson(options.io, result);
      if (result.scheduler === "cron") {
        options.io.writeStderr(`${result.next_step}\n`);
      }
      return;
    }
    case "status":
      writeJson(options.io, await scheduler.status(command.repo));
      return;
  }
}

function scheduleSpec(
  command: Extract<
    ParsedCliCommand,
    { readonly action: "install" | "print"; readonly kind: "schedule" }
  >,
): SyncScheduleSpec {
  return {
    intervalMinutes: command.intervalMinutes,
    ...(command.maxPullRequests === undefined
      ? {}
      : { maxPullRequests: command.maxPullRequests }),
    repo: command.repo,
  };
}

async function executeAdminCommand(
  command: Extract<
    ParsedCliCommand,
    {
      readonly kind:
        | "add-active"
        | "approve"
        | "approve-revision"
        | "edit"
        | "reject";
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

function writeJson(io: RepoKnowledgeCliIo, value: unknown): void {
  io.writeStdout(`${JSON.stringify(value)}\n`);
}

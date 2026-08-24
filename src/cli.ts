import type { TerminalActivityUpdate } from "./terminal-progress.js";
import type { GuidedSetupPrompt } from "./setup-service.js";
import { parseRepoKnowledgeCliArguments } from "./cli-args.js";
import {
  cliDiagnostic,
  runCliActivity,
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
  sync [repo] [--since <iso>]   Incrementally sync updated pull requests
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

Setup options:
  --workspace <path>            Resolve and register the workspace Git remote
  --since <iso-datetime>        Override the default 90-day initial window
  --all-history                 Sync all accessible pull-request history
  --json                        Print the setup result as one JSON document;
                                progress remains disabled for machine use

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

async function executeCliCommand(
  command: ParsedCliCommand,
  options: RunRepoKnowledgeCliOptions,
): Promise<number | undefined> {
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
      const prompt: GuidedSetupPrompt = {
        confirm: (request) => options.io.confirm!(request),
        input: (request) => options.io.input!(request),
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

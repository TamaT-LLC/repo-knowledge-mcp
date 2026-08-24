import {
  REPO_KNOWLEDGE_CLI_EXIT,
  RepoKnowledgeCliError,
} from "./cli-errors.js";
import type { RepoKnowledgeCliIo } from "./cli-types.js";
import {
  StatsReadError,
  type StatsReadErrorCode,
} from "./stats-read-service.js";
import type { SyncRepoSummary } from "./sync-repo-service.js";

export async function runCliActivity<Result>(
  io: RepoKnowledgeCliIo,
  id: string,
  label: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  io.activity?.({ id, label, state: "started" });
  try {
    const result = await operation();
    io.activity?.({ id, label, state: "succeeded" });
    return result;
  } catch (error) {
    io.activity?.({ id, label, state: "failed" });
    throw error;
  }
}

/**
 * Operator diagnostic for a partially failed sync run. The checkpoint stops
 * at the last contiguous success, so a plain re-run retries the failed pull
 * request before anything newer.
 */
export function syncFailureDiagnostic(summary: SyncRepoSummary): string {
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

export function cliDiagnostic(error: unknown): {
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

export function safeDiagnosticMessage(value: string): string {
  const flattened = value.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
  return flattened.slice(0, 4_096) || "operation failed";
}

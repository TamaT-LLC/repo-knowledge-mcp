export const REPO_KNOWLEDGE_CLI_EXIT = Object.freeze({
  failure: 1,
  success: 0,
  usage: 2,
});

export type RepoKnowledgeCliErrorCode =
  | "CLI_ARGUMENT_INVALID"
  | "CLI_COMMAND_UNAVAILABLE"
  | "CLI_INPUT_ENDED"
  | "CLI_INPUT_INTERRUPTED"
  | "CLI_REVIEW_UNSTABLE"
  | "CLI_TTY_REQUIRED";

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

import {
  executeBufferedCommand,
  type BufferedCommandExecutor,
  type BufferedCommandResult,
} from "./buffered-command.js";

export const DEFAULT_GH_TIMEOUT_MS = 30_000;
export const DEFAULT_GH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface GhRunnerOptions {
  readonly executor?: BufferedCommandExecutor;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

export interface GhCommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export type GhCommandErrorCode =
  | "GH_EXECUTION_FAILED"
  | "GH_EXIT_NON_ZERO"
  | "GH_MAX_BUFFER"
  | "GH_NOT_FOUND"
  | "GH_TIMEOUT";

export interface GhCommandErrorDetails {
  readonly args: readonly string[];
  readonly exitCode?: number;
  readonly maxBufferExceeded: boolean;
  readonly signal?: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export class GhCommandError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | undefined;
  readonly maxBufferExceeded: boolean;
  readonly signal: string | undefined;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;

  constructor(
    readonly code: GhCommandErrorCode,
    details: GhCommandErrorDetails,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "GhCommandError";
    this.args = [...details.args];
    this.exitCode = details.exitCode;
    this.maxBufferExceeded = details.maxBufferExceeded;
    this.signal = details.signal;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
    this.timedOut = details.timedOut;
  }
}

export interface GhRunnerLike {
  run(args: readonly string[]): Promise<GhCommandResult>;
}

/** Safe `gh` process boundary. Authentication remains entirely owned by gh. */
export class GhRunner implements GhRunnerLike {
  private readonly executor: BufferedCommandExecutor;
  private readonly maxBufferBytes: number;
  private readonly timeoutMs: number;

  constructor(options: GhRunnerOptions = {}) {
    this.executor = options.executor ?? executeBufferedCommand;
    this.maxBufferBytes = positiveInteger(
      options.maxBufferBytes ?? DEFAULT_GH_MAX_BUFFER_BYTES,
      "maxBufferBytes",
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async run(args: readonly string[]): Promise<GhCommandResult> {
    assertSafeArgv(args);
    let result: BufferedCommandResult;
    try {
      result = await this.executor({
        args: [...args],
        executable: "gh",
        maxBuffer: this.maxBufferBytes,
        shell: false,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw new GhCommandError(
        "GH_EXECUTION_FAILED",
        emptyErrorDetails(args),
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    if (!result.failed) {
      return { stderr: result.stderr, stdout: result.stdout };
    }

    const details: GhCommandErrorDetails = {
      args: [...args],
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      maxBufferExceeded: result.isMaxBuffer,
      ...(result.signal === undefined ? {} : { signal: result.signal }),
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: result.timedOut,
    };
    const code = classifyFailure(result);
    throw new GhCommandError(
      code,
      details,
      result.message ?? failureMessage(code, result),
    );
  }
}

function classifyFailure(result: BufferedCommandResult): GhCommandErrorCode {
  if (result.timedOut) return "GH_TIMEOUT";
  if (result.isMaxBuffer) return "GH_MAX_BUFFER";
  if (result.code === "ENOENT") return "GH_NOT_FOUND";
  if (result.exitCode !== undefined) return "GH_EXIT_NON_ZERO";
  return "GH_EXECUTION_FAILED";
}

function failureMessage(
  code: GhCommandErrorCode,
  result: BufferedCommandResult,
): string {
  switch (code) {
    case "GH_TIMEOUT":
      return "gh command timed out";
    case "GH_MAX_BUFFER":
      return "gh command exceeded the configured output limit";
    case "GH_NOT_FOUND":
      return "gh executable was not found";
    case "GH_EXIT_NON_ZERO":
      return `gh command exited with status ${String(result.exitCode)}`;
    case "GH_EXECUTION_FAILED":
      return "gh command could not be executed";
  }
}

function emptyErrorDetails(args: readonly string[]): GhCommandErrorDetails {
  return {
    args: [...args],
    maxBufferExceeded: false,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function assertSafeArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new TypeError("gh argv must not contain NUL bytes");
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

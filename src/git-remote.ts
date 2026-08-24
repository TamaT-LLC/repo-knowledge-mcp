import {
  executeBufferedCommand,
  type BufferedCommandExecutor,
  type BufferedCommandResult,
} from "./buffered-command.js";
import { RepositoryNameSchema } from "./domain-schemas.js";

const DEFAULT_GIT_TIMEOUT_MS = 5_000;
const DEFAULT_GIT_MAX_BUFFER_BYTES = 64 * 1024;

export type GitRemoteErrorCode =
  | "GIT_EXECUTION_FAILED"
  | "GIT_REMOTE_INVALID"
  | "GIT_REMOTE_UNAVAILABLE";

export class GitRemoteError extends Error {
  constructor(
    readonly code: GitRemoteErrorCode,
    message: string,
    readonly details: {
      readonly exitCode?: number;
      readonly stderr?: string;
      readonly stdout?: string;
      readonly timedOut?: boolean;
    } = {},
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "GitRemoteError";
  }
}

export interface GitRemoteReader {
  readOrigin(workspacePath: string): Promise<string>;
}

export interface ExecaGitRemoteReaderOptions {
  readonly executor?: BufferedCommandExecutor;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

/** Reads origin with a fixed git argv and no shell. */
export class ExecaGitRemoteReader implements GitRemoteReader {
  private readonly executor: BufferedCommandExecutor;
  private readonly maxBufferBytes: number;
  private readonly timeoutMs: number;

  constructor(options: ExecaGitRemoteReaderOptions = {}) {
    this.executor = options.executor ?? executeBufferedCommand;
    this.maxBufferBytes = positiveInteger(
      options.maxBufferBytes ?? DEFAULT_GIT_MAX_BUFFER_BYTES,
      "maxBufferBytes",
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async readOrigin(workspacePath: string): Promise<string> {
    let result: BufferedCommandResult;
    try {
      result = await this.executor({
        args: ["-C", workspacePath, "remote", "get-url", "origin"],
        executable: "git",
        maxBuffer: this.maxBufferBytes,
        shell: false,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw new GitRemoteError(
        "GIT_EXECUTION_FAILED",
        error instanceof Error ? error.message : String(error),
        {},
        { cause: error },
      );
    }
    if (result.failed) {
      throw new GitRemoteError(
        "GIT_REMOTE_UNAVAILABLE",
        "git remote get-url origin failed",
        {
          ...(result.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
          stderr: result.stderr,
          stdout: result.stdout,
          timedOut: result.timedOut,
        },
      );
    }
    if (result.stdout.length === 0) {
      throw new GitRemoteError(
        "GIT_REMOTE_UNAVAILABLE",
        "origin remote URL is empty",
      );
    }
    return result.stdout;
  }
}

/** Parses GitHub HTTPS and SSH clone URLs into a strict owner/name. */
export function parseGitHubRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (value.length === 0 || value.includes("\0")) {
    throw invalidRemote(remoteUrl);
  }

  const scpMatch = /^git@github\.com:([^/]+)\/([^/]+)$/u.exec(value);
  if (scpMatch) {
    return validateRemoteParts(scpMatch[1], scpMatch[2], remoteUrl);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRemote(remoteUrl);
  }
  const isHttps = url.protocol === "https:";
  const isSsh = url.protocol === "ssh:";
  const validAuthentication = isHttps
    ? url.username.length === 0 && url.password.length === 0
    : url.username === "git" && url.password.length === 0;
  if (
    (!isHttps && !isSsh) ||
    url.hostname.toLowerCase() !== "github.com" ||
    !validAuthentication ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (isHttps && url.port.length > 0)
  ) {
    throw invalidRemote(remoteUrl);
  }
  const segments = url.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") {
    throw invalidRemote(remoteUrl);
  }
  return validateRemoteParts(segments[1], segments[2], remoteUrl);
}

function validateRemoteParts(
  owner: string | undefined,
  rawRepository: string | undefined,
  source: string,
): string {
  if (owner === undefined || rawRepository === undefined) {
    throw invalidRemote(source);
  }
  const repository = rawRepository.endsWith(".git")
    ? rawRepository.slice(0, -4)
    : rawRepository;
  const candidate = `${owner}/${repository}`;
  const parsed = RepositoryNameSchema.safeParse(candidate);
  if (!parsed.success) throw invalidRemote(source);
  return parsed.data;
}

function invalidRemote(source: string): GitRemoteError {
  return new GitRemoteError(
    "GIT_REMOTE_INVALID",
    `unsupported GitHub remote URL (${String(Buffer.byteLength(source, "utf8"))} bytes)`,
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

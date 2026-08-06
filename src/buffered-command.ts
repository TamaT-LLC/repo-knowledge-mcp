import { execa } from "execa";

export interface BufferedCommandRequest {
  readonly args: readonly string[];
  readonly executable: string;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly timeout: number;
}

export interface BufferedCommandResult {
  readonly code?: string;
  readonly exitCode?: number;
  readonly failed: boolean;
  readonly isMaxBuffer: boolean;
  readonly message?: string;
  readonly signal?: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type BufferedCommandExecutor = (
  request: BufferedCommandRequest,
) => Promise<BufferedCommandResult>;

/** Executes a fixed executable with argv, never through a shell. */
export const executeBufferedCommand: BufferedCommandExecutor = async (
  request,
) => {
  const result = await execa(request.executable, [...request.args], {
    encoding: "utf8",
    maxBuffer: request.maxBuffer,
    reject: false,
    shell: request.shell,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
    stripFinalNewline: true,
    timeout: request.timeout,
  });

  return {
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    failed: result.failed,
    isMaxBuffer: result.isMaxBuffer,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.signal === undefined ? {} : { signal: result.signal }),
    stderr: result.stderr,
    stdout: result.stdout,
    timedOut: result.timedOut,
  };
};

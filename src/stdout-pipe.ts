/** The subset of a writable stream that the broken-pipe guard needs. */
export interface BrokenPipeGuardStream {
  on(event: "error", listener: (error: Error) => void): unknown;
  write(chunk: string): unknown;
}

/** A writer that stops writing once the reader has closed the pipe. */
export interface BrokenPipeGuardedWriter {
  /** True after the reader closed the pipe (EPIPE); later writes are dropped. */
  readonly readerClosed: boolean;
  write(value: string): void;
}

const guardedWriters = new WeakMap<
  BrokenPipeGuardStream,
  BrokenPipeGuardedWriter
>();

/**
 * Treats EPIPE on `stream` as the reader finishing early, like other Unix
 * CLIs (`repo-knowledge list | head`): output stops, the command finishes, and
 * its own exit code is kept, so a successful command still exits 0 with no
 * stack trace. Any other stream error is rethrown so it stays a fatal failure.
 * Repeated calls for the same stream share one listener and one state.
 */
export function guardBrokenPipe(
  stream: BrokenPipeGuardStream,
): BrokenPipeGuardedWriter {
  const existing = guardedWriters.get(stream);
  if (existing !== undefined) return existing;
  let readerClosed = false;
  stream.on("error", (error) => {
    if (isBrokenPipeError(error)) {
      readerClosed = true;
      return;
    }
    throw error;
  });
  const writer: BrokenPipeGuardedWriter = {
    get readerClosed() {
      return readerClosed;
    },
    write(value) {
      if (readerClosed) return;
      stream.write(value);
    },
  };
  guardedWriters.set(stream, writer);
  return writer;
}

function isBrokenPipeError(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === "EPIPE";
}

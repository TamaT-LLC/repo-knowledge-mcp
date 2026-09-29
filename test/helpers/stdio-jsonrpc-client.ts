import { spawn } from "node:child_process";

/**
 * Drives a newline-delimited JSON-RPC stdio server (e.g. `dist/bin.js serve`)
 * for E2E tests.
 *
 * `@modelcontextprotocol/server` (as of 2.1.0) aborts requests that are still
 * in flight when the client's stdin reaches EOF, per its stdio binding
 * guidance: "a client that expects responses keeps stdin open until it has
 * read them." Writing the whole request batch and closing stdin immediately
 * (e.g. execa's `input` option) therefore races the server and can drop
 * replies for slower tool calls. This helper keeps stdin open until a reply
 * has been observed for every request in the batch, then closes stdin so the
 * process can exit.
 */

export interface JsonRpcFrame {
  readonly error?: unknown;
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
}

export interface RunJsonRpcOverStdioOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly messages: readonly Record<string, unknown>[];
  readonly timeoutMs?: number;
}

export interface RunJsonRpcOverStdioResult {
  readonly replies: JsonRpcFrame[];
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 5_000;

export async function runJsonRpcOverStdio(
  options: RunJsonRpcOverStdioOptions,
): Promise<RunJsonRpcOverStdioResult> {
  const expectedIds = new Set(
    options.messages
      .map((message) => message.id)
      .filter((id): id is number => typeof id === "number"),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const replies: JsonRpcFrame[] = [];
  const seenIds = new Set<number>();
  let stdoutBuffer = "";
  let stderr = "";
  let forcedKill = false;

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  function hasAllReplies(): boolean {
    for (const id of expectedIds) {
      if (!seenIds.has(id)) return false;
    }
    return true;
  }

  function killIfRunning(signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (signal === "SIGKILL") forcedKill = true;
    child.kill(signal);
  }

  // `close` (unlike `exit`) fires only once the stdio streams have finished
  // draining, so it is the only safe point to decide whether every reply
  // has actually been observed.
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }

    const timer = setTimeout(() => {
      settle(() => {
        killIfRunning("SIGTERM");
        reject(
          new Error(
            `timed out after ${String(timeoutMs)}ms waiting for replies to ids [${[
              ...expectedIds,
            ].join(", ")}]; seen ids [${[...seenIds].join(", ")}]`,
          ),
        );
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          let frame: JsonRpcFrame;
          try {
            frame = JSON.parse(line) as JsonRpcFrame;
          } catch (error) {
            settle(() => {
              killIfRunning("SIGTERM");
              reject(
                new Error(
                  `failed to parse stdout JSON-RPC frame as JSON: ${line}`,
                  { cause: error },
                ),
              );
            });
            return;
          }
          replies.push(frame);
          if (typeof frame.id === "number") seenIds.add(frame.id);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
      if (hasAllReplies()) settle(resolve);
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // A stream's `error` event has no default handler: leaving it
    // unobserved turns e.g. an EPIPE while writing into an uncaught
    // exception that crashes the whole test worker. `child`'s own `error`
    // listener does not cover its stdin stream.
    child.stdin.once("error", (error: Error) => {
      settle(() => {
        killIfRunning("SIGTERM");
        reject(
          new Error(`stdio client stdin error: ${error.message}`, {
            cause: error,
          }),
        );
      });
    });

    child.once("close", (code, signal) => {
      settle(() => {
        reject(
          new Error(
            `stdio process closed early (code=${String(code)}, signal=${String(signal)}) before every reply arrived; seen ids [${[
              ...seenIds,
            ].join(", ")}]`,
          ),
        );
      });
    });

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.stdin.write(
      `${options.messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
  });

  // Every expected reply is in hand. Close stdin so the server observes EOF
  // and exits on its own, then wait for `close` (not just `exit`) so
  // trailing stderr output already in flight is not lost. From this point a
  // stdin write/EOF error is expected once the server has stopped reading,
  // so it is no longer treated as fatal.
  child.stdin.removeAllListeners("error");
  child.stdin.on("error", () => {
    // The server may have already closed its read side; the outcome is
    // decided by the exit/close status checked below instead.
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          killIfRunning("SIGKILL");
          resolve();
        }, EXIT_GRACE_MS);
      }),
    ]);
  }

  const { code, signal } = await closed;

  if (forcedKill) {
    throw new Error(
      "stdio process required SIGKILL after every reply was received; it did not exit once stdin reached EOF",
    );
  }
  if (signal !== null) {
    throw new Error(`stdio process was terminated by signal ${signal}`);
  }
  if (code !== 0) {
    throw new Error(`stdio process exited with nonzero code ${String(code)}`);
  }

  return { replies, stderr };
}

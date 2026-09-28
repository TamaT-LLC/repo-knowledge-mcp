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
  const replies: JsonRpcFrame[] = [];
  const seenIds = new Set<number>();
  let stdout = "";
  let stderr = "";

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `timed out after ${String(timeoutMs)}ms waiting for replies to ids [${[
            ...expectedIds,
          ].join(", ")}]; seen ids [${[...seenIds].join(", ")}]`,
        ),
      );
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout.removeListener("data", onStdoutData);
      child.stderr.removeListener("data", onStderrData);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    }

    function checkComplete(): void {
      for (const id of expectedIds) {
        if (!seenIds.has(id)) return;
      }
      cleanup();
      resolve();
    }

    function onStdoutData(chunk: string): void {
      stdout += chunk;
      let newlineIndex = stdout.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdout.slice(0, newlineIndex).replace(/\r$/u, "");
        stdout = stdout.slice(newlineIndex + 1);
        if (line.length > 0) {
          const frame = JSON.parse(line) as JsonRpcFrame;
          replies.push(frame);
          if (typeof frame.id === "number") seenIds.add(frame.id);
        }
        newlineIndex = stdout.indexOf("\n");
      }
      checkComplete();
    }

    function onStderrData(chunk: string): void {
      stderr += chunk;
    }

    function onExit(code: number | null, signal: string | null): void {
      cleanup();
      if (expectedIds.size > 0 && seenIds.size < expectedIds.size) {
        reject(
          new Error(
            `stdio process exited early (code=${String(code)}, signal=${String(signal)}) before every reply arrived`,
          ),
        );
        return;
      }
      resolve();
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);
    child.once("exit", onExit);
    child.once("error", onError);

    child.stdin.write(
      `${options.messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
  });

  // Every expected reply has arrived; let the server observe stdin EOF and
  // exit on its own rather than racing it with a signal.
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, EXIT_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    });
  }

  // Drain any trailing frames flushed between completion and process exit.
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const frame = JSON.parse(line) as JsonRpcFrame;
    if (typeof frame.id === "number" && seenIds.has(frame.id)) continue;
    replies.push(frame);
    if (typeof frame.id === "number") seenIds.add(frame.id);
  }

  return { replies, stderr };
}

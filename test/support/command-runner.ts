import { execa } from "execa";

import type { CommandIo } from "../../src/command-io.js";

type CommandRunner = (
  argv: readonly string[],
  io: CommandIo,
  env: Readonly<NodeJS.ProcessEnv>,
) => Promise<number>;

/** Run identical behavior assertions against source and the built CLI entry. */
export function createCommandTestRunner(
  mode: "in-process" | "subprocess",
  commands: ReadonlyMap<string, CommandRunner>,
) {
  return async (
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env?: Readonly<NodeJS.ProcessEnv>;
      readonly reject: false;
    },
  ) => {
    if (mode === "subprocess") {
      const result = await execa(process.execPath, args, options);
      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    }
    const command = commands.get(args[0]!);
    if (command === undefined) throw new Error(`Unknown CLI: ${args[0]}`);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await command(
      args.slice(1),
      {
        stdout: {
          write: (value) => {
            stdout.push(value);
          },
        },
        stderr: {
          write: (value) => {
            stderr.push(value);
          },
        },
      },
      { ...process.env, ...options.env },
    );
    return {
      exitCode,
      stderr: stderr.join("").replace(/\r?\n$/u, ""),
      stdout: stdout.join("").replace(/\r?\n$/u, ""),
    };
  };
}

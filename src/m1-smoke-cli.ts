import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runDefaultRepoKnowledgeCli } from "./cli-runtime.js";
import {
  runM1SmokeGate,
  type M1SmokeCommandExecutor,
} from "./m1-smoke-gate.js";

const arguments_ = parseArguments(process.argv.slice(2));
const temporaryStorage =
  arguments_.storageRoot === undefined
    ? await mkdtemp(join(tmpdir(), "rkm-m1-smoke-"))
    : null;
const storageRoot = resolve(arguments_.storageRoot ?? temporaryStorage!);

try {
  const manifest = JSON.parse(
    await readFile(resolve(arguments_.manifestPath), "utf8"),
  ) as unknown;
  const report = await runM1SmokeGate(manifest, commandExecutor(storageRoot), {
    commit: arguments_.commit,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`M1_SMOKE_FAILED: ${message}\n`);
  process.exitCode = 2;
} finally {
  if (temporaryStorage !== null) {
    await rm(temporaryStorage, { force: true, recursive: true });
  }
}

function commandExecutor(storageRoot: string): M1SmokeCommandExecutor {
  return async (argv) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runDefaultRepoKnowledgeCli({
      argv,
      io: {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        writeStderr: (value) => stderr.push(value),
        writeStdout: (value) => stdout.push(value),
      },
      storageRoot,
    });
    return {
      exitCode,
      stderr: stderr.join(""),
      stdout: stdout.join(""),
    };
  };
}

function parseArguments(argv: readonly string[]): {
  commit: string;
  manifestPath: string;
  storageRoot?: string;
} {
  let commit: string | undefined;
  let manifestPath: string | undefined;
  let storageRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new TypeError(`${option} requires a value`);
    switch (option) {
      case "--commit":
        commit = value;
        break;
      case "--manifest":
        manifestPath = value;
        break;
      case "--storage":
        storageRoot = value;
        break;
      default:
        throw new TypeError(`unknown smoke option ${String(option)}`);
    }
    index += 1;
  }
  if (commit === undefined || manifestPath === undefined) {
    throw new TypeError(
      "usage: --manifest <path> --commit <git-sha> [--storage <path>]",
    );
  }
  return {
    commit,
    manifestPath,
    ...(storageRoot === undefined ? {} : { storageRoot }),
  };
}

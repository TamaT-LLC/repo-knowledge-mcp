import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDefaultRepoKnowledgeCli } from "../src/cli-runtime.js";
import type { RepoKnowledgeCliIo } from "../src/cli-types.js";
import {
  createRuleExportHome,
  EXPORT_REPOSITORY,
} from "./helpers/rule-export-fixture.js";

/**
 * Records every write-capable filesystem call made through the ESM `node:fs`
 * and `node:fs/promises` modules that the CLI graph imports. Opening for
 * reading is allowed; any other flag or any mutating call is recorded.
 */
const spy = vi.hoisted(() => ({ recording: false, writes: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return wrapFilesystem(actual, [
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "lchown",
    "link",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ]);
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return wrapFilesystem(actual, [
    "appendFileSync",
    "chmodSync",
    "chownSync",
    "copyFileSync",
    "cpSync",
    "createWriteStream",
    "linkSync",
    "mkdirSync",
    "mkdtempSync",
    "renameSync",
    "rmSync",
    "rmdirSync",
    "symlinkSync",
    "truncateSync",
    "unlinkSync",
    "utimesSync",
    "writeFileSync",
    "writeSync",
  ]);
});

function wrapFilesystem<T extends object>(
  actual: T,
  mutating: readonly string[],
): T {
  const record = (call: string): void => {
    if (spy.recording) spy.writes.push(call);
  };
  const wrapped: Record<string, unknown> = {
    ...(actual as Record<string, unknown>),
  };
  for (const name of mutating) {
    const original = (actual as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (...args: unknown[]) => {
      record(`${name} ${String(args[0])}`);
      return (original as (...values: unknown[]) => unknown)(...args);
    };
  }
  for (const name of ["open", "openSync"]) {
    const original = (actual as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    wrapped[name] = (
      path: unknown,
      flags: unknown = "r",
      ...rest: unknown[]
    ) => {
      if (flags !== "r" && flags !== 0)
        record(`${name} ${String(path)} ${String(flags)}`);
      return (original as (...values: unknown[]) => unknown)(
        path,
        flags,
        ...rest,
      );
    };
  }
  return { ...wrapped, default: wrapped } as T;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  spy.recording = false;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

function capturingIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RepoKnowledgeCliIo = {
    stdinIsTTY: false,
    stdoutIsTTY: false,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  return { io, stderr: () => stderr.join(""), stdout: () => stdout.join("") };
}

async function runExport(storageRoot: string, cwd: string, argv: string[]) {
  const output = capturingIo();
  spy.writes.length = 0;
  spy.recording = true;
  try {
    const exitCode = await runDefaultRepoKnowledgeCli({
      argv,
      cwd,
      io: output.io,
      storageRoot,
    });
    return { ...output, exitCode, writes: [...spy.writes] };
  } finally {
    spy.recording = false;
  }
}

describe("export --format filesystem spy", () => {
  it("records a write when one happens, so a silent spy is meaningful", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    const result = await runExport(home.storageRoot, home.workspace, [
      "reindex",
      "--global",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.writes.length).toBeGreaterThan(0);
  });

  it.each([
    ["claude-md", "all"],
    ["agents-md", "all"],
    ["claude-md", "repository"],
    ["agents-md", "global"],
  ])(
    "exports %s for store %s without a single write-capable call",
    async (format, store) => {
      const home = await createRuleExportHome(temporaryDirectories);

      const result = await runExport(home.storageRoot, home.workspace, [
        "export",
        "--format",
        format,
        "--store",
        store,
        ...(store === "global" ? [] : ["--repo", EXPORT_REPOSITORY]),
      ]);

      // The fixture's hostile rule produces the escaping notice, not an error.
      expect(result.stderr()).not.toMatch(/^[A-Z_]+: /mu);
      expect(result.exitCode).toBe(0);
      expect(result.stdout()).toContain(
        `<!-- repo-knowledge:begin format=${format} store=${store} -->`,
      );
      expect(result.writes).toEqual([]);
    },
  );

  it("stays write-free on failures, including a storage root that does not exist", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const missing = join(home.root, "missing-home");

    for (const [storageRoot, argv] of [
      [
        missing,
        ["export", "--format", "claude-md", "--repo", EXPORT_REPOSITORY],
      ],
      [missing, ["export", "--format", "claude-md", "--store", "global"]],
      [
        home.storageRoot,
        ["export", "--format", "claude-md", "--repo", "owner/unknown"],
      ],
      [home.storageRoot, ["export", "--format", "claude-md"]],
    ] as const) {
      const result = await runExport(storageRoot, home.workspace, [...argv]);
      expect(result.writes).toEqual([]);
    }
  });
});

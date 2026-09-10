import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createCommandTestRunner } from "./support/command-runner.js";

describe("command test runner working directory", () => {
  let workingDirectory: string;

  beforeAll(async () => {
    workingDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "rkm-command-runner-")),
    );
  });

  afterAll(async () => {
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it("rejects a different in-process cwd before invoking the command", async () => {
    const originalCwd = process.cwd();
    const command = vi.fn(async () => 0);
    const run = createCommandTestRunner(
      "in-process",
      new Map([["test-command", command]]),
    );

    await expect(
      run(["test-command"], { cwd: workingDirectory, reject: false }),
    ).rejects.toThrow("in-process mode cannot change cwd");
    expect(command).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(originalCwd);
  });

  it("accepts a normalized path to the current in-process cwd", async () => {
    const command = vi.fn(async () => 0);
    const run = createCommandTestRunner(
      "in-process",
      new Map([["test-command", command]]),
    );
    const result = await run(["test-command"], { cwd: ".", reject: false });

    expect(result.exitCode).toBe(0);
    expect(command).toHaveBeenCalledOnce();
  });

  it("passes a different cwd to a subprocess without changing the parent cwd", async () => {
    const originalCwd = process.cwd();
    const run = createCommandTestRunner("subprocess", new Map());
    const result = await run(["-e", "process.stdout.write(process.cwd())"], {
      cwd: workingDirectory,
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(workingDirectory);
    expect(process.cwd()).toBe(originalCwd);
  });
});

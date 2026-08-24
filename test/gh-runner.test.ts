import { describe, expect, it, vi } from "vitest";

import {
  ExecaGitRemoteReader,
  GhCommandError,
  GhRunner,
  GitRemoteError,
  parseGitHubRemoteUrl,
  type BufferedCommandExecutor,
  type BufferedCommandRequest,
  type BufferedCommandResult,
} from "../src/experimental.js";

const successfulResult: BufferedCommandResult = {
  failed: false,
  isMaxBuffer: false,
  stderr: "warning",
  stdout: "result",
  timedOut: false,
};

describe("GhRunner", () => {
  it("executes gh with an argv array, explicit limits, and shell disabled", async () => {
    let request: BufferedCommandRequest | undefined;
    const executor: BufferedCommandExecutor = (received) => {
      request = received;
      return Promise.resolve(successfulResult);
    };
    const runner = new GhRunner({
      executor,
      maxBufferBytes: 12_345,
      timeoutMs: 6_789,
    });
    const suspiciousArgument = "name=$(touch should-not-run); echo nope";

    await expect(runner.run(["api", suspiciousArgument])).resolves.toEqual({
      stderr: "warning",
      stdout: "result",
    });
    expect(request).toEqual({
      args: ["api", suspiciousArgument],
      executable: "gh",
      maxBuffer: 12_345,
      shell: false,
      timeout: 6_789,
    });
  });

  it("preserves stdout, stderr, and exit status in a structured error", async () => {
    const runner = new GhRunner({
      executor: async () => ({
        exitCode: 4,
        failed: true,
        isMaxBuffer: false,
        message: "command failed",
        stderr: "authentication required",
        stdout: "partial output",
        timedOut: false,
      }),
    });

    const error = await runner
      .run(["auth", "status"])
      .catch((reason: unknown) =>
        reason instanceof GhCommandError ? reason : Promise.reject(reason),
      );
    expect(error).toMatchObject({
      args: ["auth", "status"],
      code: "GH_EXIT_NON_ZERO",
      exitCode: 4,
      maxBufferExceeded: false,
      stderr: "authentication required",
      stdout: "partial output",
      timedOut: false,
    });
  });

  it.each([
    {
      expected: "GH_TIMEOUT",
      result: { timedOut: true },
    },
    {
      expected: "GH_MAX_BUFFER",
      result: { isMaxBuffer: true },
    },
    {
      expected: "GH_NOT_FOUND",
      result: { code: "ENOENT" },
    },
  ] as const)("classifies $expected failures", async ({ expected, result }) => {
    const runner = new GhRunner({
      executor: async () => ({
        failed: true,
        isMaxBuffer: false,
        stderr: "",
        stdout: "",
        timedOut: false,
        ...result,
      }),
    });

    await expect(runner.run(["api", "graphql"])).rejects.toMatchObject({
      code: expected,
    });
  });

  it("rejects NUL bytes before invoking the executor", async () => {
    const executor = vi.fn<BufferedCommandExecutor>();
    const runner = new GhRunner({ executor });

    await expect(runner.run(["api", "bad\0argument"])).rejects.toThrow("NUL");
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("git origin reader", () => {
  it("uses a fixed git argv without a shell", async () => {
    let request: BufferedCommandRequest | undefined;
    const reader = new ExecaGitRemoteReader({
      executor: (received) => {
        request = received;
        return Promise.resolve({
          ...successfulResult,
          stderr: "",
          stdout: "git@github.com:tamat/repo.git",
        });
      },
      maxBufferBytes: 1_024,
      timeoutMs: 2_000,
    });

    await expect(reader.readOrigin("/safe/workspace")).resolves.toBe(
      "git@github.com:tamat/repo.git",
    );
    expect(request).toEqual({
      args: ["-C", "/safe/workspace", "remote", "get-url", "origin"],
      executable: "git",
      maxBuffer: 1_024,
      shell: false,
      timeout: 2_000,
    });
  });

  it("returns a structured failure when origin cannot be read", async () => {
    const reader = new ExecaGitRemoteReader({
      executor: async () => ({
        exitCode: 2,
        failed: true,
        isMaxBuffer: false,
        stderr: "No such remote 'origin'",
        stdout: "",
        timedOut: false,
      }),
    });

    await expect(reader.readOrigin("/safe/workspace")).rejects.toMatchObject({
      code: "GIT_REMOTE_UNAVAILABLE",
      details: {
        exitCode: 2,
        stderr: "No such remote 'origin'",
      },
    });
  });
});

describe("GitHub remote URL parsing", () => {
  it.each([
    [
      "https://github.com/TamaT-LLC/repo-knowledge-mcp.git",
      "TamaT-LLC/repo-knowledge-mcp",
    ],
    [
      "git@github.com:TamaT-LLC/repo-knowledge-mcp.git",
      "TamaT-LLC/repo-knowledge-mcp",
    ],
    [
      "ssh://git@github.com/TamaT-LLC/repo-knowledge-mcp",
      "TamaT-LLC/repo-knowledge-mcp",
    ],
  ])("parses %s", (remote, expected) => {
    expect(parseGitHubRemoteUrl(remote)).toBe(expected);
  });

  it.each([
    "http://github.com/owner/repo.git",
    "https://evil.example/owner/repo.git",
    "https://github.com/owner/repo/extra",
    "https://github.com/owner//repo.git",
    "https://github.com/owner/repo.git/",
    "https://token@github.com/owner/repo.git",
    "git@github.com:owner-/repo.git",
    "git@github.com:owner/../repo.git",
    "file:///owner/repo",
  ])("rejects unsupported or unsafe remote %s", (remote) => {
    expect(() => parseGitHubRemoteUrl(remote)).toThrow(GitRemoteError);
  });

  it("does not echo credentials from a rejected remote", () => {
    const credential = "secret-clone-token";

    try {
      parseGitHubRemoteUrl(
        `https://${credential}@github.com/owner/repository.git`,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GitRemoteError);
      expect((error as Error).message).not.toContain(credential);
      return;
    }
    throw new Error("Expected credential-bearing remote to be rejected");
  });
});

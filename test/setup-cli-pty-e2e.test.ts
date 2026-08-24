import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY = "owner/repository";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("repo-knowledge setup PTY E2E", () => {
  it("stops progress for prompts and shows elapsed sync plus a human summary", async () => {
    const fixture = await createFixture();
    const session = startPty(fixture, "human");

    await session.waitFor("✓ Resolving repository and private storage");
    await session.waitFor("Continue with local-only setup? [y/N]");
    session.send("n\n");
    await session.waitFor("Syncing pull request reviews (2.");
    const result = await session.finish();

    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("✓ Syncing pull request reviews (2.");
    expect(result.output).toContain("Setup complete");
    expect(result.output).toContain(`Repository  ${REPOSITORY}`);
    expect(result.output).toContain("no model transmission route is enabled");
    expect(result.output).not.toContain('{"config_path"');
  }, 15_000);

  it("keeps --json to one result document with no progress rendering", async () => {
    const fixture = await createFixture();
    const result = await startPty(fixture, "json").finish();
    const lines = result.output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(result.exitCode, result.output).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      repository: { name: REPOSITORY },
      transmission: { host_assisted: false, provider: false },
    });
    expect(result.output).not.toContain("\u001b");
    expect(result.output).not.toContain("Setup complete");
  }, 10_000);

  it("clears an active progress line when setup fails", async () => {
    const fixture = await createFixture();
    const result = await startPty(fixture, "failure").finish();

    expect(result.exitCode, result.output).toBe(1);
    expect(result.output).toContain("Syncing pull request reviews");
    expect(result.output).toContain("injected setup failure");
    expect(result.output).not.toContain("✓ Syncing pull request reviews");
  }, 10_000);
});

interface SetupPtyFixture {
  readonly bridge: string;
  readonly runner: string;
}

type SetupMode = "failure" | "human" | "json";

async function createFixture(): Promise<SetupPtyFixture> {
  const root = await temporaryDirectory("rkm-setup-pty-");
  const runner = join(root, "run.mjs");
  const bridge = join(root, "pty_bridge.py");
  await writeFile(runner, runnerSource(), "utf8");
  await writeFile(bridge, ptyBridgeSource(), "utf8");
  return { bridge, runner };
}

function runnerSource(): string {
  return `
const api = await import(process.env.RKM_INDEX_URL);
const runtime = await import(process.env.RKM_RUNTIME_URL);
const mode = process.env.RKM_SETUP_MODE;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const result = {
  config_path: "/private/config.json",
  doctor: { fail: 0, pass: 26, warn: 0 },
  initial_sync: {
    scope: { mode: "since", since: "2026-05-14T00:00:00.000Z" },
    summary: {
      discovered: 178,
      failed: 0,
      failures: [],
      ingested: 148,
      jobs_created: 151,
      next_cursor: null,
      unchanged: 30,
    },
  },
  repository: {
    id: "R_setup_pty",
    name: ${JSON.stringify(REPOSITORY)},
    storage_path: "/private/repos/R_setup_pty",
    workspace_path: "/work/repository",
  },
  resumed: false,
  state_path: "/private/repos/R_setup_pty/setup-state.json",
  storage_root: "/private",
  transmission: { host_assisted: false, provider: false },
  trust: { candidates: 2, selected: [] },
};
const argv = ["setup", ${JSON.stringify(REPOSITORY)}, ...(mode === "json" ? ["--json"] : [])];
const exitCode = await api.runRepoKnowledgeCli({
  argv,
  doctor: { run: async () => ({ checks: [], ok: true, summary: { fail: 0, pass: 0, warn: 0 } }) },
  io: runtime.createProcessCliIo(),
  mutationServiceResolver: { resolve: async () => { throw new Error("unused mutation resolver"); } },
  operationsResolver: { resolve: async () => { throw new Error("unused operations resolver"); } },
  serve: async () => undefined,
  setup: async (_request, prompt) => {
    prompt.progress?.({ id: "setup.resolve", label: "Resolving repository and private storage", state: "started" });
    await wait(40);
    prompt.progress?.({ id: "setup.resolve", label: "Resolving repository and private storage", state: "succeeded" });
    if (mode === "human") {
      await prompt.confirm({
        defaultValue: false,
        id: "local-only",
        message: "Continue with local-only setup?",
      });
    }
    prompt.progress?.({ id: "setup.sync", label: "Syncing pull request reviews", state: "started" });
    if (mode === "failure") {
      await wait(120);
      throw new Error("injected setup failure");
    }
    await wait(mode === "human" ? 2200 : 20);
    prompt.progress?.({ id: "setup.sync", label: "Syncing pull request reviews", state: "succeeded" });
    return result;
  },
});
process.exitCode = exitCode;
`;
}

function ptyBridgeSource(): string {
  return `
import os
import pty
import select
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

inputs = [master, sys.stdin.fileno()]
while True:
    readable, _, _ = select.select(inputs, [], [])
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in readable:
        data = os.read(sys.stdin.fileno(), 4096)
        if data:
            os.write(master, data)
        else:
            inputs.remove(sys.stdin.fileno())

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
}

function startPty(fixture: SetupPtyFixture, mode: SetupMode): PtySession {
  return new PtySession(createPtyChild(fixture, mode));
}

function createPtyChild(fixture: SetupPtyFixture, mode: SetupMode) {
  return execa("python3", [fixture.bridge, process.execPath, fixture.runner], {
    env: {
      ...process.env,
      RKM_INDEX_URL: pathToFileURL(
        join(process.cwd(), "dist", "experimental.js"),
      ).href,
      RKM_RUNTIME_URL: pathToFileURL(
        join(process.cwd(), "dist", "cli-runtime.js"),
      ).href,
      RKM_SETUP_MODE: mode,
    },
    reject: false,
    stdin: "pipe",
    stderr: "pipe",
    stdout: "pipe",
  });
}

class PtySession {
  private cursor = 0;
  private output = "";

  constructor(private readonly child: ReturnType<typeof createPtyChild>) {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.output += chunk.toString();
    });
  }

  send(value: string): void {
    this.child.stdin?.write(value);
  }

  async waitFor(value: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.output.indexOf(value, this.cursor);
      if (index >= 0) {
        this.cursor = index + value.length;
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${JSON.stringify(value)}. Output:\n${this.output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async finish(): Promise<{ exitCode: number; output: string }> {
    const result = await this.child;
    return { exitCode: result.exitCode ?? 0, output: this.output };
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

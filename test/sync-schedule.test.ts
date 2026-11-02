import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  REPO_KNOWLEDGE_CLI_EXIT,
  SYNC_ALREADY_RUNNING_EXIT_CODE,
  SyncScheduler,
  createProcessSyncScheduleSystem,
  cronScheduleExpression,
  parseRepoKnowledgeCliArguments,
  renderCrontabLine,
  renderLaunchdPlist,
  repoFromSyncScheduleLabel,
  runRepoKnowledgeCli,
  syncScheduleLabel,
  type RepoKnowledgeCliIo,
  type RunRepoKnowledgeCliOptions,
  type SyncScheduleCommandResult,
  type SyncScheduleSystem,
  type SyncScheduleTarget,
} from "../src/experimental.js";

const REPOSITORY = "Owner/repo.name";
const LABEL = "io.github.tamat-llc.repo-knowledge.sync.owner.repo.name";
const PLIST_PATH = `/Users/test/Library/LaunchAgents/${LABEL}.plist`;
const TARGET: SyncScheduleTarget = {
  binPath: "/opt/rk/lib/node_modules/@tamat-llc/repo-knowledge-mcp/dist/bin.js",
  ghPath: "/opt/homebrew/bin/gh",
  nodePath: "/usr/local/bin/node",
  storageRoot: "/Users/test/.repo-knowledge",
};

describe("sync schedule rendering", () => {
  it("derives a stable lower-case launchd label and reverses it", () => {
    expect(syncScheduleLabel(REPOSITORY)).toBe(LABEL);
    expect(repoFromSyncScheduleLabel(LABEL)).toBe("owner/repo.name");
    expect(repoFromSyncScheduleLabel("com.example.other")).toBeNull();
  });

  it("renders a LaunchAgent with absolute paths, interval, PATH, and logs", () => {
    const plist = renderLaunchdPlist(
      { intervalMinutes: 60, maxPullRequests: 200, repo: REPOSITORY },
      { ...TARGET, storageRoot: "/Users/test/rk&home" },
    );

    expect(plist).toContain(`<string>${LABEL}</string>`);
    expect(plist).toContain(
      [
        "    <string>/usr/local/bin/node</string>",
        `    <string>${TARGET.binPath}</string>`,
        "    <string>sync</string>",
        "    <string>Owner/repo.name</string>",
        "    <string>--max-prs</string>",
        "    <string>200</string>",
      ].join("\n"),
    );
    expect(plist).toContain(
      "<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
    expect(plist).toContain("<string>/Users/test/rk&amp;home</string>");
    expect(plist).toContain(
      "<key>StartInterval</key>\n  <integer>3600</integer>",
    );
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain(
      "<string>/Users/test/rk&amp;home/logs/sync-owner.repo.name.jsonl</string>",
    );
    expect(plist).toContain(
      "<string>/Users/test/rk&amp;home/logs/sync-owner.repo.name.err.log</string>",
    );
  });

  it("maps intervals to cron expressions only when they do not drift", () => {
    expect(cronScheduleExpression(5)).toBe("*/5 * * * *");
    expect(cronScheduleExpression(30)).toBe("*/30 * * * *");
    expect(cronScheduleExpression(60)).toBe("0 * * * *");
    expect(cronScheduleExpression(180)).toBe("0 */3 * * *");
    expect(cronScheduleExpression(1440)).toBe("0 */24 * * *");
    for (const minutes of [45, 90, 300]) {
      expect(() => cronScheduleExpression(minutes)).toThrow(
        expect.objectContaining({ code: "SCHEDULE_INTERVAL_UNSUPPORTED" }),
      );
    }
  });

  it("renders a crontab line that tolerates exit 75 and carries a marker", () => {
    const line = renderCrontabLine(
      { intervalMinutes: 60, repo: REPOSITORY },
      { ...TARGET, storageRoot: "/home/o'brien/50%" },
    );

    expect(line.startsWith("0 * * * * PATH=/opt/homebrew/bin:")).toBe(true);
    expect(line).toContain(
      "REPO_KNOWLEDGE_HOME='/home/o'\\''brien/50\\%' /usr/local/bin/node",
    );
    expect(line).toContain(`${TARGET.binPath} sync Owner/repo.name </dev/null`);
    expect(line).toContain(
      `[ "$rc" -eq ${String(SYNC_ALREADY_RUNNING_EXIT_CODE)} ]`,
    );
    expect(line.endsWith("# repo-knowledge-sync Owner/repo.name")).toBe(true);
    expect(line).not.toContain("--max-prs");
  });
});

describe("SyncScheduler", () => {
  it("installs a LaunchAgent and bootstraps it in the user domain", async () => {
    const system = fakeSystem();

    const result = await new SyncScheduler(system).install({
      intervalMinutes: 30,
      repo: REPOSITORY,
    });

    expect(result).toMatchObject({
      applied: true,
      interval_minutes: 30,
      label: LABEL,
      plist: null,
      plist_path: PLIST_PATH,
      scheduler: "launchd",
      warnings: [],
    });
    expect(system.directories).toEqual([
      ["/Users/test/.repo-knowledge/logs", 0o700],
      ["/Users/test/Library/LaunchAgents", 0o755],
    ]);
    expect(system.files.get(PLIST_PATH)).toContain("<integer>1800</integer>");
    expect(system.commands).toEqual([
      ["launchctl", "print", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", PLIST_PATH],
    ]);
  });

  it("replaces an already loaded job on reinstall", async () => {
    const system = fakeSystem({ loaded: true });

    await new SyncScheduler(system).install({
      intervalMinutes: 60,
      repo: REPOSITORY,
    });

    expect(system.commands).toEqual([
      ["launchctl", "print", `gui/501/${LABEL}`],
      ["launchctl", "bootout", `gui/501/${LABEL}`],
      ["launchctl", "bootstrap", "gui/501", PLIST_PATH],
    ]);
  });

  it("has no side effects in dry-run mode", async () => {
    const system = fakeSystem();

    const result = await new SyncScheduler(system).install(
      { intervalMinutes: 60, repo: REPOSITORY },
      { dryRun: true },
    );

    expect(result).toMatchObject({ applied: false, scheduler: "launchd" });
    expect(result.scheduler === "launchd" && result.plist).toContain(LABEL);
    expect(system.files.size).toBe(0);
    expect(system.directories).toEqual([]);
    expect(system.commands).toEqual([]);
  });

  it("fails with a launchctl diagnostic when bootstrap fails", async () => {
    const system = fakeSystem({ bootstrapExitCode: 5 });

    await expect(
      new SyncScheduler(system).install({
        intervalMinutes: 60,
        repo: REPOSITORY,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_LAUNCHCTL_FAILED" });
  });

  it("requires gh on PATH", async () => {
    await expect(
      new SyncScheduler(fakeSystem({ gh: null })).install({
        intervalMinutes: 60,
        repo: REPOSITORY,
      }),
    ).rejects.toMatchObject({ code: "SCHEDULE_GH_NOT_FOUND" });
  });

  it("warns when the CLI runs from the npx cache", async () => {
    const result = await new SyncScheduler(
      fakeSystem({ binPath: "/Users/test/.npm/_npx/abc/dist/bin.js" }),
    ).install({ intervalMinutes: 60, repo: REPOSITORY }, { dryRun: true });

    expect(result.warnings).toHaveLength(1);
  });

  it("uninstalls by booting out the job and removing the plist", async () => {
    const system = fakeSystem({ loaded: true });
    system.files.set(PLIST_PATH, "plist");

    const result = await new SyncScheduler(system).uninstall(REPOSITORY);

    expect(result).toMatchObject({
      applied: true,
      removed: true,
      scheduler: "launchd",
      unloaded: true,
    });
    expect(system.files.has(PLIST_PATH)).toBe(false);
    expect(system.commands).toContainEqual([
      "launchctl",
      "bootout",
      `gui/501/${LABEL}`,
    ]);
  });

  it("lists installed LaunchAgents with interval and load state", async () => {
    const system = fakeSystem({ loaded: true });
    await new SyncScheduler(system).install({
      intervalMinutes: 120,
      repo: REPOSITORY,
    });
    system.files.set(
      "/Users/test/Library/LaunchAgents/com.example.unrelated.plist",
      "",
    );

    await expect(new SyncScheduler(system).status()).resolves.toEqual({
      scheduler: "launchd",
      schedules: [
        {
          interval_minutes: 120,
          label: LABEL,
          loaded: true,
          plist_path: PLIST_PATH,
          repo: "owner/repo.name",
        },
      ],
    });
    await expect(
      new SyncScheduler(system).status("other/repository"),
    ).resolves.toEqual({ scheduler: "launchd", schedules: [] });
  });

  it("never edits the crontab on linux and prints the line instead", async () => {
    const system = fakeSystem({ platform: "linux" });

    const install = await new SyncScheduler(system).install({
      intervalMinutes: 15,
      maxPullRequests: 100,
      repo: REPOSITORY,
    });
    const uninstall = await new SyncScheduler(system).uninstall(REPOSITORY);

    expect(install).toMatchObject({ applied: false, scheduler: "cron" });
    expect(install.scheduler === "cron" && install.crontab_line).toMatch(
      /^\*\/15 \* \* \* \* .* sync Owner\/repo\.name --max-prs 100 /u,
    );
    expect(uninstall).toMatchObject({
      applied: false,
      marker: "# repo-knowledge-sync Owner/repo.name",
      scheduler: "cron",
    });
    expect(system.commands).toEqual([]);
    expect(system.files.size).toBe(0);
  });

  it("reads crontab -l for linux status", async () => {
    const line = renderCrontabLine(
      { intervalMinutes: 60, repo: REPOSITORY },
      TARGET,
    );
    const system = fakeSystem({
      crontab: `MAILTO=ops@example.com\n# ${line}\n${line}\n0 0 * * * other-job\n`,
      platform: "linux",
    });

    await expect(new SyncScheduler(system).status()).resolves.toEqual({
      scheduler: "cron",
      schedules: [{ line, repo: "Owner/repo.name" }],
    });
  });

  it("rejects unsupported platforms", async () => {
    await expect(
      new SyncScheduler(fakeSystem({ platform: "win32" })).status(),
    ).rejects.toMatchObject({ code: "SCHEDULE_PLATFORM_UNSUPPORTED" });
  });
});

describe("schedule CLI", () => {
  it("parses install, uninstall, status, and print", () => {
    expect(
      parseRepoKnowledgeCliArguments(
        [
          "schedule",
          "install",
          REPOSITORY,
          "--interval",
          "30",
          "--max-prs",
          "50",
          "--dry-run",
        ],
        false,
      ),
    ).toEqual({
      action: "install",
      dryRun: true,
      intervalMinutes: 30,
      kind: "schedule",
      maxPullRequests: 50,
      repo: REPOSITORY,
    });
    expect(
      parseRepoKnowledgeCliArguments(
        ["schedule", "install", "--repo", REPOSITORY],
        false,
      ),
    ).toEqual({
      action: "install",
      intervalMinutes: 60,
      kind: "schedule",
      repo: REPOSITORY,
    });
    expect(
      parseRepoKnowledgeCliArguments(
        ["schedule", "uninstall", REPOSITORY],
        false,
      ),
    ).toEqual({ action: "uninstall", kind: "schedule", repo: REPOSITORY });
    expect(
      parseRepoKnowledgeCliArguments(["schedule", "status"], false),
    ).toEqual({ action: "status", kind: "schedule" });
    expect(
      parseRepoKnowledgeCliArguments(
        ["schedule", "print", REPOSITORY, "--format", "cron"],
        false,
      ),
    ).toEqual({
      action: "print",
      format: "cron",
      intervalMinutes: 60,
      kind: "schedule",
      repo: REPOSITORY,
    });
  });

  it.each([
    [["schedule"]],
    [["schedule", "start", REPOSITORY]],
    [["schedule", "install"]],
    [["schedule", "install", REPOSITORY, "--interval", "4"]],
    [["schedule", "install", REPOSITORY, "--interval", "1441"]],
    [["schedule", "install", REPOSITORY, "--interval", "1.5"]],
    [["schedule", "install", REPOSITORY, "--format", "cron"]],
    [["schedule", "print", REPOSITORY, "--format", "systemd"]],
    [["schedule", "print", REPOSITORY, "--dry-run"]],
    [["schedule", "uninstall", REPOSITORY, "--interval", "60"]],
    [["schedule", "install", "not-a-repo"]],
  ])("rejects invalid arguments %j", (argv) => {
    expect(() => parseRepoKnowledgeCliArguments(argv, false)).toThrow(
      expect.objectContaining({ code: "CLI_ARGUMENT_INVALID" }),
    );
  });

  it("prints the generated schedule without side effects", async () => {
    const system = fakeSystem();
    const current = cliFixture(
      ["schedule", "print", REPOSITORY, "--format", "launchd"],
      system,
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.stdout()).toContain("<key>StartInterval</key>");
    expect(system.commands).toEqual([]);
  });

  it("writes JSON for install and the crontab line to stderr on linux", async () => {
    const current = cliFixture(
      ["schedule", "install", REPOSITORY],
      fakeSystem({ platform: "linux" }),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    const result = JSON.parse(current.stdout()) as { crontab_line: string };
    expect(result).toMatchObject({ applied: false, scheduler: "cron" });
    expect(current.stderr()).toContain(result.crontab_line);
  });

  it("installs on launchd with a bounded run and reports warnings", async () => {
    const system = fakeSystem({
      binPath: "/Users/test/.npm/_npx/abc/dist/bin.js",
    });
    const current = cliFixture(
      ["schedule", "install", REPOSITORY, "--max-prs", "40", "--dry-run"],
      system,
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(JSON.parse(current.stdout())).toMatchObject({
      applied: false,
      max_prs: 40,
      scheduler: "launchd",
    });
    expect(current.stderr()).toMatch(/^warning: .*npx cache/u);
    expect(system.commands).toEqual([]);
  });

  it("prints a bounded crontab line", async () => {
    const current = cliFixture(
      ["schedule", "print", REPOSITORY, "--max-prs", "10", "--format", "cron"],
      fakeSystem(),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(current.stdout()).toContain("sync Owner/repo.name --max-prs 10 ");
  });

  it.each([
    ["darwin", ""],
    ["linux", "never edits your crontab"],
  ] as const)("uninstalls on %s", async (platform, stderr) => {
    const current = cliFixture(
      ["schedule", "uninstall", REPOSITORY],
      fakeSystem({ platform }),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(JSON.parse(current.stdout())).toMatchObject({
      action: "uninstall",
    });
    expect(current.stderr()).toContain(stderr);
  });

  it("prints schedule status as JSON", async () => {
    const current = cliFixture(
      ["schedule", "status", REPOSITORY],
      fakeSystem(),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(0);

    expect(JSON.parse(current.stdout())).toEqual({
      scheduler: "launchd",
      schedules: [],
    });
  });

  it("exits with a usage error for an interval cron cannot express", async () => {
    const current = cliFixture(
      ["schedule", "install", REPOSITORY, "--interval", "45"],
      fakeSystem({ platform: "linux" }),
    );

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.usage,
    );
    expect(current.stderr()).toContain("SCHEDULE_INTERVAL_UNSUPPORTED");
  });

  it("is unavailable when the runtime has no scheduler", async () => {
    const current = cliFixture(["schedule", "status"], undefined);

    await expect(runRepoKnowledgeCli(current.options)).resolves.toBe(
      REPO_KNOWLEDGE_CLI_EXIT.failure,
    );
    expect(current.stderr()).toContain("CLI_COMMAND_UNAVAILABLE");
  });
});

interface FakeSystemOptions {
  readonly binPath?: string;
  readonly bootstrapExitCode?: number;
  readonly crontab?: string;
  readonly gh?: string | null;
  readonly loaded?: boolean;
  readonly platform?: NodeJS.Platform;
}

interface FakeSystem extends SyncScheduleSystem {
  readonly commands: string[][];
  readonly directories: [string, number][];
  readonly files: Map<string, string>;
}

function fakeSystem(options: FakeSystemOptions = {}): FakeSystem {
  const commands: string[][] = [];
  const directories: [string, number][] = [];
  const files = new Map<string, string>();
  let loaded = options.loaded ?? false;
  const ok = (stdout = ""): SyncScheduleCommandResult => ({
    exitCode: 0,
    stderr: "",
    stdout,
  });
  return {
    binPath: options.binPath ?? TARGET.binPath,
    commands,
    directories,
    files,
    async findExecutable(name) {
      return name === "gh"
        ? options.gh === undefined
          ? TARGET.ghPath
          : options.gh
        : null;
    },
    homeDir: "/Users/test",
    async listDirectory(path) {
      return [...files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1));
    },
    async makeDirectory(path, mode) {
      directories.push([path, mode]);
    },
    nodePath: TARGET.nodePath,
    platform: options.platform ?? "darwin",
    async readTextFile(path) {
      return files.get(path) ?? null;
    },
    async removeFile(path) {
      return files.delete(path);
    },
    async run(executable, args) {
      if (executable === "crontab") {
        return options.crontab === undefined
          ? { exitCode: 1, stderr: "no crontab", stdout: "" }
          : ok(options.crontab);
      }
      commands.push([executable, ...args]);
      switch (args[0]) {
        case "print":
          return loaded
            ? ok()
            : { exitCode: 113, stderr: "not found", stdout: "" };
        case "bootout":
          loaded = false;
          return ok();
        case "bootstrap":
          if ((options.bootstrapExitCode ?? 0) !== 0) {
            return {
              exitCode: options.bootstrapExitCode!,
              stderr: "Bootstrap failed",
              stdout: "",
            };
          }
          loaded = true;
          return ok();
        default:
          return ok();
      }
    },
    storageRoot: TARGET.storageRoot,
    uid: 501,
    async writeTextFile(path, content) {
      files.set(path, content);
    },
  };
}

function cliFixture(
  argv: readonly string[],
  system: SyncScheduleSystem | undefined,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RepoKnowledgeCliIo = {
    stdinIsTTY: false,
    stdoutIsTTY: false,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  const unused = vi.fn(async () => {
    throw new Error("schedule must not resolve a repository");
  });
  const options: RunRepoKnowledgeCliOptions = {
    argv,
    doctor: { run: unused },
    io,
    mutationServiceResolver: { resolve: unused },
    operationsResolver: { resolve: unused },
    ...(system === undefined ? {} : { scheduler: new SyncScheduler(system) }),
    serve: unused,
    setup: unused,
  };
  return {
    options,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

describe("createProcessSyncScheduleSystem", () => {
  it("performs file operations and runs commands without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "rkm-schedule-system-"));
    try {
      const system = createProcessSyncScheduleSystem({
        binPath: "/opt/rk/dist/bin.js",
        homeDir: root,
        storageRoot: join(root, "storage"),
      });
      const directory = join(root, "agents");
      const file = join(directory, "job.plist");

      await system.makeDirectory(directory, 0o755);
      await system.writeTextFile(file, "content", 0o644);

      expect(system.nodePath).toBe(process.execPath);
      expect(system.platform).toBe(process.platform);
      await expect(system.readTextFile(file)).resolves.toBe("content");
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      await expect(system.listDirectory(directory)).resolves.toEqual([
        "job.plist",
      ]);
      await expect(system.removeFile(file)).resolves.toBe(true);
      await expect(system.removeFile(file)).resolves.toBe(false);
      await expect(system.readTextFile(file)).resolves.toBeNull();
      await expect(
        system.listDirectory(join(root, "missing")),
      ).resolves.toEqual([]);
      await expect(
        system.run(process.execPath, [
          "-e",
          "process.stdout.write('out'); process.exit(3)",
        ]),
      ).resolves.toEqual({ exitCode: 3, stderr: "", stdout: "out" });
      await expect(
        system.findExecutable("definitely-not-a-real-binary-rkm"),
      ).resolves.toBeNull();
      const nodeName = basename(process.execPath);
      const original = process.env.PATH;
      process.env.PATH = `${join(root, "missing")}${delimiter}${dirname(process.execPath)}`;
      try {
        await expect(system.findExecutable(nodeName)).resolves.toBe(
          join(dirname(process.execPath), nodeName),
        );
      } finally {
        process.env.PATH = original;
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

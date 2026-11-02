import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { executeBufferedCommand } from "./buffered-command.js";
import { parseRepositoryName } from "./repository-resolver.js";

export const SYNC_SCHEDULE_LABEL_PREFIX =
  "io.github.tamat-llc.repo-knowledge.sync.";
export const SYNC_SCHEDULE_CRON_MARKER = "# repo-knowledge-sync";
export const DEFAULT_SYNC_SCHEDULE_INTERVAL_MINUTES = 60;
export const MIN_SYNC_SCHEDULE_INTERVAL_MINUTES = 5;
export const MAX_SYNC_SCHEDULE_INTERVAL_MINUTES = 1_440;
/**
 * Exit status of `repo-knowledge sync` when another sync of the same
 * repository holds the lock (sysexits EX_TEMPFAIL): nothing changed and the
 * next scheduled run continues, so schedulers should not alert on it.
 */
export const SYNC_ALREADY_RUNNING_EXIT_CODE = 75;

export type SyncScheduleFormat = "cron" | "launchd";

export interface SyncScheduleSpec {
  readonly intervalMinutes: number;
  readonly maxPullRequests?: number;
  readonly repo: string;
}

/** Absolute paths baked into a generated schedule. */
export interface SyncScheduleTarget {
  readonly binPath: string;
  readonly ghPath: string;
  readonly nodePath: string;
  readonly storageRoot: string;
}

export interface SyncScheduleCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Every side effect of the scheduler sits behind this interface so tests can
 * exercise install and uninstall without touching launchd, crontab, or the
 * real home directory.
 */
export interface SyncScheduleSystem {
  readonly binPath: string;
  readonly homeDir: string;
  readonly nodePath: string;
  readonly platform: NodeJS.Platform;
  readonly storageRoot: string;
  readonly uid: number;
  findExecutable(name: string): Promise<string | null>;
  listDirectory(path: string): Promise<readonly string[]>;
  makeDirectory(path: string, mode: number): Promise<void>;
  readTextFile(path: string): Promise<string | null>;
  removeFile(path: string): Promise<boolean>;
  run(
    executable: string,
    args: readonly string[],
  ): Promise<SyncScheduleCommandResult>;
  writeTextFile(path: string, content: string, mode: number): Promise<void>;
}

export type SyncScheduleErrorCode =
  | "SCHEDULE_GH_NOT_FOUND"
  | "SCHEDULE_INTERVAL_UNSUPPORTED"
  | "SCHEDULE_LAUNCHCTL_FAILED"
  | "SCHEDULE_PLATFORM_UNSUPPORTED";

export class SyncScheduleError extends Error {
  constructor(
    readonly code: SyncScheduleErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SyncScheduleError";
  }
}

export interface LaunchdScheduleEntry {
  readonly interval_minutes: number | null;
  readonly label: string;
  readonly loaded: boolean;
  readonly plist_path: string;
  readonly repo: string;
}

export interface CronScheduleEntry {
  readonly line: string;
  readonly repo: string;
}

export type SyncScheduleInstallResult =
  | {
      readonly action: "install";
      readonly applied: boolean;
      readonly interval_minutes: number;
      readonly label: string;
      readonly max_prs: number | null;
      readonly plist: string | null;
      readonly plist_path: string;
      readonly repo: string;
      readonly scheduler: "launchd";
      readonly stderr_log: string;
      readonly stdout_log: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly action: "install";
      readonly applied: false;
      readonly crontab_line: string;
      readonly interval_minutes: number;
      readonly max_prs: number | null;
      readonly next_step: string;
      readonly repo: string;
      readonly scheduler: "cron";
      readonly warnings: readonly string[];
    };

export type SyncScheduleUninstallResult =
  | {
      readonly action: "uninstall";
      readonly applied: boolean;
      readonly label: string;
      readonly plist_path: string;
      readonly removed: boolean;
      readonly repo: string;
      readonly scheduler: "launchd";
      readonly unloaded: boolean;
    }
  | {
      readonly action: "uninstall";
      readonly applied: false;
      readonly marker: string;
      readonly next_step: string;
      readonly repo: string;
      readonly scheduler: "cron";
    };

export type SyncScheduleStatusResult =
  | {
      readonly schedules: readonly LaunchdScheduleEntry[];
      readonly scheduler: "launchd";
    }
  | {
      readonly schedules: readonly CronScheduleEntry[];
      readonly scheduler: "cron";
    };

export interface SyncSchedulerLike {
  install(
    spec: SyncScheduleSpec,
    options?: { readonly dryRun?: boolean },
  ): Promise<SyncScheduleInstallResult>;
  render(spec: SyncScheduleSpec, format?: SyncScheduleFormat): Promise<string>;
  status(repo?: string): Promise<SyncScheduleStatusResult>;
  uninstall(
    repo: string,
    options?: { readonly dryRun?: boolean },
  ): Promise<SyncScheduleUninstallResult>;
}

/** launchd label for one repository; lower-cased because GitHub names are case-insensitive. */
export function syncScheduleLabel(repo: string): string {
  const [owner, name] = parseRepositoryName(repo).toLowerCase().split("/");
  return `${SYNC_SCHEDULE_LABEL_PREFIX}${owner!}.${name!}`;
}

/** Recovers `owner/name` from a label; owners never contain dots, names may. */
export function repoFromSyncScheduleLabel(label: string): string | null {
  if (!label.startsWith(SYNC_SCHEDULE_LABEL_PREFIX)) return null;
  const rest = label.slice(SYNC_SCHEDULE_LABEL_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  return `${rest.slice(0, dot)}/${rest.slice(dot + 1)}`;
}

export function syncScheduleLogPaths(
  storageRoot: string,
  repo: string,
): { readonly stderr: string; readonly stdout: string } {
  const slug = parseRepositoryName(repo).toLowerCase().replace("/", ".");
  const directory = join(storageRoot, "logs");
  return {
    stderr: join(directory, `sync-${slug}.err.log`),
    stdout: join(directory, `sync-${slug}.jsonl`),
  };
}

export function syncScheduleArguments(spec: SyncScheduleSpec): string[] {
  return [
    "sync",
    parseRepositoryName(spec.repo),
    ...(spec.maxPullRequests === undefined
      ? []
      : ["--max-prs", String(spec.maxPullRequests)]),
  ];
}

/** PATH for the scheduled process: gh and node first, then system defaults. */
export function syncSchedulePath(target: SyncScheduleTarget): string {
  return [
    ...new Set([
      dirname(target.ghPath),
      dirname(target.nodePath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":");
}

export function renderLaunchdPlist(
  spec: SyncScheduleSpec,
  target: SyncScheduleTarget,
): string {
  const logs = syncScheduleLogPaths(target.storageRoot, spec.repo);
  const argumentsXml = [
    target.nodePath,
    target.binPath,
    ...syncScheduleArguments(spec),
  ]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(syncScheduleLabel(spec.repo))}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(syncSchedulePath(target))}</string>
    <key>REPO_KNOWLEDGE_HOME</key>
    <string>${escapeXml(target.storageRoot)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${String(spec.intervalMinutes * 60)}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardInPath</key>
  <string>/dev/null</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logs.stderr)}</string>
</dict>
</plist>
`;
}

/**
 * cron has no "every N minutes from now" primitive, so only intervals that
 * divide an hour or a day evenly are representable without drift.
 */
export function cronScheduleExpression(intervalMinutes: number): string {
  if (intervalMinutes < 60 && 60 % intervalMinutes === 0) {
    return `*/${String(intervalMinutes)} * * * *`;
  }
  if (intervalMinutes === 60) return "0 * * * *";
  if (intervalMinutes % 60 === 0 && 24 % (intervalMinutes / 60) === 0) {
    return `0 */${String(intervalMinutes / 60)} * * *`;
  }
  throw new SyncScheduleError(
    "SCHEDULE_INTERVAL_UNSUPPORTED",
    `cron cannot run every ${String(intervalMinutes)} minutes without drift; use a divisor of 60 minutes (5, 10, 15, 20, 30) or a whole number of hours dividing 24 (60, 120, 180, 240, 360, 480, 720, 1440)`,
  );
}

/**
 * One crontab line. Exit 75 (another sync of the repository is already
 * running) is treated as success so cron's MAILTO only reports real failures.
 */
export function renderCrontabLine(
  spec: SyncScheduleSpec,
  target: SyncScheduleTarget,
): string {
  const repo = parseRepositoryName(spec.repo);
  const logs = syncScheduleLogPaths(target.storageRoot, repo);
  const command = [
    `PATH=${shellQuote(syncSchedulePath(target))}`,
    `REPO_KNOWLEDGE_HOME=${shellQuote(target.storageRoot)}`,
    shellQuote(target.nodePath),
    shellQuote(target.binPath),
    ...syncScheduleArguments(spec).map(shellQuote),
    "</dev/null",
    `>> ${shellQuote(logs.stdout)}`,
    `2>> ${shellQuote(logs.stderr)};`,
    "rc=$?;",
    `[ "$rc" -eq 0 ] || [ "$rc" -eq ${String(SYNC_ALREADY_RUNNING_EXIT_CODE)} ] || echo "repo-knowledge sync ${repo} failed with exit $rc"`,
    `${SYNC_SCHEDULE_CRON_MARKER} ${repo}`,
  ].join(" ");
  // `%` is a newline in crontab command fields.
  return `${cronScheduleExpression(spec.intervalMinutes)} ${command.replaceAll("%", "\\%")}`;
}

/**
 * Installs, removes, and reports OS-level sync schedules. Sync itself always
 * runs out of process through the CLI; the MCP server never owns a timer.
 * - darwin: a per-user LaunchAgent loaded with `launchctl bootstrap`.
 * - linux: the crontab is never edited automatically; install prints the
 *   line to add and status reads `crontab -l`.
 */
export class SyncScheduler implements SyncSchedulerLike {
  constructor(private readonly system: SyncScheduleSystem) {}

  async render(
    spec: SyncScheduleSpec,
    format: SyncScheduleFormat = this.defaultFormat(),
  ): Promise<string> {
    const target = await this.target();
    return format === "launchd"
      ? renderLaunchdPlist(spec, target)
      : `${renderCrontabLine(spec, target)}\n`;
  }

  async install(
    spec: SyncScheduleSpec,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<SyncScheduleInstallResult> {
    const scheduler = this.scheduler();
    const target = await this.target();
    const repo = parseRepositoryName(spec.repo);
    const logs = syncScheduleLogPaths(target.storageRoot, repo);
    const warnings = this.warnings();
    if (scheduler === "cron") {
      const line = renderCrontabLine(spec, target);
      if (options.dryRun !== true) {
        await this.system.makeDirectory(dirname(logs.stdout), 0o700);
      }
      return {
        action: "install",
        applied: false,
        crontab_line: line,
        interval_minutes: spec.intervalMinutes,
        max_prs: spec.maxPullRequests ?? null,
        next_step:
          "repo-knowledge never edits your crontab; add crontab_line with `crontab -e`.",
        repo,
        scheduler,
        warnings,
      };
    }
    const label = syncScheduleLabel(repo);
    const plistPath = this.plistPath(label);
    const plist = renderLaunchdPlist(spec, target);
    if (options.dryRun !== true) {
      await this.system.makeDirectory(dirname(logs.stdout), 0o700);
      await this.system.makeDirectory(dirname(plistPath), 0o755);
      // Reinstall replaces a loaded job so a new interval takes effect.
      if (await this.isLoaded(label)) {
        await this.launchctl(["bootout", this.serviceTarget(label)]);
      }
      await this.system.writeTextFile(plistPath, plist, 0o644);
      await this.launchctl(["bootstrap", this.domainTarget(), plistPath]);
    }
    return {
      action: "install",
      applied: options.dryRun !== true,
      interval_minutes: spec.intervalMinutes,
      label,
      max_prs: spec.maxPullRequests ?? null,
      plist: options.dryRun === true ? plist : null,
      plist_path: plistPath,
      repo,
      scheduler,
      stderr_log: logs.stderr,
      stdout_log: logs.stdout,
      warnings,
    };
  }

  async uninstall(
    repoInput: string,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<SyncScheduleUninstallResult> {
    const scheduler = this.scheduler();
    const repo = parseRepositoryName(repoInput);
    if (scheduler === "cron") {
      const marker = `${SYNC_SCHEDULE_CRON_MARKER} ${repo}`;
      return {
        action: "uninstall",
        applied: false,
        marker,
        next_step: `repo-knowledge never edits your crontab; remove the line ending with "${marker}" using \`crontab -e\`.`,
        repo,
        scheduler,
      };
    }
    const label = syncScheduleLabel(repo);
    const plistPath = this.plistPath(label);
    let unloaded = false;
    let removed = false;
    if (options.dryRun !== true) {
      if (await this.isLoaded(label)) {
        await this.launchctl(["bootout", this.serviceTarget(label)]);
        unloaded = true;
      }
      removed = await this.system.removeFile(plistPath);
    }
    return {
      action: "uninstall",
      applied: options.dryRun !== true,
      label,
      plist_path: plistPath,
      removed,
      repo,
      scheduler,
      unloaded,
    };
  }

  async status(repoInput?: string): Promise<SyncScheduleStatusResult> {
    const scheduler = this.scheduler();
    const repo =
      repoInput === undefined
        ? undefined
        : parseRepositoryName(repoInput).toLowerCase();
    if (scheduler === "cron") {
      const result = await this.system.run("crontab", ["-l"]);
      const schedules =
        result.exitCode !== 0
          ? []
          : result.stdout
              .split("\n")
              .map((line) => line.trim())
              .flatMap((line) => {
                const index = line.lastIndexOf(SYNC_SCHEDULE_CRON_MARKER);
                if (line.startsWith("#") || index < 0) return [];
                const entryRepo = line
                  .slice(index + SYNC_SCHEDULE_CRON_MARKER.length)
                  .trim();
                return repo === undefined || entryRepo.toLowerCase() === repo
                  ? [{ line, repo: entryRepo }]
                  : [];
              });
      return { scheduler, schedules };
    }
    const directory = this.launchAgentsDirectory();
    const labels = (await this.system.listDirectory(directory))
      .filter(
        (file) =>
          file.startsWith(SYNC_SCHEDULE_LABEL_PREFIX) &&
          file.endsWith(".plist"),
      )
      .map((file) => file.slice(0, -".plist".length))
      .sort();
    const schedules: LaunchdScheduleEntry[] = [];
    for (const label of labels) {
      const entryRepo = repoFromSyncScheduleLabel(label);
      if (entryRepo === null) continue;
      if (repo !== undefined && entryRepo !== repo) continue;
      const plistPath = join(directory, `${label}.plist`);
      const plist = await this.system.readTextFile(plistPath);
      const interval = plist?.match(
        /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/u,
      )?.[1];
      schedules.push({
        interval_minutes: interval === undefined ? null : Number(interval) / 60,
        label,
        loaded: await this.isLoaded(label),
        plist_path: plistPath,
        repo: entryRepo,
      });
    }
    return { scheduler, schedules };
  }

  private defaultFormat(): SyncScheduleFormat {
    return this.system.platform === "darwin" ? "launchd" : "cron";
  }

  private scheduler(): SyncScheduleFormat {
    switch (this.system.platform) {
      case "darwin":
        return "launchd";
      case "linux":
        return "cron";
      default:
        throw new SyncScheduleError(
          "SCHEDULE_PLATFORM_UNSUPPORTED",
          `scheduled sync supports darwin (launchd) and linux (cron), not ${this.system.platform}`,
        );
    }
  }

  private async target(): Promise<SyncScheduleTarget> {
    const ghPath = await this.system.findExecutable("gh");
    if (ghPath === null) {
      throw new SyncScheduleError(
        "SCHEDULE_GH_NOT_FOUND",
        "gh was not found on PATH; install and authenticate the GitHub CLI before scheduling sync",
      );
    }
    return {
      binPath: this.system.binPath,
      ghPath,
      nodePath: this.system.nodePath,
      storageRoot: this.system.storageRoot,
    };
  }

  private warnings(): string[] {
    return /[\\/]_npx[\\/]/u.test(this.system.binPath)
      ? [
          `${this.system.binPath} is inside the npx cache, which npm may delete; install the package globally (npm install -g) and re-run schedule install.`,
        ]
      : [];
  }

  private launchAgentsDirectory(): string {
    return join(this.system.homeDir, "Library", "LaunchAgents");
  }

  private plistPath(label: string): string {
    return join(this.launchAgentsDirectory(), `${label}.plist`);
  }

  private domainTarget(): string {
    return `gui/${String(this.system.uid)}`;
  }

  private serviceTarget(label: string): string {
    return `${this.domainTarget()}/${label}`;
  }

  private async isLoaded(label: string): Promise<boolean> {
    const result = await this.system.run("launchctl", [
      "print",
      this.serviceTarget(label),
    ]);
    return result.exitCode === 0;
  }

  private async launchctl(args: readonly string[]): Promise<void> {
    const result = await this.system.run("launchctl", args);
    if (result.exitCode !== 0) {
      throw new SyncScheduleError(
        "SCHEDULE_LAUNCHCTL_FAILED",
        `launchctl ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
}

export interface ProcessSyncScheduleSystemOptions {
  readonly binPath: string;
  readonly homeDir: string;
  readonly storageRoot: string;
}

/** Real side effects for the current process (never used by tests). */
export function createProcessSyncScheduleSystem(
  options: ProcessSyncScheduleSystemOptions,
): SyncScheduleSystem {
  return {
    binPath: options.binPath,
    async findExecutable(name) {
      for (const directory of (process.env.PATH ?? "").split(delimiter)) {
        if (directory.length === 0) continue;
        const candidate = join(directory, name);
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Try the next PATH entry.
        }
      }
      return null;
    },
    homeDir: options.homeDir,
    async listDirectory(path) {
      try {
        return await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async makeDirectory(path, mode) {
      await mkdir(path, { mode, recursive: true });
    },
    nodePath: process.execPath,
    platform: process.platform,
    async readTextFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async removeFile(path) {
      try {
        await unlink(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async run(executable, args) {
      const result = await executeBufferedCommand({
        args,
        executable,
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 30_000,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
    storageRoot: options.storageRoot,
    uid: process.getuid?.() ?? 0,
    async writeTextFile(path, content, mode) {
      await writeFile(path, content, { encoding: "utf8", mode });
      await chmod(path, mode);
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

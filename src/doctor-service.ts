import { lstat, readFile, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { canonicalizeJson, compareCodeUnits } from "./canonical.js";
import { CanonicalJsonlError } from "./canonical-jsonl.js";
import { DEFAULT_CONFIG_FILE_NAME, loadRepoKnowledgeConfig } from "./config.js";
import {
  buildDomainProjectionSnapshot,
  DomainProjectionError,
  type DomainProjectionSnapshot,
} from "./domain-projection.js";
import type {
  RepoKnowledgeConfig,
  KnowledgeEvidence,
} from "./domain-schemas.js";
import {
  ExecaGitRemoteReader,
  parseGitHubRemoteUrl,
  type GitRemoteReader,
} from "./git-remote.js";
import { GhCommandError, type GhRunnerLike } from "./gh-runner.js";
import {
  KnowledgeStoreInvalidError,
  type KnowledgeDocument,
} from "./knowledge-document.js";
import { repositoryStorageId } from "./repository-registry.js";
import {
  RESOLVE_REPOSITORY_GRAPHQL,
  parseRepositoryName,
  resolveAllowedWorkspacePath,
} from "./repository-resolver.js";
import {
  PROJECTION_SCHEMA_VERSION,
  captureCanonicalStateReadOnly,
  type ReadOnlyCanonicalStateCapture,
} from "./sqlite-projection.js";

export type DoctorCheckStatus = "fail" | "pass" | "warn";

export interface DoctorCheck {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly message: string;
  readonly path?: string;
  readonly remedy?: string;
  readonly status: DoctorCheckStatus;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
  readonly summary: {
    readonly fail: number;
    readonly pass: number;
    readonly warn: number;
  };
}

export interface DoctorRepositorySelection {
  readonly repo?: string;
  readonly workspacePath?: string;
}

export interface RepoKnowledgeDoctorLike {
  run(selection?: DoctorRepositorySelection): Promise<DoctorReport>;
}

export interface RepoKnowledgeDoctorOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly filesystemTypeReader?: (path: string) => Promise<bigint | number>;
  readonly ghRunner: GhRunnerLike;
  readonly gitRemoteReader?: GitRemoteReader;
  readonly nodeVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly storageRoot: string;
}

interface GithubHealth {
  readonly auth: boolean;
  readonly cli: boolean;
  readonly graphql: boolean;
}

interface GithubRepositoryIdentity {
  readonly currentName: string;
  readonly repoId: string;
}

interface RegistryEntry {
  readonly aliases: readonly string[];
  readonly currentName: string;
  readonly path: string;
}

interface RegistryInspection {
  readonly entries: ReadonlyMap<string, RegistryEntry>;
  readonly path: string;
}

interface CanonicalInspection {
  readonly capture: ReadOnlyCanonicalStateCapture;
  readonly domain: DomainProjectionSnapshot;
}

const DOCTOR_GRAPHQL_QUERY = "query RepoKnowledgeDoctor { viewer { login } }";
const NETWORK_FILESYSTEM_TYPES = new Map<number, string>([
  [0x0000_6969, "NFS"],
  [0x0000_517b, "SMB"],
  [0xff53_4d42, "CIFS"],
  [0xfe53_4d42, "SMB2"],
  [0x5346_414f, "AFS"],
  [0x0102_1997, "9P"],
]);
const SYNCHRONIZED_PATH =
  /(?:^|[/\\])(?:Dropbox|Google Drive|Mobile Documents|OneDrive)(?:[/\\]|$)/iu;

/** Runs read-only installation, GitHub, canonical-state, and projection checks. */
export class RepoKnowledgeDoctor implements RepoKnowledgeDoctorLike {
  private readonly cwd: string;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly filesystemTypeReader: (
    path: string,
  ) => Promise<bigint | number>;
  private readonly ghRunner: GhRunnerLike;
  private readonly gitRemoteReader: GitRemoteReader;
  private readonly nodeVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly storageRoot: string;

  constructor(options: RepoKnowledgeDoctorOptions) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.environment = options.environment ?? process.env;
    this.filesystemTypeReader =
      options.filesystemTypeReader ??
      (async (path) => (await statfs(path, { bigint: true })).type);
    this.ghRunner = options.ghRunner;
    this.gitRemoteReader =
      options.gitRemoteReader ?? new ExecaGitRemoteReader();
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.platform = options.platform ?? process.platform;
    this.storageRoot = resolve(options.storageRoot);
  }

  async run(selection: DoctorRepositorySelection = {}): Promise<DoctorReport> {
    const report = new DoctorReportBuilder();
    checkRuntime(report, this.nodeVersion, this.platform);
    const storageExists = await this.inspectStorage(report);
    const config = storageExists ? await this.inspectConfig(report) : null;
    checkTransmissionConfiguration(report, config, this.environment);
    await inspectSqliteFeatures(report);
    const github = await inspectGithub(report, this.ghRunner);
    const registry = storageExists
      ? await inspectRegistry(report, this.storageRoot)
      : null;
    const target = await resolveDoctorTarget(report, selection, config, {
      cwd: this.cwd,
      gitRemoteReader: this.gitRemoteReader,
    });
    const identity = await inspectGithubRepository(
      report,
      this.ghRunner,
      github,
      target,
    );
    const local = bindLocalRepository(
      report,
      registry,
      target,
      identity,
      this.storageRoot,
    );
    if (local === null) {
      addSkippedRepositoryChecks(report);
      return report.build();
    }

    await inspectRepositoryPermissions(report, local.absolutePath);
    await inspectTransactions(report, local.absolutePath, local.currentName);
    const canonical = await inspectCanonicalState(
      report,
      local.absolutePath,
      local.repoId,
      local.currentName,
    );
    await inspectSqliteProjection(
      report,
      local.absolutePath,
      canonical,
      local.repoId,
      local.currentName,
    );
    return report.build();
  }

  private async inspectStorage(report: DoctorReportBuilder): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(this.storageRoot);
    } catch (error) {
      report.add({
        id: "storage.permissions",
        message: "Storage root does not exist or cannot be inspected.",
        path: this.storageRoot,
        remedy:
          "Run a normal repo-knowledge setup command to create private storage, then rerun doctor.",
        status: "fail",
        details: { error: errorCode(error) },
      });
      report.add({
        id: "storage.local_filesystem",
        message:
          "Local-filesystem support could not be checked without storage.",
        path: this.storageRoot,
        status: "warn",
      });
      return false;
    }
    const permission = metadata.mode & 0o777;
    const privateDirectory =
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      permission === 0o700;
    report.add(
      privateDirectory
        ? {
            id: "storage.permissions",
            message: "Storage root is a real directory with mode 700.",
            path: this.storageRoot,
            status: "pass",
          }
        : {
            details: { mode: octal(permission) },
            id: "storage.permissions",
            message:
              "Storage root must be a non-symlink directory with mode 700.",
            path: this.storageRoot,
            remedy: `Move storage to a private directory and run chmod 700 ${this.storageRoot}.`,
            status: "fail",
          },
    );

    if (SYNCHRONIZED_PATH.test(this.storageRoot)) {
      report.add({
        id: "storage.local_filesystem",
        message: "Storage appears to be inside a synchronized filesystem path.",
        path: this.storageRoot,
        remedy:
          "Move REPO_KNOWLEDGE_HOME to a local, non-synchronized filesystem.",
        status: "fail",
      });
      return true;
    }
    try {
      const type = unsignedFilesystemType(
        await this.filesystemTypeReader(this.storageRoot),
      );
      const networkName = NETWORK_FILESYSTEM_TYPES.get(type);
      report.add(
        networkName === undefined
          ? {
              details: { filesystem_type: `0x${type.toString(16)}` },
              id: "storage.local_filesystem",
              message:
                "Storage is not on a recognized network filesystem or sync path.",
              path: this.storageRoot,
              status: "pass",
            }
          : {
              details: { filesystem: networkName },
              id: "storage.local_filesystem",
              message: `${networkName} storage is outside the M1 durability guarantee.`,
              path: this.storageRoot,
              remedy:
                "Move REPO_KNOWLEDGE_HOME to a local filesystem before writing canonical state.",
              status: "fail",
            },
      );
    } catch (error) {
      report.add({
        details: { error: errorCode(error) },
        id: "storage.local_filesystem",
        message: "Filesystem type could not be determined.",
        path: this.storageRoot,
        remedy:
          "Confirm manually that storage is local and not NFS, SMB, Dropbox, iCloud, or another sync area.",
        status: "warn",
      });
    }
    return true;
  }

  private async inspectConfig(
    report: DoctorReportBuilder,
  ): Promise<RepoKnowledgeConfig | null> {
    const configPath = join(this.storageRoot, DEFAULT_CONFIG_FILE_NAME);
    let config: RepoKnowledgeConfig;
    try {
      config = await loadRepoKnowledgeConfig(configPath);
      report.add({
        id: "config.syntax",
        message: "Configuration is valid and uses the supported schema.",
        path: configPath,
        status: "pass",
      });
    } catch (error) {
      report.add({
        details: { error: errorMessage(error) },
        id: "config.syntax",
        message: "Configuration could not be parsed safely.",
        path: configPath,
        remedy: `Fix ${configPath}; doctor does not rewrite invalid configuration.`,
        status: "fail",
      });
      report.add({
        id: "config.permissions",
        message: "Config permissions were not trusted because parsing failed.",
        path: configPath,
        status: "warn",
      });
      return null;
    }
    try {
      const metadata = await lstat(configPath);
      const permission = metadata.mode & 0o777;
      const valid =
        metadata.isFile() && !metadata.isSymbolicLink() && permission === 0o600;
      report.add(
        valid
          ? {
              id: "config.permissions",
              message: "Config is a regular file with mode 600.",
              path: configPath,
              status: "pass",
            }
          : {
              details: { mode: octal(permission) },
              id: "config.permissions",
              message:
                "Config must be a non-symlink regular file with mode 600.",
              path: configPath,
              remedy: `Replace any symlink and run chmod 600 ${configPath}.`,
              status: "fail",
            },
      );
    } catch (error) {
      report.add({
        details: { error: errorCode(error) },
        id: "config.permissions",
        message: "Config permissions could not be inspected.",
        path: configPath,
        status: "fail",
      });
    }
    return config;
  }
}

class DoctorReportBuilder {
  private readonly checks: DoctorCheck[] = [];

  add(check: DoctorCheck): void {
    this.checks.push(check);
  }

  build(): DoctorReport {
    const summary = { fail: 0, pass: 0, warn: 0 };
    for (const check of this.checks) summary[check.status] += 1;
    return {
      checks: [...this.checks],
      ok: summary.fail === 0,
      summary,
    };
  }
}

function checkRuntime(
  report: DoctorReportBuilder,
  nodeVersion: string,
  platform: NodeJS.Platform,
): void {
  const supportedNode = isSupportedNodeVersion(nodeVersion);
  report.add(
    supportedNode
      ? {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js version is supported.",
          status: "pass",
        }
      : {
          details: { version: nodeVersion },
          id: "runtime.node",
          message: "Node.js must be 22.13 or newer in the 22 line, or 24+.",
          remedy: "Install a supported Node.js release and rerun doctor.",
          status: "fail",
        },
  );
  const supportedPlatform = platform === "darwin" || platform === "linux";
  report.add(
    supportedPlatform
      ? {
          details: { platform },
          id: "runtime.os",
          message: "Operating system is supported by the M1 storage model.",
          status: "pass",
        }
      : {
          details: { platform },
          id: "runtime.os",
          message: "M1 supports only macOS and Linux.",
          remedy: "Use repo-knowledge on macOS or Linux.",
          status: "fail",
        },
  );
}

function checkTransmissionConfiguration(
  report: DoctorReportBuilder,
  config: RepoKnowledgeConfig | null,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (config === null) {
    for (const id of [
      "config.provider_transmission",
      "config.host_assisted_transmission",
    ]) {
      report.add({
        id,
        message:
          "Transmission consent could not be checked without valid config.",
        status: "warn",
      });
    }
    return;
  }
  const provider = config.llm;
  if (provider.mode === "disabled" && provider.allowCloudTransmission) {
    report.add({
      id: "config.provider_transmission",
      message:
        "Cloud transmission consent is true while the provider mode is disabled.",
      remedy:
        "Set llm.allowCloudTransmission to false, or configure mode and model intentionally.",
      status: "warn",
    });
  } else if (
    provider.mode === "anthropic" &&
    !provider.allowCloudTransmission
  ) {
    report.add({
      id: "config.provider_transmission",
      message:
        "Anthropic mode is configured but cloud transmission consent is false; provider calls remain disabled.",
      remedy:
        "Either set mode to disabled or explicitly enable allowCloudTransmission after reviewing data disclosure.",
      status: "warn",
    });
  } else if (
    provider.mode === "anthropic" &&
    provider.allowCloudTransmission &&
    provider.model === null
  ) {
    report.add({
      id: "config.provider_transmission",
      message: "Enabled Anthropic transmission has no configured model.",
      remedy: "Set llm.model before running provider distillation.",
      status: "fail",
    });
  } else if (
    provider.mode === "anthropic" &&
    provider.allowCloudTransmission &&
    !environment.ANTHROPIC_API_KEY?.trim()
  ) {
    report.add({
      id: "config.provider_transmission",
      message: "Enabled Anthropic transmission has no ANTHROPIC_API_KEY.",
      remedy:
        "Provide ANTHROPIC_API_KEY in the process environment; never place it in config.json.",
      status: "fail",
    });
  } else {
    report.add({
      id: "config.provider_transmission",
      message:
        provider.mode === "disabled"
          ? "Provider transmission is safely disabled."
          : "Provider mode, model, consent, and credential presence are coherent.",
      status: "pass",
    });
  }

  const host = config.hostAssistedDistillation;
  if (host.enabled !== host.allowReviewContentTransmission) {
    report.add({
      id: "config.host_assisted_transmission",
      message:
        "Host-assisted mode requires both enabled and allowReviewContentTransmission; review content remains unavailable.",
      remedy:
        "Set both host-assisted consent fields to false, or intentionally enable both after reviewing disclosure.",
      status: "warn",
    });
  } else {
    report.add({
      id: "config.host_assisted_transmission",
      message: host.enabled
        ? "Host-assisted transmission has both required opt-ins."
        : "Host-assisted transmission is safely disabled.",
      status: "pass",
    });
  }
}

async function inspectSqliteFeatures(
  report: DoctorReportBuilder,
): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(
      "CREATE VIRTUAL TABLE doctor_fts USING fts5(value, tokenize='trigram')",
    );
    database.prepare("INSERT INTO doctor_fts(value) VALUES (?)").run("doctor");
    const row = database
      .prepare(
        "SELECT count(*) AS count FROM doctor_fts WHERE doctor_fts MATCH ?",
      )
      .get('"doctor"') as { count: number };
    if (row.count !== 1) throw new Error("trigram query returned no row");
    report.add({
      id: "sqlite.features",
      message: "SQLite FTS5 and the trigram tokenizer are available.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.features",
      message: "SQLite FTS5 or the trigram tokenizer is unavailable.",
      remedy:
        "Use the supported prebuilt better-sqlite3 runtime for this Node.js version.",
      status: "fail",
    });
  } finally {
    database.close();
  }
}

async function inspectGithub(
  report: DoctorReportBuilder,
  ghRunner: GhRunnerLike,
): Promise<GithubHealth> {
  let cli = false;
  try {
    await ghRunner.run(["--version"]);
    cli = true;
    report.add({
      id: "github.cli",
      message: "GitHub CLI is installed and executable.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: ghErrorCode(error) },
      id: "github.cli",
      message: "GitHub CLI could not be executed.",
      remedy: "Install gh and ensure it is available on PATH.",
      status: "fail",
    });
  }
  if (!cli) {
    report.add({
      id: "github.auth",
      message: "Authentication check was skipped because gh is unavailable.",
      status: "warn",
    });
    report.add({
      id: "github.graphql",
      message: "GraphQL check was skipped because gh is unavailable.",
      status: "warn",
    });
    return { auth: false, cli: false, graphql: false };
  }

  let auth = false;
  try {
    await ghRunner.run(["auth", "status"]);
    auth = true;
    report.add({
      id: "github.auth",
      message: "GitHub CLI authentication is valid.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: ghErrorCode(error) },
      id: "github.auth",
      message: "GitHub CLI is not authenticated for API access.",
      remedy: "Run gh auth login, then verify with gh auth status.",
      status: "fail",
    });
  }
  if (!auth) {
    report.add({
      id: "github.graphql",
      message: "GraphQL check was skipped because gh authentication failed.",
      status: "warn",
    });
    return { auth: false, cli: true, graphql: false };
  }

  let graphql = false;
  try {
    const result = await ghRunner.run([
      "api",
      "graphql",
      "-f",
      `query=${DOCTOR_GRAPHQL_QUERY}`,
    ]);
    const value = parseJsonObject(result.stdout);
    const data = objectProperty(value, "data");
    const viewer = objectProperty(data, "viewer");
    if (typeof viewer.login !== "string" || viewer.login.length === 0) {
      throw new TypeError("viewer.login was absent");
    }
    graphql = true;
    report.add({
      details: { login: viewer.login },
      id: "github.graphql",
      message: "GitHub GraphQL connectivity succeeded.",
      status: "pass",
    });
  } catch (error) {
    report.add({
      details: { error: ghErrorCode(error) },
      id: "github.graphql",
      message: "GitHub GraphQL could not be queried or returned invalid data.",
      remedy:
        "Check network access and gh token scopes, then run gh api graphql manually.",
      status: "fail",
    });
  }
  return { auth, cli, graphql };
}

async function inspectRegistry(
  report: DoctorReportBuilder,
  storageRoot: string,
): Promise<RegistryInspection | null> {
  const path = join(storageRoot, "repositories.json");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      report.add({
        id: "repository.registry",
        message: "Repository registry does not exist yet.",
        path,
        remedy:
          "Run ingest or another repository-bound command to register the first repository.",
        status: "warn",
      });
      return { entries: new Map(), path };
    }
    report.add({
      details: { error: errorCode(error) },
      id: "repository.registry",
      message: "Repository registry could not be read.",
      path,
      status: "fail",
    });
    return null;
  }
  try {
    const value = parseJsonObject(decodeUtf8(bytes));
    const repositories = objectProperty(value, "repositories");
    const entries = new Map<string, RegistryEntry>();
    for (const [repoId, raw] of Object.entries(repositories).sort(([a], [b]) =>
      compareCodeUnits(a, b),
    )) {
      if (repoId.length === 0) throw new TypeError("empty repository ID");
      const entry = asObject(raw);
      const currentName = parseRepositoryName(
        stringProperty(entry, "currentName"),
      );
      const entryPath = stringProperty(entry, "path");
      const aliases = stringArrayProperty(entry, "aliases").map((alias) =>
        parseRepositoryName(alias),
      );
      const expectedPath = `repos/${repositoryStorageId(repoId)}`;
      if (entryPath !== expectedPath) {
        throw new TypeError(`invalid storage path for ${repoId}`);
      }
      entries.set(repoId, { aliases, currentName, path: entryPath });
    }
    const metadata = await lstat(path);
    const permission = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      permission !== 0o600
    ) {
      throw new TypeError(
        `registry must be a mode-600 regular file, got ${octal(permission)}`,
      );
    }
    report.add({
      details: { repositories: entries.size },
      id: "repository.registry",
      message: "Repository registry is valid and private.",
      path,
      status: "pass",
    });
    return { entries, path };
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "repository.registry",
      message: "Repository registry is invalid.",
      path,
      remedy:
        "Restore repositories.json from a trusted backup; doctor will not rewrite registry identity.",
      status: "fail",
    });
    return null;
  }
}

async function resolveDoctorTarget(
  report: DoctorReportBuilder,
  selection: DoctorRepositorySelection,
  config: RepoKnowledgeConfig | null,
  options: { readonly cwd: string; readonly gitRemoteReader: GitRemoteReader },
): Promise<string | null> {
  try {
    let target: string | undefined;
    let source: string;
    if (selection.repo !== undefined) {
      target = parseRepositoryName(selection.repo);
      source = "explicit repo";
    } else if (selection.workspacePath !== undefined) {
      if (config === null) {
        throw new TypeError("workspace resolution requires valid config");
      }
      const workspace = await resolveAllowedWorkspacePath(
        selection.workspacePath,
        Object.keys(config.workspaceMappings),
      );
      target = parseGitHubRemoteUrl(
        await options.gitRemoteReader.readOrigin(workspace),
      );
      source = `workspace ${workspace}`;
    } else if (config?.defaultRepo !== undefined) {
      target = config.defaultRepo;
      source = "config defaultRepo";
    } else {
      const mapped = config?.workspaceMappings[options.cwd];
      if (mapped !== undefined) {
        target = mapped;
        source = "current workspace mapping";
      } else {
        report.add({
          id: "repository.target",
          message: "No repository target was selected.",
          remedy:
            "Pass doctor owner/name or --workspace, or set defaultRepo in config.json.",
          status: "warn",
        });
        return null;
      }
    }
    report.add({
      details: { repo: target, source },
      id: "repository.target",
      message:
        "Repository target was resolved without changing registry state.",
      status: "pass",
    });
    return target;
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "repository.target",
      message: "Repository remote or target could not be resolved safely.",
      remedy:
        "Use a configured workspace with a GitHub origin, or pass a strict owner/name repository.",
      status: "fail",
    });
    return null;
  }
}

async function inspectGithubRepository(
  report: DoctorReportBuilder,
  ghRunner: GhRunnerLike,
  health: GithubHealth,
  target: string | null,
): Promise<GithubRepositoryIdentity | null> {
  if (target === null) {
    report.add({
      id: "repository.identity",
      message:
        "Repository ID check was skipped because no target was selected.",
      status: "warn",
    });
    return null;
  }
  if (!health.graphql) {
    report.add({
      id: "repository.identity",
      message:
        "Repository ID check was skipped because GraphQL is unavailable.",
      status: "warn",
    });
    return null;
  }
  const [owner, name] = target.split("/") as [string, string];
  try {
    const result = await ghRunner.run([
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_REPOSITORY_GRAPHQL}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]);
    const value = parseJsonObject(result.stdout);
    if (Array.isArray(value.errors) && value.errors.length > 0) {
      throw new TypeError("GitHub returned GraphQL errors");
    }
    const repository = objectProperty(
      objectProperty(value, "data"),
      "repository",
    );
    const identity = {
      currentName: parseRepositoryName(
        stringProperty(repository, "nameWithOwner"),
      ),
      repoId: stringProperty(repository, "id"),
    };
    report.add({
      details: { repo: identity.currentName, repo_id: identity.repoId },
      id: "repository.identity",
      message: "Repository name and stable GitHub node ID resolved.",
      status: "pass",
    });
    return identity;
  } catch (error) {
    report.add({
      details: { error: ghErrorCode(error), repo: target },
      id: "repository.identity",
      message: "Target repository was not accessible through GraphQL.",
      remedy:
        "Check repository spelling, access, SSO authorization, and gh token scopes.",
      status: "fail",
    });
    return null;
  }
}

function bindLocalRepository(
  report: DoctorReportBuilder,
  registry: RegistryInspection | null,
  target: string | null,
  identity: GithubRepositoryIdentity | null,
  storageRoot: string,
): {
  readonly absolutePath: string;
  readonly currentName: string;
  readonly repoId: string;
} | null {
  if (registry === null) {
    report.add({
      id: "repository.local_state",
      message:
        "Local repository state could not be bound because registry is invalid.",
      status: "warn",
    });
    return null;
  }
  const matchesByName =
    target === null
      ? []
      : [...registry.entries.entries()].filter(
          ([, entry]) =>
            entry.currentName === target || entry.aliases.includes(target),
        );
  if (matchesByName.length > 1) {
    report.add({
      id: "repository.local_state",
      message: "Repository name maps to multiple local repository IDs.",
      path: registry.path,
      remedy: "Restore an unambiguous repositories.json from backup.",
      status: "fail",
    });
    return null;
  }
  const byIdentity =
    identity === null ? undefined : registry.entries.get(identity.repoId);
  const byName = matchesByName[0];
  if (
    identity !== null &&
    byName !== undefined &&
    byName[0] !== identity.repoId
  ) {
    report.add({
      details: {
        github_repo_id: identity.repoId,
        registry_repo_id: byName[0],
      },
      id: "repository.local_state",
      message: "Registry name binding conflicts with GitHub repository ID.",
      path: registry.path,
      remedy:
        "Do not reindex into this store; restore the correct registry or repository backup first.",
      status: "fail",
    });
    return null;
  }
  const binding =
    byIdentity === undefined
      ? byName
      : ([identity!.repoId, byIdentity] as const);
  if (binding === undefined) {
    report.add({
      id: "repository.local_state",
      message: "Repository has no local canonical store yet.",
      path: registry.path,
      remedy:
        "Run repo-knowledge ingest for this repository, then rerun doctor.",
      status: "warn",
    });
    return null;
  }
  const [repoId, entry] = binding;
  if (identity !== null && entry.currentName !== identity.currentName) {
    report.add({
      details: {
        github_name: identity.currentName,
        registry_name: entry.currentName,
      },
      id: "repository.local_state",
      message: "Registry uses an older repository name for the same stable ID.",
      path: registry.path,
      remedy:
        "Run a repository-bound ingest after confirming the rename; it will update aliases safely.",
      status: "warn",
    });
  } else {
    report.add({
      details: { repo: entry.currentName, repo_id: repoId },
      id: "repository.local_state",
      message:
        "Local canonical store is bound to the expected stable repository ID.",
      path: join(storageRoot, entry.path),
      status: "pass",
    });
  }
  return {
    absolutePath: join(storageRoot, entry.path),
    currentName: identity?.currentName ?? entry.currentName,
    repoId,
  };
}

function addSkippedRepositoryChecks(report: DoctorReportBuilder): void {
  for (const id of [
    "repository.permissions",
    "canonical.transactions",
    "canonical.files",
    "canonical.domain",
    "canonical.repo_identity",
    "canonical.orphan_evidence",
    "canonical.derived_counts",
    "sqlite.journal",
    "sqlite.projection",
  ]) {
    report.add({
      id,
      message:
        "Check was skipped because no trustworthy local repository store was bound.",
      status: "warn",
    });
  }
}

async function inspectRepositoryPermissions(
  report: DoctorReportBuilder,
  repositoryRoot: string,
): Promise<void> {
  try {
    const metadata = await lstat(repositoryRoot);
    const permission = metadata.mode & 0o777;
    const valid =
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      permission === 0o700;
    report.add(
      valid
        ? {
            id: "repository.permissions",
            message: "Repository storage directory has mode 700.",
            path: repositoryRoot,
            status: "pass",
          }
        : {
            details: { mode: octal(permission) },
            id: "repository.permissions",
            message: "Repository storage must be a mode-700 real directory.",
            path: repositoryRoot,
            remedy: `Inspect ownership, remove symlinks, and run chmod 700 ${repositoryRoot}.`,
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "repository.permissions",
      message: "Repository storage directory is missing or unreadable.",
      path: repositoryRoot,
      status: "fail",
    });
  }
}

async function inspectTransactions(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  repository: string,
): Promise<void> {
  const path = join(repositoryRoot, "transactions");
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      report.add({
        id: "canonical.transactions",
        message: "No unresolved canonical transactions exist.",
        path,
        status: "pass",
      });
      return;
    }
    report.add({
      details: { error: errorCode(error) },
      id: "canonical.transactions",
      message: "Transaction journal could not be inspected.",
      path,
      status: "fail",
    });
    return;
  }
  if (entries.length === 0) {
    report.add({
      id: "canonical.transactions",
      message: "No unresolved canonical transactions exist.",
      path,
      status: "pass",
    });
    return;
  }
  const unresolved = entries
    .sort((a, b) => compareCodeUnits(a.name, b.name))
    .map((entry) => ({
      kind: entry.isDirectory() ? "transaction" : "unexpected-entry",
      name: entry.name,
    }));
  report.add({
    details: { unresolved },
    id: "canonical.transactions",
    message: "Unresolved or malformed canonical transaction entries remain.",
    path,
    remedy: `Run repo-knowledge reindex ${repository} to invoke canonical recovery. If it reports RECOVERY_CONFLICT or UNRECOVERABLE_TRANSACTION, restore the affected target or staged payload before retrying.`,
    status: "fail",
  });
}

async function inspectCanonicalState(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  repoId: string,
  repository: string,
): Promise<CanonicalInspection | null> {
  let capture: ReadOnlyCanonicalStateCapture;
  try {
    capture = await captureCanonicalStateReadOnly(repositoryRoot);
    report.add({
      details: {
        canonical_digest: capture.canonicalDigest,
        knowledge: capture.knowledge.length,
        records: capture.records.length,
      },
      id: "canonical.files",
      message:
        "Canonical Markdown and JSONL are complete, unique, and structurally valid.",
      path: repositoryRoot,
      status: "pass",
    });
  } catch (error) {
    const relativePath =
      error instanceof KnowledgeStoreInvalidError ||
      error instanceof CanonicalJsonlError
        ? error.path
        : null;
    const path =
      relativePath === null
        ? repositoryRoot
        : join(repositoryRoot, relativePath);
    report.add({
      details: { error: errorMessage(error) },
      id: "canonical.files",
      message: "Canonical Markdown or JSONL is invalid.",
      path,
      remedy: `Restore or repair the reported canonical file, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    addSkippedCanonicalChecks(report);
    return null;
  }

  await inspectCanonicalFilePermissions(report, repositoryRoot, capture);
  let domain: DomainProjectionSnapshot;
  try {
    domain = buildDomainProjectionSnapshot(
      capture.records.map((entry) => entry.record),
      capture.knowledge,
    );
    report.add({
      id: "canonical.domain",
      message: "Canonical records reduce to a valid domain state.",
      path: repositoryRoot,
      status: "pass",
    });
  } catch (error) {
    const targetPath =
      error instanceof DomainProjectionError
        ? capture.records.find(
            (entry) => entry.record.record_id === error.recordId,
          )?.targetPath
        : error instanceof KnowledgeStoreInvalidError
          ? error.path
          : undefined;
    report.add({
      details: { error: errorMessage(error) },
      id: "canonical.domain",
      message: "Canonical records do not reduce to a valid domain state.",
      ...(targetPath === undefined
        ? { path: repositoryRoot }
        : { path: join(repositoryRoot, targetPath) }),
      remedy: `Repair or restore the reported canonical source, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    for (const id of [
      "canonical.repo_identity",
      "canonical.orphan_evidence",
      "canonical.derived_counts",
    ]) {
      report.add({
        id,
        message: "Check was skipped because canonical domain reduction failed.",
        status: "warn",
      });
    }
    return null;
  }

  inspectCanonicalRepoIdentity(report, repositoryRoot, capture, repoId);
  inspectOrphanEvidence(report, repositoryRoot, capture, domain, repoId);
  inspectDerivedCounts(
    report,
    repositoryRoot,
    capture.knowledge,
    domain,
    repository,
  );
  return { capture, domain };
}

function addSkippedCanonicalChecks(report: DoctorReportBuilder): void {
  for (const id of [
    "canonical.permissions",
    "canonical.domain",
    "canonical.repo_identity",
    "canonical.orphan_evidence",
    "canonical.derived_counts",
  ]) {
    report.add({
      id,
      message: "Check was skipped because canonical file capture failed.",
      status: "warn",
    });
  }
}

async function inspectCanonicalFilePermissions(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
): Promise<void> {
  const paths = new Set([
    ...capture.knowledge.map((document) => document.path),
    ...capture.records.map((entry) => entry.targetPath),
  ]);
  const invalid: Array<{ mode: string; path: string }> = [];
  for (const path of [...paths].sort(compareCodeUnits)) {
    let metadata;
    try {
      metadata = await lstat(join(repositoryRoot, path));
    } catch (error) {
      report.add({
        details: { error: errorCode(error) },
        id: "canonical.permissions",
        message:
          "A canonical file disappeared or became unreadable during diagnosis.",
        path: join(repositoryRoot, path),
        remedy:
          "Stop concurrent writers, restore the reported canonical file, and rerun doctor.",
        status: "fail",
      });
      return;
    }
    const permission = metadata.mode & 0o777;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      permission !== 0o600
    ) {
      invalid.push({ mode: octal(permission), path });
    }
  }
  report.add(
    invalid.length === 0
      ? {
          id: "canonical.permissions",
          message: "Canonical files are regular mode-600 files.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { invalid },
          id: "canonical.permissions",
          message:
            "One or more canonical files have unsafe type or permissions.",
          path: join(repositoryRoot, invalid[0]!.path),
          remedy:
            "Replace symlinks with trusted regular files and set canonical file modes to 600.",
          status: "fail",
        },
  );
}

function inspectCanonicalRepoIdentity(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
  repoId: string,
): void {
  const mismatches: Array<{
    actual: string;
    expected: string;
    path: string;
    record_id?: string;
  }> = [];
  for (const document of capture.knowledge) {
    if (document.frontmatter.repo_id !== repoId) {
      mismatches.push({
        actual: document.frontmatter.repo_id,
        expected: repoId,
        path: document.path,
      });
    }
  }
  for (const entry of capture.records) {
    const payload = asOptionalObject(entry.record.payload);
    const actual = payload?.repo_id;
    if (typeof actual === "string" && actual !== repoId) {
      mismatches.push({
        actual,
        expected: repoId,
        path: entry.targetPath,
        record_id: entry.record.record_id,
      });
    }
  }
  report.add(
    mismatches.length === 0
      ? {
          id: "canonical.repo_identity",
          message: "Canonical repo_id values match the registry binding.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { mismatches },
          id: "canonical.repo_identity",
          message: "Canonical data contains a different repository ID.",
          path: join(repositoryRoot, mismatches[0]!.path),
          remedy:
            "Do not rewrite IDs automatically; restore data into the correct registry-bound store.",
          status: "fail",
        },
  );
}

function inspectOrphanEvidence(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  capture: ReadOnlyCanonicalStateCapture,
  domain: DomainProjectionSnapshot,
  repoId: string,
): void {
  const knowledge = new Set(
    domain.knowledge
      .filter((item) => item.repoId === repoId)
      .map((item) => item.id),
  );
  const orphaned = domain.evidence
    .filter(
      (evidence) =>
        evidence.repo_id === repoId && !knowledge.has(evidence.knowledge_id),
    )
    .map((evidence) => ({
      evidence_id: evidence.evidence_id,
      knowledge_id: evidence.knowledge_id,
      path: evidencePath(capture, evidence),
      thread_id: evidence.thread_id,
    }));
  report.add(
    orphaned.length === 0
      ? {
          id: "canonical.orphan_evidence",
          message:
            "Every evidence item references an existing knowledge document.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { orphaned },
          id: "canonical.orphan_evidence",
          message:
            "Evidence references missing knowledge, commonly caused by direct Markdown deletion.",
          path:
            orphaned[0]!.path === undefined
              ? repositoryRoot
              : join(repositoryRoot, orphaned[0]!.path),
          remedy:
            "Restore the deleted knowledge Markdown from backup or version control; prefer status transitions over direct deletion.",
          status: "fail",
        },
  );
}

function inspectDerivedCounts(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  documents: readonly KnowledgeDocument[],
  domain: DomainProjectionSnapshot,
  repository: string,
): void {
  const byId = new Map(domain.knowledge.map((item) => [item.id, item]));
  const mismatches: Array<{
    actual: unknown;
    expected: unknown;
    field: string;
    path: string;
  }> = [];
  for (const document of documents) {
    const projected = byId.get(document.frontmatter.id);
    if (projected === undefined) continue;
    compareOptionalDerived(
      mismatches,
      document,
      "evidence_count",
      projected.evidenceCount,
    );
    compareOptionalDerived(
      mismatches,
      document,
      "violation_count",
      projected.violationCount,
    );
    compareOptionalDerived(
      mismatches,
      document,
      "applied_count",
      projected.appliedCount,
    );
    compareOptionalDerived(mismatches, document, "sources", projected.sources);
  }
  report.add(
    mismatches.length === 0
      ? {
          id: "canonical.derived_counts",
          message:
            "Any explicitly stored derived metadata agrees with canonical events.",
          path: repositoryRoot,
          status: "pass",
        }
      : {
          details: { mismatches },
          id: "canonical.derived_counts",
          message: "Stored derived metadata differs from event-derived values.",
          path: join(repositoryRoot, mismatches[0]!.path),
          remedy: `Run repo-knowledge reconcile ${repository} --write-derived-metadata after reviewing canonical events.`,
          status: "warn",
        },
  );
}

function compareOptionalDerived(
  target: Array<{
    actual: unknown;
    expected: unknown;
    field: string;
    path: string;
  }>,
  document: KnowledgeDocument,
  field: string,
  expected: unknown,
): void {
  if (!Object.hasOwn(document.frontmatter, field)) return;
  const actual = document.frontmatter[field];
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    target.push({ actual, expected, field, path: document.path });
  }
}

async function inspectSqliteProjection(
  report: DoctorReportBuilder,
  repositoryRoot: string,
  canonical: CanonicalInspection | null,
  repoId: string,
  repository: string,
): Promise<void> {
  const path = join(repositoryRoot, "index.sqlite");
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    report.add({
      id: "sqlite.journal",
      message: "SQLite projection does not exist.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    report.add({
      id: "sqlite.projection",
      message: "Projection metadata could not be checked without index.sqlite.",
      path,
      status: "warn",
    });
    return;
  }
  const permission = metadata.mode & 0o777;
  if (!metadata.isFile() || metadata.isSymbolicLink() || permission !== 0o600) {
    report.add({
      details: { mode: octal(permission) },
      id: "sqlite.journal",
      message: "index.sqlite must be a mode-600 regular file.",
      path,
      remedy: `Run chmod 600 ${path}, then reindex if integrity checks fail.`,
      status: "fail",
    });
  }

  let databaseBytes: Buffer;
  try {
    databaseBytes = await readFile(path);
  } catch (error) {
    report.add({
      details: { error: errorCode(error) },
      id: "sqlite.journal",
      message: "SQLite projection could not be read without mutation.",
      path,
      remedy: `Restore access to index.sqlite, then run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    report.add({
      id: "sqlite.projection",
      message: "Projection metadata could not be read.",
      path,
      status: "warn",
    });
    return;
  }
  const sqliteHeader = databaseBytes
    .subarray(0, 16)
    .equals(Buffer.from("SQLite format 3\0", "binary"));
  const walHeader =
    sqliteHeader && databaseBytes[18] === 2 && databaseBytes[19] === 2;
  const walPath = `${path}-wal`;
  let pendingWalBytes = 0;
  let walInspectionError: string | null = null;
  try {
    pendingWalBytes = (await lstat(walPath)).size;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      walInspectionError = errorCode(error);
    }
  }

  // A WAL-format database cannot be deserialized directly. Flip only the
  // private in-memory snapshot to rollback format after confirming that no
  // uncheckpointed WAL bytes exist; the on-disk projection is never opened.
  const snapshotBytes = Buffer.from(databaseBytes);
  if (walHeader) {
    snapshotBytes[18] = 1;
    snapshotBytes[19] = 1;
  }
  let database: Database.Database;
  try {
    database = new Database(snapshotBytes, { readonly: true });
  } catch (error) {
    if (permission === 0o600) {
      report.add({
        details: {
          error: errorMessage(error),
          sqlite_header: sqliteHeader,
          ...(walInspectionError === null
            ? {}
            : { wal_error: walInspectionError }),
        },
        id: "sqlite.journal",
        message: "SQLite journal state or database header is invalid.",
        path,
        remedy: `Run repo-knowledge reindex ${repository}.`,
        status: "fail",
      });
    }
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection snapshot could not be opened read-only.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
    return;
  }
  try {
    const quickCheck = String(
      database.pragma("quick_check", { simple: true }),
    ).toLowerCase();
    const journalOk =
      walHeader &&
      pendingWalBytes === 0 &&
      walInspectionError === null &&
      quickCheck === "ok" &&
      permission === 0o600;
    if (permission === 0o600) {
      report.add(
        journalOk
          ? {
              details: {
                journal_mode: "wal",
                pending_wal_bytes: pendingWalBytes,
                quick_check: quickCheck,
              },
              id: "sqlite.journal",
              message:
                "SQLite is private, WAL-backed, fully checkpointed, and passes quick_check.",
              path,
              status: "pass",
            }
          : {
              details: {
                journal_mode: walHeader ? "wal" : "rollback-or-invalid",
                pending_wal_bytes: pendingWalBytes,
                quick_check: quickCheck,
                ...(walInspectionError === null
                  ? {}
                  : { wal_error: walInspectionError }),
              },
              id: "sqlite.journal",
              message:
                "SQLite journal mode, checkpoint state, or integrity is invalid.",
              path,
              remedy: `Run repo-knowledge reindex ${repository}.`,
              status: "fail",
            },
      );
    }

    if (pendingWalBytes > 0 || walInspectionError !== null) {
      report.add({
        details: {
          pending_wal_bytes: pendingWalBytes,
          ...(walInspectionError === null
            ? {}
            : { wal_error: walInspectionError }),
        },
        id: "sqlite.projection",
        message:
          "Projection comparison was skipped because the main database snapshot may not include WAL frames.",
        path,
        remedy:
          "Stop repository writers, allow SQLite to checkpoint, then rerun doctor before deciding whether reindex is necessary.",
        status: "warn",
      });
      return;
    }

    const meta = readProjectionMeta(database);
    const mismatches: Array<Record<string, unknown>> = [];
    if (meta.schema_version !== PROJECTION_SCHEMA_VERSION) {
      mismatches.push({
        actual: meta.schema_version,
        expected: PROJECTION_SCHEMA_VERSION,
        field: "schema_version",
      });
    }
    if (meta.index_dirty !== "false") {
      mismatches.push({
        actual: meta.index_dirty,
        expected: "false",
        field: "index_dirty",
      });
    }
    if (
      canonical !== null &&
      meta.canonical_digest !== canonical.capture.canonicalDigest
    ) {
      mismatches.push({
        actual: meta.canonical_digest,
        expected: canonical.capture.canonicalDigest,
        field: "canonical_digest",
      });
    }
    if (canonical !== null) {
      const checkpointFloor = latestCanonicalTransactionId(canonical.capture);
      const checkpoint = meta.last_committed_transaction_id ?? null;
      const hasCanonicalState =
        canonical.capture.knowledge.length > 0 ||
        canonical.capture.records.length > 0;
      if (hasCanonicalState && checkpoint === null) {
        mismatches.push({
          actual: null,
          expected:
            checkpointFloor === null
              ? "a committed transaction id"
              : `at least ${checkpointFloor}`,
          field: "last_committed_transaction_id",
        });
      } else if (
        checkpointFloor !== null &&
        checkpoint !== null &&
        compareCodeUnits(checkpoint, checkpointFloor) < 0
      ) {
        mismatches.push({
          actual: checkpoint,
          expected: `at least ${checkpointFloor}`,
          field: "last_committed_transaction_id",
        });
      }
      compareProjectionCounts(database, canonical, mismatches);
      compareProjectedKnowledge(database, canonical.domain, repoId, mismatches);
    }
    report.add(
      mismatches.length === 0
        ? {
            details: {
              canonical_digest: meta.canonical_digest,
              checkpoint: meta.last_committed_transaction_id,
            },
            id: "sqlite.projection",
            message:
              "Projection checkpoint, canonical digest, records, and derived counts are current.",
            path,
            status: "pass",
          }
        : {
            details: { mismatches },
            id: "sqlite.projection",
            message:
              "SQLite projection is dirty or differs from canonical state.",
            path,
            remedy: `Run repo-knowledge reindex ${repository}; use reconcile only for optional Markdown metadata.`,
            status: "fail",
          },
    );
  } catch (error) {
    report.add({
      details: { error: errorMessage(error) },
      id: "sqlite.projection",
      message: "SQLite projection schema or metadata could not be inspected.",
      path,
      remedy: `Run repo-knowledge reindex ${repository}.`,
      status: "fail",
    });
  } finally {
    database.close();
  }
}

function readProjectionMeta(
  database: Database.Database,
): Record<string, string | null> {
  const rows = database
    .prepare("SELECT key, value FROM projection_meta ORDER BY key")
    .all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    canonical_digest: values.get("canonical_digest") ?? null,
    index_dirty: values.get("index_dirty") ?? null,
    last_committed_transaction_id:
      values.get("last_committed_transaction_id") ?? null,
    schema_version: values.get("schema_version") ?? null,
  };
}

function latestCanonicalTransactionId(
  capture: ReadOnlyCanonicalStateCapture,
): string | null {
  return capture.records.reduce<string | null>((latest, entry) => {
    const transactionId = entry.record.transaction_id;
    return latest === null || compareCodeUnits(latest, transactionId) < 0
      ? transactionId
      : latest;
  }, null);
}

function compareProjectionCounts(
  database: Database.Database,
  canonical: CanonicalInspection,
  mismatches: Array<Record<string, unknown>>,
): void {
  const expected = new Map<string, number>([
    ["canonical_records", canonical.capture.records.length],
    ["knowledge_documents", canonical.capture.knowledge.length],
    ["knowledge", canonical.domain.knowledge.length],
    ["evidence", canonical.domain.evidence.length],
    ["distill_jobs", canonical.domain.distillJobs.length],
    ["pull_requests", canonical.domain.pullRequests.length],
    ["pull_request_snapshots", canonical.domain.pullRequestSnapshots.length],
    ["review_threads", canonical.domain.threads.length],
    ["review_comments", canonical.domain.comments.length],
    ["revision_proposals", canonical.domain.revisionProposals.length],
    ["submission_receipts", canonical.domain.submissionReceipts.length],
    ["outcomes", canonical.domain.outcomes.length],
  ]);
  for (const [table, count] of expected) {
    const row = database
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .get() as { count: number };
    if (row.count !== count) {
      mismatches.push({ actual: row.count, expected: count, table });
    }
  }
}

function compareProjectedKnowledge(
  database: Database.Database,
  domain: DomainProjectionSnapshot,
  repoId: string,
  mismatches: Array<Record<string, unknown>>,
): void {
  const rows = database
    .prepare(
      `SELECT id, repo_id, evidence_count, violation_count, applied_count,
              not_applicable_count, false_positive_count
       FROM knowledge WHERE repo_id = ? ORDER BY id`,
    )
    .all(repoId) as Array<{
    applied_count: number;
    evidence_count: number;
    false_positive_count: number;
    id: string;
    not_applicable_count: number;
    repo_id: string;
    violation_count: number;
  }>;
  const expected = domain.knowledge
    .filter((item) => item.repoId === repoId)
    .map((item) => ({
      applied_count: item.appliedCount,
      evidence_count: item.evidenceCount,
      false_positive_count: item.falsePositiveCount,
      id: item.id,
      not_applicable_count: item.notApplicableCount,
      repo_id: item.repoId,
      violation_count: item.violationCount,
    }));
  if (canonicalizeJson(rows) !== canonicalizeJson(expected)) {
    mismatches.push({ actual: rows, expected, table: "knowledge counts" });
  }
}

function isSupportedNodeVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || major >= 24;
}

function unsignedFilesystemType(value: bigint | number): number {
  return Number(BigInt.asUintN(32, BigInt(value)));
}

function octal(value: number): string {
  return `0${value.toString(8).padStart(3, "0")}`;
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function ghErrorCode(error: unknown): string {
  return error instanceof GhCommandError ? error.code : errorCode(error);
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 2_048);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function parseJsonObject(value: string): Record<string, unknown> {
  return asObject(JSON.parse(value) as unknown);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

function asOptionalObject(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null
    : (value as Record<string, unknown>);
}

function objectProperty(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asObject(value[key]);
}

function stringProperty(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return item;
}

function stringArrayProperty(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const item = value[key];
  if (
    !Array.isArray(item) ||
    !item.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${key} must be a string array`);
  }
  return item;
}

function evidencePath(
  capture: ReadOnlyCanonicalStateCapture,
  evidence: KnowledgeEvidence,
): string | undefined {
  return capture.records.find((entry) => {
    const payload = asOptionalObject(entry.record.payload);
    return payload?.evidence_id === evidence.evidence_id;
  })?.targetPath;
}

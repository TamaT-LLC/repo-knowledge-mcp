import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { compareCodeUnits } from "../canonical.js";
import type { RepoKnowledgeConfig } from "../domain-schemas.js";
import { parseGitHubRemoteUrl, type GitRemoteReader } from "../git-remote.js";
import type { GhRunnerLike } from "../gh-runner.js";
import { repositoryStorageId } from "../repository-registry.js";
import {
  RESOLVE_REPOSITORY_GRAPHQL,
  parseRepositoryName,
  resolveAllowedWorkspacePath,
} from "../repository-resolver.js";
import { DoctorReportBuilder } from "./report-builder.js";
import {
  asObject,
  decodeUtf8,
  errorCode,
  errorMessage,
  ghErrorCode,
  objectProperty,
  octal,
  parseJsonObject,
  stringArrayProperty,
  stringProperty,
} from "./util.js";

const DOCTOR_GRAPHQL_QUERY = "query RepoKnowledgeDoctor { viewer { login } }";

export interface GithubHealth {
  readonly auth: boolean;
  readonly cli: boolean;
  readonly graphql: boolean;
}

export interface GithubRepositoryIdentity {
  readonly currentName: string;
  readonly repoId: string;
}

interface RegistryEntry {
  readonly aliases: readonly string[];
  readonly currentName: string;
  readonly path: string;
}

export interface RegistryInspection {
  readonly entries: ReadonlyMap<string, RegistryEntry>;
  readonly path: string;
}

export async function inspectGithub(
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

export async function inspectRegistry(
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

export async function resolveDoctorTarget(
  report: DoctorReportBuilder,
  selection: { readonly repo?: string; readonly workspacePath?: string },
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

export async function inspectGithubRepository(
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

export function bindLocalRepository(
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

export function addSkippedRepositoryChecks(report: DoctorReportBuilder): void {
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

export async function inspectRepositoryPermissions(
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

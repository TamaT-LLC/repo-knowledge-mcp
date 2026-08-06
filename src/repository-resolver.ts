import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, sep } from "node:path";

import { z } from "zod";

import { compareCodeUnits, sortAndDedupeStrings } from "./canonical.js";
import {
  GitHubNodeIdSchema,
  RepoKnowledgeConfigSchema,
  RepositoryNameSchema,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import {
  ExecaGitRemoteReader,
  GitRemoteError,
  parseGitHubRemoteUrl,
  type GitRemoteReader,
} from "./git-remote.js";
import type { GhRunnerLike } from "./gh-runner.js";
import {
  type RegisterRepositoryRequest,
  type ResolvedRepository,
} from "./repository-registry.js";

export const RESOLVE_REPOSITORY_GRAPHQL = `query ResolveRepository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
  }
}`;

const GitHubRepositoryResponseSchema = z
  .object({
    data: z
      .object({
        repository: z
          .object({
            id: GitHubNodeIdSchema,
            nameWithOwner: RepositoryNameSchema,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type RepositoryResolutionSource =
  | "config-default-repo"
  | "config-workspace-mapping"
  | "startup-repo"
  | "startup-workspace"
  | "tool-repo"
  | "tool-workspace";

export interface RepositoryResolution extends ResolvedRepository {
  readonly source: RepositoryResolutionSource;
  readonly workspacePath?: string;
}

export interface RepositoryResolutionInput {
  readonly repo?: string;
  readonly workspacePath?: string;
}

export interface RepositoryRegistryWriter {
  register(request: RegisterRepositoryRequest): Promise<ResolvedRepository>;
}

export interface RepositoryResolverOptions {
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly config: RepoKnowledgeConfig;
  readonly cwd?: string;
  readonly ghRunner: GhRunnerLike;
  readonly gitRemoteReader?: GitRemoteReader;
  readonly registry: RepositoryRegistryWriter;
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export type RepositoryResolutionErrorCode =
  | "GITHUB_GRAPHQL_ERROR"
  | "GITHUB_RESPONSE_INVALID"
  | "INVALID_REPOSITORY_NAME"
  | "REPOSITORY_NOT_FOUND"
  | "REPOSITORY_UNRESOLVED"
  | "WORKSPACE_MAPPING_AMBIGUOUS"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_UNSAFE";

export interface RepositoryResolutionErrorDetails {
  readonly candidates?: readonly string[];
  readonly diagnostics?: readonly string[];
  readonly guidance?: readonly string[];
}

export class RepositoryResolutionError extends Error {
  readonly candidates: readonly string[];
  readonly diagnostics: readonly string[];
  readonly guidance: readonly string[];

  constructor(
    readonly code: RepositoryResolutionErrorCode,
    message: string,
    details: RepositoryResolutionErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RepositoryResolutionError";
    this.candidates = [...(details.candidates ?? [])];
    this.diagnostics = [...(details.diagnostics ?? [])];
    this.guidance = [...(details.guidance ?? [])];
  }
}

interface GitHubRepositoryIdentity {
  readonly nameWithOwner: string;
  readonly repoId: string;
}

interface WorkspaceMapping {
  readonly repository: string;
  readonly root: string;
}

/** Resolves every supported input route to a node ID and stable registry path. */
export class RepositoryResolver {
  private readonly allowedWorkspaceRoots: readonly string[];
  private readonly config: RepoKnowledgeConfig;
  private readonly cwd: string;
  private readonly ghRunner: GhRunnerLike;
  private readonly gitRemoteReader: GitRemoteReader;
  private readonly registry: RepositoryRegistryWriter;
  private readonly startupRepo: string | undefined;
  private readonly startupWorkspace: string | undefined;

  constructor(options: RepositoryResolverOptions) {
    this.allowedWorkspaceRoots = [...(options.allowedWorkspaceRoots ?? [])];
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.cwd = options.cwd ?? process.cwd();
    this.ghRunner = options.ghRunner;
    this.gitRemoteReader =
      options.gitRemoteReader ?? new ExecaGitRemoteReader();
    this.registry = options.registry;
    this.startupRepo = options.startupRepo;
    this.startupWorkspace = options.startupWorkspace;
  }

  async resolve(
    input: RepositoryResolutionInput = {},
  ): Promise<RepositoryResolution> {
    const diagnostics: string[] = [];

    if (input.repo !== undefined) {
      return this.resolveName(input.repo, "tool-repo");
    }

    let toolWorkspace: string | undefined;
    if (input.workspacePath !== undefined) {
      toolWorkspace = await this.resolvePermittedWorkspace(input.workspacePath);
      const remote = await this.tryReadRemote(toolWorkspace, diagnostics);
      if (remote !== null) {
        return this.resolveName(remote, "tool-workspace", toolWorkspace);
      }
    }

    if (this.startupRepo !== undefined) {
      return this.resolveName(this.startupRepo, "startup-repo");
    }

    let startupWorkspace: string | undefined;
    if (this.startupWorkspace !== undefined) {
      startupWorkspace = await this.resolvePermittedWorkspace(
        this.startupWorkspace,
      );
      const remote = await this.tryReadRemote(startupWorkspace, diagnostics);
      if (remote !== null) {
        return this.resolveName(remote, "startup-workspace", startupWorkspace);
      }
    }

    if (Object.keys(this.config.workspaceMappings).length > 0) {
      let mappingWorkspace = toolWorkspace ?? startupWorkspace;
      if (mappingWorkspace === undefined) {
        try {
          mappingWorkspace = await canonicalWorkspace(this.cwd);
        } catch (error) {
          if (!(error instanceof RepositoryResolutionError)) throw error;
          diagnostics.push(error.message);
        }
      }
      if (mappingWorkspace !== undefined) {
        const mapping = await this.findWorkspaceMapping(
          mappingWorkspace,
          diagnostics,
        );
        if (mapping !== null) {
          return this.resolveName(
            mapping.repository,
            "config-workspace-mapping",
            mappingWorkspace,
          );
        }
      }
    }

    if (this.config.defaultRepo !== undefined) {
      return this.resolveName(this.config.defaultRepo, "config-default-repo");
    }

    throw this.unresolvedError(diagnostics);
  }

  private async resolveName(
    value: string,
    source: RepositoryResolutionSource,
    workspacePath?: string,
  ): Promise<RepositoryResolution> {
    const requestedName = parseRepositoryName(value);
    const identity = await this.lookupRepository(requestedName);
    const aliases =
      requestedName === identity.nameWithOwner ? [] : [requestedName];
    const registered = await this.registry.register({
      aliases,
      currentName: identity.nameWithOwner,
      repoId: identity.repoId,
    });
    return {
      ...registered,
      source,
      ...(workspacePath === undefined ? {} : { workspacePath }),
    };
  }

  private async lookupRepository(
    repository: string,
  ): Promise<GitHubRepositoryIdentity> {
    const [owner, name] = repository.split("/");
    if (owner === undefined || name === undefined) {
      throw invalidRepositoryName(repository);
    }
    const result = await this.ghRunner.run([
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_REPOSITORY_GRAPHQL}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ]);

    let rawResponse: unknown;
    try {
      rawResponse = JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new RepositoryResolutionError(
        "GITHUB_RESPONSE_INVALID",
        "gh returned non-JSON repository data",
        { diagnostics: [result.stderr] },
        { cause: error },
      );
    }
    const parsed = GitHubRepositoryResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new RepositoryResolutionError(
        "GITHUB_RESPONSE_INVALID",
        "GitHub repository response did not match the expected schema",
        { diagnostics: [parsed.error.message] },
        { cause: parsed.error },
      );
    }
    if ((parsed.data.errors?.length ?? 0) > 0) {
      throw new RepositoryResolutionError(
        "GITHUB_GRAPHQL_ERROR",
        "GitHub returned GraphQL errors; partial data was rejected",
        {
          diagnostics: [truncate(JSON.stringify(parsed.data.errors))],
        },
      );
    }
    const resolved = parsed.data.data?.repository;
    if (resolved === undefined || resolved === null) {
      throw new RepositoryResolutionError(
        "REPOSITORY_NOT_FOUND",
        `GitHub repository ${repository} was not found or is not accessible`,
      );
    }
    return { nameWithOwner: resolved.nameWithOwner, repoId: resolved.id };
  }

  private async resolvePermittedWorkspace(value: string): Promise<string> {
    const roots = [
      ...this.allowedWorkspaceRoots,
      ...Object.keys(this.config.workspaceMappings),
      ...(this.startupWorkspace === undefined ? [] : [this.startupWorkspace]),
    ];
    return resolveAllowedWorkspacePath(value, roots);
  }

  private async tryReadRemote(
    workspacePath: string,
    diagnostics: string[],
  ): Promise<string | null> {
    try {
      return parseGitHubRemoteUrl(
        await this.gitRemoteReader.readOrigin(workspacePath),
      );
    } catch (error) {
      if (!(error instanceof GitRemoteError)) throw error;
      diagnostics.push(error.message);
      return null;
    }
  }

  private async findWorkspaceMapping(
    workspacePath: string,
    diagnostics: string[],
  ): Promise<WorkspaceMapping | null> {
    const matches: WorkspaceMapping[] = [];
    for (const [configuredRoot, repository] of Object.entries(
      this.config.workspaceMappings,
    )) {
      let root: string;
      try {
        root = await canonicalWorkspace(configuredRoot);
      } catch (error) {
        if (!(error instanceof RepositoryResolutionError)) throw error;
        diagnostics.push(error.message);
        continue;
      }
      if (isWithin(root, workspacePath)) matches.push({ repository, root });
    }
    matches.sort((left, right) => {
      const lengthOrder = right.root.length - left.root.length;
      return lengthOrder !== 0
        ? lengthOrder
        : compareCodeUnits(left.repository, right.repository);
    });
    const best = matches[0];
    if (best === undefined) return null;
    const equallySpecific = matches.filter(
      (candidate) => candidate.root.length === best.root.length,
    );
    const repositories = sortAndDedupeStrings(
      equallySpecific.map((candidate) => candidate.repository),
    );
    if (repositories.length > 1) {
      throw new RepositoryResolutionError(
        "WORKSPACE_MAPPING_AMBIGUOUS",
        `Workspace ${workspacePath} matches conflicting mappings`,
        { candidates: repositories },
      );
    }
    return best;
  }

  private unresolvedError(diagnostics: readonly string[]): Error {
    const candidates = sortAndDedupeStrings([
      ...this.config.repos,
      ...Object.values(this.config.workspaceMappings),
      ...(this.startupRepo === undefined ? [] : [this.startupRepo]),
    ]);
    const guidance = [
      "Pass repo as a strict owner/name argument.",
      "Pass workspace_path under an allowed workspace root or configure workspaceMappings.",
      "Set --repo/--workspace at startup or set defaultRepo in config.json.",
    ];
    const candidateMessage =
      candidates.length === 0 ? "none configured" : candidates.join(", ");
    return new RepositoryResolutionError(
      "REPOSITORY_UNRESOLVED",
      `Unable to resolve a repository. Candidates: ${candidateMessage}. ${guidance.join(" ")}`,
      { candidates, diagnostics, guidance },
    );
  }
}

/** Realpaths a workspace and proves it is inside at least one configured root. */
export async function resolveAllowedWorkspacePath(
  workspacePath: string,
  allowedRoots: readonly string[],
): Promise<string> {
  if (allowedRoots.length === 0) {
    throw new RepositoryResolutionError(
      "WORKSPACE_PATH_UNSAFE",
      "No allowed workspace roots are configured",
    );
  }
  const roots: Array<{ canonical: string; lexical: string }> = [];
  const diagnostics: string[] = [];
  for (const root of allowedRoots) {
    try {
      const lexical = normalizeWorkspaceSyntax(root);
      roots.push({ canonical: await canonicalWorkspace(lexical), lexical });
    } catch (error) {
      if (!(error instanceof RepositoryResolutionError)) throw error;
      diagnostics.push(error.message);
    }
  }
  const lexicalWorkspace = normalizeWorkspaceSyntax(workspacePath);
  if (
    !roots.some(
      (root) =>
        isWithin(root.lexical, lexicalWorkspace) ||
        isWithin(root.canonical, lexicalWorkspace),
    )
  ) {
    throw new RepositoryResolutionError(
      "WORKSPACE_PATH_UNSAFE",
      "Workspace path is outside all allowed workspace roots",
      {
        diagnostics: [...roots.map((root) => root.canonical), ...diagnostics],
      },
    );
  }
  const workspace = await canonicalWorkspace(lexicalWorkspace);
  if (!roots.some((root) => isWithin(root.canonical, workspace))) {
    throw new RepositoryResolutionError(
      "WORKSPACE_PATH_UNSAFE",
      `Workspace ${workspace} is outside all allowed workspace roots`,
      {
        diagnostics: [...roots.map((root) => root.canonical), ...diagnostics],
      },
    );
  }
  return workspace;
}

export function parseRepositoryName(value: string): string {
  const parsed = RepositoryNameSchema.safeParse(value);
  if (!parsed.success) throw invalidRepositoryName(value, parsed.error);
  return parsed.data;
}

async function canonicalWorkspace(value: string): Promise<string> {
  const normalized = normalizeWorkspaceSyntax(value);
  let canonical: string;
  try {
    canonical = await realpath(normalized);
  } catch (error) {
    throw new RepositoryResolutionError(
      "WORKSPACE_NOT_FOUND",
      `Workspace path cannot be resolved: ${normalized}`,
      {},
      { cause: error },
    );
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(canonical)).isDirectory();
  } catch (error) {
    throw new RepositoryResolutionError(
      "WORKSPACE_NOT_FOUND",
      `Workspace path disappeared while it was being resolved: ${canonical}`,
      {},
      { cause: error },
    );
  }
  if (!isDirectory) {
    throw new RepositoryResolutionError(
      "WORKSPACE_PATH_UNSAFE",
      `Workspace path is not a directory: ${canonical}`,
    );
  }
  return canonical;
}

function normalizeWorkspaceSyntax(value: string): string {
  if (
    value.length === 0 ||
    !isAbsolute(value) ||
    value.split(/[\\/]+/u).includes("..")
  ) {
    throw new RepositoryResolutionError(
      "WORKSPACE_PATH_UNSAFE",
      `Workspace path must be absolute and must not contain '..': ${JSON.stringify(value)}`,
    );
  }
  return normalize(value);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function invalidRepositoryName(
  value: string,
  cause?: unknown,
): RepositoryResolutionError {
  return new RepositoryResolutionError(
    "INVALID_REPOSITORY_NAME",
    `Repository must use a strict owner/name form: ${JSON.stringify(value)}`,
    {},
    cause === undefined ? undefined : { cause },
  );
}

function truncate(value: string, maxLength = 2_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

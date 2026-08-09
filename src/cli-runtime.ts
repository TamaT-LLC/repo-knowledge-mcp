import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { Transport } from "@modelcontextprotocol/server";

import {
  runRepoKnowledgeCli,
  type CliRepositoryOperationsResolver,
  type RepoKnowledgeCliIo,
} from "./cli.js";
import { CanonicalCliRepositoryOperationsResolver } from "./cli-maintenance-service.js";
import { initializeStorage, updateRepoKnowledgeConfig } from "./config.js";
import { loadDistillationPrompt } from "./distillation-prompt.js";
import { reduceDomainRecords } from "./domain-projection.js";
import type { RepoKnowledgeConfig } from "./domain-schemas.js";
import { RepoKnowledgeDoctor } from "./doctor-service.js";
import { GhRunner, type GhRunnerLike } from "./gh-runner.js";
import {
  ExecaGitRemoteReader,
  GitRemoteError,
  parseGitHubRemoteUrl,
  type GitRemoteReader,
} from "./git-remote.js";
import {
  CanonicalKnowledgeMutationServiceResolver,
  type KnowledgeMutationServiceResolver,
} from "./mcp-mutation-tools.js";
import {
  CanonicalKnowledgeReadServiceResolver,
  serveRepoKnowledgeStdio,
  type KnowledgeReadServiceResolver,
} from "./mcp-server.js";
import { DefaultRepositoryApplicationFactory } from "./repository-application.js";
import {
  RepositoryRegistry,
  repositoryStorageId,
} from "./repository-registry.js";
import {
  RepositoryResolver,
  resolveAllowedWorkspacePath,
  type RepositoryResolution,
} from "./repository-resolver.js";
import {
  collectSetupTrustCandidates,
  GuidedSetupError,
  GuidedSetupService,
  type GuidedSetupDependencies,
  type GuidedSetupRequest,
} from "./setup-service.js";
import { SetupStateStore } from "./setup-state-store.js";
import { captureCanonicalStateReadOnly } from "./sqlite-projection.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";

export interface DefaultCliRuntime {
  readonly mutationServiceResolver: KnowledgeMutationServiceResolver;
  readonly operationsResolver: CliRepositoryOperationsResolver;
  readonly readServiceResolver: KnowledgeReadServiceResolver;
  serve(request: {
    readonly startupRepo?: string;
    readonly startupWorkspace?: string;
  }): ReturnType<typeof serveRepoKnowledgeStdio>;
}

export interface CreateDefaultCliRuntimeOptions {
  readonly clock?: () => Date;
  readonly cwd?: string;
  readonly ghRunner?: GhRunnerLike;
  readonly gitRemoteReader?: GitRemoteReader;
  readonly promptPath?: string;
  readonly repositoryContext?: unknown;
  readonly storageRoot?: string;
  readonly transport?: Transport;
}

export interface RunDefaultRepoKnowledgeCliOptions extends CreateDefaultCliRuntimeOptions {
  readonly argv?: readonly string[];
  readonly io?: RepoKnowledgeCliIo;
}

/** Creates the production dependency graph without writing to stdout. */
export async function createDefaultCliRuntime(
  options: CreateDefaultCliRuntimeOptions = {},
): Promise<DefaultCliRuntime> {
  const storageRoot = defaultStorageRoot(options.storageRoot);
  const storage = await initializeStorage(storageRoot);
  const prompt = await loadDistillationPrompt(
    options.promptPath ??
      fileURLToPath(new URL("../prompts/distill.md", import.meta.url)),
  );
  const ghRunner = options.ghRunner ?? new GhRunner();
  const registry = new RepositoryRegistry(storage.rootPath);
  const allowedWorkspaceRoots = Object.keys(storage.config.workspaceMappings);
  const applicationFactory = new DefaultRepositoryApplicationFactory({
    config: storage.config,
    ghRunner,
    prompt,
    repositoryContext: options.repositoryContext ?? {},
  });
  const resolverOptions = {
    allowedWorkspaceRoots,
    config: storage.config,
    ghRunner,
    registry,
  };
  const mutationServiceResolver = new CanonicalKnowledgeMutationServiceResolver(
    {
      ...resolverOptions,
      pipelineFactory: applicationFactory,
    },
  );
  const operationsResolver = new CanonicalCliRepositoryOperationsResolver({
    ...resolverOptions,
    operationsFactory: applicationFactory,
  });
  const readServiceResolver = new CanonicalKnowledgeReadServiceResolver(
    resolverOptions,
  );
  return {
    mutationServiceResolver,
    operationsResolver,
    readServiceResolver,
    serve(request) {
      return serveRepoKnowledgeStdio({
        mutationServiceResolver,
        readServiceResolver,
        ...(request.startupRepo === undefined
          ? {}
          : { startupRepo: request.startupRepo }),
        ...(request.startupWorkspace === undefined
          ? {}
          : { startupWorkspace: request.startupWorkspace }),
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
      });
    },
  };
}

/** Lazily initializes storage so help/bootstrap remain side-effect free. */
export async function runDefaultRepoKnowledgeCli(
  options: RunDefaultRepoKnowledgeCliOptions = {},
): Promise<number> {
  const storageRoot = defaultStorageRoot(options.storageRoot);
  const ghRunner = options.ghRunner ?? new GhRunner();
  let runtime: Promise<DefaultCliRuntime> | undefined;
  const loadRuntime = (): Promise<DefaultCliRuntime> => {
    runtime ??= createDefaultCliRuntime({
      ...options,
      ghRunner,
      storageRoot,
    });
    return runtime;
  };
  return runRepoKnowledgeCli({
    argv: options.argv ?? process.argv.slice(2),
    doctor: new RepoKnowledgeDoctor({
      ghRunner,
      storageRoot,
    }),
    io: options.io ?? processCliIo(),
    mutationServiceResolver: {
      async resolve(input) {
        return (await loadRuntime()).mutationServiceResolver.resolve(input);
      },
    },
    operationsResolver: {
      async resolve(input) {
        return (await loadRuntime()).operationsResolver.resolve(input);
      },
    },
    async setup(request, prompt) {
      return createGuidedSetupService({
        ...options,
        ghRunner,
        storageRoot,
      }).run(request, prompt);
    },
    async serve(request) {
      (await loadRuntime()).serve(request);
    },
  });
}

function defaultStorageRoot(explicit: string | undefined): string {
  return (
    explicit ??
    process.env.REPO_KNOWLEDGE_HOME ??
    join(homedir(), ".repo-knowledge")
  );
}

function processCliIo(): RepoKnowledgeCliIo {
  return {
    async confirm(request) {
      const suffix = request.defaultValue ? "[Y/n]" : "[y/N]";
      const terminal = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        for (;;) {
          const answer = (
            await terminal.question(`${request.message} ${suffix} `)
          )
            .trim()
            .toLocaleLowerCase("en-US");
          if (answer.length === 0) return request.defaultValue;
          if (answer === "y" || answer === "yes") return true;
          if (answer === "n" || answer === "no") return false;
          process.stderr.write("Please answer yes or no.\n");
        }
      } finally {
        terminal.close();
      }
    },
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    writeStderr(value) {
      process.stderr.write(value);
    },
    writeStdout(value) {
      process.stdout.write(value);
    },
  };
}

interface CreateGuidedSetupServiceOptions extends CreateDefaultCliRuntimeOptions {
  readonly ghRunner: GhRunnerLike;
  readonly storageRoot: string;
}

function createGuidedSetupService(
  options: CreateGuidedSetupServiceOptions,
): GuidedSetupService {
  const cwd = options.cwd ?? process.cwd();
  const gitRemoteReader = options.gitRemoteReader ?? new ExecaGitRemoteReader();
  const runtime = () =>
    createDefaultCliRuntime({
      ...options,
      ghRunner: options.ghRunner,
      storageRoot: options.storageRoot,
    });
  const dependencies: GuidedSetupDependencies = {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    async hasSyncCheckpoint(repository) {
      return (
        (await new SyncCheckpointStore(repository.absolutePath).read()) !== null
      );
    },
    initializeStorage: () => initializeStorage(options.storageRoot),
    async prepareRepository(repository) {
      const current = await runtime();
      const operations = await current.operationsResolver.resolve({
        repo: repository.currentName,
      });
      await operations.reindex();
    },
    async readTrustCandidates(repository, config) {
      const capture = await captureCanonicalStateReadOnly(
        repository.absolutePath,
      );
      const domain = reduceDomainRecords(
        capture.records.map((record) => record.record),
      );
      return collectSetupTrustCandidates(domain.comments, config);
    },
    async redistill(repository) {
      const current = await runtime();
      const operations = await current.operationsResolver.resolve({
        repo: repository.currentName,
      });
      return operations.redistill({ selector: "outdated" });
    },
    resolveRepository: (request, config) =>
      resolveSetupRepository(request, config, {
        cwd,
        ghRunner: options.ghRunner,
        gitRemoteReader,
        storageRoot: options.storageRoot,
      }),
    runDoctor: (repository) =>
      new RepoKnowledgeDoctor({
        cwd,
        ghRunner: options.ghRunner,
        gitRemoteReader,
        storageRoot: options.storageRoot,
      }).run({ repo: repository.currentName }),
    stateStore: (repository) => new SetupStateStore(repository.absolutePath),
    async sync(repository, request) {
      const current = await runtime();
      const operations = await current.mutationServiceResolver.resolve({
        repo: repository.currentName,
      });
      return operations.syncRepo(request);
    },
    updateConfig: (configPath, update) =>
      updateRepoKnowledgeConfig(configPath, update),
  };
  return new GuidedSetupService(dependencies);
}

async function resolveSetupRepository(
  request: GuidedSetupRequest,
  config: RepoKnowledgeConfig,
  options: {
    readonly cwd: string;
    readonly ghRunner: GhRunnerLike;
    readonly gitRemoteReader: GitRemoteReader;
    readonly storageRoot: string;
  },
): Promise<RepositoryResolution> {
  const registry = new RepositoryRegistry(options.storageRoot);
  const candidateWorkspace = request.workspacePath ?? options.cwd;
  let workspacePath: string | undefined;
  let remoteRepository: string | undefined;
  try {
    workspacePath = await resolveAllowedWorkspacePath(candidateWorkspace, [
      candidateWorkspace,
    ]);
    remoteRepository = parseGitHubRemoteUrl(
      await options.gitRemoteReader.readOrigin(workspacePath),
    );
  } catch (error) {
    const implicitWorkspaceWithoutRemote =
      request.workspacePath === undefined &&
      request.repo !== undefined &&
      error instanceof GitRemoteError;
    if (!implicitWorkspaceWithoutRemote) throw error;
    workspacePath = undefined;
  }

  const resolver = new RepositoryResolver({
    allowedWorkspaceRoots: workspacePath === undefined ? [] : [workspacePath],
    config,
    cwd: options.cwd,
    ghRunner: options.ghRunner,
    gitRemoteReader: options.gitRemoteReader,
    registry: {
      async register(discovered) {
        const path = `repos/${repositoryStorageId(discovered.repoId)}`;
        return {
          absolutePath: join(options.storageRoot, path),
          aliases: [...(discovered.aliases ?? [])],
          currentName: discovered.currentName,
          path,
          repoId: discovered.repoId,
        };
      },
    },
  });
  const explicit =
    request.repo === undefined
      ? null
      : await resolver.resolve({ repo: request.repo });
  const remote =
    remoteRepository === undefined
      ? null
      : await resolver.resolve({ repo: remoteRepository });
  if (
    explicit !== null &&
    remote !== null &&
    explicit.repoId !== remote.repoId
  ) {
    throw new GuidedSetupError(
      "SETUP_REPOSITORY_MISMATCH",
      `requested repository ${explicit.currentName} does not match workspace remote ${remote.currentName}`,
      {
        requested_repo_id: explicit.repoId,
        workspace_repo_id: remote.repoId,
      },
    );
  }
  const resolved = explicit ?? remote;
  if (resolved === null) {
    throw new GuidedSetupError(
      "SETUP_REPOSITORY_MISMATCH",
      "setup requires an owner/name repository or a workspace with a GitHub origin",
    );
  }
  const registered = await registry.register({
    aliases: resolved.aliases,
    currentName: resolved.currentName,
    repoId: resolved.repoId,
  });
  return {
    ...registered,
    source: explicit === null ? "tool-workspace" : resolved.source,
    ...(workspacePath === undefined ? {} : { workspacePath }),
  };
}

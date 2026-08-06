import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Transport } from "@modelcontextprotocol/server";

import {
  runRepoKnowledgeCli,
  type CliRepositoryOperationsResolver,
  type RepoKnowledgeCliIo,
} from "./cli.js";
import { CanonicalCliRepositoryOperationsResolver } from "./cli-maintenance-service.js";
import { initializeStorage } from "./config.js";
import { loadDistillationPrompt } from "./distillation-prompt.js";
import { RepoKnowledgeDoctor } from "./doctor-service.js";
import { GhRunner, type GhRunnerLike } from "./gh-runner.js";
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
import { RepositoryRegistry } from "./repository-registry.js";

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
  readonly ghRunner?: GhRunnerLike;
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

import { homedir } from "node:os";
import { join } from "node:path";

import type { Transport } from "@modelcontextprotocol/server";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { initializeStorage } from "./config.js";
import { GhRunner, type GhRunnerLike } from "./gh-runner.js";
import type { KnowledgeMutationServiceResolver } from "./mcp-mutation-tools.js";
import {
  CanonicalKnowledgeReadServiceResolver,
  serveRepoKnowledgeStdio,
} from "./mcp-server.js";
import { RepositoryRegistry } from "./repository-registry.js";
import { parseRepositoryName } from "./repository-resolver.js";

export interface StdioEntrySelection {
  readonly startupRepo?: string;
  readonly startupWorkspace?: string;
}

export interface ServeDefaultRepoKnowledgeStdioOptions {
  readonly argv?: readonly string[];
  readonly ghRunner?: GhRunnerLike;
  readonly mutationServiceResolver?: KnowledgeMutationServiceResolver;
  readonly storageRoot?: string;
  readonly transport?: Transport;
}

/** Builds the default read runtime and starts the stdio server. */
export async function serveDefaultRepoKnowledgeStdio(
  options: ServeDefaultRepoKnowledgeStdioOptions = {},
): Promise<StdioServerHandle> {
  const selection = parseStdioEntryArguments(
    options.argv ?? process.argv.slice(2),
  );
  const storage = await initializeStorage(
    options.storageRoot ??
      process.env.REPO_KNOWLEDGE_HOME ??
      join(homedir(), ".repo-knowledge"),
  );
  const readServiceResolver = new CanonicalKnowledgeReadServiceResolver({
    allowedWorkspaceRoots: Object.keys(storage.config.workspaceMappings),
    config: storage.config,
    ghRunner: options.ghRunner ?? new GhRunner(),
    registry: new RepositoryRegistry(storage.rootPath),
  });

  return serveRepoKnowledgeStdio({
    mutationServiceResolver:
      options.mutationServiceResolver ?? unavailableMutationServiceResolver(),
    readServiceResolver,
    ...(selection.startupRepo === undefined
      ? {}
      : { startupRepo: selection.startupRepo }),
    ...(selection.startupWorkspace === undefined
      ? {}
      : { startupWorkspace: selection.startupWorkspace }),
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
  });
}

function unavailableMutationServiceResolver(): KnowledgeMutationServiceResolver {
  return {
    async resolve() {
      throw new MutationRuntimeUnavailableError();
    },
  };
}

class MutationRuntimeUnavailableError extends Error {
  readonly code = "MUTATION_RUNTIME_UNAVAILABLE";

  constructor() {
    super(
      "Mutation services require an application runtime; inject mutationServiceResolver when starting this stdio entry",
    );
    this.name = "MutationRuntimeUnavailableError";
  }
}

/** Parses the two startup selectors supported by the dedicated stdio entry. */
export function parseStdioEntryArguments(
  argv: readonly string[],
): StdioEntrySelection {
  let startupRepo: string | undefined;
  let startupWorkspace: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const equal = token.indexOf("=");
    const name = token.slice(0, equal < 0 ? undefined : equal);
    if (name !== "--repo" && name !== "--workspace") {
      throw new TypeError(`unsupported stdio option: ${token}`);
    }
    const value =
      equal >= 0 ? token.slice(equal + 1) : requireValue(argv, ++index, name);
    if (value.trim().length === 0) {
      throw new TypeError(`${name} requires a non-empty value`);
    }
    if (name === "--repo") {
      if (startupRepo !== undefined) throw new TypeError("--repo was repeated");
      startupRepo = parseRepositoryName(value);
    } else {
      if (startupWorkspace !== undefined) {
        throw new TypeError("--workspace was repeated");
      }
      startupWorkspace = value;
    }
  }

  if (startupRepo !== undefined && startupWorkspace !== undefined) {
    throw new TypeError("--repo and --workspace are mutually exclusive");
  }
  return {
    ...(startupRepo === undefined ? {} : { startupRepo }),
    ...(startupWorkspace === undefined ? {} : { startupWorkspace }),
  };
}

function requireValue(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

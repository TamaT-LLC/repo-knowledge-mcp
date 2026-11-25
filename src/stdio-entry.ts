import { GlobalStore } from "./global-store.js";
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
import {
  parseRepositoryName,
  RepositoryResolver,
} from "./repository-resolver.js";

export interface StdioEntrySelection {
  readonly allowAlwaysReturnChanges?: boolean;
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
  const resolverOptions = {
    allowedWorkspaceRoots: Object.keys(storage.config.workspaceMappings),
    config: storage.config,
    ghRunner: options.ghRunner ?? new GhRunner(),
    registry: new RepositoryRegistry(storage.rootPath),
    globalStore: new GlobalStore(storage.rootPath),
  };
  const readServiceResolver = new CanonicalKnowledgeReadServiceResolver(
    resolverOptions,
  );

  return serveRepoKnowledgeStdio({
    ...(selection.allowAlwaysReturnChanges
      ? { allowAlwaysReturnChanges: true }
      : {}),
    mutationServiceResolver: options.mutationServiceResolver ?? {
      async resolve() {
        throw new MutationRuntimeUnavailableError();
      },
      async setGlobalAlwaysReturn(input, id, enabled) {
        const { repoId } = await new RepositoryResolver({
          ...resolverOptions,
          ...input,
        }).resolve(input);
        return resolverOptions.globalStore.setAlwaysReturn(id, enabled, {
          actor: "mcp",
          caller_repo_id: repoId,
        });
      },
    },
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
  const options = new Map<string, string | true>();
  const tokens = argv.values();
  for (const token of tokens) {
    if (token === "--allow-always-return-changes") {
      if (options.has(token))
        throw new TypeError("duplicate --allow-always-return-changes");
      options.set(token, true);
      continue;
    }
    const equal = token.indexOf("=");
    const name = token.slice(0, equal < 0 ? undefined : equal);
    if (name !== "--repo" && name !== "--workspace") {
      throw new TypeError(`unsupported stdio option: ${token}`);
    }
    const value =
      equal >= 0
        ? token.slice(equal + 1)
        : requireValue(tokens.next().value, name);
    if (value.trim().length === 0)
      throw new TypeError(`${name} requires a non-empty value`);
    if (options.has(name)) throw new TypeError(`${name} was repeated`);
    options.set(name, name === "--repo" ? parseRepositoryName(value) : value);
  }
  const startupRepo = options.get("--repo");
  const startupWorkspace = options.get("--workspace");
  if (startupRepo !== undefined && startupWorkspace !== undefined) {
    throw new TypeError("--repo and --workspace are mutually exclusive");
  }
  return {
    ...(options.has("--allow-always-return-changes")
      ? { allowAlwaysReturnChanges: true }
      : {}),
    ...(typeof startupRepo === "string" ? { startupRepo } : {}),
    ...(typeof startupWorkspace === "string" ? { startupWorkspace } : {}),
  };
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { compareCodeUnits } from "./canonical.js";
import {
  DEFAULT_CONFIG_FILE_NAME,
  loadRepoKnowledgeConfig,
  RepoKnowledgeConfigError,
} from "./config.js";
import { buildDomainProjectionSnapshot } from "./domain-projection.js";
import type { RepoKnowledgeConfig } from "./domain-schemas.js";
import { GLOBAL_STORE_ID } from "./global-always-return.js";
import { GlobalStore } from "./global-store.js";
import { RepositoryRegistry } from "./repository-registry.js";
import {
  canonicalWorkspace,
  findWorkspaceMapping,
  RepositoryResolutionError,
} from "./repository-resolver.js";
import { captureCanonicalStateReadOnly } from "./sqlite-projection.js";

export const RULE_EXPORT_FORMATS = ["claude-md", "agents-md"] as const;
export const RULE_EXPORT_STORES = ["repository", "global", "all"] as const;
export const RULE_EXPORT_ORIGINS = ["conversation", "all"] as const;

export type RuleExportFormat = (typeof RULE_EXPORT_FORMATS)[number];
export type RuleExportStore = (typeof RULE_EXPORT_STORES)[number];
export type RuleExportOrigin = (typeof RULE_EXPORT_ORIGINS)[number];

export interface RuleExportRequest {
  readonly origin: RuleExportOrigin;
  /** Only for the repository store; the global store is never selected by name. */
  readonly repo?: string;
  readonly store: RuleExportStore;
}

export interface ExportedRule {
  /** True only for `enforcement_hint.kind: hook`; anything else is prose. */
  readonly hook: boolean;
  readonly id: string;
  readonly rule: string;
  readonly store: "global" | "repository";
}

export interface RuleExportResult {
  /** Repository rules first, then global rules; each ordered by knowledge ID. */
  readonly rules: readonly ExportedRule[];
}

export interface RuleExporter {
  collect(request: RuleExportRequest): Promise<RuleExportResult>;
}

export type RuleExportErrorCode =
  | "RULE_EXPORT_RECOVERY_REQUIRED"
  | "RULE_EXPORT_REPOSITORY_NOT_REGISTERED"
  | "RULE_EXPORT_REPOSITORY_UNRESOLVED"
  | "RULE_EXPORT_STORE_UNSAFE";

export class RuleExportError extends Error {
  constructor(
    readonly code: RuleExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    // The CLI prints `code: message`, so the code is not repeated here.
    super(message, options);
    this.name = "RuleExportError";
  }
}

export interface RuleExportServiceOptions {
  readonly cwd?: string;
  readonly storageRoot: string;
}

/**
 * Collects active rules for `export --format` strictly read-only: no lock
 * files, no registry registration, no projection rebuild, no recovery, and no
 * network. A store with an unrecovered transaction is refused instead of read,
 * because its canonical files may be half applied.
 */
export class RuleExportService implements RuleExporter {
  private readonly cwd: string;
  private readonly storageRoot: string;

  constructor(options: RuleExportServiceOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.storageRoot = options.storageRoot;
  }

  async collect(request: RuleExportRequest): Promise<RuleExportResult> {
    const repository =
      request.store === "global"
        ? []
        : await this.readRepositoryRules(request.repo);
    const global =
      request.store === "repository" ? [] : await this.readGlobalRules();
    return {
      rules: [...repository, ...global]
        .filter(
          (entry) =>
            request.origin === "all" || entry.origin === "conversation",
        )
        .map(({ origin: _origin, ...rule }) => rule),
    };
  }

  private async readRepositoryRules(
    repo: string | undefined,
  ): Promise<CollectedRule[]> {
    const name = repo ?? (await this.configuredRepositoryName());
    const registered = await new RepositoryRegistry(
      this.storageRoot,
    ).findByNameReadOnly(name);
    if (registered === null) {
      throw new RuleExportError(
        "RULE_EXPORT_REPOSITORY_NOT_REGISTERED",
        `${name} is not registered in this storage; run repo-knowledge setup ${name} first`,
      );
    }
    let status: Awaited<ReturnType<typeof lstat>>;
    try {
      status = await lstat(registered.absolutePath);
    } catch (error) {
      // Registered before anything was stored: there is nothing to export.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new RuleExportError(
        "RULE_EXPORT_STORE_UNSAFE",
        `the store of ${registered.currentName} must be a real directory`,
      );
    }
    return readActiveRules(
      registered.absolutePath,
      registered.repoId,
      "repository",
      `repo-knowledge reindex ${registered.currentName}`,
    );
  }

  private async readGlobalRules(): Promise<CollectedRule[]> {
    const store = new GlobalStore(this.storageRoot);
    if (!(await store.exists())) return [];
    return readActiveRules(
      store.reference.absolutePath,
      GLOBAL_STORE_ID,
      "global",
      "repo-knowledge reindex --global",
    );
  }

  /** Mirrors the CLI resolver without a repository argument: cwd mapping, then defaultRepo. */
  private async configuredRepositoryName(): Promise<string> {
    const config = await this.readConfig();
    const diagnostics: string[] = [];
    if (config !== null && Object.keys(config.workspaceMappings).length > 0) {
      let workspace: string | undefined;
      try {
        workspace = await canonicalWorkspace(this.cwd);
      } catch (error) {
        if (!(error instanceof RepositoryResolutionError)) throw error;
        diagnostics.push(error.message);
      }
      const mapping =
        workspace === undefined
          ? null
          : await findWorkspaceMapping(
              config.workspaceMappings,
              workspace,
              diagnostics,
            );
      if (mapping !== null) return mapping.repository;
    }
    if (config?.defaultRepo !== undefined) return config.defaultRepo;
    throw new RuleExportError(
      "RULE_EXPORT_REPOSITORY_UNRESOLVED",
      [
        "no repository was selected; pass --repo <owner/name>, run from a mapped workspace, or set defaultRepo in config.json",
        ...diagnostics,
      ].join(". "),
    );
  }

  private async readConfig(): Promise<RepoKnowledgeConfig | null> {
    try {
      return await loadRepoKnowledgeConfig(
        join(this.storageRoot, DEFAULT_CONFIG_FILE_NAME),
      );
    } catch (error) {
      if (
        error instanceof RepoKnowledgeConfigError &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }
}

interface CollectedRule extends ExportedRule {
  readonly origin: "conversation" | "other";
}

async function readActiveRules(
  storeRoot: string,
  storeId: string,
  store: ExportedRule["store"],
  remedy: string,
): Promise<CollectedRule[]> {
  await assertNoUnrecoveredTransaction(storeRoot, remedy);
  const capture = await captureCanonicalStateReadOnly(storeRoot);
  // Validates every record and frontmatter, as a locked read would.
  const domain = buildDomainProjectionSnapshot(
    capture.records.map((entry) => entry.record),
    capture.knowledge,
  );
  // A writer that started during the capture leaves a journal entry behind.
  await assertNoUnrecoveredTransaction(storeRoot, remedy);
  const frontmatter = new Map(
    capture.knowledge.map((document) => [document.path, document.frontmatter]),
  );
  return domain.knowledge
    .filter((entry) => entry.status === "active" && entry.repoId === storeId)
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((entry) => {
      const fields = frontmatter.get(entry.path);
      return {
        hook: objectField(fields?.enforcement_hint, "kind") === "hook",
        id: entry.id,
        origin:
          objectField(fields?.origin, "source") === "conversation"
            ? "conversation"
            : "other",
        rule: entry.rule,
        store,
      };
    });
}

async function assertNoUnrecoveredTransaction(
  storeRoot: string,
  remedy: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(join(storeRoot, "transactions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) {
    throw new RuleExportError(
      "RULE_EXPORT_RECOVERY_REQUIRED",
      `the store has an unrecovered transaction; run ${remedy} and export again`,
    );
  }
}

/** Reads one string field of an optional passthrough frontmatter object. */
function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

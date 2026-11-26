import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { compareCodeUnits } from "./canonical.js";
import { readTransactionJournal } from "./canonical-files.js";
import {
  DEFAULT_CONFIG_FILE_NAME,
  loadRepoKnowledgeConfigIfPresent,
} from "./config.js";
import {
  isConversationKnowledge,
  readEnforcementHint,
} from "./conversation-knowledge-summary.js";
import { buildDomainProjectionSnapshot } from "./domain-projection.js";
import { GLOBAL_STORE_ID } from "./global-always-return.js";
import { GlobalStore } from "./global-store.js";
import { RepositoryRegistry } from "./repository-registry.js";
import { selectConfiguredRepository } from "./repository-resolver.js";
import {
  captureCanonicalStateReadOnly,
  type ReadOnlyCanonicalStateCapture,
} from "./sqlite-projection.js";

export const RuleExportFormatSchema = z.enum(["claude-md", "agents-md"]);
export const RuleExportStoreSchema = z.enum(["repository", "global", "all"]);
export const RuleExportOriginSchema = z.enum(["conversation", "all"]);

export type RuleExportFormat = z.infer<typeof RuleExportFormatSchema>;
export type RuleExportStore = z.infer<typeof RuleExportStoreSchema>;
export type RuleExportOrigin = z.infer<typeof RuleExportOriginSchema>;

export interface RuleExportRequest {
  readonly origin: RuleExportOrigin;
  /** Only for the repository store; the global store is never selected by name. */
  readonly repo?: string;
  readonly store: RuleExportStore;
}

export interface ExportedRule {
  /** True only for a valid `enforcement_hint` of kind `hook`. */
  readonly hook: boolean;
  readonly id: string;
  readonly rule: string;
}

export interface RuleExporter {
  /** Repository rules first, then global rules; each ordered by knowledge ID. */
  collect(request: RuleExportRequest): Promise<readonly ExportedRule[]>;
}

export type RuleExportErrorCode =
  | "RULE_EXPORT_RECOVERY_REQUIRED"
  | "RULE_EXPORT_REPOSITORY_NOT_REGISTERED"
  | "RULE_EXPORT_REPOSITORY_UNRESOLVED"
  | "RULE_EXPORT_STORE_BUSY"
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

/** Consecutive captures compared before a store that keeps changing is refused. */
const CONSISTENT_CAPTURE_ATTEMPTS = 3;

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

  async collect(request: RuleExportRequest): Promise<readonly ExportedRule[]> {
    const conversationOnly = request.origin === "conversation";
    const repository =
      request.store === "global"
        ? []
        : await this.readRepositoryRules(request.repo, conversationOnly);
    const global =
      request.store === "repository"
        ? []
        : await this.readGlobalRules(conversationOnly);
    return [...repository, ...global];
  }

  private async readRepositoryRules(
    repo: string | undefined,
    conversationOnly: boolean,
  ): Promise<ExportedRule[]> {
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
      conversationOnly,
      `repo-knowledge reindex ${registered.currentName}`,
    );
  }

  private async readGlobalRules(
    conversationOnly: boolean,
  ): Promise<ExportedRule[]> {
    const store = new GlobalStore(this.storageRoot);
    if (!(await store.exists())) return [];
    return readActiveRules(
      store.reference.absolutePath,
      GLOBAL_STORE_ID,
      conversationOnly,
      "repo-knowledge reindex --global",
    );
  }

  /** The same fallback as the CLI resolver, without its GitHub lookup. */
  private async configuredRepositoryName(): Promise<string> {
    const config = await loadRepoKnowledgeConfigIfPresent(
      join(this.storageRoot, DEFAULT_CONFIG_FILE_NAME),
    );
    const diagnostics: string[] = [];
    const configured =
      config === null
        ? null
        : await selectConfiguredRepository(
            config,
            undefined,
            this.cwd,
            diagnostics,
          );
    if (configured !== null) return configured.repository;
    throw new RuleExportError(
      "RULE_EXPORT_REPOSITORY_UNRESOLVED",
      [
        "no repository was selected; pass --repo <owner/name>, run from a mapped workspace, or set defaultRepo in config.json",
        ...diagnostics,
      ].join(". "),
    );
  }
}

async function readActiveRules(
  storeRoot: string,
  storeId: string,
  conversationOnly: boolean,
  remedy: string,
): Promise<ExportedRule[]> {
  const capture = await captureConsistently(storeRoot, remedy);
  // Fails closed on any invalid record or frontmatter, as doctor does.
  const domain = buildDomainProjectionSnapshot(
    capture.records.map((entry) => entry.record),
    capture.knowledge,
  );
  const frontmatter = new Map(
    capture.knowledge.map((document) => [document.path, document.frontmatter]),
  );
  return domain.knowledge
    .filter((entry) => entry.status === "active" && entry.repoId === storeId)
    .flatMap((entry) => {
      const fields = frontmatter.get(entry.path)!;
      if (conversationOnly && !isConversationKnowledge(fields)) return [];
      return [
        {
          hook: readEnforcementHint(fields)?.kind === "hook",
          id: entry.id,
          rule: entry.rule,
        },
      ];
    })
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

/**
 * Captures until two consecutive journal-guarded captures agree. A writer
 * leaves a journal entry while it applies a commit, so a guarded capture can
 * only be torn by a commit that started and finished inside it; the next
 * capture then sees the committed state and the digests differ.
 */
async function captureConsistently(
  storeRoot: string,
  remedy: string,
): Promise<ReadOnlyCanonicalStateCapture> {
  let previous = await guardedCapture(storeRoot, remedy);
  for (let attempt = 1; attempt < CONSISTENT_CAPTURE_ATTEMPTS; attempt += 1) {
    const current = await guardedCapture(storeRoot, remedy);
    if (current.canonicalDigest === previous.canonicalDigest) return current;
    previous = current;
  }
  throw new RuleExportError(
    "RULE_EXPORT_STORE_BUSY",
    "the store kept changing while it was read; export again",
  );
}

async function guardedCapture(
  storeRoot: string,
  remedy: string,
): Promise<ReadOnlyCanonicalStateCapture> {
  await assertNoUnrecoveredTransaction(storeRoot, remedy);
  const capture = await captureCanonicalStateReadOnly(storeRoot);
  await assertNoUnrecoveredTransaction(storeRoot, remedy);
  return capture;
}

async function assertNoUnrecoveredTransaction(
  storeRoot: string,
  remedy: string,
): Promise<void> {
  if ((await readTransactionJournal(storeRoot)).length > 0) {
    throw new RuleExportError(
      "RULE_EXPORT_RECOVERY_REQUIRED",
      `the store has an unrecovered transaction; run ${remedy} and export again`,
    );
  }
}

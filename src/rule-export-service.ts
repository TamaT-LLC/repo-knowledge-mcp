import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { readTransactionJournal } from "./canonical-files.js";
import { CANONICAL_WRITE_LOCK_NAME } from "./canonical-transaction-store.js";
import {
  DEFAULT_CONFIG_FILE_NAME,
  loadRepoKnowledgeConfigIfPresent,
  RepoKnowledgeConfigError,
} from "./config.js";
import {
  isConversationKnowledge,
  readEnforcementHint,
} from "./conversation-knowledge-summary.js";
import { buildDomainProjectionSnapshot } from "./domain-projection.js";
import { GLOBAL_STORE_ID } from "./global-always-return.js";
import { GlobalStore } from "./global-store.js";
import { isPosixFileLockHeld } from "./posix-file-lock.js";
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
  /** Path globs the rule is limited to; empty applies to the whole store. */
  readonly scope: readonly string[];
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
  ) {
    // The CLI prints `code: message`, so the code is not repeated here.
    super(message);
    this.name = "RuleExportError";
  }
}

export interface RuleExportServiceOptions {
  readonly cwd?: string;
  readonly retry?: RuleExportRetry;
  readonly storageRoot: string;
}

/** How long export waits for a concurrent writer before reporting a busy store. */
export interface RuleExportRetry {
  readonly attempts: number;
  readonly delayMs: number;
}

const DEFAULT_RETRY: RuleExportRetry = { attempts: 40, delayMs: 50 };

/**
 * Collects active rules for `export --format` strictly read-only: no lock
 * files, no registry registration, no projection rebuild, no recovery, and no
 * network. A store with an unrecovered transaction is refused instead of read,
 * because its canonical files may be half applied.
 */
export class RuleExportService implements RuleExporter {
  private readonly cwd: string;
  private readonly retry: RuleExportRetry;
  private readonly storageRoot: string;

  constructor(options: RuleExportServiceOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.storageRoot = options.storageRoot;
  }

  async collect(request: RuleExportRequest): Promise<readonly ExportedRule[]> {
    // An empty root would read the cwd. The broad-directory guard (root,
    // home, cwd) protects permission changes, so reads do not apply it.
    if (this.storageRoot.trim().length === 0) {
      throw new RepoKnowledgeConfigError(
        "CONFIG_PATH_UNSAFE",
        this.storageRoot,
        "storage root must be explicit",
      );
    }
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
      this.retry,
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
      this.retry,
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
  retry: RuleExportRetry,
): Promise<ExportedRule[]> {
  const capture = await captureConsistently(storeRoot, remedy, retry);
  // Fails closed on any invalid record or frontmatter, as doctor does.
  const domain = buildDomainProjectionSnapshot(
    capture.records.map((entry) => entry.record),
    capture.knowledge,
  );
  const frontmatter = new Map(
    capture.knowledge.map((document) => [document.path, document.frontmatter]),
  );
  // The projection already orders knowledge by ID.
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
          scope: entry.scope,
        },
      ];
    });
}

type WriterState = "abandoned" | "idle" | "writing";

/**
 * A commit keeps a journal entry under `transactions/` while it holds the
 * writer lock, so a journal with a live lock is a writer to wait for, and a
 * journal whose lock is free or owned by a dead process was interrupted.
 */
async function writerState(storeRoot: string): Promise<WriterState> {
  if ((await readTransactionJournal(storeRoot)).length === 0) return "idle";
  return (await isPosixFileLockHeld(join(storeRoot, CANONICAL_WRITE_LOCK_NAME)))
    ? "writing"
    : "abandoned";
}

/**
 * Captures until two consecutive captures taken while no writer was active
 * agree. A capture can only be torn by a commit that started and finished
 * inside it; the next capture then sees the committed state and the digests
 * differ. Capture errors from a concurrent commit (a half-appended line, a
 * file renamed away) are retried; an error on a quiet store is real.
 */
async function captureConsistently(
  storeRoot: string,
  remedy: string,
  retry: RuleExportRetry,
): Promise<ReadOnlyCanonicalStateCapture> {
  let previousDigest: string | undefined;
  let abandoned = 0;
  let failed = 0;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    const state = await writerState(storeRoot);
    // Confirm an interrupted journal on a second look, so a commit that
    // starts between the journal read and the lock probe is not misread.
    abandoned = state === "abandoned" ? abandoned + 1 : 0;
    if (abandoned >= 2) {
      throw new RuleExportError(
        "RULE_EXPORT_RECOVERY_REQUIRED",
        `the store has an interrupted transaction; run ${remedy} and export again`,
      );
    }
    if (state === "idle") {
      let capture: ReadOnlyCanonicalStateCapture | undefined;
      try {
        capture = await captureCanonicalStateReadOnly(storeRoot);
        failed = 0;
      } catch (error) {
        failed += 1;
        if (failed >= 2 && (await writerState(storeRoot)) === "idle") {
          throw error;
        }
      }
      if (capture !== undefined && (await writerState(storeRoot)) === "idle") {
        if (capture.canonicalDigest === previousDigest) return capture;
        previousDigest = capture.canonicalDigest;
        continue; // Confirm at once; there is no writer to wait for.
      }
    }
    if (attempt < retry.attempts) await delay(retry.delayMs);
  }
  throw new RuleExportError(
    "RULE_EXPORT_STORE_BUSY",
    "another repo-knowledge command kept writing to the store; export again",
  );
}

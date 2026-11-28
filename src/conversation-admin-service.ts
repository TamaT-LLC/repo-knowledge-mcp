import {
  ConversationConfigError,
  loadConversationDistillationConfig,
  type ConversationDistillationConfig,
} from "./conversation-config.js";
import { ConversationStoreError } from "./conversation-key.js";
import {
  ConversationStore,
  type ConversationStatus,
  type ConversationStoreOptions,
  type PurgeResult,
  type ResetKeyResult,
} from "./conversation-store.js";
import type { PurgeCriteria } from "./conversation-records.js";

/** `conversations status`: settings summary plus data-area counts. */
export type ConversationStatusReport = ConversationStatusConfig &
  (
    | ConversationStatus
    | {
        /** The data area could not be read; counts and warnings are absent. */
        readonly data_error: {
          readonly code: string;
          readonly file: string | null;
          readonly message: string;
        };
      }
  );

interface ConversationStatusConfig {
  readonly config:
    | {
        readonly error: ConversationConfigError["code"];
        readonly present: true | null;
      }
    | {
        readonly assistant_context: ConversationDistillationConfig["assistantContext"];
        readonly enabled: boolean;
        readonly exclude_projects: number;
        readonly present: boolean;
        /** False when group or others can read it; run chmod 600 on it. */
        readonly private: boolean;
        /** Count only: the dictionary itself is never printed. */
        readonly redact_terms: number;
        readonly retention_days: number | null;
        readonly sources: {
          readonly claude_code: boolean;
          readonly codex: boolean;
        };
      };
}

export interface ConversationAdminOperations {
  /** `null` finishes an interrupted purge without adding a condition. */
  purge(criteria: PurgeCriteria | null): Promise<PurgeResult>;
  resetKey(options: { readonly restart: boolean }): Promise<ResetKeyResult>;
  status(): Promise<ConversationStatusReport>;
}

/** CLI operations over the conversation data area of one storage root. */
export class ConversationAdminService implements ConversationAdminOperations {
  readonly #storageRoot: string;
  readonly #store: ConversationStore;

  constructor(storageRoot: string, options: ConversationStoreOptions = {}) {
    this.#storageRoot = storageRoot;
    this.#store = new ConversationStore(storageRoot, options);
  }

  /**
   * Neither problem hides the other: an invalid config is reported in place
   * of the summary, and an unreadable data area in place of its counts.
   */
  async status(): Promise<ConversationStatusReport> {
    const store = await this.#store.status().catch((error: unknown) => {
      // Store errors and filesystem errors (EACCES, ...) alike.
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "string" || !(error instanceof Error)) throw error;
      return {
        data_error: {
          code,
          file:
            error instanceof ConversationStoreError
              ? (error.file ?? null)
              : null,
          message: error.message,
        },
      };
    });
    let loaded: Awaited<ReturnType<typeof loadConversationDistillationConfig>>;
    try {
      loaded = await loadConversationDistillationConfig(this.#storageRoot, {
        tightenPermissions: false,
      });
    } catch (error) {
      if (!(error instanceof ConversationConfigError)) throw error;
      // An IO error leaves it unknown whether the file exists.
      return {
        config: {
          error: error.code,
          present: error.code === "CONVERSATION_CONFIG_IO_ERROR" ? null : true,
        },
        ...store,
      };
    }
    const { config, present, private: isPrivate } = loaded;
    return {
      config: {
        assistant_context: config.assistantContext,
        enabled: config.enabled,
        exclude_projects: config.excludeProjects.length,
        present,
        private: isPrivate,
        redact_terms: config.redactTerms.length,
        retention_days: config.retentionDays,
        sources: {
          claude_code: config.enabled && config.sources.claudeCode.enabled,
          codex: config.enabled && config.sources.codex.enabled,
        },
      },
      ...store,
    };
  }

  purge(criteria: PurgeCriteria | null): Promise<PurgeResult> {
    return this.#store.purge(criteria);
  }

  resetKey(options: { readonly restart: boolean }): Promise<ResetKeyResult> {
    return this.#store.resetKey(options);
  }
}

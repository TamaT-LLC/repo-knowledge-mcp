import { randomUUID } from "node:crypto";
import { chmod, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import { canonicalizeJson, compareCodeUnits } from "./canonical.js";
import { ensurePrivateDirectory, resolveStorageRoot } from "./config.js";
import type { ConversationDistillationConfig } from "./conversation-config.js";
import {
  ConversationKey,
  ConversationStoreError,
  encodeConversationKeyFile,
  generateConversationKeyBytes,
  readConversationKeyFile,
} from "./conversation-key.js";
import {
  ProjectPathSchema,
  projectPathMatchKey,
} from "./conversation-paths.js";
import { IsoDateTimeSchema, NonEmptyStringSchema } from "./domain-schemas.js";
import {
  ConversationDataRecordSchema,
  ConversationSourceSchema,
  MAX_UTTERANCE_TEXT_CHARACTERS,
  PurgeFilterSchema,
  UtteranceIdSchema,
  purgeBoundMilliseconds,
  UtteranceRecordSchema,
  matchesExcludedProject,
  matchesPurgeFilter,
  rawMatchTarget,
  storedMatchTarget,
  toExpiredTombstone,
  type ConversationDataRecord,
  type ConversationSource,
  type PurgeCriteria,
  type PurgeFilter,
  type UtteranceRecord,
} from "./conversation-records.js";
import {
  computeConversationMaskingVersion,
  mergeRedactionCounts,
  redactConversationText,
  truncateMaskedText,
  type ConversationRedactionCount,
} from "./conversation-redaction.js";
import {
  appendDurable,
  fsyncDirectory,
  lstatNoFollow,
  openRegularFileNoFollow,
  writeDurable,
} from "./durable-fs.js";
import { computeByteSha256 } from "./knowledge-document.js";
import { withPosixFileLock } from "./posix-file-lock.js";

/** Outside `global/`: every JSONL under a store root is canonical capture. */
const CONVERSATIONS_DIRECTORY = "conversations";

const FILES = Object.freeze({
  checkpoints: "checkpoints.json",
  episodes: "episodes.jsonl",
  key: "local.key",
  lock: ".lock",
  nextKey: "local.key.next",
  purgeFilters: "purge-filters.json",
  purgeProgress: "purge-progress.json",
  resetPending: "reset-pending.json",
  routeCache: "route-cache.json",
  utterances: "utterances.jsonl",
});

/** Files written through `#writeAtomically`, whose temporaries we may own. */
const ATOMICALLY_WRITTEN_FILES: ReadonlySet<string> = new Set([
  FILES.episodes,
  FILES.key,
  FILES.purgeFilters,
  FILES.purgeProgress,
  FILES.resetPending,
  FILES.utterances,
]);

/** Files `reset-key` stage 1 discards; `purge-filters.json` is kept. */
const RESET_DISCARDED_FILES = [
  // Stage 0 finishes an interrupted purge first; never present by now.
  FILES.purgeProgress,
  FILES.utterances,
  FILES.episodes,
  FILES.checkpoints,
  FILES.routeCache,
] as const;

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

/** Returned by a line visitor to end a scan early. */
const STOP = Symbol("stop");

/** Bytes buffered before a compaction write; keeps memory bounded. */
const WRITE_CHUNK_BYTES = 1 << 20;

/** Named points where tests inject a crash to prove every stage resumes. */
export type ConversationStoreCheckpoint =
  | "compaction:before-rename"
  | "purge:progress-recorded"
  | "purge:filter-appended"
  | "purge:ids-recorded"
  | "purge:compacted"
  | "purge:evidence-withdrawn"
  | "reset-key:next-key-written"
  | "reset-key:marker-written"
  | "reset-key:renamed"
  | "reset-key:discarded"
  | "reset-key:stage-2"
  | "reset-key:stage-3";

/**
 * Canonical follow-ups that later phases plug in: purge stage 4 (PR4b) and
 * stage 5 (PR4a), and reset-key stage 3. Until then there is no
 * conversation evidence or job, so the defaults have nothing to do.
 */
export interface ConversationCanonicalFollowUp {
  failJobsFor(utteranceIds: readonly string[]): Promise<void>;
  withdrawEvidenceFor(utteranceIds: readonly string[]): Promise<void>;
  withdrawEvidenceNotFromKey(keyId: string): Promise<void>;
}

const NO_CANONICAL_FOLLOW_UP: ConversationCanonicalFollowUp = {
  async failJobsFor() {},
  async withdrawEvidenceFor() {},
  async withdrawEvidenceNotFromKey() {},
};

export interface ConversationStoreOptions {
  readonly checkpoint?: (
    name: ConversationStoreCheckpoint,
  ) => Promise<void> | void;
  readonly clock?: () => Date;
  readonly followUp?: ConversationCanonicalFollowUp;
  readonly lockTimeoutMs?: number;
}

/** An utterance as read from a source, before masking. Never persisted. */
export interface UtteranceDraft {
  /** Preceding assistant text; ignored for history and when disabled. */
  readonly assistant_context: string | null;
  readonly detector_version: string;
  readonly flags: readonly string[];
  readonly human_confidence: UtteranceRecord["human_confidence"];
  readonly human_reasons: readonly string[];
  readonly project: {
    readonly kind: UtteranceRecord["project"]["kind"];
    readonly name_with_owner: string | null;
    /** Raw absolute project path; only HMACs and a masked copy are stored. */
    readonly raw_path: string | null;
    readonly repo_id: string | null;
  };
  readonly session_id: string;
  readonly session_kind: UtteranceRecord["session_kind"];
  readonly signals: readonly string[];
  readonly source: ConversationSource;
  readonly source_message_id: string | null;
  readonly source_origin: UtteranceRecord["source_origin"];
  readonly text: string;
  readonly timestamp: string;
}

/** A project path as stored: masked for display, HMACed for matching. */
interface StoredProjectPath {
  readonly hmacs: string[];
  readonly masked: string;
}

/** The key-independent identity of one stored copy of an utterance. */
type ConversationIdentity = z.infer<typeof PurgedCopySchema>;

/** Exact identity, to the millisecond the timestamps are compared in. */
function identityKey(identity: ConversationIdentity): string {
  return canonicalizeJson([
    identity.source,
    identity.session_id,
    Date.parse(identity.timestamp),
  ]);
}

export interface SaveUtterancesResult {
  readonly key_id: string;
  /** What the retention compaction at the start of this ingest did. */
  readonly retention: CompactionResult;
  readonly saved: number;
  readonly skipped: {
    readonly duplicate: number;
    readonly excluded_project: number;
    readonly expired: number;
    /** Drafts that do not form a valid record (e.g. a bad timestamp). */
    readonly invalid: number;
    readonly purged: number;
  };
}

export interface CompactionResult {
  readonly expired: number;
  readonly removed_episodes: number;
  readonly removed_tombstones: number;
  readonly removed_utterances: number;
}
type CompactionCounts = { -readonly [K in keyof CompactionResult]: number };

export interface PurgeResult extends CompactionResult {
  readonly filter_added: boolean;
  readonly filters: number;
  /** Stage a previous interrupted purge was resumed from, if any. */
  readonly resumed_from: PurgeStage | null;
}

export interface ResetKeyResult {
  readonly discarded: readonly string[];
  readonly key_id: string;
  readonly restarted: boolean;
  /** Last completed stage of an interrupted reset that was resumed. */
  readonly resumed_after_stage: number | null;
}

const PurgeProgressSchema = z.discriminatedUnion("stage", [
  // The filter being added, until it is saved: its only copy.
  z.strictObject({
    schema_version: z.literal(1),
    stage: z.literal("filter_saved"),
    filter: PurgeFilterSchema,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    stage: z.enum(["ids_recorded", "compacted", "evidence_withdrawn"]),
    utterance_ids: z.array(UtteranceIdSchema),
  }),
]);
type PurgeProgress = z.infer<typeof PurgeProgressSchema>;
type PurgeStage = PurgeProgress["stage"];
type IdsProgress = Extract<
  z.infer<typeof PurgeProgressSchema>,
  { readonly utterance_ids: unknown }
>;

/**
 * A copy of an utterance purged only through its `superseded` link. Kept
 * apart from the user's filters and matched by exact identity, so ingest
 * pays a set lookup, not a filter scan, for each.
 */
const PurgedCopySchema = z.strictObject({
  source: ConversationSourceSchema,
  session_id: NonEmptyStringSchema,
  timestamp: IsoDateTimeSchema,
});

const PurgeFiltersFileSchema = z.strictObject({
  schema_version: z.literal(1),
  filters: z.array(PurgeFilterSchema),
  copies: z.array(PurgedCopySchema).default([]),
});
type PurgeState = z.infer<typeof PurgeFiltersFileSchema>;

/** `reset-pending` marker: the new key generation and the last done stage. */
const ResetPendingSchema = z.strictObject({
  schema_version: z.literal(1),
  key_id: z.string().regex(/^[0-9a-f]{16}$/u),
  completed_stage: z.number().int().min(0).max(3),
});
type ResetPendingMarker = z.infer<typeof ResetPendingSchema>;

export interface UnsafeKeyFile {
  readonly file: string;
  readonly reason: "owner" | "permissions";
}

export interface ResetPendingState {
  /** `null` when the marker itself is unreadable. */
  readonly completed_stage: number | null;
  readonly key_id: string | null;
  /** False when neither key file matches the marker: `--restart` is needed. */
  readonly recoverable: boolean;
  /**
   * The key file the reset resumes with, when it may not be used: its fix
   * (`chmod 600`, or `chown` for another owner) comes before reset-key,
   * which cannot get past it.
   */
  readonly unsafe_key: UnsafeKeyFile | null;
}

export type ConversationKeyState =
  | { readonly key_id: string; readonly state: "present" }
  | {
      readonly code: string;
      readonly key_id: null;
      readonly state: "unusable";
    }
  | { readonly key_id: null; readonly state: "missing" };

/** A status warning with the command that resolves it. */
export interface ConversationWarning {
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
}

export interface ConversationStatus {
  readonly data_directory: { readonly present: boolean };
  readonly key: ConversationKeyState;
  readonly purge: {
    /** `null` when purge-filters.json is damaged (see the warnings). */
    readonly filters: number | null;
    readonly in_progress: {
      readonly stage: PurgeStage | "unreadable";
      readonly utterances: number;
    } | null;
  };
  readonly reset_pending: ResetPendingState | null;
  readonly utterances: {
    readonly by_source: Readonly<Record<ConversationSource, number>>;
    readonly superseded: number;
    readonly tombstones: number;
    readonly total: number;
  };
  readonly warnings: readonly ConversationWarning[];
}

/**
 * Compaction rewrites these files. A later phase adds `grouping-runs.jsonl`
 * (PR5) by appending a target whose lines reference utterance IDs.
 */
interface CompactionTarget {
  readonly file: string;
  /** False when no line can change, so the file is not even read. */
  readonly applies?: (context: CompactionContext) => boolean;
  readonly rewrite: (line: string, context: CompactionContext) => string | null;
}

interface CompactionContext {
  readonly counts: CompactionCounts;
  /** Tombstoned utterances: existing ones and those this compaction makes. */
  readonly expiredIds: Set<string>;
  readonly removeIds: ReadonlySet<string>;
  /** Utterances strictly older than this epoch millisecond expire. */
  readonly retentionCutoff: number | null;
  /** Filled with every ID the utterances pass reads (ingest dedupe). */
  readonly seen?: SeenRecords;
}

/** IDs in utterances.jsonl, including both ends of `superseded` links. */
interface SeenRecords {
  hasData: boolean;
  readonly ids: Set<string>;
}

function noteSeen(seen: SeenRecords, record: PeekedRecord): void {
  seen.ids.add(record.utterance_id);
  if (record.type === "superseded") seen.ids.add(record.superseded_by);
  else seen.hasData = true;
}

const COMPACTION_TARGETS: readonly CompactionTarget[] = [
  {
    file: FILES.utterances,
    rewrite(line, context) {
      // Hot path (every ingest starts with retention): read only the fields
      // the decision needs; the full schema runs only on a record that is
      // turned into a tombstone.
      const record = peekDataRecord(line);
      if (context.seen !== undefined) noteSeen(context.seen, record);
      // Links are kept (design: "superseded は残す"). They hold only IDs, and
      // they let ingest recognize a re-read copy of a purged utterance.
      if (record.type === "superseded") return line;
      if (context.removeIds.has(record.utterance_id)) {
        if (record.type === "utterance") context.counts.removed_utterances += 1;
        else context.counts.removed_tombstones += 1;
        return null;
      }
      if (record.type === "expired") {
        // Already a tombstone: its episodes go too, which finishes a
        // retention run stopped before it rewrote episodes.jsonl.
        context.expiredIds.add(record.utterance_id);
        return line;
      }
      if (
        record.type === "utterance" &&
        context.retentionCutoff !== null &&
        Date.parse(record.timestamp) < context.retentionCutoff
      ) {
        // `record` is the parsed line; validate it in full only now.
        const full = UtteranceRecordSchema.safeParse(record);
        if (!full.success) throw corrupt(FILES.utterances);
        context.expiredIds.add(record.utterance_id);
        context.counts.expired += 1;
        return JSON.stringify(toExpiredTombstone(full.data));
      }
      return line;
    },
  },
  {
    // Episodes are rebuilt from utterances, so an episode that mentions any
    // removed utterance is dropped whole. Matching every `utt_` string keeps
    // this correct whatever shape PR4a gives the episode records.
    file: FILES.episodes,
    // An episode built from an expired utterance goes with its text too.
    // Once a tombstone exists this reads all of episodes.jsonl on each
    // retention run; nothing writes that file before PR4a, which must keep
    // the episodes it writes small or record which tombstones it has seen.
    applies: (context) =>
      context.removeIds.size > 0 || context.expiredIds.size > 0,
    rewrite(line, context) {
      const value = parseJsonLine(line, FILES.episodes);
      if (
        !referencesAny(value, context.removeIds) &&
        !referencesAny(value, context.expiredIds)
      )
        return line;
      context.counts.removed_episodes += 1;
      return null;
    },
  },
];

/**
 * The conversation data area (`$REPO_KNOWLEDGE_HOME/conversations/`). It is
 * not a canonical store: files are rewritten by compaction under `.lock`.
 *
 * Lock order is always this area's `.lock` first, then any store writer
 * lock, so purge and reset-key (and job creation, in a later phase) can
 * never deadlock.
 */
export class ConversationStore {
  readonly directory: string;
  readonly #checkpoint: NonNullable<ConversationStoreOptions["checkpoint"]>;
  readonly #clock: () => Date;
  readonly #followUp: ConversationCanonicalFollowUp;
  readonly #lockTimeoutMs: number;
  readonly #storageRoot: string;

  constructor(storageRoot: string, options: ConversationStoreOptions = {}) {
    this.#storageRoot = storageRoot;
    this.directory = join(storageRoot, CONVERSATIONS_DIRECTORY);
    this.#checkpoint = options.checkpoint ?? (() => undefined);
    this.#clock = options.clock ?? (() => new Date());
    this.#followUp = options.followUp ?? NO_CANONICAL_FOLLOW_UP;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Read-only: never creates the directory or the key. */
  async readResetPending(): Promise<ResetPendingState | null> {
    if (!(await this.#directoryExists())) return null;
    const marker = await this.#readMarker();
    if (marker === null) return null;
    if (marker === "unreadable") {
      return {
        completed_stage: null,
        key_id: null,
        recoverable: false,
        unsafe_key: null,
      };
    }
    const holder = await this.#markerKeyFile(marker);
    let unsafe: UnsafeKeyFile | null = null;
    if (holder !== null) {
      try {
        await readConversationKeyFile(this.#path(holder));
      } catch (error) {
        if (!(error instanceof ConversationStoreError)) throw error;
        if (error.code === "CONVERSATION_KEY_PERMISSIONS_UNSAFE") {
          unsafe = { file: holder, reason: "permissions" };
        } else if (error.code === "CONVERSATION_KEY_OWNER_MISMATCH") {
          unsafe = { file: holder, reason: "owner" };
        } else {
          throw error;
        }
      }
    }
    return {
      completed_stage: marker.completed_stage,
      key_id: marker.key_id,
      recoverable: holder !== null,
      unsafe_key: unsafe,
    };
  }

  /**
   * Refuses work that must wait for `reset-key` to finish. Every writer here
   * calls it; later phases call it before ingest (CLI and MCP), distill,
   * prepare, and submit.
   */
  async assertNoResetPending(): Promise<void> {
    const pending = await this.readResetPending();
    if (pending === null) return;
    throw new ConversationStoreError(
      "CONVERSATION_RESET_PENDING",
      pending.unsafe_key !== null
        ? `a key reset is unfinished; ${unsafeKeyRemedy(pending.unsafe_key)}`
        : pending.recoverable
          ? "a key reset is unfinished; run repo-knowledge conversations reset-key to finish it"
          : "a key reset is unfinished and its new key is gone; run repo-knowledge conversations reset-key --restart",
    );
  }

  /** The current key, or `null` when none has been created. */
  async readKey(): Promise<ConversationKey | null> {
    if (!(await this.#directoryExists())) return null;
    return readConversationKeyFile(this.#path(FILES.key));
  }

  /** The user's purge conditions (not the identities of linked copies). */
  async readPurgeFilters(): Promise<PurgeFilter[]> {
    return (await this.#readPurgeState()).filters;
  }

  /** Every record in `utterances.jsonl` (an incomplete last line is ignored). */
  async readRecords(): Promise<ConversationDataRecord[]> {
    const records: ConversationDataRecord[] = [];
    if (!(await this.#directoryExists())) return records;
    await this.#forEachRecord((record) => {
      records.push(record);
    });
    return records;
  }

  /**
   * IDs of stored utterances and tombstones that a purge filter or an
   * `excludeProjects` entry matches, using the current key's prefix HMACs.
   * Purge sweeps through `#matchRecords`; this is the entry point for
   * re-applying `excludeProjects` to stored records (design: config), which
   * a later phase calls when the exclusion list grows.
   */
  async findMatchingIds(conditions: {
    readonly excludeProjects?: readonly string[];
    readonly filters?: readonly PurgeCriteria[];
  }): Promise<string[]> {
    // A caller must not mistake "no key" for "no match" on a path entry.
    if (
      (conditions.excludeProjects ?? []).some((entry) =>
        entry.startsWith("/"),
      ) ||
      (conditions.filters ?? []).some(
        (filter) => filter.project_path_prefix !== undefined,
      )
    ) {
      await this.#assertPathMatchable();
    }
    return (await this.#matchRecords(conditions)).ids;
  }

  /**
   * Matching IDs, plus the identity of each copy matched only through a
   * `superseded` link (its own fields did not match), so a purge can keep
   * it from being ingested again once the link is gone.
   */
  async #matchRecords(conditions: {
    readonly copies?: readonly ConversationIdentity[];
    readonly excludeProjects?: readonly string[];
    readonly filters?: readonly PurgeCriteria[];
    /** Records already chosen (a purge's recorded IDs). */
    readonly ids?: readonly string[];
    /** Key to match paths with instead of `local.key` (reset-key stage 0). */
    readonly key?: ConversationKey;
  }): Promise<{
    readonly ids: string[];
    readonly linked: readonly ConversationIdentity[];
  }> {
    if (!(await this.#directoryExists())) return { ids: [], linked: [] };
    // The key is needed only for a path criterion. Without a usable key,
    // session, period, source and repository criteria still match, and a
    // path criterion matches nothing: a new path purge is refused up front
    // (#assertPathMatchable), and older ones were swept when they were added
    // and are applied to raw paths at ingest.
    // It is not even read otherwise, so an unreadable key file (EACCES)
    // cannot stop a session or period purge.
    const needsKey =
      (conditions.filters ?? []).some(
        (filter) => filter.project_path_prefix !== undefined,
      ) ||
      (conditions.excludeProjects ?? []).some((entry) => entry.startsWith("/"));
    let key: ConversationKey | null = conditions.key ?? null;
    if (needsKey && key === null) {
      try {
        key = await this.readKey();
      } catch (error) {
        if (!(error instanceof ConversationStoreError)) throw error;
      }
    }
    const prefixHmac = (prefix: string): string | null =>
      key?.pathPrefixHmac(prefix) ?? null;
    const copies = new Set((conditions.copies ?? []).map(identityKey));
    const chosen = new Set(conditions.ids);
    const direct = new Set<string>();
    const identities = new Map<string, ConversationIdentity>();
    const links: { duplicate: string; kept: string }[] = [];
    await this.#forEachRecord((record) => {
      if (record.type === "superseded") {
        links.push({
          duplicate: record.utterance_id,
          kept: record.superseded_by,
        });
        return;
      }
      identities.set(record.utterance_id, {
        session_id: record.session_id,
        source: record.source,
        timestamp: record.timestamp,
      });
      const target = storedMatchTarget(record, prefixHmac);
      if (
        chosen.has(record.utterance_id) ||
        copies.has(identityKey(record)) ||
        (conditions.filters ?? []).some((filter) =>
          matchesPurgeFilter(filter, target),
        ) ||
        (conditions.excludeProjects ?? []).some((entry) =>
          matchesExcludedProject(entry, target),
        )
      ) {
        direct.add(record.utterance_id);
      }
    });
    // History and transcript copies linked by `superseded` are one
    // utterance: matching either copy removes both, even when the other's
    // own fields (a pseudo session, a millisecond apart) do not match.
    // Chosen IDs seed the walk even when their record is already gone (a
    // compaction stopped between files), so their links are still followed.
    const matched = new Set([...direct, ...chosen]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const { duplicate, kept } of links) {
        for (const [from, to] of [
          [kept, duplicate],
          [duplicate, kept],
        ] as const) {
          if (matched.has(from) && !matched.has(to)) {
            matched.add(to);
            grew = true;
          }
        }
      }
    }
    const linked = [...matched]
      .filter((id) => !direct.has(id))
      .flatMap((id) => identities.get(id) ?? []);
    return { ids: [...matched].sort(compareCodeUnits), linked };
  }

  /**
   * Masks and stores utterances. Raw text, raw context, and raw paths never
   * reach an utterance record: only masked text, digests, and keyed prefix
   * HMACs do. (Purge filters keep the raw values the user typed, by design:
   * they must survive `reset-key`, so they cannot depend on the key.)
   * Purge filters, including one an interrupted purge has not saved yet,
   * `excludeProjects`, and `retentionDays` are applied to the raw values
   * first, so a matching utterance is never written. A draft that does not
   * form a valid record is skipped and counted, not fatal to the batch.
   * With `retentionDays`, the retention compaction runs first, in the same
   * pass that reads the log.
   */
  async saveUtterances(
    drafts: readonly UtteranceDraft[],
    config: ConversationDistillationConfig,
  ): Promise<SaveUtterancesResult> {
    return this.#withLock(async () => {
      await this.assertNoResetPending();
      // One pass over the log: retention compaction (design: at the start of
      // each ingest) also collects the known IDs. IDs only: status and doctor
      // do the full schema validation. IDs named by kept `superseded` links
      // count as known, so a re-read copy of a purged utterance is still a
      // duplicate. (An ID depends on the masked text, so a changed
      // dictionary needs reset-key, as the design says, before re-reading.)
      // A torn or unterminated last line is settled first, so the scan below
      // sees exactly the records the append will follow.
      await this.#recoverInterruptedWrites();
      const seen: SeenRecords = { hasData: false, ids: new Set() };
      const cutoff = retentionCutoff(config, this.#clock());
      let retention = emptyCompaction();
      if (cutoff === null) {
        await this.#forEachLine(FILES.utterances, (line) => {
          noteSeen(seen, peekDataRecord(line));
        });
      } else {
        retention = await this.#compact(new Set(), cutoff, seen);
      }
      const known = seen.ids;
      const key = await this.#ensureKey(seen.hasData);
      const purge = await this.#effectivePurgeState();
      const purgedCopies = new Set(purge.copies.map(identityKey));
      const maskingVersion = computeConversationMaskingVersion(
        key.bytes,
        config.redactTerms,
      );
      const skipped = {
        duplicate: 0,
        excluded_project: 0,
        expired: 0,
        invalid: 0,
        purged: 0,
      };
      // A batch shares a few project paths: mask each and HMAC its prefixes
      // once.
      const projectPaths = new Map<string, StoredProjectPath>();
      const projectPath = (
        rawPath: string | null,
      ): StoredProjectPath | null => {
        if (rawPath === null) return null;
        let stored = projectPaths.get(rawPath);
        if (stored === undefined) {
          stored = {
            hmacs: key.pathPrefixHmacs(rawPath),
            masked: maskToFixpoint(
              rawPath,
              Number.POSITIVE_INFINITY,
              config.redactTerms,
            ).text,
          };
          projectPaths.set(rawPath, stored);
        }
        return stored;
      };
      const lines: string[] = [];
      for (const input of drafts) {
        // Fields that feed IDs, HMACs and matching must be well formed; a
        // bad one is this draft's problem, not the batch's.
        if (!isWellFormedDraft(input)) {
          skipped.invalid += 1;
          continue;
        }
        const draft = withUsablePath(input);
        // A path that cannot be normalized (relative, `~/`, empty) could
        // never be matched by a path exclusion or purge, now or later: skip
        // it rather than store it unmatchable.
        if (
          input.project.raw_path !== null &&
          draft.project.raw_path === null
        ) {
          skipped.invalid += 1;
          continue;
        }
        const target = rawMatchTarget({
          name_with_owner: draft.project.name_with_owner,
          raw_path: draft.project.raw_path,
          session_id: draft.session_id,
          source: draft.source,
          timestamp: draft.timestamp,
        });
        if (
          config.excludeProjects.some((entry) =>
            matchesExcludedProject(entry, target),
          )
        ) {
          skipped.excluded_project += 1;
          continue;
        }
        if (
          purgedCopies.has(identityKey(draft)) ||
          purge.filters.some((filter) => matchesPurgeFilter(filter, target))
        ) {
          skipped.purged += 1;
          continue;
        }
        if (cutoff !== null && Date.parse(draft.timestamp) < cutoff) {
          skipped.expired += 1;
          continue;
        }
        // The ID needs only the masked text: check it before masking the
        // context and path of what may be a re-read duplicate.
        const text = maskToFixpoint(
          draft.text,
          MAX_UTTERANCE_TEXT_CHARACTERS,
          config.redactTerms,
        );
        const textDigest = sha256Text(text.text);
        const utteranceId = key.utteranceId({
          masked_text_digest: textDigest,
          session_id: draft.session_id,
          source: draft.source,
          source_message_id: draft.source_message_id,
          timestamp: draft.timestamp,
        });
        if (known.has(utteranceId)) {
          skipped.duplicate += 1;
          continue;
        }
        const record = buildUtteranceRecord(
          draft,
          config,
          maskingVersion,
          { ...text, digest: textDigest, utteranceId },
          projectPath(draft.project.raw_path),
        );
        if (record === null) {
          skipped.invalid += 1;
          continue;
        }
        known.add(utteranceId);
        lines.push(JSON.stringify(record));
      }
      await this.#appendLines(FILES.utterances, lines);
      return { key_id: key.keyId, retention, saved: lines.length, skipped };
    });
  }

  /** Records that each pair's `utterance_id` duplicates its `superseded_by`. */
  async saveSuperseded(
    pairs: readonly {
      readonly superseded_by: string;
      readonly utterance_id: string;
    }[],
  ): Promise<void> {
    const lines = pairs.map((pair) =>
      JSON.stringify(
        ConversationDataRecordSchema.parse({ type: "superseded", ...pair }),
      ),
    );
    await this.#withLock(async () => {
      await this.assertNoResetPending();
      await this.#appendLines(FILES.utterances, lines);
    });
  }

  /**
   * Retention compaction on its own (`saveUtterances` runs it at the start
   * of each ingest): utterances older than `retentionDays` become `expired`
   * tombstones. Unlike purge, this adds no purge filter and withdraws no
   * evidence.
   */
  async applyRetention(
    config: ConversationDistillationConfig,
  ): Promise<CompactionResult> {
    const cutoff = retentionCutoff(config, this.#clock());
    if (cutoff === null) return emptyCompaction();
    return this.#withLock(async () => {
      await this.assertNoResetPending();
      await this.#recoverInterruptedWrites();
      return this.#compact(new Set(), cutoff);
    });
  }

  /**
   * `conversations purge` stages 1-3, then the canonical follow-ups (stages 4
   * and 5). The filter is persisted before compaction, so an interrupted
   * purge can never let a later ingest store a matching utterance; progress
   * is recorded so a rerun resumes from the stage that was reached.
   * `null` criteria add no filter: they only finish an interrupted purge and
   * sweep every saved filter (`conversations purge --resume`).
   */
  async purge(criteria: PurgeCriteria | null): Promise<PurgeResult> {
    const filter = criteria === null ? null : this.#purgeFilter(criteria);
    // Stage 1: the data area lock.
    return this.#withLock(async () => {
      await this.assertNoResetPending();
      await this.#recoverInterruptedWrites();
      const resumed = await this.#readJsonFile(
        FILES.purgeProgress,
        PurgeProgressSchema,
      );
      const totals = emptyCompaction();
      let resumedFilterSaved = false;
      if (resumed?.stage === "filter_saved") {
        // Stopped around saving its filter: save it (if it was not), then
        // the sweep below finishes the purge. A path filter needs a usable
        // key, as when it was first requested.
        if (resumed.filter.project_path_prefix !== undefined) {
          await this.#assertPathMatchable();
        }
        resumedFilterSaved = await this.#saveFilter(resumed.filter);
      } else if (resumed !== null) {
        addCounts(totals, await this.#finishPurge(resumed));
      }

      // Stage 2: persist the filter before anything is removed. Progress,
      // holding the filter, is recorded first, so an interruption anywhere
      // is reported by status and finished by `purge --resume`.
      const state = await this.#readPurgeState();
      let filterAdded = false;
      if (filter !== null && !containsFilter(state.filters, filter)) {
        if (filter.project_path_prefix !== undefined) {
          await this.#assertPathMatchable();
        }
        await this.#writeJsonFile(FILES.purgeProgress, {
          filter,
          schema_version: 1,
          stage: "filter_saved",
        });
        await this.#checkpoint("purge:progress-recorded");
        await this.#saveFilter(filter);
        filterAdded = true;
        await this.#checkpoint("purge:filter-appended");
      }

      // Stage 3 onwards: sweep every saved filter.
      addCounts(totals, await this.#finishPurge(null));
      return {
        ...totals,
        filter_added: filterAdded || resumedFilterSaved,
        filters: (await this.readPurgeFilters()).length,
        resumed_from: resumed?.stage ?? null,
      };
    });
  }

  /**
   * A path criterion needs the key to match stored records. Refuse a new
   * path purge without a usable key rather than save it unapplied.
   */
  async #assertPathMatchable(): Promise<void> {
    if ((await this.readKey()) !== null) return;
    if (await this.#hasStoredUtterances()) throw missingKeyWithData();
  }

  /** True when any utterance or tombstone is stored (links alone do not count). */
  async #hasStoredUtterances(): Promise<boolean> {
    let hasData = false;
    await this.#forEachLine(FILES.utterances, (line) => {
      hasData = peekDataRecord(line).type !== "superseded";
      return hasData ? STOP : undefined;
    });
    return hasData;
  }

  /**
   * The saved purge state, plus the filter an interrupted purge recorded but
   * did not save, so ingest honors a purge from the moment it starts.
   */
  async #effectivePurgeState(): Promise<PurgeState> {
    const progress = await this.#readJsonFile(
      FILES.purgeProgress,
      PurgeProgressSchema,
    );
    const state = await this.#readPurgeState();
    return progress?.stage === "filter_saved"
      ? { ...state, filters: [...state.filters, progress.filter] }
      : state;
  }

  async #readPurgeState(): Promise<PurgeState> {
    const saved = (await this.#directoryExists())
      ? await this.#readJsonFile(FILES.purgeFilters, PurgeFiltersFileSchema)
      : null;
    return saved ?? { copies: [], filters: [], schema_version: 1 };
  }

  async #writePurgeState(state: PurgeState): Promise<void> {
    await this.#writeJsonFile(FILES.purgeFilters, state);
  }

  /** Appends a filter unless one with the same criteria is saved. */
  async #saveFilter(filter: PurgeFilter): Promise<boolean> {
    const state = await this.#readPurgeState();
    if (containsFilter(state.filters, filter)) return false;
    await this.#writePurgeState({
      ...state,
      filters: [...state.filters, filter],
    });
    return true;
  }

  #purgeFilter(criteria: PurgeCriteria): PurgeFilter {
    return PurgeFilterSchema.parse({
      ...criteria,
      // One spelling per instant, so a repeated purge is recognized. Times
      // are compared in milliseconds, so a finer bound is widened to the
      // millisecond that still covers it (never narrowed).
      ...(criteria.before === undefined
        ? {}
        : { before: toMillisecondBound(criteria.before, "up") }),
      ...(criteria.after === undefined
        ? {}
        : { after: toMillisecondBound(criteria.after, "down") }),
      // GitHub names are case-insensitive; one spelling per repository.
      ...(criteria.name_with_owner === undefined
        ? {}
        : { name_with_owner: criteria.name_with_owner.toLowerCase() }),
      added_at: this.#clock().toISOString(),
    });
  }

  /**
   * `conversations reset-key` stages 0, 1, 2 and 4 (stage 3 is the
   * canonical follow-up). The new key is durable before the marker, and the
   * marker before anything is replaced, so no interruption can lose the key
   * or make a rerun generate a different one. `--restart` only takes effect
   * when the marker's key is gone; a resumable reset is always resumed.
   */
  async resetKey(
    options: { readonly restart?: boolean } = {},
  ): Promise<ResetKeyResult> {
    return this.#withLock(async () => {
      // The same reading status reports, so the two never disagree.
      const pending = await this.readResetPending();
      if (pending?.unsafe_key != null) {
        // Refuse a key whose permissions are unsafe rather than treat it as
        // lost: `chmod 600` then resumes with the same key (reset-key itself
        // cannot get past this, so it is not suggested).
        throw new ConversationStoreError(
          pending.unsafe_key.reason === "owner"
            ? "CONVERSATION_KEY_OWNER_MISMATCH"
            : "CONVERSATION_KEY_PERMISSIONS_UNSAFE",
          `${pending.unsafe_key.file} holds the key this reset resumes with but may not be used; ${unsafeKeyRemedy(pending.unsafe_key)}`,
        );
      }
      const unrecoverable = pending !== null && !pending.recoverable;
      if (unrecoverable && options.restart !== true) {
        throw new ConversationStoreError(
          "CONVERSATION_RESET_KEY_UNRECOVERABLE",
          "the key reset cannot resume: its marker is unreadable or neither local.key nor local.key.next holds its key; run repo-knowledge conversations reset-key --restart",
        );
      }
      const resumedAfter = pending?.completed_stage ?? null;
      // On --restart the old marker stays until stage 0 writes the new one
      // over it, so ingest stays refused if the restart is interrupted too.
      let marker: ResetPendingMarker | null =
        pending?.recoverable === true
          ? {
              completed_stage: pending.completed_stage!,
              key_id: pending.key_id!,
              schema_version: 1,
            }
          : null;
      marker ??= await this.#resetStage0();

      const discarded = await this.#resetStage1(marker);
      if (marker.completed_stage < 2) {
        // Stage 2 keeps purge-filters.json: it holds key-independent values.
        marker = await this.#writeMarker({ ...marker, completed_stage: 2 });
        await this.#checkpoint("reset-key:stage-2");
      }
      if (marker.completed_stage < 3) {
        await this.#followUp.withdrawEvidenceNotFromKey(marker.key_id);
        marker = await this.#writeMarker({ ...marker, completed_stage: 3 });
        await this.#checkpoint("reset-key:stage-3");
      }
      // Stage 4: ingest may resume and will re-read sources with the new key.
      await this.#unlinkDurably(FILES.resetPending);
      return {
        discarded,
        key_id: marker.key_id,
        restarted: unrecoverable,
        resumed_after_stage: unrecoverable ? null : resumedAfter,
      };
    });
  }

  /**
   * Counts only; never returns text, paths, or session IDs. Every record is
   * schema-validated on purpose: status and doctor are how corruption is
   * found.
   */
  async status(): Promise<ConversationStatus> {
    const bySource: Record<ConversationSource, number> = {
      "claude-code": 0,
      codex: 0,
    };
    const counts = { superseded: 0, tombstones: 0, total: 0 };
    const present = await this.#directoryExists();
    // A damaged file is reported next to the other warnings, not fatal:
    // status must still show a pending reset and the order of the fixes.
    const damaged: string[] = [];
    const orDamaged = <T>(read: Promise<T>, fallback: T): Promise<T> =>
      read.catch((error: unknown) => {
        if (
          !(error instanceof ConversationStoreError) ||
          error.code !== "CONVERSATION_DATA_CORRUPT"
        )
          throw error;
        damaged.push(error.file!);
        return fallback;
      });
    const [key, resetPending, progress, filters] = present
      ? await Promise.all([
          this.#keyState(),
          this.readResetPending(),
          orDamaged<PurgeProgress | "unreadable" | null>(
            this.#readJsonFile(FILES.purgeProgress, PurgeProgressSchema),
            "unreadable",
          ),
          orDamaged<PurgeFilter[] | null>(this.readPurgeFilters(), null),
          orDamaged(
            this.#forEachRecord((record) => {
              if (record.type === "superseded") counts.superseded += 1;
              else if (record.type === "expired") counts.tombstones += 1;
              else {
                counts.total += 1;
                bySource[record.source] += 1;
              }
            }),
            undefined,
          ),
        ])
      : ([{ key_id: null, state: "missing" }, null, null, []] as const);
    return buildStatus(
      present,
      key,
      resetPending,
      progress,
      filters?.length ?? null,
      { ...counts, by_source: bySource },
      // Reads ran concurrently; report in a stable order.
      damaged.filter((file) => file !== FILES.purgeProgress).sort(),
    );
  }

  /** Runs purge from the recorded stage to the end, then drops progress. */
  async #finishPurge(
    progress: IdsProgress | null,
    key?: ConversationKey,
  ): Promise<CompactionResult> {
    let counts = emptyCompaction();
    let current = progress;
    if (current === null) {
      // Stage 3: record the IDs every saved filter matches, so a purge
      // interrupted before this point is finished by any later purge.
      const state = await this.#readPurgeState();
      const { ids, linked } = await this.#matchRecords({
        copies: state.copies,
        filters: state.filters,
        ...(key === undefined ? {} : { key }),
      });
      await this.#keepLinkedCopies(state, linked);
      if (ids.length === 0) {
        await this.#unlinkDurably(FILES.purgeProgress);
        return counts;
      }
      current = {
        schema_version: 1,
        stage: "ids_recorded",
        utterance_ids: ids,
      };
      await this.#writeJsonFile(FILES.purgeProgress, current);
      await this.#checkpoint("purge:ids-recorded");
    }
    if (progress !== null) {
      // Resumed: a link saved since the IDs were recorded may tie another
      // copy to one of them. Recorded IDs seed the walk even when already
      // compacted away. A copy found after compaction sends the purge back
      // to compaction; the later stages are safe to repeat.
      const state = await this.#readPurgeState();
      const { ids, linked } = await this.#matchRecords({
        ids: current.utterance_ids,
      });
      await this.#keepLinkedCopies(state, linked);
      // Recorded IDs stay even when gone from utterances.jsonl (the
      // compaction stopped between files): the other files still need them.
      const all = new Set([...current.utterance_ids, ...ids]);
      if (all.size !== current.utterance_ids.length) {
        current = {
          ...current,
          stage: "ids_recorded",
          utterance_ids: [...all].sort(compareCodeUnits),
        };
        await this.#writeJsonFile(FILES.purgeProgress, current);
      }
    }
    if (current.stage === "ids_recorded") {
      counts = await this.#compact(new Set(current.utterance_ids), null);
      current = await this.#writePurgeStage(current, "compacted");
      await this.#checkpoint("purge:compacted");
    }
    if (current.stage === "compacted") {
      await this.#followUp.withdrawEvidenceFor(current.utterance_ids);
      current = await this.#writePurgeStage(current, "evidence_withdrawn");
      await this.#checkpoint("purge:evidence-withdrawn");
    }
    await this.#followUp.failJobsFor(current.utterance_ids);
    await this.#unlinkDurably(FILES.purgeProgress);
    return counts;
  }

  /**
   * A copy removed only through its link would not match the filters once
   * the link is gone (reset-key drops it): keep its identity.
   */
  async #keepLinkedCopies(
    state: PurgeState,
    linked: readonly ConversationIdentity[],
  ): Promise<void> {
    const known = new Set(state.copies.map(identityKey));
    const copies = linked.filter((copy) => !known.has(identityKey(copy)));
    if (copies.length > 0) {
      await this.#writePurgeState({
        ...state,
        copies: [...state.copies, ...copies],
      });
    }
  }

  async #writePurgeStage(
    progress: IdsProgress,
    stage: IdsProgress["stage"],
  ): Promise<IdsProgress> {
    const next = { ...progress, stage };
    await this.#writeJsonFile(FILES.purgeProgress, next);
    return next;
  }

  /** The key file holding the marker's key, or `null` if it is gone. */
  async #markerKeyFile(marker: ResetPendingMarker): Promise<string | null> {
    for (const file of [FILES.nextKey, FILES.key]) {
      if ((await this.#identifyKey(file))?.keyId === marker.key_id) return file;
    }
    return null;
  }

  async #resetStage0(): Promise<ResetPendingMarker> {
    // An interrupted purge is finished first, while the old key can still
    // match its paths and its linked copies can still be found: its filter
    // and copies must survive the discard. A damaged progress file may be
    // the only copy of a request, so it stops the reset instead.
    const progress = await this.#readJsonFile(
      FILES.purgeProgress,
      PurgeProgressSchema,
    );
    if (progress?.stage === "filter_saved") {
      // Saved first: whatever happens below, ingest honors the condition.
      await this.#saveFilter(progress.filter);
      if (progress.filter.project_path_prefix === undefined) {
        await this.#finishPurge(null);
      } else {
        // A path filter matches stored records only through the old key.
        // One with unsafe permissions is still readable, and it is about to
        // be discarded, so it may finish the purge. Without any old key the
        // copies linked to matching utterances cannot be found, and the
        // reset would drop their links: stop, keeping progress and links.
        const oldKey = await this.#identifyKey(FILES.key);
        if (oldKey === null && (await this.#hasStoredUtterances())) {
          throw interruptedPathPurgeWithoutKey();
        }
        await this.#finishPurge(null, oldKey ?? undefined);
      }
    } else if (progress !== null) {
      await this.#finishPurge(progress);
    }
    // A next key without a marker means nothing was changed yet, so a new
    // key may be generated.
    await this.#unlinkDurably(FILES.nextKey);
    const key = new ConversationKey(generateConversationKeyBytes());
    await writeDurable(
      this.#path(FILES.nextKey),
      encodeConversationKeyFile(key.bytes),
      "wx",
    );
    await fsyncDirectory(this.directory);
    await this.#checkpoint("reset-key:next-key-written");
    const marker = await this.#writeMarker({
      completed_stage: 0,
      key_id: key.keyId,
      schema_version: 1,
    });
    await this.#checkpoint("reset-key:marker-written");
    return marker;
  }

  async #resetStage1(marker: ResetPendingMarker): Promise<string[]> {
    const next = await this.#identifyKey(FILES.nextKey);
    if (next?.keyId === marker.key_id) {
      await rename(this.#path(FILES.nextKey), this.#path(FILES.key));
      await fsyncDirectory(this.directory);
      await this.#checkpoint("reset-key:renamed");
    } else {
      // The rename already happened; a stale next file is not the new key.
      await this.#unlinkDurably(FILES.nextKey);
    }
    await this.#cleanupTemporaryFiles();
    const discarded: string[] = [];
    for (const file of RESET_DISCARDED_FILES) {
      if (await this.#unlink(file)) discarded.push(file);
    }
    await fsyncDirectory(this.directory);
    await this.#checkpoint("reset-key:discarded");
    if (marker.completed_stage < 1) {
      await this.#writeMarker({ ...marker, completed_stage: 1 });
    }
    return discarded;
  }

  async #writeMarker(marker: ResetPendingMarker): Promise<ResetPendingMarker> {
    const parsed = ResetPendingSchema.parse(marker);
    await this.#writeJsonFile(FILES.resetPending, parsed);
    return parsed;
  }

  /** `"unreadable"`: a reset is pending but cannot resume (needs --restart). */
  async #readMarker(): Promise<ResetPendingMarker | "unreadable" | null> {
    try {
      return await this.#readJsonFile(FILES.resetPending, ResetPendingSchema);
    } catch (error) {
      if (
        error instanceof ConversationStoreError &&
        error.code === "CONVERSATION_DATA_CORRUPT"
      )
        return "unreadable";
      throw error;
    }
  }

  async #keyState(): Promise<ConversationKeyState> {
    try {
      const key = await this.readKey();
      return key === null
        ? { key_id: null, state: "missing" }
        : { key_id: key.keyId, state: "present" };
    } catch (error) {
      if (!(error instanceof ConversationStoreError)) throw error;
      return { code: error.code, key_id: null, state: "unusable" };
    }
  }

  /**
   * Which generation a key file holds, ignoring its permissions; a missing,
   * symlinked or corrupt file holds none. Never hash with the result, except
   * in reset-key stage 0, where the old key finishes a purge just before it
   * is discarded.
   */
  async #identifyKey(file: string): Promise<ConversationKey | null> {
    try {
      return await readConversationKeyFile(this.#path(file), {
        identifyOnly: true,
      });
    } catch (error) {
      if (error instanceof ConversationStoreError) return null;
      throw error;
    }
  }

  /** The key, created on first use; never regenerated over stored data. */
  async #ensureKey(hasStoredUtterances: boolean): Promise<ConversationKey> {
    const existing = await readConversationKeyFile(this.#path(FILES.key));
    if (existing !== null) return existing;
    if (hasStoredUtterances) throw missingKeyWithData();
    const key = new ConversationKey(generateConversationKeyBytes());
    await this.#writeAtomically(FILES.key, async (write) => {
      await write(encodeConversationKeyFile(key.bytes));
    });
    return key;
  }

  async #compact(
    removeIds: ReadonlySet<string>,
    cutoff: number | null,
    seen?: SeenRecords,
  ): Promise<CompactionResult> {
    const context: CompactionContext = {
      counts: emptyCompaction(),
      expiredIds: new Set(),
      removeIds,
      retentionCutoff: cutoff,
      ...(seen === undefined ? {} : { seen }),
    };
    for (const target of COMPACTION_TARGETS) {
      await this.#rewriteJsonl(target, context);
    }
    return { ...context.counts };
  }

  /**
   * Streams the rewritten lines into a temporary file, then fsync + rename,
   * so readers see the old or the new file whole. A first pass stops at the
   * first line that would change, so an unchanged file is never rewritten.
   */
  async #rewriteJsonl(
    target: CompactionTarget,
    context: CompactionContext,
  ): Promise<void> {
    if (target.applies?.(context) === false) return;
    let changes = false;
    const probe: CompactionContext = { ...context, counts: emptyCompaction() };
    await this.#forEachLine(target.file, (line) => {
      changes = target.rewrite(line, probe) !== line;
      return changes ? STOP : undefined;
    });
    if (!changes) return;
    await this.#writeAtomically(
      target.file,
      async (write) => {
        let chunk = "";
        await this.#forEachLine(target.file, async (line) => {
          const next = target.rewrite(line, context);
          if (next === null) return;
          chunk += `${next}\n`;
          if (chunk.length >= WRITE_CHUNK_BYTES) {
            await write(Buffer.from(chunk, "utf8"));
            chunk = "";
          }
        });
        await write(Buffer.from(chunk, "utf8"));
      },
      "compaction:before-rename",
    );
  }

  async #appendLines(file: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return;
    const path = this.#path(file);
    await this.#assertRegularOrMissing(file);
    await repairTornTail(path);
    await appendDurable(path, Buffer.from(`${lines.join("\n")}\n`, "utf8"));
    await chmod(path, 0o600);
    await fsyncDirectory(this.directory);
  }

  async #forEachRecord(
    visit: (record: ConversationDataRecord) => void,
  ): Promise<void> {
    await this.#forEachLine(FILES.utterances, (line) => {
      visit(parseDataRecord(line));
    });
  }

  /**
   * Streams complete lines, split straight from the read chunks; blank lines
   * (hand edits) hold no record and are skipped. A final line without a
   * newline counts only when it is complete JSON: a record whose newline
   * was lost, which the next write keeps (repairTornTail); anything else
   * there is a torn append. A visit returning `STOP` ends the scan early;
   * only an async visit is awaited.
   */
  async #forEachLine(
    file: string,
    visit: (line: string) => Promise<unknown> | unknown,
  ): Promise<void> {
    const opened = await this.#openData(file);
    if (opened === null) return;
    // Closes the handle when the stream is destroyed.
    const stream = opened.handle.createReadStream({ encoding: "utf8" });
    let rest = "";
    try {
      for await (const chunk of stream as AsyncIterable<string>) {
        rest += chunk;
        let start = 0;
        for (
          let end = rest.indexOf("\n");
          end >= 0;
          end = rest.indexOf("\n", start)
        ) {
          const line = rest.slice(
            start,
            rest[end - 1] === "\r" ? end - 1 : end,
          );
          start = end + 1;
          if (isBlank(line)) continue;
          let result = visit(line);
          if (result instanceof Promise) result = await result;
          if (result === STOP) return;
        }
        rest = rest.slice(start);
      }
    } finally {
      stream.destroy();
    }
    if (!isBlank(rest) && isCompleteJson(rest)) {
      const result = visit(rest);
      if (result instanceof Promise) await result;
    }
  }

  async #readJsonFile<T>(
    file: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const opened = await this.#openData(file);
    if (opened === null) return null;
    let bytes: Buffer;
    try {
      bytes = await opened.handle.readFile();
    } finally {
      await opened.handle.close();
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw corrupt(file);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw corrupt(file);
    return parsed.data;
  }

  async #writeJsonFile(file: string, value: unknown): Promise<void> {
    await this.#writeAtomically(file, async (write) => {
      await write(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    });
  }

  /**
   * Writes a `0600` temporary file through `produce`, fsyncs it, and renames
   * it over `file`.
   */
  async #writeAtomically(
    file: string,
    produce: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>,
    checkpoint?: ConversationStoreCheckpoint,
  ): Promise<void> {
    await this.#assertRegularOrMissing(file);
    const temporary = this.#path(temporaryName(file));
    const handle = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      await produce(async (bytes) => {
        await handle.writeFile(bytes);
      });
      await handle.sync();
      await handle.close();
      if (checkpoint !== undefined) await this.#checkpoint(checkpoint);
      await rename(temporary, this.#path(file));
      renamed = true;
      await fsyncDirectory(this.directory);
    } finally {
      await handle.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  /**
   * Undoes what an interrupted write left: temporary files, and a torn last
   * line, which a compaction would otherwise keep on disk.
   */
  async #recoverInterruptedWrites(): Promise<void> {
    for (const target of COMPACTION_TARGETS) {
      if (await this.#assertRegularOrMissing(target.file)) {
        await repairTornTail(this.#path(target.file));
      }
    }
    await this.#cleanupTemporaryFiles();
  }

  /** Removes temporary files an interrupted write left behind. */
  async #cleanupTemporaryFiles(): Promise<void> {
    let removed = false;
    for (const entry of await readdir(this.directory)) {
      const target = temporaryTarget(entry);
      if (target !== null && ATOMICALLY_WRITTEN_FILES.has(target)) {
        await unlink(join(this.directory, entry));
        removed = true;
      }
    }
    if (removed) await fsyncDirectory(this.directory);
  }

  /** Opens a data file for reading without following a symlink. */
  #openData(file: string) {
    return openRegularFileNoFollow(this.#path(file), () =>
      unsafePath(`${file} must be a regular file, not a symlink`),
    );
  }

  /** True when the file exists as a regular file; refuses symlinks. */
  async #assertRegularOrMissing(file: string): Promise<boolean> {
    return (
      (await lstatNoFollow(this.#path(file), "file", () =>
        unsafePath(`${file} must be a regular file, not a symlink`),
      )) !== null
    );
  }

  async #unlink(file: string): Promise<boolean> {
    try {
      await unlink(this.#path(file));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #unlinkDurably(file: string): Promise<void> {
    if (await this.#unlink(file)) await fsyncDirectory(this.directory);
  }

  async #directoryExists(): Promise<boolean> {
    // A blank root (REPO_KNOWLEDGE_HOME="") would read `./conversations`.
    // The broad-directory guard is for writes (#withLock); reads still work
    // when run from inside the storage root.
    if (this.#storageRoot.trim().length === 0) {
      throw unsafePath("the storage root must be explicit");
    }
    return (
      (await lstatNoFollow(this.directory, "directory", () =>
        unsafePath(`${this.directory} must be a real directory, not a symlink`),
      )) !== null
    );
  }

  async #withLock<T>(callback: () => Promise<T>): Promise<T> {
    const root = resolveStorageRoot(this.#storageRoot);
    await ensurePrivateDirectory(root);
    await this.#directoryExists();
    await ensurePrivateDirectory(this.directory);
    return withPosixFileLock(
      this.#path(FILES.lock),
      this.#lockTimeoutMs,
      callback,
    );
  }

  #path(file: string): string {
    return join(this.directory, file);
  }
}

const UNUSABLE_KEY_MESSAGES: Readonly<Record<string, string>> = {
  CONVERSATION_DATA_PATH_UNSAFE:
    "local.key is a symlink or not a regular file, so it is not used.",
  CONVERSATION_KEY_CORRUPT: "local.key is not a valid key.",
  CONVERSATION_KEY_OWNER_MISMATCH:
    "local.key is owned by another user (created with sudo?), so it is not used.",
  CONVERSATION_KEY_PERMISSIONS_UNSAFE:
    "local.key is readable by group or others, so it is not used.",
};

/** The fix for a key file the reset must resume with but may not use. */
function unsafeKeyRemedy(unsafe: UnsafeKeyFile): string {
  return unsafe.reason === "owner"
    ? `run chown on ${unsafe.file} in the conversations directory to your user, then repo-knowledge conversations reset-key`
    : `run chmod 600 on ${unsafe.file} in the conversations directory after confirming nobody else read it, then repo-knowledge conversations reset-key`;
}

function buildStatus(
  present: boolean,
  key: ConversationKeyState,
  resetPending: ResetPendingState | null,
  progress: PurgeProgress | "unreadable" | null,
  filters: number | null,
  utterances: ConversationStatus["utterances"],
  damaged: readonly string[],
): ConversationStatus {
  const warnings: ConversationWarning[] = damaged.map((file) => ({
    code: "CONVERSATION_DATA_CORRUPT",
    message: `${file} contains a record that does not match its schema; counts may be incomplete.`,
    // Deleting purge-filters.json would let purged conversations be
    // ingested again, so it is repaired, never removed.
    remedy:
      file === FILES.purgeFilters
        ? "Repair the damaged entry in purge-filters.json by hand; do not delete the file, or purged conversations can be ingested again"
        : `Repair or remove the damaged record in ${file}`,
  }));
  if (resetPending !== null) {
    warnings.push(
      resetPending.recoverable
        ? {
            code: "CONVERSATION_RESET_PENDING",
            message:
              "A key reset is unfinished; ingest is refused until it finishes.",
            remedy:
              resetPending.unsafe_key === null
                ? "repo-knowledge conversations reset-key"
                : unsafeKeyRemedy(resetPending.unsafe_key),
          }
        : {
            code: "CONVERSATION_RESET_KEY_UNRECOVERABLE",
            message:
              "A key reset is unfinished and its new key is gone; it must start over.",
            remedy: "repo-knowledge conversations reset-key --restart",
          },
    );
  }
  if (key.state === "unusable") {
    warnings.push({
      code: key.code,
      message: UNUSABLE_KEY_MESSAGES[key.code] ?? "local.key cannot be used.",
      // Loose permissions need chmod, not a reset that discards every
      // stored utterance.
      remedy:
        key.code === "CONVERSATION_KEY_PERMISSIONS_UNSAFE"
          ? "chmod 600 local.key in the conversations directory, after confirming nobody else read it"
          : key.code === "CONVERSATION_KEY_OWNER_MISMATCH"
            ? "chown local.key in the conversations directory to your user, or repo-knowledge conversations reset-key"
            : "repo-knowledge conversations reset-key",
    });
  } else if (
    key.state === "missing" &&
    resetPending === null &&
    // A damaged log stops the counts early; it still holds data.
    (utterances.total + utterances.tombstones > 0 ||
      damaged.includes(FILES.utterances))
  ) {
    warnings.push({
      code: "CONVERSATION_KEY_MISSING",
      message: "Stored utterances exist but local.key is missing.",
      remedy: "repo-knowledge conversations reset-key",
    });
  }
  if (progress === "unreadable") {
    // It may hold the only copy of a condition not yet saved; a pending
    // reset refuses the purge until reset-key has finished.
    warnings.push({
      code: "CONVERSATION_PURGE_PROGRESS_UNREADABLE",
      message:
        "purge-progress.json is damaged; the interrupted purge's condition may exist only there.",
      remedy:
        resetPending === null
          ? "Remove purge-progress.json, then rerun the original conversations purge command (not --resume)"
          : "Remove purge-progress.json, run repo-knowledge conversations reset-key, then rerun the original conversations purge command",
    });
  } else if (progress !== null) {
    warnings.push({
      code: "CONVERSATION_PURGE_INCOMPLETE",
      message:
        "A purge was interrupted; finish it before relying on the deletion.",
      remedy: "repo-knowledge conversations purge --resume",
    });
  }
  return {
    data_directory: { present },
    key,
    purge: {
      filters,
      in_progress:
        progress === null
          ? null
          : progress === "unreadable"
            ? { stage: "unreadable", utterances: 0 }
            : {
                stage: progress.stage,
                utterances:
                  progress.stage === "filter_saved"
                    ? 0
                    : progress.utterance_ids.length,
              },
    },
    reset_pending: resetPending,
    utterances,
    warnings,
  };
}

/** In `u` mode a surrogate pair is one code point, so this finds lone ones. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function isWellFormedDraft(draft: UtteranceDraft): boolean {
  const strings = [
    draft.session_id,
    draft.source_message_id,
    draft.text,
    draft.assistant_context,
    draft.project.raw_path,
    draft.project.name_with_owner,
    draft.project.repo_id,
    draft.detector_version,
    ...draft.signals,
    ...draft.human_reasons,
    ...draft.flags,
  ];
  return (
    IsoDateTimeSchema.safeParse(draft.timestamp).success &&
    strings.every((value) => value === null || !LONE_SURROGATE.test(value))
  );
}

/**
 * Normalizes the project path once; a path that cannot be normalized
 * becomes `null`, and the caller skips that draft as invalid.
 */
function withUsablePath(draft: UtteranceDraft): UtteranceDraft {
  const path = draft.project.raw_path;
  if (path === null) return draft;
  const parsed = ProjectPathSchema.safeParse(path);
  return {
    ...draft,
    project: {
      ...draft.project,
      raw_path: parsed.success ? parsed.data : null,
    },
  };
}

function buildUtteranceRecord(
  draft: UtteranceDraft,
  config: ConversationDistillationConfig,
  maskingVersion: string,
  text: {
    readonly digest: string;
    readonly redactions: readonly ConversationRedactionCount[];
    readonly text: string;
    readonly utteranceId: string;
  },
  path: StoredProjectPath | null,
): UtteranceRecord | null {
  const mask = (value: string, limit: number) =>
    maskToFixpoint(value, limit, config.redactTerms);
  const withContext =
    config.assistantContext.enabled &&
    draft.source_origin === "transcript" &&
    draft.assistant_context !== null;
  const context = withContext
    ? mask(draft.assistant_context!, config.assistantContext.maxCharacters)
    : null;
  const parsed = UtteranceRecordSchema.safeParse({
    type: "utterance",
    utterance_id: text.utteranceId,
    source: draft.source,
    source_origin: draft.source_origin,
    session_id: draft.session_id,
    session_kind: draft.session_kind,
    timestamp: draft.timestamp,
    project: {
      kind: draft.project.kind,
      repo_id: draft.project.repo_id,
      name_with_owner: draft.project.name_with_owner,
      path: path?.masked ?? null,
      path_prefix_hmacs: path?.hmacs ?? [],
    },
    text: text.text,
    text_digest: text.digest,
    context:
      context === null
        ? null
        : { text: context.text, text_digest: sha256Text(context.text) },
    signals: [...draft.signals],
    human_confidence: draft.human_confidence,
    human_reasons: [...draft.human_reasons],
    redactions: mergeRedactionCounts(
      text.redactions,
      context?.redactions ?? [],
    ),
    flags: [...draft.flags],
    detector_version: draft.detector_version,
    masking_version: maskingVersion,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Masks, then cuts to `limit`; if the cut exposed a match (a run that ended
 * at a cut-off path separator, say), masks and cuts again. What is stored is
 * a fixpoint of the rules it was written with. Masking first means a cut
 * cannot split a secret so its remainder escapes its rule. Checked here, at
 * the write, not in the read schema, so stored records keep the rules
 * recorded in `masking_version`.
 */
function maskToFixpoint(
  value: string,
  limit: number,
  redactTerms: readonly string[],
): {
  readonly redactions: readonly ConversationRedactionCount[];
  readonly text: string;
} {
  let masked = redactConversationText(value, { redactTerms });
  let redactions: readonly ConversationRedactionCount[] = masked.redactions;
  let text = truncateMaskedText(masked.text, limit);
  for (let round = 0; text !== masked.text; round += 1) {
    // Each round only masks or cuts an already capped text, so it settles;
    // not settling is a masking bug, not a bad draft.
    /* c8 ignore next */
    if (round === 4) throw new Error("conversation masking did not settle");
    masked = redactConversationText(text, { redactTerms });
    redactions = mergeRedactionCounts(redactions, masked.redactions);
    text = truncateMaskedText(masked.text, limit);
  }
  return { redactions, text };
}

function sha256Text(value: string): string {
  return `sha256:${computeByteSha256(value)}`;
}

/**
 * An append cut short by a crash leaves a partial last line; drop it. A
 * last line that is complete JSON and only lacks its newline (a hand edit)
 * is kept and terminated instead.
 */
async function repairTornTail(path: string): Promise<void> {
  // The handle that is checked is the one repaired: never a symlink target.
  const opened = await openRegularFileNoFollow(
    path,
    () => unsafePath(`${basename(path)} must be a regular file, not a symlink`),
    "read-write",
  );
  if (opened === null) return;
  const { handle } = opened;
  try {
    const { size } = opened.status;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    let end = size;
    while (end > 0) {
      const length = Math.min(buffer.length, end);
      await handle.read(buffer, 0, length, end - length);
      const newline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (newline >= 0) {
        end = end - length + newline + 1;
        break;
      }
      end -= length;
    }
    if (end === size) return;
    const tail = Buffer.alloc(size - end);
    await handle.read(tail, 0, tail.length, end);
    if (isCompleteJson(tail.toString("utf8"))) {
      await handle.write("\n", size);
    } else {
      await handle.truncate(end);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isBlank(line: string): boolean {
  return line.length === 0 || (line.charCodeAt(0) <= 32 && line.trim() === "");
}

function isCompleteJson(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function retentionCutoff(
  config: ConversationDistillationConfig,
  now: Date,
): number | null {
  return config.retentionDays === null
    ? null
    : now.getTime() - config.retentionDays * 86_400_000;
}

/** A purge bound in its stored ISO form; see `purgeBoundMilliseconds`. */
function toMillisecondBound(value: string, direction: "down" | "up"): string {
  const time = purgeBoundMilliseconds(value, direction);
  if (time === null) {
    throw new ConversationStoreError(
      "CONVERSATION_PURGE_FILTER_INVALID",
      "purge bounds must fall in the years 1970-9999 (UTC)",
    );
  }
  return new Date(time).toISOString();
}

function containsFilter(
  filters: readonly PurgeFilter[],
  filter: PurgeFilter,
): boolean {
  const key = criteriaKey(filter);
  return filters.some((existing) => criteriaKey(existing) === key);
}

/** Identity of a filter's criteria, ignoring when it was added. */
function criteriaKey(filter: PurgeFilter): string {
  const { added_at: _added, ...criteria } = filter;
  return canonicalizeJson(
    Object.fromEntries(
      Object.entries(criteria)
        .filter(([, value]) => value !== undefined)
        // Paths are compared the way they are matched: case-folded.
        .map(([name, value]) => [
          name,
          name === "project_path_prefix"
            ? projectPathMatchKey(String(value))
            : value,
        ]),
    ),
  );
}

type PeekedRecord =
  | { readonly type: "expired"; readonly utterance_id: string }
  | {
      readonly superseded_by: string;
      readonly type: "superseded";
      readonly utterance_id: string;
    }
  | {
      readonly timestamp: string;
      readonly type: "utterance";
      readonly utterance_id: string;
    };

/** The fields hot paths decide on, without the full record schema. */
function peekDataRecord(line: string): PeekedRecord {
  const value = parseJsonLine(line, FILES.utterances) as Record<
    string,
    unknown
  >;
  const isString = (field: string) => typeof value?.[field] === "string";
  const shaped =
    isString("utterance_id") &&
    (value.type === "expired" ||
      (value.type === "superseded" && isString("superseded_by")) ||
      (value.type === "utterance" && isString("timestamp")));
  if (!shaped) throw corrupt(FILES.utterances);
  return value as unknown as PeekedRecord;
}

function parseDataRecord(line: string): ConversationDataRecord {
  const parsed = ConversationDataRecordSchema.safeParse(
    parseJsonLine(line, FILES.utterances),
  );
  if (!parsed.success) throw corrupt(FILES.utterances);
  return parsed.data;
}

function parseJsonLine(line: string, file: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw corrupt(file);
  }
}

function referencesAny(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value))
    return value.some((item) => referencesAny(item, ids));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => ids.has(key) || referencesAny(item, ids),
    );
  }
  return false;
}

const TEMPORARY_NAME =
  /^\.(.+)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u;

function temporaryName(file: string): string {
  return `.${file}.${randomUUID()}.tmp`;
}

/** The file a `temporaryName` belongs to, or `null` for any other name. */
function temporaryTarget(entry: string): string | null {
  return TEMPORARY_NAME.exec(entry)?.[1] ?? null;
}

function emptyCompaction(): CompactionCounts {
  return {
    expired: 0,
    removed_episodes: 0,
    removed_tombstones: 0,
    removed_utterances: 0,
  };
}

function addCounts(total: CompactionCounts, add: CompactionResult): void {
  for (const name of Object.keys(total) as (keyof CompactionCounts)[]) {
    total[name] += add[name];
  }
}

function unsafePath(message: string): ConversationStoreError {
  return new ConversationStoreError("CONVERSATION_DATA_PATH_UNSAFE", message);
}

function corrupt(file: string): ConversationStoreError {
  // Never echo the line: it may hold masked text or a session ID.
  return new ConversationStoreError(
    "CONVERSATION_DATA_CORRUPT",
    `${file} contains a record that does not match its schema`,
    { file },
  );
}

function interruptedPathPurgeWithoutKey(): ConversationStoreError {
  return new ConversationStoreError(
    "CONVERSATION_KEY_MISSING",
    "an interrupted path purge needs the old local.key to find the copies linked to the utterances it removes; restore local.key and rerun repo-knowledge conversations reset-key, or remove purge-progress.json to reset without them (the purge condition is already saved and still applies to new ingests)",
  );
}

function missingKeyWithData(): ConversationStoreError {
  return new ConversationStoreError(
    "CONVERSATION_KEY_MISSING",
    "stored utterances exist but local.key is missing; run repo-knowledge conversations reset-key",
  );
}

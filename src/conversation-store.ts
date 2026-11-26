import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson } from "./canonical.js";
import { ensurePrivateDirectory, resolveStorageRoot } from "./config.js";
import {
  ConversationRedactionSchema,
  hmacHex,
  redactConversationText,
} from "./conversation-redaction.js";
import {
  IsoDateTimeSchema,
  RepositoryNameSchema,
  Sha256DigestSchema,
} from "./domain-schemas.js";
import {
  appendDurable,
  fsyncDirectory,
  pathExists,
  replaceDurable,
  writeDurable,
} from "./durable-fs.js";
import type { DoctorCheck } from "./doctor/report-builder.js";
import { withPosixFileLock } from "./posix-file-lock.js";

const CONVERSATIONS_DIRECTORY = "conversations";
const FILES = {
  utterances: "utterances.jsonl",
  episodes: "episodes.jsonl",
  checkpoints: "checkpoints.json",
  purgeFilters: "purge-filters.json",
  purgeProgress: "purge-progress.json",
  routeCache: "route-cache.json",
  key: "local.key",
  nextKey: "local.key.next",
  resetPending: "reset-pending.json",
  lock: ".lock",
} as const;
const KEY_BYTES = 32;
const RESET_KEY = "run `repo-knowledge conversations reset-key`";
const FINISH_RESET = `${RESET_KEY} to finish it`;
const RESTART_RESET = "run `repo-knowledge conversations reset-key --restart`";

// ---------------------------------------------------------------------------
// Records

export const ConversationSourceSchema = z.enum(["claude-code", "codex"]);
const UtteranceIdSchema = z.string().regex(/^utt_[0-9a-f]{32}$/u);
const HmacSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const PathPrefixHmacsSchema = z.array(HmacSchema).min(1);

const UtteranceRecordSchema = z
  .object({
    type: z.literal("utterance"),
    utterance_id: UtteranceIdSchema,
    source: ConversationSourceSchema,
    source_origin: z.enum(["history", "transcript"]),
    session_id: z.string().min(1),
    session_kind: z.enum(["real", "pseudo"]),
    timestamp: IsoDateTimeSchema,
    project: z
      .object({
        kind: z.enum([
          "repository",
          "unregistered",
          "no_repository",
          "unresolved",
        ]),
        repo_id: z.string().min(1).nullable(),
        name_with_owner: RepositoryNameSchema.nullable(),
        path: z.string(),
        path_prefix_hmacs: PathPrefixHmacsSchema,
      })
      .strict(),
    text: z.string().max(2_000),
    text_digest: Sha256DigestSchema,
    context: z
      .object({ text: z.string(), text_digest: Sha256DigestSchema })
      .strict()
      .nullable(),
    signals: z.array(z.string()),
    human_confidence: z.enum(["high", "medium", "low"]),
    human_reasons: z.array(z.string()),
    redactions: z.array(ConversationRedactionSchema),
    flags: z.array(z.string()),
    detector_version: z.string().min(1),
    masking_version: z.string().min(1),
  })
  .strict();

const SupersededRecordSchema = z
  .object({
    type: z.literal("superseded"),
    utterance_id: UtteranceIdSchema,
    superseded_by: UtteranceIdSchema,
  })
  .strict();

/** Retention tombstone: only what purge filters need, never text or paths. */
const ExpiredTombstoneSchema = z
  .object({
    type: z.literal("expired"),
    utterance_id: UtteranceIdSchema,
    source: ConversationSourceSchema,
    session_id: z.string().min(1),
    timestamp: IsoDateTimeSchema,
    project: z
      .object({
        path_prefix_hmacs: PathPrefixHmacsSchema,
        name_with_owner: RepositoryNameSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const ConversationRecordSchema = z.discriminatedUnion("type", [
  UtteranceRecordSchema,
  SupersededRecordSchema,
  ExpiredTombstoneSchema,
]);

export type UtteranceRecord = z.infer<typeof UtteranceRecordSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;

const PurgeFilterShape = z
  .object({
    source: ConversationSourceSchema.optional(),
    session_id: z.string().min(1).optional(),
    before: IsoDateTimeSchema.optional(),
    after: IsoDateTimeSchema.optional(),
    project_path_prefix: z.string().startsWith("/").optional(),
    name_with_owner: RepositoryNameSchema.optional(),
  })
  .strict();
/**
 * A persisted filter is read back exactly as it was stored: re-resolving its
 * path later would let a changed symlink move what the filter deletes.
 */
export type PurgeFilter = z.infer<typeof PurgeFilterShape>;
/**
 * A filter as a user registers it. The path is resolved once, here, so
 * equivalent spellings dedupe and the stored value never changes meaning.
 */
const PurgeFilterInputSchema = PurgeFilterShape.extend({
  project_path_prefix: z
    .string()
    .startsWith("/")
    .transform((path) => normalizeProjectPath(path))
    .optional(),
  name_with_owner: RepositoryNameSchema.transform((name) =>
    name.toLowerCase(),
  ).optional(),
}).refine(
  (filter) => Object.keys(filter).length > 0,
  "a purge filter needs at least one condition",
);

/** Every rule for adding a filter, for both counting and purging. */
function parsePurgeFilterInput(input: PurgeFilter, now: Date): PurgeFilter {
  const filter = PurgeFilterInputSchema.parse(input);
  assertPurgeBeforeNotInFuture(filter, now);
  return filter;
}

const PurgeFiltersFileSchema = z
  .object({
    schema_version: z.literal(1),
    filters: z.array(PurgeFilterShape.extend({ added_at: IsoDateTimeSchema })),
  })
  .strict();

const PURGE_STAGES = [
  "ids_recorded",
  "compacted",
  "evidence_withdrawn",
  "jobs_failed",
] as const;
const PurgeProgressSchema = z
  .object({
    schema_version: z.literal(1),
    stage: z.enum(PURGE_STAGES),
    // Recorded with the IDs (stage 2) so a crash before the filter is
    // appended (stage 3) still adds it on resume. See design Q-017.
    filter: PurgeFilterShape,
    utterance_ids: z.array(UtteranceIdSchema),
  })
  .strict();
type PurgeProgress = z.infer<typeof PurgeProgressSchema>;

const ResetPendingSchema = z
  .object({
    schema_version: z.literal(1),
    key_id: z.string().regex(/^[0-9a-f]{16}$/u),
    completed_stage: z.number().int().min(0).max(3),
  })
  .strict();
export type ResetPendingMarker = z.infer<typeof ResetPendingSchema>;

// ---------------------------------------------------------------------------
// Keyed identifiers

export function keyId(key: Uint8Array): string {
  return hmacHex(key, "repo-knowledge/key-id").slice(0, 16);
}

export function utteranceId(
  key: Uint8Array,
  input: {
    readonly source: string;
    readonly session_id: string;
    readonly source_message_id: string | null;
    readonly timestamp: string;
    readonly masked_text_digest: string;
  },
): string {
  // Normalize the instant so `+09:00` and `Z` spellings share one ID.
  const timestamp = new Date(input.timestamp).toISOString();
  return `utt_${hmacHex(key, canonicalizeJson({ ...input, timestamp })).slice(0, 32)}`;
}

export function sessionKey(
  key: Uint8Array,
  source: string,
  sessionId: string,
): string {
  return hmacHex(key, canonicalizeJson(["session", source, sessionId]));
}

export function projectKey(key: Uint8Array, rawPath: string): string {
  return hmacHex(
    key,
    canonicalizeJson(["project", normalizeProjectPath(rawPath)]),
  );
}

function pathPrefixHmac(key: Uint8Array, normalizedPrefix: string): string {
  return hmacHex(key, canonicalizeJson(["path-prefix", normalizedPrefix]));
}

/**
 * One shared normalization for both the HMAC side and the filter side,
 * applied when a record is ingested or a filter is registered. Components are
 * resolved left to right the way the OS does: an existing component through
 * realpath (so a symlink or an alias such as macOS `/var` names its real
 * directory) before a later `..` steps up from it; once a component does not
 * exist, the rest is kept as written.
 */
export function normalizeProjectPath(path: string): string {
  if (!path.startsWith("/")) {
    throw new ConversationStoreError(
      "CONVERSATION_RECORD_INVALID",
      "project paths must be absolute",
    );
  }
  try {
    // The common case: the whole path exists and realpath resolves it alike.
    return realpathSync.native(path);
  } catch {
    // Fall through: resolve what exists component by component.
  }
  let resolved = "/";
  let exists = true;
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved = posix.dirname(resolved);
      continue;
    }
    const next = posix.join(resolved, part);
    if (exists) {
      try {
        resolved = realpathSync.native(next);
        continue;
      } catch {
        exists = false;
      }
    }
    resolved = next;
  }
  return resolved;
}

function pathPrefixes(normalized: string): string[] {
  const segments = normalized.split("/").filter(Boolean);
  return [
    "/",
    ...segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`),
  ];
}

/**
 * The stored form of a project path: a masked display path and the keyed
 * HMAC of every prefix (no depth limit), never the raw path itself.
 */
export function projectPathFields(
  key: Uint8Array,
  rawPath: string,
  redactTerms: readonly string[] = [],
): { path: string; path_prefix_hmacs: string[] } {
  const normalized = normalizeProjectPath(rawPath);
  return {
    path: redactConversationText(normalized, { redactTerms }).text,
    path_prefix_hmacs: pathPrefixes(normalized).map((prefix) =>
      pathPrefixHmac(key, prefix),
    ),
  };
}

// ---------------------------------------------------------------------------
// Matching (purge filters and excludeProjects share these)

export interface ProjectSubject {
  readonly nameWithOwner: string | null;
  /**
   * True when the subject path is at or below `prefix` (segment-wise).
   * `prefix` must already be normalized; it is not resolved again here.
   */
  hasPathPrefix(prefix: string): boolean;
}

/** Subject for values read from a source before anything is stored. */
export function rawProjectSubject(
  rawPath: string,
  nameWithOwner: string | null,
): ProjectSubject {
  const prefixes = new Set(pathPrefixes(normalizeProjectPath(rawPath)));
  return {
    nameWithOwner,
    hasPathPrefix: (prefix) => prefixes.has(prefix),
  };
}

/**
 * Subjects for stored utterances and tombstones, compared under `key`. Each
 * filter prefix is hashed once per matcher, not once per record.
 */
export function storedProjectMatcher(
  key: Uint8Array | null,
): (project: {
  readonly path_prefix_hmacs: readonly string[];
  readonly name_with_owner: string | null;
}) => ProjectSubject {
  if (key === null) {
    // Without a key no stored path can be compared.
    return (project) => ({
      nameWithOwner: project.name_with_owner,
      hasPathPrefix: () => false,
    });
  }
  const hmacs = new Map<string, string>();
  return (project) => ({
    nameWithOwner: project.name_with_owner,
    hasPathPrefix: (prefix) => {
      let hmac = hmacs.get(prefix);
      if (hmac === undefined) {
        hmac = pathPrefixHmac(key, prefix);
        hmacs.set(prefix, hmac);
      }
      return project.path_prefix_hmacs.includes(hmac);
    },
  });
}

/** `excludeProjects` entry or `--project` value: `/path` prefix or owner/name. */
export function matchesProjectSelector(
  selector: string,
  subject: ProjectSubject,
): boolean {
  return selector.startsWith("/")
    ? subject.hasPathPrefix(normalizeProjectPath(selector))
    : sameRepository(subject.nameWithOwner, selector);
}

/** GitHub owner and repository names are case-insensitive. */
function sameRepository(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

function matchesPurgeFilter(
  filter: PurgeFilter,
  subject: {
    readonly source: string;
    readonly session_id: string;
    readonly timestamp: string;
    readonly project: ProjectSubject;
  },
): boolean {
  const time = Date.parse(subject.timestamp);
  return (
    (filter.source === undefined || filter.source === subject.source) &&
    (filter.session_id === undefined ||
      filter.session_id === subject.session_id) &&
    (filter.before === undefined || time < Date.parse(filter.before)) &&
    (filter.after === undefined || time >= Date.parse(filter.after)) &&
    (filter.project_path_prefix === undefined ||
      subject.project.hasPathPrefix(filter.project_path_prefix)) &&
    (filter.name_with_owner === undefined ||
      sameRepository(subject.project.nameWithOwner, filter.name_with_owner))
  );
}

// ---------------------------------------------------------------------------
// Store

export type ConversationStoreErrorCode =
  | "CONVERSATION_KEY_INVALID"
  | "CONVERSATION_KEY_MISSING"
  | "CONVERSATION_PURGE_BEFORE_IN_FUTURE"
  | "CONVERSATION_KEY_MISMATCH"
  | "CONVERSATION_KEY_PERMISSIONS"
  | "CONVERSATION_RECORD_INVALID"
  | "CONVERSATION_RECORD_UNMASKED"
  | "CONVERSATION_RESET_PENDING"
  | "CONVERSATION_RESET_UNRECOVERABLE";

export class ConversationStoreError extends Error {
  constructor(
    readonly code: ConversationStoreErrorCode,
    /** The message without the code, for callers that add their own. */
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ConversationStoreError";
  }
}

/**
 * A purge filter also applies to every later ingest and cannot be removed,
 * so a future `before` would silently drop conversations until that time.
 * Checked where filters are added, never where persisted ones are read.
 */
export function assertPurgeBeforeNotInFuture(
  filter: Pick<PurgeFilter, "before">,
  now: Date,
): void {
  if (
    filter.before !== undefined &&
    Date.parse(filter.before) > now.getTime()
  ) {
    throw new ConversationStoreError(
      "CONVERSATION_PURGE_BEFORE_IN_FUTURE",
      "--before must not be in the future: the purge filter also drops conversations ingested later and cannot be removed",
    );
  }
}

export interface ConversationStoreOptions {
  readonly now?: () => Date;
  readonly lockTimeoutMs?: number;
  /** Test hook called after each durable step; throwing simulates a crash. */
  readonly faultInjector?: (point: string) => void;
  /**
   * Purge stages 4 (evidence withdrawn) and 5 (jobs failed), and reset-key
   * stage 3. They run while `.lock` is held so store writer locks are always
   * taken after it. Later phases replace the no-op defaults.
   */
  readonly purgeStages?: {
    readonly evidence_withdrawn?: (ids: readonly string[]) => Promise<void>;
    readonly jobs_failed?: (ids: readonly string[]) => Promise<void>;
  };
  readonly resetStage3?: (keyId: string) => Promise<void>;
}

export interface ConversationStatus {
  readonly directory_exists: boolean;
  readonly key: {
    readonly present: boolean;
    readonly key_id: string | null;
    readonly error?: ConversationStoreErrorCode;
  };
  readonly reset_pending: ResetPendingMarker | null;
  readonly purge_in_progress: PurgeProgress["stage"] | null;
  readonly purge_filter_count: number;
  readonly records: Record<ConversationRecord["type"], number>;
}

export class ConversationStore {
  readonly directory: string;

  constructor(
    private readonly storageRoot: string,
    private readonly options: ConversationStoreOptions = {},
  ) {
    this.directory = join(resolve(storageRoot), CONVERSATIONS_DIRECTORY);
  }

  private path(name: keyof typeof FILES): string {
    return join(this.directory, FILES[name]);
  }

  private inject(point: string): void {
    this.options.faultInjector?.(point);
  }

  private async locked<T>(callback: () => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(resolveStorageRoot(this.storageRoot));
    await ensurePrivateDirectory(this.directory);
    return withPosixFileLock(
      this.path("lock"),
      this.options.lockTimeoutMs ?? 30_000,
      callback,
    );
  }

  /**
   * Every writer except reset-key: refuse during a key reset, finish an
   * interrupted purge, and drop an append torn by a crash, before the
   * callback reads or adds records.
   */
  private writeLocked<T>(callback: () => Promise<T>): Promise<T> {
    return this.locked(async () => {
      await this.assertNoResetPending();
      await this.resumePurge();
      await dropPartialLastLine(this.path("utterances"));
      return callback();
    });
  }

  // --- reset-pending guard -------------------------------------------------

  async resetPending(): Promise<ResetPendingMarker | null> {
    return readJsonFile(this.path("resetPending"), ResetPendingSchema);
  }

  /** Refuses ingest (and later distill/prepare/submit) during a key reset. */
  async assertNoResetPending(): Promise<void> {
    if ((await this.resetPending()) !== null) {
      throw new ConversationStoreError(
        "CONVERSATION_RESET_PENDING",
        `a key reset is in progress; ${FINISH_RESET}`,
      );
    }
  }

  // --- key -----------------------------------------------------------------

  /** Reads `local.key`; returns null when absent and refuses wide modes. */
  async readKey(): Promise<Buffer | null> {
    return readKeyFile(this.path("key"));
  }

  /** Returns the key, creating it on first use (never during a reset). */
  async ensureKey(): Promise<Buffer> {
    return this.writeLocked(async () => {
      const existing = await this.readKey();
      assertKeyMatchesRecords(existing, await this.readRecords());
      if (existing !== null) return existing;
      const key = randomBytes(KEY_BYTES);
      await writeDurable(this.path("key"), key, "wx");
      await fsyncDirectory(this.directory);
      return key;
    });
  }

  // --- records -------------------------------------------------------------

  async readRecords(): Promise<ConversationRecord[]> {
    return readJsonl(this.path("utterances"), ConversationRecordSchema);
  }

  async readPurgeFilters(): Promise<PurgeFilter[]> {
    return (await this.readPurgeFiltersFile()).filters;
  }

  private async readPurgeFiltersFile() {
    return (
      (await readJsonFile(
        this.path("purgeFilters"),
        PurgeFiltersFileSchema,
      )) ?? {
        schema_version: 1 as const,
        filters: [],
      }
    );
  }

  /**
   * Appends already-masked records. Records matching a persisted purge
   * filter are dropped; unmasked text or paths are rejected outright.
   */
  async appendRecords(
    records: readonly ConversationRecord[],
    options: { readonly redactTerms?: readonly string[] } = {},
  ): Promise<{ appended: number; skipped_by_purge_filter: number }> {
    const parsed = records.map((record) =>
      ConversationRecordSchema.parse(record),
    );
    for (const record of parsed) assertMasked(record, options.redactTerms);
    return this.writeLocked(async () => {
      const key = await this.readKey();
      if (key === null) {
        throw new ConversationStoreError(
          "CONVERSATION_KEY_MISSING",
          "local.key does not exist",
        );
      }
      if (!recordsMatchKey(key, parsed)) {
        throw new ConversationStoreError(
          "CONVERSATION_KEY_MISMATCH",
          "records were built with a different local.key; ingest again",
        );
      }
      const purged = purgeMatcher(key, await this.readPurgeFilters());
      const kept = parsed.filter((record) => !purged(record));
      if (kept.length > 0) {
        await appendDurable(this.path("utterances"), toJsonl(kept));
      }
      return {
        appended: kept.length,
        skipped_by_purge_filter: parsed.length - kept.length,
      };
    });
  }

  /** Retention compaction run at the start of every ingest. */
  async compact(retentionDays: number | null): Promise<void> {
    await this.writeLocked(() => this.compactRecords(new Set(), retentionDays));
  }

  private async compactRecords(
    purgedIds: ReadonlySet<string>,
    retentionDays: number | null,
  ): Promise<void> {
    if (purgedIds.size === 0 && retentionDays === null) return;
    const cutoff =
      retentionDays === null
        ? null
        : this.now().getTime() - retentionDays * 86_400_000;
    // Compaction targets; PR5 adds grouping-runs.jsonl here.
    const targets = [
      {
        name: "utterances" as const,
        schema: ConversationRecordSchema,
        transform: (record: ConversationRecord): ConversationRecord[] => {
          if (record.type === "superseded") return [record];
          if (purgedIds.has(record.utterance_id)) return [];
          return record.type === "utterance" &&
            cutoff !== null &&
            Date.parse(record.timestamp) < cutoff
            ? [tombstoneOf(record)]
            : [record];
        },
      },
    ];
    for (const target of targets) {
      const records = await readJsonl(this.path(target.name), target.schema);
      const kept = records.flatMap(target.transform);
      if (
        kept.length !== records.length ||
        kept.some((r, i) => r !== records[i])
      ) {
        await replaceDurable(this.path(target.name), toJsonl(kept));
        this.inject("compaction:after_rename");
      }
    }
  }

  // --- purge (stages 1-3, with hooks for 4-5) -------------------------------

  /** Read-only count used to confirm a purge before taking the lock. */
  async previewPurge(input: PurgeFilter): Promise<number> {
    return (await this.matchingIds(parsePurgeFilterInput(input, this.now())))
      .length;
  }

  private async matchingIds(filter: PurgeFilter): Promise<string[]> {
    const key = await this.readKey();
    const records = await this.readRecords();
    // A path filter is compared through the key: without it, or with a key
    // that did not hash the stored records, it would match nothing and
    // report a purge that removed nothing as a success.
    if (
      filter.project_path_prefix !== undefined &&
      records.some((record) => record.type !== "superseded")
    ) {
      assertKeyMatchesRecords(key, records);
    }
    const matches = purgeMatcher(key, [filter]);
    return records.flatMap((record) =>
      record.type !== "superseded" && matches(record)
        ? [record.utterance_id]
        : [],
    );
  }

  async purge(
    input: PurgeFilter,
  ): Promise<{ filter_added: boolean; purged_records: number }> {
    const filter = parsePurgeFilterInput(input, this.now());
    return this.writeLocked(async () => {
      const progress: PurgeProgress = {
        schema_version: 1,
        stage: "ids_recorded",
        filter,
        utterance_ids: await this.matchingIds(filter),
      };
      await this.writePurgeProgress(progress);
      return {
        filter_added: await this.finishPurge(progress),
        purged_records: progress.utterance_ids.length,
      };
    });
  }

  /** Finishes an interrupted purge before anything reads or adds records. */
  private async resumePurge(): Promise<void> {
    const pending = await this.readPurgeProgress();
    if (pending !== null) await this.finishPurge(pending);
  }

  private readPurgeProgress(): Promise<PurgeProgress | null> {
    return readJsonFile(this.path("purgeProgress"), PurgeProgressSchema);
  }

  /**
   * Continues from the recorded stage; IDs never change once recorded.
   * Returns whether the filter was newly persisted.
   */
  private async finishPurge(progress: PurgeProgress): Promise<boolean> {
    let filterAdded = false;
    if (progress.stage === "ids_recorded") {
      // Stage 3 starts by appending the filter recorded in stage 2, so later
      // ingests skip matches even if compaction is interrupted.
      const file = await this.readPurgeFiltersFile();
      filterAdded = !file.filters.some(
        ({ added_at: _, ...existing }) =>
          canonicalizeJson(existing) === canonicalizeJson(progress.filter),
      );
      if (filterAdded) {
        file.filters.push({
          ...progress.filter,
          added_at: this.now().toISOString(),
        });
        await replaceDurable(this.path("purgeFilters"), jsonLine(file));
      }
      this.inject("purge:filter_added");
    }
    const ids = progress.utterance_ids;
    const steps = [
      ["compacted", () => this.compactRecords(new Set(ids), null)],
      [
        "evidence_withdrawn",
        async () => this.options.purgeStages?.evidence_withdrawn?.(ids),
      ],
      ["jobs_failed", async () => this.options.purgeStages?.jobs_failed?.(ids)],
    ] as const;
    const done = PURGE_STAGES.indexOf(progress.stage);
    for (const [stage, run] of steps.slice(done)) {
      await run();
      await this.writePurgeProgress({ ...progress, stage });
    }
    await rm(this.path("purgeProgress"), { force: true });
    await fsyncDirectory(this.directory);
    return filterAdded;
  }

  private async writePurgeProgress(progress: PurgeProgress): Promise<void> {
    await replaceDurable(this.path("purgeProgress"), jsonLine(progress));
    this.inject(`purge:${progress.stage}`);
  }

  // --- reset-key (stages 0, 1, 2, 4, with a hook for 3) --------------------

  async resetKey(
    options: { readonly restart?: boolean } = {},
  ): Promise<{ key_id: string; resumed: boolean }> {
    return this.locked(async () => {
      let marker: ResetPendingMarker | null;
      if (options.restart === true) {
        // --restart only drops a marker that can no longer be resumed;
        // otherwise the pending key is kept and the reset continues.
        marker = await this.resetPending().catch((error: unknown) => {
          if (error instanceof ConversationStoreError) return null;
          throw error;
        });
        if (marker !== null && !(await this.canResume(marker))) marker = null;
      } else {
        marker = await this.resetPending();
      }
      const resumed = marker !== null;
      if (marker === null) {
        // Stage 0: the key is durable before the marker that names it.
        await rm(this.path("nextKey"), { force: true });
        const key = randomBytes(KEY_BYTES);
        await writeDurable(this.path("nextKey"), key, "wx");
        await fsyncDirectory(this.directory);
        this.inject("reset:next_key_written");
        marker = { schema_version: 1, key_id: keyId(key), completed_stage: 0 };
        await replaceDurable(this.path("resetPending"), jsonLine(marker));
        this.inject("reset:marker_written");
      }

      // A pending purge still owes its later stages for the recorded IDs.
      if (marker.completed_stage < 2) await this.resumePurge();

      // Stage 1: swap the key, then discard key-dependent state.
      if (!(await this.canResume(marker))) {
        throw new ConversationStoreError(
          "CONVERSATION_RESET_UNRECOVERABLE",
          `neither local.key nor local.key.next matches the reset marker; ${RESTART_RESET}`,
        );
      }
      if ((await keyIdOf(this.path("key"))) !== marker.key_id) {
        await rename(this.path("nextKey"), this.path("key"));
        await fsyncDirectory(this.directory);
        this.inject("reset:key_renamed");
      }
      await rm(this.path("nextKey"), { force: true });
      if (marker.completed_stage < 2) {
        for (const name of [
          "utterances",
          "episodes",
          "checkpoints",
          "routeCache",
          "purgeProgress",
        ] as const) {
          await rm(this.path(name), { force: true });
          await rm(`${this.path(name)}.tmp`, { force: true });
        }
        await fsyncDirectory(this.directory);
        this.inject("reset:discarded");
        // Stage 2 keeps purge-filters.json: it holds key-independent values.
        marker = { ...marker, completed_stage: 2 };
        await replaceDurable(this.path("resetPending"), jsonLine(marker));
      }
      if (marker.completed_stage < 3) {
        await this.options.resetStage3?.(marker.key_id);
        marker = { ...marker, completed_stage: 3 };
        await replaceDurable(this.path("resetPending"), jsonLine(marker));
        this.inject("reset:stage3_done");
      }
      // Stage 4: ingest is allowed again.
      await rm(this.path("resetPending"), { force: true });
      await fsyncDirectory(this.directory);
      return { key_id: marker.key_id, resumed };
    });
  }

  /** Whether one of the key files still matches the reset marker. */
  private async canResume(marker: ResetPendingMarker): Promise<boolean> {
    return (
      (await keyIdOf(this.path("key"))) === marker.key_id ||
      (marker.completed_stage < 1 &&
        (await keyIdOf(this.path("nextKey"))) === marker.key_id)
    );
  }

  /**
   * Read-only health of the key and the reset marker for `doctor`; null
   * when the conversation data area has never been created. The marker is
   * checked first: finishing or restarting a reset also replaces a damaged
   * local.key, so the key alone would point at the wrong recovery.
   */
  async diagnose(): Promise<Pick<
    DoctorCheck,
    "status" | "message" | "remedy"
  > | null> {
    if (!(await pathExists(this.directory))) return null;
    let marker: ResetPendingMarker | null;
    try {
      marker = await this.resetPending();
    } catch {
      return {
        status: "warn",
        message: "reset-pending.json is not valid",
        remedy: RESTART_RESET,
      };
    }
    const key = await inspectKeyFile(this.path("key"));
    if (marker !== null) {
      // A key that only has too wide a mode still names its generation.
      if (key.error !== undefined && key.keyId === marker.key_id) {
        return {
          status: "fail",
          message: key.error.message,
          remedy: `chmod 600 the key file, then ${FINISH_RESET}`,
        };
      }
      return (await this.canResume(marker))
        ? {
            status: "warn",
            message:
              "A conversation key reset is in progress; ingest is refused",
            remedy: FINISH_RESET,
          }
        : {
            status: "warn",
            message:
              "Neither local.key nor local.key.next matches the reset marker",
            remedy: RESTART_RESET,
          };
    }
    if (key.error !== undefined) {
      return {
        status: "fail",
        message: key.error.message,
        remedy:
          key.error.code === "CONVERSATION_KEY_PERMISSIONS"
            ? "chmod 600 the key file"
            : RESET_KEY,
      };
    }
    try {
      assertKeyMatchesRecords(key.key, await this.readRecords());
    } catch (error) {
      if (!(error instanceof ConversationStoreError)) throw error;
      return {
        status: "warn",
        message:
          error.code === "CONVERSATION_KEY_MISSING"
            ? "Stored conversations exist but local.key is missing"
            : "Stored conversations were hashed with a different local.key",
        remedy: RESET_KEY,
      };
    }
    return {
      status: "pass",
      message: "Conversation key and reset state are consistent.",
    };
  }

  // --- status --------------------------------------------------------------

  async status(): Promise<ConversationStatus> {
    const records = { utterance: 0, superseded: 0, expired: 0 };
    for (const record of await this.readRecords()) records[record.type] += 1;
    let key: ConversationStatus["key"];
    try {
      const value = await this.readKey();
      key = {
        present: value !== null,
        key_id: value === null ? null : keyId(value),
      };
    } catch (error) {
      if (!(error instanceof ConversationStoreError)) throw error;
      key = { present: true, key_id: null, error: error.code };
    }
    return {
      directory_exists: await pathExists(this.directory),
      key,
      reset_pending: await this.resetPending(),
      purge_in_progress: (await this.readPurgeProgress())?.stage ?? null,
      purge_filter_count: (await this.readPurgeFilters()).length,
      records,
    };
  }

  // --- helpers -------------------------------------------------------------

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** Every stored utterance and tombstone hashes the `/` prefix. */
function recordsMatchKey(
  key: Uint8Array,
  records: readonly ConversationRecord[],
): boolean {
  const root = pathPrefixHmac(key, "/");
  return records.every(
    (record) =>
      record.type === "superseded" ||
      record.project.path_prefix_hmacs.includes(root),
  );
}

/**
 * The one rule for whether `key` can be used with the stored records: they
 * need the key that hashed them, so a missing key or a different one would
 * silently match nothing (and a new key would mint unrelated IDs).
 */
function assertKeyMatchesRecords(
  key: Uint8Array | null,
  records: readonly ConversationRecord[],
): void {
  if (key === null && records.length > 0) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_MISSING",
      `stored conversations exist but local.key is missing; ${RESET_KEY} to start over with a new key`,
    );
  }
  if (key !== null && !recordsMatchKey(key, records)) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_MISMATCH",
      `stored conversations were hashed with a different local.key; ${RESET_KEY} to start over with a new key`,
    );
  }
}

/** True for records (not supersede links) that match any of `filters`. */
function purgeMatcher(
  key: Uint8Array | null,
  filters: readonly PurgeFilter[],
): (record: ConversationRecord) => boolean {
  const projectOf = storedProjectMatcher(key);
  return (record) =>
    record.type !== "superseded" &&
    filters.some((filter) =>
      matchesPurgeFilter(filter, {
        ...record,
        project: projectOf(record.project),
      }),
    );
}

function jsonLine(value: unknown): Buffer {
  return Buffer.from(`${canonicalizeJson(value)}\n`, "utf8");
}

function toJsonl(records: readonly unknown[]): Buffer {
  return Buffer.concat(records.map(jsonLine));
}

function tombstoneOf(
  record: UtteranceRecord,
): z.infer<typeof ExpiredTombstoneSchema> {
  return {
    type: "expired",
    utterance_id: record.utterance_id,
    source: record.source,
    session_id: record.session_id,
    timestamp: record.timestamp,
    project: {
      path_prefix_hmacs: record.project.path_prefix_hmacs,
      name_with_owner: record.project.name_with_owner,
    },
  };
}

/** Masking is idempotent, so anything it would still change is unmasked. */
function assertMasked(
  record: ConversationRecord,
  redactTerms: readonly string[] = [],
): void {
  if (record.type !== "utterance") return;
  for (const value of [
    record.text,
    record.context?.text ?? "",
    record.project.path,
  ]) {
    if (redactConversationText(value, { redactTerms }).text !== value) {
      throw new ConversationStoreError(
        "CONVERSATION_RECORD_UNMASKED",
        `${record.utterance_id} contains text that was not masked`,
      );
    }
  }
}

async function readKeyFile(path: string): Promise<Buffer | null> {
  const status = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (status === null) return null;
  if (!status.isFile()) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_INVALID",
      `${path} must be a regular file`,
    );
  }
  if ((status.mode & 0o077) !== 0) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_PERMISSIONS",
      `${path} must not be readable by group or others (chmod 600)`,
    );
  }
  const key = await readFile(path);
  if (key.length !== KEY_BYTES) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_INVALID",
      `${path} must contain ${String(KEY_BYTES)} bytes`,
    );
  }
  return key;
}

/**
 * The key's generation even when its mode is too wide, so doctor can tell a
 * key that only needs chmod from a key that no longer matches.
 */
async function inspectKeyFile(path: string): Promise<{
  readonly key: Buffer | null;
  readonly keyId: string | null;
  readonly error?: ConversationStoreError;
}> {
  try {
    const key = await readKeyFile(path);
    return { key, keyId: key === null ? null : keyId(key) };
  } catch (error) {
    if (!(error instanceof ConversationStoreError)) throw error;
    const bytes =
      error.code === "CONVERSATION_KEY_PERMISSIONS"
        ? await readFile(path)
        : null;
    return {
      key: null,
      keyId: bytes?.length === KEY_BYTES ? keyId(bytes) : null,
      error,
    };
  }
}

async function keyIdOf(path: string): Promise<string | null> {
  try {
    const key = await readKeyFile(path);
    return key === null ? null : keyId(key);
  } catch {
    return null;
  }
}

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return schema.parse(JSON.parse(source));
  } catch {
    throw new ConversationStoreError(
      "CONVERSATION_RECORD_INVALID",
      `${path} is not valid`,
    );
  }
}

async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // The last element is "" or an append torn by a crash; never a record.
  return source
    .split("\n")
    .slice(0, -1)
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      try {
        return [schema.parse(JSON.parse(line))];
      } catch {
        // The line number only: never echo conversation content.
        throw new ConversationStoreError(
          "CONVERSATION_RECORD_INVALID",
          `${path} line ${String(index + 1)} is not a valid record`,
        );
      }
    });
}

/** Removes an unterminated final line left by an interrupted append. */
async function dropPartialLastLine(path: string): Promise<void> {
  const handle = await open(path, "r+").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (handle === null) return;
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size === 0) return;
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    // Rare crash path only: find the last complete line.
    const bytes = await handle.readFile();
    await handle.truncate(bytes.lastIndexOf(0x0a) + 1);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

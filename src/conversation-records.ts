import { z } from "zod";

import {
  ProjectPathSchema,
  projectPathMatchKey,
  projectPathPrefixes,
} from "./conversation-paths.js";
import { ConversationRedactionCountSchema } from "./conversation-redaction.js";
import {
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  RepositoryNameSchema,
  Sha256DigestSchema,
} from "./domain-schemas.js";

/** Stored text cap. Pastes are cut to 300 characters before this (PR3). */
export const MAX_UTTERANCE_TEXT_CHARACTERS = 2_000;

export const ConversationSourceSchema = z.enum(["claude-code", "codex"]);
export type ConversationSource = z.infer<typeof ConversationSourceSchema>;

export const UtteranceIdSchema = z
  .string()
  .regex(/^utt_[0-9a-f]{32}$/u, "must be utt_ + 32 lowercase hex digits");

const PathPrefixHmacSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/u, "must be 32 lowercase hex digits");

/**
 * Masked text. The read schema does not re-apply masking rules: a record
 * keeps the rules it was written with (`masking_version`), and the write
 * path checks the result.
 */
const MaskedTextSchema = z.string().max(MAX_UTTERANCE_TEXT_CHARACTERS);

const PathPrefixHmacsSchema = z
  .array(PathPrefixHmacSchema)
  .refine(
    (values) =>
      values.every((value, index) => index === 0 || values[index - 1]! < value),
    "must be sorted and unique",
  );

const ConversationProjectKindSchema = z.enum([
  "repository",
  "unregistered",
  "no_repository",
  "unresolved",
]);

const StoredProjectSchema = z
  .object({
    kind: ConversationProjectKindSchema,
    repo_id: NonEmptyStringSchema.nullable(),
    name_with_owner: RepositoryNameSchema.nullable(),
    /** Masked path, for display and per-job aliasing only; never matched. */
    path: z.string().nullable(),
    /** HMAC of every component prefix of the raw path; see the design doc. */
    path_prefix_hmacs: PathPrefixHmacsSchema,
  })
  .strict()
  .refine(
    (project) =>
      project.kind !== "repository" ||
      (project.repo_id !== null && project.name_with_owner !== null),
    "a repository project needs repo_id and name_with_owner",
  );

export const UtteranceRecordSchema = z
  .object({
    type: z.literal("utterance"),
    utterance_id: UtteranceIdSchema,
    source: ConversationSourceSchema,
    source_origin: z.enum(["history", "transcript"]),
    session_id: NonEmptyStringSchema,
    session_kind: z.enum(["real", "pseudo"]),
    timestamp: IsoDateTimeSchema,
    project: StoredProjectSchema,
    text: MaskedTextSchema,
    text_digest: Sha256DigestSchema,
    context: z
      .object({ text: MaskedTextSchema, text_digest: Sha256DigestSchema })
      .strict()
      .nullable(),
    signals: z.array(NonEmptyStringSchema),
    human_confidence: z.enum(["high", "medium", "low"]),
    human_reasons: z.array(NonEmptyStringSchema),
    /**
     * Masks applied to the source text and context, by kind. A mask in a part
     * the length cap later cut off is still counted: these describe what
     * masking did, not what placeholders remain.
     */
    redactions: z.array(ConversationRedactionCountSchema),
    flags: z.array(NonEmptyStringSchema),
    detector_version: NonEmptyStringSchema,
    masking_version: NonEmptyStringSchema,
  })
  .strict();
export type UtteranceRecord = z.infer<typeof UtteranceRecordSchema>;

/** History and transcript copies of one utterance (pipeline step 2). */
const SupersededRecordSchema = z
  .object({
    type: z.literal("superseded"),
    utterance_id: UtteranceIdSchema,
    superseded_by: UtteranceIdSchema,
  })
  .strict();

/**
 * What remains of an utterance after `retentionDays`: only the values a
 * later purge filter is matched against. No text, context, or signals.
 */
const ExpiredTombstoneSchema = z
  .object({
    type: z.literal("expired"),
    utterance_id: UtteranceIdSchema,
    source: ConversationSourceSchema,
    session_id: NonEmptyStringSchema,
    timestamp: IsoDateTimeSchema,
    project: z
      .object({
        name_with_owner: RepositoryNameSchema.nullable(),
        path_prefix_hmacs: PathPrefixHmacsSchema,
      })
      .strict(),
  })
  .strict();
export type ExpiredTombstone = z.infer<typeof ExpiredTombstoneSchema>;

export const ConversationDataRecordSchema = z.discriminatedUnion("type", [
  UtteranceRecordSchema,
  SupersededRecordSchema,
  ExpiredTombstoneSchema,
]);
export type ConversationDataRecord = z.infer<
  typeof ConversationDataRecordSchema
>;

export function toExpiredTombstone(record: UtteranceRecord): ExpiredTombstone {
  return {
    type: "expired",
    utterance_id: record.utterance_id,
    source: record.source,
    session_id: record.session_id,
    timestamp: record.timestamp,
    project: {
      name_with_owner: record.project.name_with_owner,
      path_prefix_hmacs: record.project.path_prefix_hmacs,
    },
  };
}

/**
 * One purge condition, stored with key-independent values so it survives
 * `reset-key`. Every set criterion must hold; filters are OR-ed. Values are
 * kept raw, as typed (design: 削除条件の形式), in the 0600 data area.
 */
export const PurgeFilterSchema = z
  .object({
    source: ConversationSourceSchema.optional(),
    session_id: NonEmptyStringSchema.optional(),
    /** Exclusive upper bound on the utterance timestamp. */
    before: IsoDateTimeSchema.optional(),
    /** Inclusive lower bound on the utterance timestamp. */
    after: IsoDateTimeSchema.optional(),
    project_path_prefix: ProjectPathSchema.optional(),
    name_with_owner: RepositoryNameSchema.optional(),
    added_at: IsoDateTimeSchema,
  })
  .strict()
  .refine(
    (filter) =>
      Object.entries(filter).some(
        ([name, value]) => name !== "added_at" && value !== undefined,
      ),
    "a purge filter needs at least one criterion",
  );
export type PurgeFilter = z.infer<typeof PurgeFilterSchema>;

/** 9999-12-31T23:59:59.999Z: later instants need a six-digit year. */
const LAST_FOUR_DIGIT_YEAR_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/**
 * A purge bound as stored: UTC milliseconds, widened so it still covers the
 * user's bound (`Date` drops sub-millisecond digits, so an exclusive upper
 * bound rounds up and a lower bound down). `null` outside the four-digit
 * years from 1970, which the stored ISO form cannot hold. The CLI and the
 * store both use this, so they accept exactly the same bounds.
 */
export function purgeBoundMilliseconds(
  value: string,
  direction: "down" | "up",
): number | null {
  const fraction = /\.\d{3}(\d*)/u.exec(value)?.[1] ?? "";
  const finer = direction === "up" && /[1-9]/u.test(fraction) ? 1 : 0;
  const time = Date.parse(value) + finer;
  return time >= 0 && time <= LAST_FOUR_DIGIT_YEAR_MS ? time : null;
}
export type PurgeCriteria = Omit<PurgeFilter, "added_at">;

/**
 * What a filter is matched against. `matchesPathPrefix` hides whether the
 * project path is raw (ingest time) or a set of prefix HMACs (stored), so
 * purge filters and `excludeProjects` share one matching rule.
 */
export interface ConversationMatchTarget {
  readonly matchesPathPrefix: (prefix: string) => boolean;
  readonly name_with_owner: string | null;
  readonly session_id: string;
  readonly source: ConversationSource;
  readonly timestamp: string;
}

/** Target for an utterance read from a source, before anything is stored. */
export function rawMatchTarget(input: {
  readonly name_with_owner: string | null;
  readonly raw_path: string | null;
  readonly session_id: string;
  readonly source: ConversationSource;
  readonly timestamp: string;
}): ConversationMatchTarget {
  // Computed once per utterance, then reused for every filter and entry.
  let prefixes: ReadonlySet<string> | undefined;
  const { raw_path } = input;
  return {
    matchesPathPrefix: (prefix) => {
      if (raw_path === null) return false;
      prefixes ??= new Set(projectPathPrefixes(raw_path));
      return prefixes.has(projectPathMatchKey(prefix));
    },
    name_with_owner: input.name_with_owner,
    session_id: input.session_id,
    source: input.source,
    timestamp: input.timestamp,
  };
}

/**
 * Target for a stored utterance or tombstone. `prefixHmac` is the current
 * key's prefix HMAC, or `null` without a usable key; it is only called for
 * a path criterion, so the other criteria match without the key.
 */
export function storedMatchTarget(
  record: UtteranceRecord | ExpiredTombstone,
  prefixHmac: (prefix: string) => string | null,
): ConversationMatchTarget {
  const hmacs = record.project.path_prefix_hmacs;
  return {
    // No path HMACs, no key needed; no usable key (`null`), no path match.
    matchesPathPrefix: (prefix) => {
      if (hmacs.length === 0) return false;
      const hmac = prefixHmac(prefix);
      return hmac !== null && hmacs.includes(hmac);
    },
    name_with_owner: record.project.name_with_owner,
    session_id: record.session_id,
    source: record.source,
    timestamp: record.timestamp,
  };
}

function sameRepositoryName(left: string, right: string): boolean {
  // GitHub owner and repository names are case-insensitive.
  return left.toLowerCase() === right.toLowerCase();
}

/** A bound as purge stores it, so every caller compares the same way. */
function boundMilliseconds(value: string, direction: "down" | "up"): number {
  return purgeBoundMilliseconds(value, direction) ?? Date.parse(value);
}

export function matchesPurgeFilter(
  filter: PurgeCriteria,
  target: ConversationMatchTarget,
): boolean {
  const time = Date.parse(target.timestamp);
  return (
    (filter.source === undefined || filter.source === target.source) &&
    (filter.session_id === undefined ||
      filter.session_id === target.session_id) &&
    (filter.before === undefined ||
      time < boundMilliseconds(filter.before, "up")) &&
    (filter.after === undefined ||
      time >= boundMilliseconds(filter.after, "down")) &&
    (filter.project_path_prefix === undefined ||
      target.matchesPathPrefix(filter.project_path_prefix)) &&
    (filter.name_with_owner === undefined ||
      (target.name_with_owner !== null &&
        sameRepositoryName(filter.name_with_owner, target.name_with_owner)))
  );
}

/** `excludeProjects` entry: `/…` is a path prefix, otherwise `owner/name`. */
export function matchesExcludedProject(
  entry: string,
  target: ConversationMatchTarget,
): boolean {
  return entry.startsWith("/")
    ? target.matchesPathPrefix(entry)
    : target.name_with_owner !== null &&
        sameRepositoryName(entry, target.name_with_owner);
}

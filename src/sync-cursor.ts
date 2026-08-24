import { z } from "zod";

import { GitHubNodeIdSchema, IsoDateTimeSchema } from "./domain-schemas.js";

export const SYNC_CURSOR_VERSION = 1;

/**
 * Versioned resume point for incremental sync. The boundary is the pair
 * (last_updated_at, last_pr_number); resuming enumerates strictly after it,
 * so several PRs sharing one timestamp are never dropped at the boundary.
 */
export const SyncCursorSchema = z
  .object({
    last_pr_number: z.number().int().positive(),
    last_updated_at: IsoDateTimeSchema,
    repo_id: GitHubNodeIdSchema,
    version: z.literal(SYNC_CURSOR_VERSION),
  })
  .strict();

export type SyncCursor = z.infer<typeof SyncCursorSchema>;

export type SyncCursorErrorCode =
  | "SYNC_BOUNDARY_CONFLICT"
  | "SYNC_CURSOR_INVALID"
  | "SYNC_CURSOR_REPOSITORY_MISMATCH"
  | "SYNC_CURSOR_VERSION_UNSUPPORTED"
  | "SYNC_SINCE_INVALID";

export class SyncCursorError extends Error {
  constructor(
    readonly code: SyncCursorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SyncCursorError";
  }
}

export interface SyncCursorBoundary {
  readonly cursor: SyncCursor;
  readonly kind: "cursor";
  readonly lastUpdatedAtMs: number;
}

export interface SyncFullBoundary {
  readonly kind: "full";
}

export interface SyncSinceBoundary {
  readonly kind: "since";
  readonly sinceIso: string;
  readonly sinceMs: number;
}

export type SyncBoundary =
  | SyncCursorBoundary
  | SyncFullBoundary
  | SyncSinceBoundary;

export interface ResolveSyncBoundaryRequest {
  readonly cursor?: unknown;
  readonly since?: string;
}

export interface SyncOrderKey {
  readonly number: number;
  readonly updatedAtMs: number;
}

export function parseSyncCursor(value: unknown): SyncCursor {
  if (
    isRecord(value) &&
    "version" in value &&
    value.version !== SYNC_CURSOR_VERSION
  ) {
    throw new SyncCursorError(
      "SYNC_CURSOR_VERSION_UNSUPPORTED",
      `sync cursor version must be ${String(SYNC_CURSOR_VERSION)}`,
    );
  }
  const parsed = SyncCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new SyncCursorError("SYNC_CURSOR_INVALID", parsed.error.message, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function resolveSyncBoundary(
  request: ResolveSyncBoundaryRequest,
): SyncBoundary {
  if (request.cursor !== undefined && request.since !== undefined) {
    throw new SyncCursorError(
      "SYNC_BOUNDARY_CONFLICT",
      "cursor and --since are mutually exclusive boundaries",
    );
  }
  if (request.cursor !== undefined) {
    const cursor = parseSyncCursor(request.cursor);
    return {
      cursor,
      kind: "cursor",
      lastUpdatedAtMs: parseIsoTimestampMs(cursor.last_updated_at),
    };
  }
  if (request.since !== undefined) {
    const parsed = IsoDateTimeSchema.safeParse(request.since);
    if (!parsed.success) {
      throw new SyncCursorError("SYNC_SINCE_INVALID", parsed.error.message, {
        cause: parsed.error,
      });
    }
    return {
      kind: "since",
      sinceIso: parsed.data,
      sinceMs: parseIsoTimestampMs(parsed.data),
    };
  }
  return { kind: "full" };
}

/**
 * Boundary rule fixed by spec: `--since` is exclusive (only PRs with
 * updatedAt strictly newer than the boundary time are targets), while a
 * cursor resumes strictly after the (updatedAt, PR number) pair.
 */
export function isAfterSyncBoundary(
  boundary: SyncBoundary,
  updatedAtMs: number,
  prNumber: number,
): boolean {
  switch (boundary.kind) {
    case "full":
      return true;
    case "since":
      return updatedAtMs > boundary.sinceMs;
    case "cursor":
      if (updatedAtMs !== boundary.lastUpdatedAtMs) {
        return updatedAtMs > boundary.lastUpdatedAtMs;
      }
      return prNumber > boundary.cursor.last_pr_number;
  }
}

/**
 * True when every PR at or below this timestamp is outside the boundary
 * window, letting an updatedAt-descending traversal stop early without
 * losing same-timestamp PRs at a cursor boundary.
 */
export function isBeyondSyncBoundaryWindow(
  boundary: SyncBoundary,
  updatedAtMs: number,
): boolean {
  switch (boundary.kind) {
    case "full":
      return false;
    case "since":
      return updatedAtMs <= boundary.sinceMs;
    case "cursor":
      return updatedAtMs < boundary.lastUpdatedAtMs;
  }
}

/** Deterministic ascending order: updatedAt first, PR number as tie-break. */
export function compareSyncOrder(a: SyncOrderKey, b: SyncOrderKey): number {
  if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
  return a.number - b.number;
}

export function nextSyncCursor(
  repoId: string,
  last: { readonly number: number; readonly updatedAt: string },
): SyncCursor {
  return SyncCursorSchema.parse({
    last_pr_number: last.number,
    last_updated_at: last.updatedAt,
    repo_id: repoId,
    version: SYNC_CURSOR_VERSION,
  });
}

/** Compares ISO timestamps by instant so `Z` and `+00:00` forms are equal. */
export function parseIsoTimestampMs(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new TypeError(`invalid ISO timestamp: ${value}`);
  }
  return ms;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

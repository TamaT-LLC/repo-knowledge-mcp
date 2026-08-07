import { describe, expect, it } from "vitest";

import {
  SYNC_CURSOR_VERSION,
  SyncCursorSchema,
  compareSyncOrder,
  isAfterSyncBoundary,
  isBeyondSyncBoundaryWindow,
  nextSyncCursor,
  parseIsoTimestampMs,
  parseSyncCursor,
  resolveSyncBoundary,
  type SyncCursor,
} from "../src/index.js";

const BOUNDARY_AT = "2026-08-01T12:00:00.000Z";

const cursor: SyncCursor = {
  last_pr_number: 41,
  last_updated_at: BOUNDARY_AT,
  repo_id: "R_repo_node",
  version: SYNC_CURSOR_VERSION,
};

describe("SyncCursorSchema", () => {
  it("accepts a versioned cursor and rejects unknown or invalid fields", () => {
    expect(SyncCursorSchema.parse(cursor)).toEqual(cursor);
    expect(SyncCursorSchema.safeParse({ ...cursor, extra: true }).success).toBe(
      false,
    );
    expect(
      SyncCursorSchema.safeParse({ ...cursor, last_pr_number: 0 }).success,
    ).toBe(false);
    expect(
      SyncCursorSchema.safeParse({ ...cursor, last_updated_at: "yesterday" })
        .success,
    ).toBe(false);
  });
});

describe("parseSyncCursor", () => {
  it("round-trips a valid cursor", () => {
    expect(parseSyncCursor(cursor)).toEqual(cursor);
  });

  it("rejects an unsupported version before shape validation", () => {
    expect(() => parseSyncCursor({ ...cursor, version: 2 })).toThrowError(
      expect.objectContaining({ code: "SYNC_CURSOR_VERSION_UNSUPPORTED" }),
    );
  });

  it("rejects malformed cursors", () => {
    for (const value of [null, "cursor", { version: SYNC_CURSOR_VERSION }]) {
      expect(() => parseSyncCursor(value)).toThrowError(
        expect.objectContaining({ code: "SYNC_CURSOR_INVALID" }),
      );
    }
  });
});

describe("resolveSyncBoundary", () => {
  it("resolves full, since, and cursor boundaries", () => {
    expect(resolveSyncBoundary({})).toEqual({ kind: "full" });
    expect(resolveSyncBoundary({ since: BOUNDARY_AT })).toEqual({
      kind: "since",
      sinceIso: BOUNDARY_AT,
      sinceMs: parseIsoTimestampMs(BOUNDARY_AT),
    });
    expect(resolveSyncBoundary({ cursor })).toEqual({
      cursor,
      kind: "cursor",
      lastUpdatedAtMs: parseIsoTimestampMs(BOUNDARY_AT),
    });
  });

  it("rejects supplying both a cursor and --since", () => {
    expect(() =>
      resolveSyncBoundary({ cursor, since: BOUNDARY_AT }),
    ).toThrowError(expect.objectContaining({ code: "SYNC_BOUNDARY_CONFLICT" }));
  });

  it("rejects a non-ISO --since value", () => {
    expect(() => resolveSyncBoundary({ since: "last week" })).toThrowError(
      expect.objectContaining({ code: "SYNC_SINCE_INVALID" }),
    );
  });
});

describe("isAfterSyncBoundary", () => {
  const boundaryMs = parseIsoTimestampMs(BOUNDARY_AT);

  it("treats --since as an exclusive time boundary", () => {
    const boundary = resolveSyncBoundary({ since: BOUNDARY_AT });
    expect(isAfterSyncBoundary(boundary, boundaryMs + 1, 1)).toBe(true);
    expect(isAfterSyncBoundary(boundary, boundaryMs, 999)).toBe(false);
    expect(isAfterSyncBoundary(boundary, boundaryMs - 1, 999)).toBe(false);
  });

  it("resumes a cursor strictly after the (updatedAt, number) pair", () => {
    const boundary = resolveSyncBoundary({ cursor });
    expect(isAfterSyncBoundary(boundary, boundaryMs + 1, 1)).toBe(true);
    expect(isAfterSyncBoundary(boundary, boundaryMs, 42)).toBe(true);
    expect(isAfterSyncBoundary(boundary, boundaryMs, 41)).toBe(false);
    expect(isAfterSyncBoundary(boundary, boundaryMs, 40)).toBe(false);
    expect(isAfterSyncBoundary(boundary, boundaryMs - 1, 999)).toBe(false);
  });

  it("compares timestamps by instant rather than by string form", () => {
    const boundary = resolveSyncBoundary({
      cursor: { ...cursor, last_updated_at: "2026-08-01T12:00:00+00:00" },
    });
    expect(isAfterSyncBoundary(boundary, boundaryMs, 42)).toBe(true);
    expect(isAfterSyncBoundary(boundary, boundaryMs, 41)).toBe(false);
  });
});

describe("isBeyondSyncBoundaryWindow", () => {
  const boundaryMs = parseIsoTimestampMs(BOUNDARY_AT);

  it("never stops a full enumeration", () => {
    expect(isBeyondSyncBoundaryWindow({ kind: "full" }, 0)).toBe(false);
  });

  it("stops --since traversal at the boundary timestamp itself", () => {
    const boundary = resolveSyncBoundary({ since: BOUNDARY_AT });
    expect(isBeyondSyncBoundaryWindow(boundary, boundaryMs + 1)).toBe(false);
    expect(isBeyondSyncBoundaryWindow(boundary, boundaryMs)).toBe(true);
  });

  it("keeps scanning cursor-equal timestamps for number tie-breaks", () => {
    const boundary = resolveSyncBoundary({ cursor });
    expect(isBeyondSyncBoundaryWindow(boundary, boundaryMs)).toBe(false);
    expect(isBeyondSyncBoundaryWindow(boundary, boundaryMs - 1)).toBe(true);
  });
});

describe("compareSyncOrder", () => {
  it("orders by updatedAt then PR number", () => {
    const unordered = [
      { number: 9, updatedAtMs: 200 },
      { number: 3, updatedAtMs: 100 },
      { number: 1, updatedAtMs: 200 },
      { number: 2, updatedAtMs: 100 },
    ];
    expect([...unordered].sort(compareSyncOrder)).toEqual([
      { number: 2, updatedAtMs: 100 },
      { number: 3, updatedAtMs: 100 },
      { number: 1, updatedAtMs: 200 },
      { number: 9, updatedAtMs: 200 },
    ]);
  });
});

describe("nextSyncCursor", () => {
  it("builds a versioned cursor from the newest enumerated PR", () => {
    expect(
      nextSyncCursor("R_repo_node", { number: 41, updatedAt: BOUNDARY_AT }),
    ).toEqual(cursor);
  });
});

describe("parseIsoTimestampMs", () => {
  it("rejects non-timestamp input", () => {
    expect(() => parseIsoTimestampMs("not-a-date")).toThrowError(TypeError);
  });
});

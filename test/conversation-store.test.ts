import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  redactConversationText,
  truncateRedactedText,
} from "../src/conversation-redaction.js";
import {
  ConversationStore,
  keyId,
  matchesProjectSelector,
  projectPathFields,
  rawProjectSubject,
  sessionKey,
  projectKey,
  storedProjectMatcher,
  utteranceId,
  type ConversationRecord,
  type ConversationStoreOptions,
  type UtteranceRecord,
} from "../src/conversation-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rk-conversation-store-"));
  roots.push(root);
  return root;
}

const NOW = new Date("2026-06-01T00:00:00Z");
const ALICE = "/Users/alice/repo/app";
const BOB = "/Users/bob/repo/app";

function utterance(
  key: Buffer,
  overrides: {
    readonly path?: string;
    readonly session?: string;
    readonly timestamp?: string;
    readonly text?: string;
    readonly source?: "claude-code" | "codex";
  } = {},
): UtteranceRecord {
  const text = overrides.text ?? "please answer in Japanese";
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const source = overrides.source ?? "claude-code";
  const session_id = overrides.session ?? "session-1";
  const timestamp = overrides.timestamp ?? "2026-05-30T00:00:00Z";
  return {
    type: "utterance",
    utterance_id: utteranceId(key, {
      source,
      session_id,
      source_message_id: null,
      timestamp,
      masked_text_digest: digest,
    }),
    source,
    source_origin: "transcript",
    session_id,
    session_kind: "real",
    timestamp,
    project: {
      kind: "unregistered",
      repo_id: null,
      name_with_owner: "owner/name",
      ...projectPathFields(key, overrides.path ?? ALICE),
    },
    text,
    text_digest: digest,
    context: null,
    signals: ["correction_keyword"],
    human_confidence: "high",
    human_reasons: [],
    redactions: [],
    flags: [],
    detector_version: "test",
    masking_version: "conv-mask-v1+test",
  };
}

class Crash extends Error {}

function store(
  root: string,
  options: ConversationStoreOptions = {},
): ConversationStore {
  return new ConversationStore(root, { now: () => NOW, ...options });
}

/** Crashes at `point`, then lets a fresh store finish from disk state. */
function crashingAt(point: string): (current: string) => void {
  return (current) => {
    if (current === point) throw new Crash(point);
  };
}

async function seed(root: string): Promise<{ key: Buffer; ids: string[] }> {
  const current = store(root);
  const key = await current.ensureKey();
  const records: ConversationRecord[] = [
    utterance(key, { session: "s-alice" }),
    utterance(key, { path: BOB, session: "s-bob", text: "use pnpm" }),
    utterance(key, {
      session: "s-old",
      timestamp: "2025-01-01T00:00:00Z",
      text: "old",
    }),
  ];
  const [first, second] = records as [UtteranceRecord, UtteranceRecord];
  records.push({
    type: "superseded",
    utterance_id: first.utterance_id,
    superseded_by: second.utterance_id,
  });
  await current.appendRecords(records);
  return {
    key,
    ids: records.flatMap((r) =>
      r.type === "utterance" ? [r.utterance_id] : [],
    ),
  };
}

async function rawFile(root: string, name: string): Promise<string> {
  return readFile(join(root, "conversations", name), "utf8").catch(() => "");
}

describe("keyed identifiers (M4-AC-031)", () => {
  it("are deterministic for the same input and key, and differ by key", () => {
    const key = Buffer.alloc(32, 1);
    const other = Buffer.alloc(32, 2);
    const input = {
      source: "codex",
      session_id: "s",
      source_message_id: "m",
      timestamp: "2026-05-30T09:00:00+09:00",
      masked_text_digest: "sha256:00",
    };
    expect(utteranceId(key, input)).toMatch(/^utt_[0-9a-f]{32}$/u);
    expect(utteranceId(key, input)).toBe(utteranceId(key, { ...input }));
    expect(
      utteranceId(key, { ...input, timestamp: "2026-05-30T00:00:00.000Z" }),
    ).toBe(utteranceId(key, input));
    expect(utteranceId(other, input)).not.toBe(utteranceId(key, input));
    expect(keyId(key)).toMatch(/^[0-9a-f]{16}$/u);
    expect(keyId(key)).toBe(keyId(Buffer.alloc(32, 1)));
    expect(keyId(other)).not.toBe(keyId(key));
    expect(sessionKey(key, "codex", "s")).toBe(sessionKey(key, "codex", "s"));
    expect(projectKey(key, "/a/b/")).toBe(projectKey(key, "/a/b"));
  });
});

describe("project matching", () => {
  const key = Buffer.alloc(32, 3);
  const cases = [
    [ALICE, "/Users/alice/repo", true],
    [ALICE, "/Users/alice/repo/", true],
    [ALICE, "/Users/alice/re", false],
    [ALICE, "/Users/bob/repo", false],
    [ALICE, "/", true],
    [ALICE, ALICE, true],
    [ALICE, `${ALICE}/deeper`, false],
    ["/a/b/c/d/e/f/g/h/i/j/k/l", "/a/b/c/d/e/f/g/h/i/j/k", true],
    [ALICE, "owner/name", true],
    [ALICE, "owner/other", false],
    [ALICE, "OWNER/Name", true],
  ] as const;

  it.each(cases)(
    "%s against %s is %s on both the raw and stored side",
    (path, selector, expected) => {
      const stored = storedProjectMatcher(key)({
        ...projectPathFields(key, path),
        name_with_owner: "owner/name",
      });
      expect(
        matchesProjectSelector(selector, rawProjectSubject(path, "owner/name")),
      ).toBe(expected);
      expect(matchesProjectSelector(selector, stored)).toBe(expected);
    },
  );

  it("never stores the raw path", () => {
    const fields = projectPathFields(key, ALICE);
    expect(fields.path).toBe("~/repo/app");
    expect(projectPathFields(key, "/work/Acme/app", ["acme"]).path).toBe(
      "/work/[REDACTED]/app",
    );
    expect(JSON.stringify(fields)).not.toContain("alice");
    expect(fields.path_prefix_hmacs).toHaveLength(5);
  });
});

describe("conversation data area", () => {
  it("creates private files and refuses a wide key (M4-AC-028)", async () => {
    const root = await home();
    await seed(root);
    const directory = join(root, "conversations");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) {
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    await chmod(join(directory, "local.key"), 0o644);
    await expect(store(root).readKey()).rejects.toThrow(
      "CONVERSATION_KEY_PERMISSIONS",
    );
    await expect(store(root).ensureKey()).rejects.toThrow(
      "CONVERSATION_KEY_PERMISSIONS",
    );
    expect((await store(root).status()).key).toEqual({
      present: true,
      key_id: null,
      error: "CONVERSATION_KEY_PERMISSIONS",
    });
  });

  it("reports status without text and without creating anything", async () => {
    const root = await home();
    expect(await store(root).status()).toMatchObject({
      directory_exists: false,
      key: { present: false, key_id: null },
      records: { utterance: 0, superseded: 0, expired: 0 },
    });
    expect(await readdir(root)).toEqual([]);
    const { key } = await seed(root);
    const status = await store(root).status();
    expect(status).toMatchObject({
      key: { present: true, key_id: keyId(key) },
      records: { utterance: 3, superseded: 1, expired: 0 },
      reset_pending: null,
      purge_in_progress: null,
      purge_filter_count: 0,
    });
    expect(JSON.stringify(status)).not.toContain("Japanese");
  });

  it("rejects unmasked text or paths and stores no raw path (M4-AC-007)", async () => {
    const root = await home();
    const current = store(root);
    const key = await current.ensureKey();
    await expect(
      current.appendRecords([
        utterance(key, { text: "token=abcdefghijklmnopqrstu" }),
      ]),
    ).rejects.toThrow("CONVERSATION_RECORD_UNMASKED");
    await expect(
      current.appendRecords([utterance(key, { text: "Ask Tanaka" })], {
        redactTerms: ["tanaka"],
      }),
    ).rejects.toThrow("CONVERSATION_RECORD_UNMASKED");
    const raw = utterance(key);
    await expect(
      current.appendRecords([
        { ...raw, project: { ...raw.project, path: ALICE } },
      ]),
    ).rejects.toThrow("CONVERSATION_RECORD_UNMASKED");
    await expect(current.appendRecords([])).resolves.toEqual({
      appended: 0,
      skipped_by_purge_filter: 0,
    });
    await seed(root);
    await current.compact(30);
    const bytes = await rawFile(root, "utterances.jsonl");
    expect(bytes).toContain('"type":"expired"');
    expect(bytes).not.toMatch(/\/Users\/|alice\/|bob\//u);
  });

  it("requires a key before appending", async () => {
    const root = await home();
    const key = Buffer.alloc(32, 9);
    await expect(store(root).appendRecords([utterance(key)])).rejects.toThrow(
      "CONVERSATION_KEY_MISSING",
    );
  });

  it("reports invalid lines without echoing content", async () => {
    const root = await home();
    await seed(root);
    await writeFile(
      join(root, "conversations", "utterances.jsonl"),
      '{"type":"utterance","text":"secret words"}\n',
    );
    const error = await store(root)
      .readRecords()
      .catch((e: Error) => e);
    expect(String(error)).toContain("line 1");
    expect(String(error)).not.toContain("secret words");
  });
});

describe("retention (M4-AC-037, M4-AC-051)", () => {
  it("turns expired utterances into minimal tombstones and adds no filter", async () => {
    const root = await home();
    const { ids } = await seed(root);
    await store(root).compact(30);
    const records = await store(root).readRecords();
    const tombstone = records.find((r) => r.type === "expired");
    expect(Object.keys(tombstone!).sort()).toEqual([
      "project",
      "session_id",
      "source",
      "timestamp",
      "type",
      "utterance_id",
    ]);
    expect(
      Object.keys(tombstone!.type === "expired" ? tombstone!.project : {}),
    ).toEqual(["path_prefix_hmacs", "name_with_owner"]);
    expect(tombstone!.utterance_id).toBe(ids[2]);
    expect(records.filter((r) => r.type === "superseded")).toHaveLength(1);
    expect(await store(root).readPurgeFilters()).toEqual([]);
    await store(root).compact(30);
    expect(await store(root).readRecords()).toEqual(records);
    await store(root).compact(null);
    expect(await store(root).readRecords()).toEqual(records);
  });

  it("purges tombstones by a later path filter, sparing other homes", async () => {
    const root = await home();
    await seed(root);
    await store(root).compact(30);
    const result = await store(root).purge({
      project_path_prefix: "/Users/alice/repo",
    });
    expect(result).toEqual({ filter_added: true, purged_records: 2 });
    const remaining = await store(root).readRecords();
    expect(remaining.map((r) => r.type).sort()).toEqual([
      "superseded",
      "utterance",
    ]);
    expect(remaining.find((r) => r.type === "utterance")?.session_id).toBe(
      "s-bob",
    );
  });
});

describe("purge stages 1-3 (M4-AC-022)", () => {
  it("removes matches, keeps superseded, persists the filter, blocks re-ingest", async () => {
    const root = await home();
    const { key } = await seed(root);
    const current = store(root);
    expect(await current.previewPurge({ session_id: "s-alice" })).toBe(1);
    await current.purge({ session_id: "s-alice" });
    const again = await current.purge({ session_id: "s-alice" });
    expect(again).toEqual({ filter_added: false, purged_records: 0 });
    expect(await current.readPurgeFilters()).toEqual([
      { session_id: "s-alice", added_at: NOW.toISOString() },
    ]);
    expect(
      await current.appendRecords([utterance(key, { session: "s-alice" })]),
    ).toEqual({ appended: 0, skipped_by_purge_filter: 1 });
    const types = (await current.readRecords()).map((r) => r.type);
    expect(types.sort()).toEqual(["superseded", "utterance", "utterance"]);

    for (const filter of [
      { source: "codex" as const },
      { before: "2025-06-01T00:00:00Z", name_with_owner: "owner/name" },
      { after: "2026-05-01T00:00:00Z" },
    ]) {
      await current.purge(filter);
    }
    expect(
      (await current.readRecords()).filter((r) => r.type !== "superseded"),
    ).toEqual([]);
    await expect(current.purge({} as never)).rejects.toThrow();
  });

  it("runs post-compaction stages with the recorded IDs", async () => {
    const root = await home();
    const { ids } = await seed(root);
    const calls: string[] = [];
    await store(root, {
      purgeStages: {
        evidence_withdrawn: async (purged) => {
          calls.push(`evidence:${purged.join(",")}`);
        },
        jobs_failed: async () => {
          calls.push("jobs");
        },
      },
    }).purge({ session_id: "s-bob" });
    expect(calls).toEqual([`evidence:${ids[1]}`, "jobs"]);
  });
});

describe("interruption and resume (M4-AC-049)", () => {
  it.each([
    "purge:filter_added",
    "purge:ids_recorded",
    "compaction:after_rename",
    "purge:compacted",
    "purge:evidence_withdrawn",
    "purge:jobs_failed",
  ])("purge resumes after a crash at %s", async (point) => {
    const root = await home();
    await seed(root);
    await expect(
      store(root, { faultInjector: crashingAt(point) }).purge({
        project_path_prefix: "/Users/alice",
      }),
    ).rejects.toThrow(Crash);
    if (point !== "purge:filter_added" && point !== "purge:ids_recorded") {
      // Once compaction has renamed, nothing purged is physically left.
      expect(await rawFile(root, "utterances.jsonl")).not.toContain("s-alice");
    }
    // Re-running the same command finishes the recorded purge first.
    await store(root).purge({ project_path_prefix: "/Users/alice" });
    const remaining = await store(root).readRecords();
    expect(
      remaining.filter((r) => r.type !== "superseded").map((r) => r.session_id),
    ).toEqual(["s-bob"]);
    expect(await store(root).readPurgeFilters()).toHaveLength(1);
    expect(await readdir(join(root, "conversations"))).not.toContain(
      "purge-progress.json",
    );
  });

  it("finishes an interrupted purge before a different one", async () => {
    const root = await home();
    await seed(root);
    await expect(
      store(root, { faultInjector: crashingAt("purge:ids_recorded") }).purge({
        session_id: "s-alice",
      }),
    ).rejects.toThrow(Crash);
    expect((await store(root).status()).purge_in_progress).toBe("ids_recorded");
    await store(root).purge({ session_id: "s-bob" });
    expect(
      (await store(root).readRecords())
        .filter((r) => r.type === "utterance")
        .map((r) => r.session_id),
    ).toEqual(["s-old"]);
  });

  it.each([
    ["reset:next_key_written", false],
    ["reset:marker_written", true],
    ["reset:key_renamed", true],
    ["reset:discarded", true],
    ["reset:stage3_done", true],
  ] as const)(
    "reset-key resumes after a crash at %s (keeps the key: %s)",
    async (point, keepsKey) => {
      const root = await home();
      const { key: oldKey } = await seed(root);
      await store(root).purge({ session_id: "s-alice" });
      await expect(
        store(root, { faultInjector: crashingAt(point) }).resetKey(),
      ).rejects.toThrow(Crash);
      const marker = await store(root).resetPending();
      expect(marker !== null).toBe(keepsKey);
      if (marker !== null) {
        // Ingest is refused while the reset is pending (M4-AC-023).
        await expect(store(root).ensureKey()).rejects.toThrow(
          "CONVERSATION_RESET_PENDING",
        );
        await expect(store(root).appendRecords([])).rejects.toThrow(
          "CONVERSATION_RESET_PENDING",
        );
        await expect(store(root).compact(null)).rejects.toThrow(
          "CONVERSATION_RESET_PENDING",
        );
        await expect(
          store(root).purge({ session_id: "s-bob" }),
        ).rejects.toThrow("CONVERSATION_RESET_PENDING");
      }

      const result = await store(root).resetKey();
      expect(result.resumed).toBe(keepsKey);
      if (marker !== null) expect(result.key_id).toBe(marker.key_id);
      const newKey = await store(root).readKey();
      expect(keyId(newKey!)).toBe(result.key_id);
      expect(result.key_id).not.toBe(keyId(oldKey));
      expect(await readdir(join(root, "conversations"))).toEqual(
        expect.not.arrayContaining([
          "utterances.jsonl",
          "local.key.next",
          "reset-pending.json",
        ]),
      );
      // Purge filters survive and match records rebuilt with the new key.
      expect(await store(root).readPurgeFilters()).toHaveLength(1);
      expect(
        await store(root).appendRecords([
          utterance(newKey!, { session: "s-alice" }),
          utterance(newKey!, { path: BOB, session: "s-bob" }),
        ]),
      ).toEqual({ appended: 1, skipped_by_purge_filter: 1 });
      await store(root).purge({ project_path_prefix: "/Users/bob" });
      expect(await store(root).readRecords()).toEqual([]);
    },
  );

  it("refuses to guess when both keys are gone, and --restart recovers", async () => {
    const root = await home();
    await seed(root);
    await expect(
      store(root, {
        faultInjector: crashingAt("reset:marker_written"),
      }).resetKey(),
    ).rejects.toThrow(Crash);
    await rm(join(root, "conversations", "local.key.next"));
    await expect(store(root).resetKey()).rejects.toThrow(
      "CONVERSATION_RESET_UNRECOVERABLE",
    );
    const stage3: string[] = [];
    const result = await store(root, {
      resetStage3: async (id) => {
        stage3.push(id);
      },
    }).resetKey({ restart: true });
    expect(result.resumed).toBe(false);
    expect(stage3).toEqual([result.key_id]);
    expect(await store(root).resetPending()).toBeNull();
  });

  it("does not need a readable old key to reset", async () => {
    const root = await home();
    await seed(root);
    await chmod(join(root, "conversations", "local.key"), 0o644);
    const result = await store(root).resetKey();
    expect((await store(root).status()).key.key_id).toBe(result.key_id);
  });
});

describe("recovery and normalization", () => {
  it("accepts text truncated after masking even with a splitting term", async () => {
    const root = await home();
    const key = await store(root).ensureKey();
    const redactTerms = ["ted"];
    const masked = redactConversationText("token=abcdefghijklmnopqrstuv", {
      redactTerms,
    }).text;
    // A naive cut ends in `[REDACTED`, which the term "ted" would change.
    await expect(
      store(root).appendRecords(
        [utterance(key, { text: masked.slice(0, 15) })],
        {
          redactTerms,
        },
      ),
    ).rejects.toThrow("CONVERSATION_RECORD_UNMASKED");
    const text = truncateRedactedText(masked, 15, { redactTerms });
    expect(
      await store(root).appendRecords([utterance(key, { text })], {
        redactTerms,
      }),
    ).toEqual({ appended: 1, skipped_by_purge_filter: 0 });
  });

  it("refuses a future --before but still reads persisted future filters", async () => {
    const root = await home();
    await seed(root);
    // NOW is 2026-06-01: a filter until year end would also drop new ingests.
    await expect(
      store(root).purge({ before: "2026-12-31T00:00:00Z" }),
    ).rejects.toThrow("CONVERSATION_PURGE_BEFORE_IN_FUTURE");
    expect(await store(root).readPurgeFilters()).toEqual([]);
    expect(await store(root).readRecords()).toHaveLength(4);
    await expect(
      store(root).purge({ before: NOW.toISOString() }),
    ).resolves.toMatchObject({ filter_added: true });
    await writeFile(
      join(root, "conversations", "purge-filters.json"),
      `${JSON.stringify({
        schema_version: 1,
        filters: [
          { before: "2999-01-01T00:00:00Z", added_at: NOW.toISOString() },
        ],
      })}\n`,
    );
    expect(await store(root).readPurgeFilters()).toHaveLength(1);
  });

  it("rejects records built with another key", async () => {
    const root = await home();
    await store(root).ensureKey();
    await expect(
      store(root).appendRecords([utterance(Buffer.alloc(32, 5))]),
    ).rejects.toThrow("CONVERSATION_KEY_MISMATCH");
  });

  it("removes temporary files when the key is reset", async () => {
    const root = await home();
    await seed(root);
    const tmp = join(root, "conversations", "utterances.jsonl.tmp");
    await writeFile(tmp, "old text\n");
    await store(root).resetKey();
    expect(await readdir(join(root, "conversations"))).not.toContain(
      "utterances.jsonl.tmp",
    );
  });

  it("ignores and then drops a torn final line", async () => {
    const root = await home();
    const { key } = await seed(root);
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}{"type":"utter`);
    expect(await store(root).readRecords()).toHaveLength(4);
    await store(root).appendRecords([utterance(key, { session: "s-new" })]);
    expect(await store(root).readRecords()).toHaveLength(5);
  });

  it("reports the physical line number of an invalid record", async () => {
    const root = await home();
    await seed(root);
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, `\n${await readFile(path, "utf8")}\n{}\n`);
    await expect(store(root).readRecords()).rejects.toThrow("line 7 ");
  });

  it.each(["compact", "append"] as const)(
    "finishes an interrupted purge on %s",
    async (operation) => {
      const root = await home();
      const { key } = await seed(root);
      await expect(
        store(root, { faultInjector: crashingAt("purge:filter_added") }).purge({
          session_id: "s-alice",
        }),
      ).rejects.toThrow(Crash);
      if (operation === "compact") await store(root).compact(null);
      else
        await store(root).appendRecords([utterance(key, { session: "s-x" })]);
      expect(await rawFile(root, "utterances.jsonl")).not.toContain("s-alice");
      expect(await store(root).readPurgeFilters()).toHaveLength(1);
      expect((await store(root).status()).purge_in_progress).toBeNull();
    },
  );

  it("matches owner/name case-insensitively and normalizes path filters", async () => {
    const root = await home();
    await seed(root);
    expect(await store(root).purge({ name_with_owner: "Owner/NAME" })).toEqual({
      filter_added: true,
      purged_records: 3,
    });
    await store(root).purge({ project_path_prefix: "/a/b/" });
    expect(
      (await store(root).purge({ project_path_prefix: "/a/b" })).filter_added,
    ).toBe(false);
    expect(
      (await store(root).purge({ name_with_owner: "owner/name" })).filter_added,
    ).toBe(false);
  });

  it("finishes a pending purge's later stages before a key reset", async () => {
    const root = await home();
    const { ids } = await seed(root);
    await expect(
      store(root, { faultInjector: crashingAt("purge:compacted") }).purge({
        session_id: "s-alice",
      }),
    ).rejects.toThrow(Crash);
    const withdrawn: string[] = [];
    await store(root, {
      purgeStages: {
        evidence_withdrawn: async (purged) => {
          withdrawn.push(...purged);
        },
      },
    }).resetKey();
    expect(withdrawn).toEqual([ids[0]]);
  });
});

describe("key loss and --restart", () => {
  it("refuses a path purge after the key is lost instead of reporting success", async () => {
    const root = await home();
    await seed(root);
    await rm(join(root, "conversations", "local.key"));
    await expect(
      store(root).purge({ project_path_prefix: "/Users/alice" }),
    ).rejects.toThrow("CONVERSATION_KEY_MISSING");
    await expect(
      store(root).previewPurge({ project_path_prefix: "/Users/alice" }),
    ).rejects.toThrow("CONVERSATION_KEY_MISSING");
    // Nothing was recorded or removed by the refused purge.
    expect(await store(root).readPurgeFilters()).toEqual([]);
    expect((await store(root).status()).purge_in_progress).toBeNull();
    expect(await store(root).readRecords()).toHaveLength(4);
    // Conditions that need no key still work.
    await expect(store(root).purge({ session_id: "s-alice" })).resolves.toEqual(
      { filter_added: true, purged_records: 1 },
    );
  });

  it("does not create a new key while stored conversations exist", async () => {
    const root = await home();
    await seed(root);
    await rm(join(root, "conversations", "local.key"));
    await expect(store(root).ensureKey()).rejects.toThrow(
      "CONVERSATION_KEY_MISSING",
    );
    await expect(readdir(join(root, "conversations"))).resolves.not.toContain(
      "local.key",
    );
    // reset-key discards the old data, after which a key can be created.
    const { key_id } = await store(root).resetKey();
    expect(keyId(await store(root).ensureKey())).toBe(key_id);
  });

  it.each(["reset:marker_written", "reset:key_renamed", "reset:discarded"])(
    "--restart keeps the pending key when the reset can resume (%s)",
    async (point) => {
      const root = await home();
      await seed(root);
      await expect(
        store(root, { faultInjector: crashingAt(point) }).resetKey(),
      ).rejects.toThrow(Crash);
      const marker = await store(root).resetPending();
      const result = await store(root).resetKey({ restart: true });
      expect(result).toEqual({ key_id: marker!.key_id, resumed: true });
      expect(keyId((await store(root).readKey())!)).toBe(marker!.key_id);
    },
  );

  it("--restart starts over from a corrupt marker", async () => {
    const root = await home();
    await seed(root);
    await writeFile(join(root, "conversations", "reset-pending.json"), "{");
    await expect(store(root).resetKey()).rejects.toThrow(
      "CONVERSATION_RECORD_INVALID",
    );
    const result = await store(root).resetKey({ restart: true });
    expect(result.resumed).toBe(false);
    expect(await store(root).resetPending()).toBeNull();
  });
});

describe("paths that name the same directory", () => {
  it("match through a symlink in either direction", async () => {
    const root = await home();
    const real = join(root, "work", "real");
    const link = join(root, "work", "link");
    await mkdir(join(real, "app"), { recursive: true });
    await symlink(real, link);
    const key = Buffer.alloc(32, 4);
    const viaLink = storedProjectMatcher(key)({
      ...projectPathFields(key, join(link, "app")),
      name_with_owner: null,
    });
    const viaReal = storedProjectMatcher(key)({
      ...projectPathFields(key, join(real, "app")),
      name_with_owner: null,
    });
    expect(matchesProjectSelector(real, viaLink)).toBe(true);
    expect(matchesProjectSelector(link, viaReal)).toBe(true);
    expect(matchesProjectSelector(`${link}/./app/../app/`, viaReal)).toBe(true);
    expect(
      matchesProjectSelector(link, rawProjectSubject(join(real, "app"), null)),
    ).toBe(true);
    // A deleted child under an existing symlink still resolves its parent.
    expect(
      matchesProjectSelector(
        join(link, "gone"),
        storedProjectMatcher(key)({
          ...projectPathFields(key, join(real, "gone", "x")),
          name_with_owner: null,
        }),
      ),
    ).toBe(true);
    expect(matchesProjectSelector(join(root, "work", "other"), viaReal)).toBe(
      false,
    );
  });
});

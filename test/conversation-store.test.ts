import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseConversationDistillationConfig,
  type ConversationDistillationConfig,
} from "../src/conversation-config.js";
import { ConversationKey } from "../src/conversation-key.js";
import {
  rawMatchTarget,
  storedMatchTarget,
  matchesPurgeFilter,
  type UtteranceRecord,
} from "../src/conversation-records.js";
import {
  ConversationStore,
  type ConversationCanonicalFollowUp,
  type ConversationStoreCheckpoint,
  type UtteranceDraft,
} from "../src/conversation-store.js";

const NOW = new Date("2026-11-20T00:00:00.000Z");
const SECRET = "ghp_0123456789abcdefghij0123456789";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rk-conv-store-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function config(
  overrides: Record<string, unknown> = {},
): ConversationDistillationConfig {
  return parseConversationDistillationConfig({
    schemaVersion: 1,
    enabled: true,
    ...overrides,
  });
}

let draftCounter = 0;
function draft(overrides: Partial<UtteranceDraft> = {}): UtteranceDraft {
  draftCounter += 1;
  return {
    assistant_context: null,
    detector_version: "detector-v1",
    flags: [],
    human_confidence: "high",
    human_reasons: [],
    project: {
      kind: "repository",
      name_with_owner: "octo/app",
      raw_path: "/Users/alice/repo",
      repo_id: "R_app",
    },
    session_id: "session-1",
    session_kind: "real",
    signals: ["correction_keyword"],
    source: "claude-code",
    source_message_id: `message-${String(draftCounter)}`,
    source_origin: "transcript",
    text: `utterance ${String(draftCounter)}`,
    timestamp: "2026-11-19T00:00:00.000Z",
    ...overrides,
  };
}

function projectAt(rawPath: string, name: string | null = null) {
  return {
    kind: name === null ? ("no_repository" as const) : ("repository" as const),
    name_with_owner: name,
    raw_path: rawPath,
    repo_id: name === null ? null : `R_${name.replace("/", "_")}`,
  };
}

class Crash extends Error {}

/** A store that throws once at `point`, like a process killed there. */
function crashingStore(
  point: ConversationStoreCheckpoint,
  followUp?: ConversationCanonicalFollowUp,
) {
  let armed = true;
  return new ConversationStore(root, {
    checkpoint: (name) => {
      if (armed && name === point) {
        armed = false;
        throw new Crash(point);
      }
    },
    clock: () => NOW,
    ...(followUp === undefined ? {} : { followUp }),
  });
}

function store(options: { followUp?: ConversationCanonicalFollowUp } = {}) {
  return new ConversationStore(root, { clock: () => NOW, ...options });
}

async function rawData(): Promise<string> {
  return readFile(
    join(root, "conversations", "utterances.jsonl"),
    "utf8",
  ).catch(() => "");
}

async function utterances(target = store()): Promise<UtteranceRecord[]> {
  return (await target.readRecords()).filter(
    (record): record is UtteranceRecord => record.type === "utterance",
  );
}

async function listDirectory(): Promise<string[]> {
  return (await readdir(join(root, "conversations"))).sort();
}

describe("saving utterances", () => {
  it("stores only masked text, digests and keyed path prefixes", async () => {
    const result = await store().saveUtterances(
      [
        draft({
          assistant_context: `Run /Users/alice/repo/x.sh with ${SECRET} for Tanaka ${"y".repeat(600)}`,
          project: projectAt("/Users/alice/repo/app", "octo/app"),
          text: `Tanaka said: token ${SECRET} in /Users/alice/repo and mail alice@example.com`,
        }),
      ],
      config({ redactTerms: ["tanaka"] }),
    );

    expect(result).toMatchObject({ saved: 1 });
    const [record] = await utterances();
    expect(record!.text).toBe(
      "[REDACTED] said: token [REDACTED] in ~/repo and mail [REDACTED]",
    );
    expect(record!.context!.text).toHaveLength(500);
    expect(
      record!.context!.text.startsWith(
        "Run ~/repo/x.sh with [REDACTED] for [REDACTED] y",
      ),
    ).toBe(true);
    expect(record!.project.path).toBe("~/repo/app");
    expect(record!.project.path_prefix_hmacs).toHaveLength(5);
    expect(record!.text_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(record!.redactions).toEqual(
      [
        { count: 2, kind: "github_token" },
        { count: 2, kind: "home_directory_path" },
        { count: 2, kind: "redact_term" },
        { count: 1, kind: "email_address" },
      ].sort((a, b) => (a.kind < b.kind ? -1 : 1)),
    );
    // M4-AC-007: no secret, raw home path, account name, or dictionary term.
    const raw = await rawData();
    for (const leaked of [
      SECRET,
      "/Users/alice",
      "alice",
      "Tanaka",
      "tanaka",
    ]) {
      expect(raw).not.toContain(leaked);
    }
    expect(record!.masking_version).not.toMatch(/tanaka/iu);
  });

  it("drops context for history lines and when disabled, and caps text", async () => {
    await store().saveUtterances(
      [
        draft({ assistant_context: "ctx", source_origin: "history" }),
        draft({ assistant_context: null }),
        draft({ text: "z".repeat(2_500) }),
        draft({ text: `${"a".repeat(1_999)}😀` }),
      ],
      config(),
    );
    await store().saveUtterances(
      [draft({ assistant_context: "ctx" })],
      config({ assistantContext: { enabled: false } }),
    );

    const records = await utterances();
    expect(records.map((record) => record.context)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(records[2]!.text).toHaveLength(2_000);
    // A surrogate pair is never split by the cap.
    expect(records[3]!.text).toBe("a".repeat(1_999));
  });

  it("creates a private directory, a 0600 key and 0600 files", async () => {
    await store().saveUtterances([draft()], config());

    const directory = join(root, "conversations");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of await listDirectory()) {
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    expect(await listDirectory()).toEqual(["local.key", "utterances.jsonl"]);
  });

  it("refuses a key readable by others and does not touch it", async () => {
    await store().saveUtterances([draft()], config());
    const keyPath = join(root, "conversations", "local.key");
    const before = await readFile(keyPath);
    await chmod(keyPath, 0o640);
    expect((await store().status()).warnings[0]?.remedy).toMatch(/^chmod 600/u);

    await expect(
      store().saveUtterances([draft()], config()),
    ).rejects.toMatchObject({ code: "CONVERSATION_KEY_PERMISSIONS_UNSAFE" });
    await expect(store().status()).resolves.toMatchObject({
      key: { code: "CONVERSATION_KEY_PERMISSIONS_UNSAFE", state: "unusable" },
    });
    expect(await readFile(keyPath)).toEqual(before);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o640);
  });

  it("refuses a FIFO in place of the key without blocking", async () => {
    await store().saveUtterances([draft()], config());
    const keyPath = join(root, "conversations", "local.key");
    await rm(keyPath);
    execFileSync("mkfifo", [keyPath]);

    await expect(store().readKey()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_PATH_UNSAFE",
    });
    expect((await store().status()).key).toMatchObject({ state: "unusable" });
  });

  it("refuses a corrupt or symlinked key", async () => {
    await store().saveUtterances([draft()], config());
    const keyPath = join(root, "conversations", "local.key");
    await writeFile(keyPath, "not-a-key\n", { mode: 0o600 });
    await expect(store().readKey()).rejects.toMatchObject({
      code: "CONVERSATION_KEY_CORRUPT",
    });
    expect((await store().status()).warnings[0]).toMatchObject({
      code: "CONVERSATION_KEY_CORRUPT",
      message: "local.key is not a valid key.",
    });
    await rm(keyPath);
    await writeFile(join(root, "elsewhere"), "0".repeat(64), { mode: 0o600 });
    await symlink(join(root, "elsewhere"), keyPath);
    await expect(store().readKey()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_PATH_UNSAFE",
    });
  });

  it("never regenerates a lost key over stored utterances", async () => {
    await store().saveUtterances([draft()], config());
    await rm(join(root, "conversations", "local.key"));

    await expect(
      store().saveUtterances([draft()], config()),
    ).rejects.toMatchObject({ code: "CONVERSATION_KEY_MISSING" });
    // Only a path criterion needs the key: without one it matches nothing,
    // and a new path purge is refused before anything is saved.
    await expect(
      store().findMatchingIds({ filters: [{ project_path_prefix: "/" }] }),
    ).rejects.toMatchObject({ code: "CONVERSATION_KEY_MISSING" });
    await expect(
      store().purge({ project_path_prefix: "/Users" }),
    ).rejects.toMatchObject({ code: "CONVERSATION_KEY_MISSING" });
    expect(await store().readPurgeFilters()).toEqual([]);
    expect((await store().status()).warnings.map((w) => w.code)).toEqual([
      "CONVERSATION_KEY_MISSING",
    ]);
    await expect(
      store().purge({ session_id: "session-1" }),
    ).resolves.toMatchObject({ removed_utterances: 1 });
  });

  it("skips duplicates, excluded projects, purged and expired lines", async () => {
    const target = store();
    const same = draft();
    await target.purge({ session_id: "purged-session" });

    const result = await target.saveUtterances(
      [
        same,
        same,
        draft({ project: projectAt("/Users/alice/secret/app", "octo/x") }),
        draft({ project: projectAt("/srv/other", "Octo/Hidden") }),
        draft({ session_id: "purged-session" }),
        draft({ timestamp: "2026-10-01T00:00:00.000Z" }),
      ],
      config({
        excludeProjects: ["/Users/alice/secret", "octo/hidden"],
        retentionDays: 30,
      }),
    );

    expect(result.skipped).toEqual({
      duplicate: 1,
      excluded_project: 2,
      expired: 1,
      invalid: 0,
      purged: 1,
    });
    expect(result.saved).toBe(1);
    // Saving again is a no-op: the ID is derived, not random.
    await expect(
      target.saveUtterances([same], config()),
    ).resolves.toMatchObject({ saved: 0, skipped: { duplicate: 1 } });
  });

  it("repairs a torn last line before appending", async () => {
    await store().saveUtterances([draft()], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await appendFile(path, '{"type":"utterance","utterance_id":"utt_');

    expect(await utterances()).toHaveLength(1);
    await store().saveUtterances([draft()], config());

    expect(await utterances()).toHaveLength(2);
    expect((await readFile(path, "utf8")).endsWith("}\n")).toBe(true);
  });

  it("does not store a record twice after its newline was lost", async () => {
    const first = draft();
    await store().saveUtterances([first], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).trimEnd(), {
      mode: 0o600,
    });

    await expect(
      store().saveUtterances([first], config()),
    ).resolves.toMatchObject({ saved: 0, skipped: { duplicate: 1 } });
    expect(await utterances()).toHaveLength(1);
  });

  it("counts an unterminated complete last line in read-only scans", async () => {
    await store().saveUtterances([draft()], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).trimEnd(), {
      mode: 0o600,
    });

    expect((await store().status()).utterances.total).toBe(1);
  });

  it("keeps a complete last line that only lacks its newline", async () => {
    await store().saveUtterances([draft()], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, (await readFile(path, "utf8")).trimEnd(), {
      mode: 0o600,
    });

    await store().saveUtterances([draft()], config());

    expect(await utterances()).toHaveLength(2);
  });

  it("reports a corrupt line without echoing it", async () => {
    await store().saveUtterances([draft()], config());
    await appendFile(
      join(root, "conversations", "utterances.jsonl"),
      '{"type":"utterance","text":"private words"}\n',
    );

    const error = await store()
      .readRecords()
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: "CONVERSATION_DATA_CORRUPT" });
    expect(String(error)).not.toContain("private words");
  });

  it("refuses symlinked data files and a symlinked data directory", async () => {
    await store().saveUtterances([draft()], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await rm(path);
    await writeFile(join(root, "outside.jsonl"), "");
    await symlink(join(root, "outside.jsonl"), path);
    await expect(store().readRecords()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_PATH_UNSAFE",
    });

    await rm(join(root, "conversations"), { recursive: true });
    await symlink(root, join(root, "conversations"));
    await expect(store().status()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_PATH_UNSAFE",
    });
  });

  it("keeps superseded links through compaction, even after a purge", async () => {
    await store().saveUtterances(
      [
        draft(),
        draft(),
        draft({ session_id: "other", timestamp: "2026-01-01T00:00:00.000Z" }),
      ],
      config(),
    );
    const [first, second] = await utterances();
    const link = {
      superseded_by: second!.utterance_id,
      type: "superseded",
      utterance_id: first!.utterance_id,
    };
    await store().saveSuperseded([link]);

    // Retention and an unrelated purge leave the link alone.
    await store().applyRetention(config({ retentionDays: 30 }));
    await store().purge({ session_id: "other" });
    expect(
      (await store().readRecords()).filter((r) => r.type === "superseded"),
    ).toEqual([link]);

    const result = await store().purge({ session_id: "session-1" });

    expect(result).toMatchObject({ removed_utterances: 2 });
    expect(await store().readRecords()).toEqual([link]);
  });

  it("skips a draft that does not form a valid record", async () => {
    await expect(
      store().saveUtterances(
        [
          draft({ timestamp: "2026-11-19T00:00:00" }),
          draft({ timestamp: "garbage" }),
          draft({ session_id: "a\uD800" }),
          draft({ text: "\uDC00 text" }),
          draft({ signals: [""] }),
          draft(),
        ],
        config(),
      ),
    ).resolves.toMatchObject({ saved: 1, skipped: { invalid: 5 } });
  });

  it("skips a draft whose path cannot be normalized, without failing the batch", async () => {
    const drafts = [
      draft({ project: projectAt("relative/dir") }),
      draft({ project: projectAt("~/secret") }),
      draft({ project: projectAt("") }),
      draft(),
    ];

    // With or without path conditions: an unmatchable path is never stored.
    await expect(
      store().saveUtterances(drafts, config()),
    ).resolves.toMatchObject({ saved: 1, skipped: { invalid: 3 } });
    expect(
      (await utterances()).map((r) => r.project.path_prefix_hmacs.length),
    ).toEqual([4]);
  });

  it("ignores blank lines left by a hand edit", async () => {
    await store().saveUtterances([draft()], config());
    await appendFile(join(root, "conversations", "utterances.jsonl"), "\n  \n");

    await expect(
      store().saveUtterances([draft()], config()),
    ).resolves.toMatchObject({ saved: 1 });
    expect((await store().status()).warnings).toEqual([]);
    expect(await utterances()).toHaveLength(2);
  });

  it("settles when the cap falls next to a masked short term", async () => {
    const drafts = Array.from({ length: 12 }, (_, offset) =>
      draft({ text: `${"x".repeat(1_995 - offset)}ed${"y".repeat(50)}` }),
    );

    await expect(
      store().saveUtterances(drafts, config({ redactTerms: ["ed", "r"] })),
    ).resolves.toMatchObject({ saved: 12 });
    for (const record of await utterances()) {
      expect(record.text.length).toBeLessThanOrEqual(2_000);
      expect(record.text.replaceAll("[REDACTED]", "")).not.toMatch(/\[R/u);
    }
  });

  it("re-masks what the length cap exposes", async () => {
    // The run is a path component until the cap cuts the "/" after it.
    const run = "a1".repeat(20);
    await store().saveUtterances(
      [draft({ text: `${"x ".repeat(980)}${run}/rest-of-path` })],
      config(),
    );

    const [record] = await utterances();
    expect(record!.text.endsWith("[REDACTED]")).toBe(true);
    expect(record!.text).not.toContain(run.slice(0, 32));
    expect(record!.redactions).toEqual([{ count: 1, kind: "long_token" }]);
  });

  it("stores a project path longer than the text cap", async () => {
    const long = `/srv/${"a".repeat(2_100)}`;
    await expect(
      store().saveUtterances([draft({ project: projectAt(long) })], config()),
    ).resolves.toMatchObject({ saved: 1 });
    expect((await utterances())[0]!.project.path).toBe(long);
  });
});

describe("utterance IDs and keys", () => {
  it("derives the same IDs and key_id from the same input and key", () => {
    const key = new ConversationKey(Buffer.alloc(32, 1));
    const input = {
      masked_text_digest: `sha256:${"a".repeat(64)}`,
      session_id: "s",
      source: "codex",
      source_message_id: null,
      timestamp: "2026-11-19T00:00:00.000Z",
    };

    expect(new ConversationKey(Buffer.alloc(32, 1)).keyId).toBe(key.keyId);
    expect(key.keyId).toMatch(/^[0-9a-f]{16}$/u);
    expect(key.utteranceId(input)).toBe(
      new ConversationKey(Buffer.alloc(32, 1)).utteranceId({ ...input }),
    );
    expect(key.utteranceId(input)).toMatch(/^utt_[0-9a-f]{32}$/u);
    const other = new ConversationKey(Buffer.alloc(32, 2));
    expect(other.keyId).not.toBe(key.keyId);
    expect(other.utteranceId(input)).not.toBe(key.utteranceId(input));
    expect(key.sessionKey("codex", "s")).toMatch(/^ses_[0-9a-f]{32}$/u);
    expect(key.projectKey("/a/b/")).toBe(key.projectKey("/a//b"));
    expect(() => new ConversationKey(Buffer.alloc(16))).toThrow(TypeError);
  });

  it("gives the same utterance the same ID across stores sharing a key", async () => {
    const fixed = draft();
    await store().saveUtterances([fixed], config());
    const [first] = await utterances();
    const key = await store().readKey();

    expect(first!.utterance_id).toBe(
      key!.utteranceId({
        masked_text_digest: first!.text_digest,
        session_id: fixed.session_id,
        source: fixed.source,
        source_message_id: fixed.source_message_id,
        timestamp: fixed.timestamp,
      }),
    );
  });
});

/** Ingest-time (raw path) prefix match, as purge filters use it. */
function pathHasPrefix(path: string, prefix: string): boolean {
  return rawMatchTarget({
    name_with_owner: null,
    raw_path: path,
    session_id: "s",
    source: "codex",
    timestamp: "2026-11-19T00:00:00.000Z",
  }).matchesPathPrefix(prefix);
}

describe("path prefix matching", () => {
  const key = new ConversationKey(Buffer.alloc(32, 9));
  const record = (rawPath: string): UtteranceRecord =>
    ({
      project: {
        name_with_owner: null,
        path_prefix_hmacs: key.pathPrefixHmacs(rawPath),
      },
      session_id: "s",
      source: "codex",
      timestamp: "2026-11-19T00:00:00.000Z",
    }) as unknown as UtteranceRecord;

  const paths = [
    "/Users/alice/repo",
    "/Users/alice/repo/app",
    "/Users/bob/repo",
    "/Users/alice/re",
    "/",
    "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z",
  ];
  const prefixes = [
    "/",
    "/Users",
    "/Users/alice",
    "/Users/alice/re",
    "/Users/alice/repo",
    "/Users/alice/repo/",
    "/Users/bob/repo",
    "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y",
    "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z",
  ];

  it("agrees between raw ingest-time and stored HMAC matching", () => {
    for (const path of paths) {
      for (const prefix of prefixes) {
        const filter = { project_path_prefix: prefix };
        const raw = matchesPurgeFilter(
          filter,
          rawMatchTarget({
            name_with_owner: null,
            raw_path: path,
            session_id: "s",
            source: "codex",
            timestamp: "2026-11-19T00:00:00.000Z",
          }),
        );
        const stored = matchesPurgeFilter(
          filter,
          storedMatchTarget(record(path), (prefix) =>
            key.pathPrefixHmac(prefix),
          ),
        );
        expect({ path, prefix, stored }).toEqual({ path, prefix, stored: raw });
      }
    }
  });

  it("matches by path component and keeps every depth", () => {
    expect(pathHasPrefix("/Users/alice/repo", "/Users/alice/re")).toBe(false);
    expect(pathHasPrefix("/Users/alice/repo/app", "/Users/alice/repo")).toBe(
      true,
    );
    expect(pathHasPrefix("/Users/bob/repo", "/Users/alice/repo")).toBe(false);
    expect(pathHasPrefix("/x", "/")).toBe(true);
    expect(key.pathPrefixHmacs(paths[5]!)).toHaveLength(27);
    expect(() => pathHasPrefix("relative", "/")).toThrow(TypeError);
  });
});

describe("retention", () => {
  it("replaces old utterances with minimal tombstones and adds no filter", async () => {
    await store().saveUtterances(
      [
        draft({
          project: projectAt("/Users/alice/repo", "octo/app"),
          timestamp: "2026-09-01T00:00:00.000Z",
        }),
        draft({ timestamp: "2026-11-18T00:00:00.000Z" }),
      ],
      config(),
    );
    const [old] = await utterances();

    const result = await store().applyRetention(config({ retentionDays: 30 }));

    expect(result).toEqual({
      expired: 1,
      removed_episodes: 0,
      removed_tombstones: 0,
      removed_utterances: 0,
    });
    const records = await store().readRecords();
    expect(records[0]).toEqual({
      project: {
        name_with_owner: "octo/app",
        path_prefix_hmacs: old!.project.path_prefix_hmacs,
      },
      session_id: old!.session_id,
      source: "claude-code",
      timestamp: "2026-09-01T00:00:00.000Z",
      type: "expired",
      utterance_id: old!.utterance_id,
    });
    expect(records[1]).toMatchObject({ type: "utterance" });
    expect(await rawData()).not.toContain(old!.text);
    expect(await store().readPurgeFilters()).toEqual([]);
    // Tombstones stay until a purge matches them.
    await store().applyRetention(config({ retentionDays: 1 }));
    expect(
      (await store().readRecords()).filter((r) => r.type === "expired"),
    ).toHaveLength(2);
  });

  it("compacts in the same pass when ingest starts", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2026-01-01T00:00:00.000Z" })],
      config(),
    );

    const result = await store().saveUtterances(
      [draft({ text: "new" })],
      config({ retentionDays: 30 }),
    );

    expect(result).toMatchObject({ retention: { expired: 1 }, saved: 1 });
    expect((await store().readRecords()).map((r) => r.type)).toEqual([
      "expired",
      "utterance",
    ]);
  });

  it("is a no-op without retentionDays", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2000-01-01T00:00:00.000Z" })],
      config(),
    );
    await expect(store().applyRetention(config())).resolves.toMatchObject({
      expired: 0,
    });
    expect(await utterances()).toHaveLength(1);
  });

  it("completes after a crash before the rename and removes the temporary file", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2026-01-01T00:00:00.000Z" })],
      config(),
    );
    await expect(
      crashingStore("compaction:before-rename").applyRetention(
        config({ retentionDays: 30 }),
      ),
    ).rejects.toBeInstanceOf(Crash);
    // The old file is intact; a process killed at that point would also
    // leave its temporary file, which the next locked run removes.
    expect(await utterances()).toHaveLength(1);
    const stale = ".utterances.jsonl.00000000-0000-4000-8000-000000000000.tmp";
    await writeFile(join(root, "conversations", stale), "partial", {
      mode: 0o600,
    });
    await writeFile(join(root, "conversations", ".lock.1.x.tmp"), "", {
      mode: 0o600,
    });

    await store().applyRetention(config({ retentionDays: 30 }));

    expect(await utterances()).toHaveLength(0);
    expect(await listDirectory()).toEqual([
      ".lock.1.x.tmp",
      "local.key",
      "utterances.jsonl",
    ]);
  });
});

describe("purge", () => {
  it("purges a tombstone by a later path filter and keeps the other home", async () => {
    // M4-AC-051: /Users/alice/repo and /Users/bob/repo are both ~/repo once
    // masked, but only Alice's is purged.
    await store().saveUtterances(
      [
        draft({
          project: projectAt("/Users/alice/repo"),
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        draft({
          project: projectAt("/Users/bob/repo"),
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        draft({ project: projectAt("/Users/alice/repo/app") }),
        draft({ project: projectAt("/Users/bob/repo") }),
      ],
      config(),
    );
    await store().applyRetention(config({ retentionDays: 30 }));
    const masked = (await store().readRecords()).map((r) =>
      r.type === "utterance" ? r.project.path : null,
    );
    expect(masked).toEqual([null, null, "~/repo/app", "~/repo"]);

    const result = await store().purge({
      project_path_prefix: "/Users/alice/repo/",
    });

    expect(result).toMatchObject({
      filter_added: true,
      filters: 1,
      removed_tombstones: 1,
      removed_utterances: 1,
      resumed_from: null,
    });
    const remaining = await store().readRecords();
    expect(remaining.map((r) => r.type)).toEqual(["expired", "utterance"]);
    expect(await store().readPurgeFilters()).toEqual([
      { added_at: NOW.toISOString(), project_path_prefix: "/Users/alice/repo" },
    ]);
    // A re-ingest of Alice's lines is refused; Bob's is not.
    await expect(
      store().saveUtterances(
        [
          draft({ project: projectAt("/Users/alice/repo/app") }),
          draft({ project: projectAt("/Users/bob/repo") }),
        ],
        config(),
      ),
    ).resolves.toMatchObject({ saved: 1, skipped: { purged: 1 } });
  });

  it("matches a deep filter and excludeProjects through the same HMACs", async () => {
    const deep = "/Users/alice/w/a/b/c/d/e/f/g/h/i/j/k/l/m";
    await store().saveUtterances(
      [
        draft({ project: projectAt(`${deep}/n/o`) }),
        draft({ project: projectAt("/Users/alice/w/a/b") }),
        draft({ project: projectAt("/srv/x", "octo/hidden") }),
      ],
      config(),
    );
    const [deepRecord, shallow, named] = await utterances();

    expect(await store().findMatchingIds({ excludeProjects: [deep] })).toEqual([
      deepRecord!.utterance_id,
    ]);
    expect(
      await store().findMatchingIds({ excludeProjects: ["OCTO/Hidden"] }),
    ).toEqual([named!.utterance_id]);
    expect(
      await store().findMatchingIds({
        filters: [{ project_path_prefix: "/Users/alice/w/a/b" }],
      }),
    ).toEqual([deepRecord!.utterance_id, shallow!.utterance_id].sort());
  });

  it("combines criteria, keeps one copy of a repeated filter, and drops episodes", async () => {
    await store().saveUtterances(
      [
        draft({ source: "codex", timestamp: "2026-11-01T00:00:00.000Z" }),
        draft({ source: "codex" }),
        draft({ source: "claude-code", timestamp: "2026-11-01T00:00:00.000Z" }),
      ],
      config(),
    );
    const [oldCodex, newCodex] = await utterances();
    await writeFile(
      join(root, "conversations", "episodes.jsonl"),
      `${JSON.stringify({ episode_id: "e1", utterance_ids: [oldCodex!.utterance_id] })}\n${JSON.stringify({ episode_id: "e2", members: [{ id: newCodex!.utterance_id }] })}\n${JSON.stringify({ episode_id: "e3", weights: { [oldCodex!.utterance_id]: 1 } })}\n`,
      { mode: 0o600 },
    );

    const first = await store().purge({
      before: "2026-11-10T00:00:00.000Z",
      source: "codex",
    });
    const again = await store().purge({
      before: "2026-11-10T00:00:00.000Z",
      source: "codex",
    });

    expect(first).toMatchObject({ removed_episodes: 2, removed_utterances: 1 });
    expect(again).toMatchObject({ filter_added: false, filters: 1 });
    expect((await utterances()).map((r) => r.utterance_id)).not.toContain(
      oldCodex!.utterance_id,
    );
    expect(await utterances()).toHaveLength(2);
    expect(
      await readFile(join(root, "conversations", "episodes.jsonl"), "utf8"),
    ).toContain('"e2"');
    expect(
      matchesPurgeFilter(
        { after: "2026-11-02T00:00:00.000Z", name_with_owner: "octo/app" },
        rawMatchTarget({
          name_with_owner: null,
          raw_path: null,
          session_id: "s",
          source: "codex",
          timestamp: "2026-11-05T00:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("finishes an interrupted purge from any later purge", async () => {
    await store().saveUtterances(
      [draft({ session_id: "doomed" }), draft({ session_id: "kept" })],
      config(),
    );
    await expect(
      crashingStore("purge:filter-appended").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);

    await store().purge({ source: "codex" });

    expect((await utterances()).map((r) => r.session_id)).toEqual(["kept"]);
  });

  it("drops a torn last line before compacting", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await appendFile(
      path,
      '{"type":"utterance","session_id":"doomed","text":"half',
    );

    await store().purge({ session_id: "doomed" });

    expect(await readFile(path, "utf8")).toBe("");
  });

  it("resumes when the episodes rewrite is interrupted after utterances", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    const [doomed] = await utterances();
    const episodes = join(root, "conversations", "episodes.jsonl");
    await writeFile(
      episodes,
      `${JSON.stringify({ utterance_ids: [doomed!.utterance_id] })}\n`,
      { mode: 0o600 },
    );
    let renames = 0;
    const crashing = new ConversationStore(root, {
      checkpoint: (name) => {
        if (name !== "compaction:before-rename") return;
        renames += 1;
        if (renames === 2) {
          throw new Crash(name);
        }
      },
      clock: () => NOW,
    });

    await expect(
      crashing.purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);
    expect(await utterances()).toEqual([]);
    expect(await readFile(episodes, "utf8")).toContain(doomed!.utterance_id);

    await expect(
      store().purge({ session_id: "doomed" }),
    ).resolves.toMatchObject({
      removed_episodes: 1,
      resumed_from: "ids_recorded",
    });
    expect(await readFile(episodes, "utf8")).toBe("");
  });

  it("honors a purge's unsaved filter in ingest and keeps it through reset-key", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    await expect(
      crashingStore("purge:progress-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);

    await expect(
      store().saveUtterances(
        [draft({ session_id: "doomed", text: "new" })],
        config(),
      ),
    ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
    await store().resetKey();

    expect(await store().readPurgeFilters()).toMatchObject([
      { session_id: "doomed" },
    ]);
  });

  it("removes a copy linked after an interrupted purge recorded its IDs", async () => {
    await store().saveUtterances(
      [
        draft({ session_id: "doomed" }),
        draft({ session_id: "pseudo-1", source_origin: "history" }),
      ],
      config(),
    );
    const [doomed, copy] = await utterances();
    await expect(
      crashingStore("purge:ids-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);
    await store().saveSuperseded([
      { superseded_by: doomed!.utterance_id, utterance_id: copy!.utterance_id },
    ]);

    await expect(store().purge(null)).resolves.toMatchObject({
      removed_utterances: 2,
      resumed_from: "ids_recorded",
    });
    expect(await utterances()).toEqual([]);
    // The copy matched only through its link, so its identity is kept.
    await store().resetKey();
    await expect(
      store().saveUtterances(
        [draft({ session_id: "pseudo-1", source_origin: "history" })],
        config(),
      ),
    ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
  });

  it("follows a link to a recorded ID whose record is already compacted away", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    const [doomed] = await utterances();
    const episodes = join(root, "conversations", "episodes.jsonl");
    await writeFile(
      episodes,
      `${JSON.stringify({ utterance_ids: [doomed!.utterance_id] })}\n`,
      { mode: 0o600 },
    );
    let renames = 0;
    const crashing = new ConversationStore(root, {
      checkpoint: (name) => {
        if (name === "compaction:before-rename" && ++renames === 2) {
          throw new Crash(name);
        }
      },
      clock: () => NOW,
    });
    await expect(
      crashing.purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);
    expect(await utterances()).toEqual([]);

    await store().saveUtterances(
      [draft({ session_id: "pseudo-2", source_origin: "history" })],
      config(),
    );
    const [copy] = await utterances();
    await store().saveSuperseded([
      { superseded_by: doomed!.utterance_id, utterance_id: copy!.utterance_id },
    ]);

    await expect(store().purge(null)).resolves.toMatchObject({
      resumed_from: "ids_recorded",
    });
    expect(await utterances()).toEqual([]);
    expect(await readFile(episodes, "utf8")).toBe("");
  });

  it("purges by session without reading an unreadable key", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    const target = store();
    const readKey = vi.spyOn(target, "readKey").mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      }),
    );

    await expect(target.purge({ session_id: "doomed" })).resolves.toMatchObject(
      { removed_utterances: 1 },
    );
    expect(readKey).not.toHaveBeenCalled();
  });

  it("finds and purges the same records for a sub-millisecond bound", async () => {
    await store().saveUtterances(
      [draft({ session_id: "edge", timestamp: "2026-11-19T00:00:00.123Z" })],
      config(),
    );
    const before = "2026-11-19T00:00:00.1239Z";
    const found = await store().findMatchingIds({
      filters: [{ before }],
    });
    expect(found).toHaveLength(1);
    await expect(store().purge({ before })).resolves.toMatchObject({
      removed_utterances: 1,
    });
  });

  it("purges a superseded copy along with the copy that matched", async () => {
    const historyMessage = "history-1";
    const historyText = "same words";
    await store().saveUtterances(
      [
        draft({
          project: projectAt("/srv/elsewhere"),
          source_message_id: historyMessage,
          source_origin: "history",
          text: historyText,
        }),
        draft({ project: projectAt("/work/secret") }),
      ],
      config(),
    );
    const [historyCopy, transcriptCopy] = await utterances();
    await store().saveSuperseded([
      {
        superseded_by: transcriptCopy!.utterance_id,
        utterance_id: historyCopy!.utterance_id,
      },
    ]);

    await expect(
      store().purge({ project_path_prefix: "/work/secret" }),
    ).resolves.toMatchObject({ removed_utterances: 2 });
    expect(await store().readRecords()).toEqual([
      expect.objectContaining({ type: "superseded" }),
    ]);

    // The copy removed through its link gets a filter of its own, so a
    // re-read is refused even after reset-key drops the link.
    const historyDraft = draft({
      project: projectAt("/srv/elsewhere"),
      source_message_id: historyMessage,
      source_origin: "history",
      text: historyText,
    });
    await expect(
      store().saveUtterances([historyDraft], config()),
    ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
    await store().resetKey();
    await expect(
      store().saveUtterances([historyDraft], config()),
    ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
    // The linked copy is kept as an identity, not as one more filter.
    expect(await store().readPurgeFilters()).toHaveLength(1);
  });

  it("keeps purging by session while a path filter cannot be matched", async () => {
    await store().saveUtterances(
      [
        draft({ project: projectAt("/work/a"), session_id: "s1" }),
        draft({ project: projectAt("/work/b"), session_id: "s2" }),
      ],
      config(),
    );
    await store().purge({ project_path_prefix: "/work/a" });
    await chmod(join(root, "conversations", "local.key"), 0o644);

    await expect(store().purge({ session_id: "s2" })).resolves.toMatchObject({
      removed_utterances: 1,
    });
    expect((await store().status()).warnings.map((w) => w.code)).toEqual([
      "CONVERSATION_KEY_PERMISSIONS_UNSAFE",
    ]);
  });

  it("refuses to resume a path purge without a usable key", async () => {
    await store().saveUtterances(
      [draft({ project: projectAt("/work/secret") })],
      config(),
    );
    await expect(
      crashingStore("purge:progress-recorded").purge({
        project_path_prefix: "/work/secret",
      }),
    ).rejects.toBeInstanceOf(Crash);
    await rm(join(root, "conversations", "local.key"));

    await expect(store().purge(null)).rejects.toMatchObject({
      code: "CONVERSATION_KEY_MISSING",
    });
    expect((await store().status()).purge.in_progress).toMatchObject({
      stage: "filter_saved",
    });
  });

  it("runs an interrupted purge's follow-ups before reset-key drops it", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    const [doomed] = await utterances();
    await expect(
      crashingStore("purge:ids-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);
    const followUp = {
      failJobsFor: vi.fn(async () => undefined),
      withdrawEvidenceFor: vi.fn(async () => undefined),
      withdrawEvidenceNotFromKey: vi.fn(async () => undefined),
    };

    await store({ followUp }).resetKey();

    expect(followUp.withdrawEvidenceFor).toHaveBeenCalledWith([
      doomed!.utterance_id,
    ]);
    expect(followUp.failJobsFor).toHaveBeenCalledWith([doomed!.utterance_id]);
  });

  it("reports a damaged purge progress file with the fix order", async () => {
    await store().saveUtterances([draft()], config());
    await writeFile(join(root, "conversations", "purge-progress.json"), "{", {
      mode: 0o600,
    });
    expect((await store().status()).warnings).toEqual([
      expect.objectContaining({
        code: "CONVERSATION_PURGE_PROGRESS_UNREADABLE",
        remedy: expect.stringMatching(
          /^Remove purge-progress.json, then rerun/u,
        ),
      }),
    ]);

    // A reset that stopped earlier: the purge damage shows the fix order.
    await rm(join(root, "conversations", "purge-progress.json"));
    await expect(
      crashingStore("reset-key:marker-written").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    await writeFile(join(root, "conversations", "purge-progress.json"), "{", {
      mode: 0o600,
    });
    const status = await store().status();
    expect(status.purge.in_progress).toEqual({
      stage: "unreadable",
      utterances: 0,
    });
    expect(status.warnings.map((w) => w.remedy)).toContain(
      "Remove purge-progress.json, run repo-knowledge conversations reset-key, then rerun the original conversations purge command",
    );
  });

  it("reports damaged data files as warnings next to the rest", async () => {
    await store().purge({ source: "codex" });
    await store().saveUtterances([draft()], config());
    await writeFile(join(root, "conversations", "purge-filters.json"), "{", {
      mode: 0o600,
    });
    await appendFile(join(root, "conversations", "utterances.jsonl"), "x\n");

    const status = await store().status();

    expect(status.purge.filters).toBeNull();
    expect(status.warnings.map((w) => [w.code, w.remedy])).toEqual([
      [
        "CONVERSATION_DATA_CORRUPT",
        expect.stringContaining("do not delete the file"),
      ],
      [
        "CONVERSATION_DATA_CORRUPT",
        "Repair or remove the damaged record in utterances.jsonl",
      ],
    ]);
    // purge-filters.json sorts before utterances.jsonl.
  });

  it("refuses to reset over a damaged purge progress file", async () => {
    await store().saveUtterances([draft()], config());
    await writeFile(join(root, "conversations", "purge-progress.json"), "{", {
      mode: 0o600,
    });

    await expect(store().resetKey()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_CORRUPT",
      file: "purge-progress.json",
    });
    await rm(join(root, "conversations", "purge-progress.json"));
    await expect(store().resetKey()).resolves.toBeDefined();
  });

  it("drops episodes of utterances that expired in an interrupted retention run", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2026-01-01T00:00:00.000Z" })],
      config(),
    );
    const [old] = await utterances();
    const episodes = join(root, "conversations", "episodes.jsonl");
    await writeFile(
      episodes,
      `${JSON.stringify({ utterance_ids: [old!.utterance_id] })}\n`,
      { mode: 0o600 },
    );
    let renames = 0;
    const crashing = new ConversationStore(root, {
      checkpoint: (name) => {
        if (name !== "compaction:before-rename") return;
        renames += 1;
        if (renames === 2) throw new Crash(name);
      },
      clock: () => NOW,
    });
    await expect(
      crashing.applyRetention(config({ retentionDays: 30 })),
    ).rejects.toBeInstanceOf(Crash);

    await store().applyRetention(config({ retentionDays: 30 }));

    expect(await readFile(episodes, "utf8")).toBe("");
  });

  it("purges both copies when only the superseded one matches", async () => {
    await store().saveUtterances(
      [
        draft({ timestamp: "2026-11-01T00:00:00.000Z" }),
        draft({ timestamp: "2026-11-01T00:00:00.002Z" }),
      ],
      config(),
    );
    const [historyCopy, transcriptCopy] = await utterances();
    await store().saveSuperseded([
      {
        superseded_by: transcriptCopy!.utterance_id,
        utterance_id: historyCopy!.utterance_id,
      },
    ]);

    await expect(
      store().purge({ before: "2026-11-01T00:00:00.001Z" }),
    ).resolves.toMatchObject({ removed_utterances: 2 });
  });

  it("widens a sub-millisecond bound so it still covers earlier lines", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2026-01-01T00:00:00.1231Z" })],
      config(),
    );

    await store().purge({ before: "2026-01-01T00:00:00.1239Z" });

    expect(await utterances()).toEqual([]);
    expect(await store().readPurgeFilters()).toMatchObject([
      { before: "2026-01-01T00:00:00.124Z" },
    ]);
  });

  it("keeps a filter interrupted before it was saved, then applies it", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    await expect(
      crashingStore("purge:progress-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);
    expect(await store().readPurgeFilters()).toEqual([]);

    await expect(store().purge(null)).resolves.toMatchObject({
      filters: 1,
      removed_utterances: 1,
      resumed_from: "filter_saved",
    });
    expect(await utterances()).toEqual([]);
  });

  it("treats path filters differing only in case as one", async () => {
    await store().purge({ project_path_prefix: "/Users/Bob/Work" });
    await expect(
      store().purge({ project_path_prefix: "/users/bob/work" }),
    ).resolves.toMatchObject({ filter_added: false, filters: 1 });
  });

  it("matches paths and repository names regardless of case", async () => {
    await store().saveUtterances(
      [
        draft({ project: projectAt("/Users/bob/Work/Secret", "Acme/App") }),
        draft({ project: projectAt("/Users/bob/other") }),
      ],
      config(),
    );
    await store().purge({ name_with_owner: "Acme/App" });
    const again = await store().purge({ name_with_owner: "acme/app" });
    expect(again).toMatchObject({ filter_added: false, filters: 1 });
    expect(await utterances()).toHaveLength(1);

    await store().saveUtterances(
      [draft({ project: projectAt("/Users/bob/Work/Secret/x") })],
      config({ excludeProjects: ["/users/BOB/work"] }),
    );
    expect(
      await store().findMatchingIds({ excludeProjects: ["/USERS/bob/OTHER"] }),
    ).toHaveLength(1);
    await store().purge({ project_path_prefix: "/users/bob/other" });
    expect(await utterances()).toEqual([]);
  });

  it("folds final sigma and ß in project paths", async () => {
    await store().saveUtterances(
      [
        draft({ project: projectAt("/work/ΟΣ") }),
        draft({ project: projectAt("/work/Straße") }),
        draft({ project: projectAt("/work/ẞ") }),
      ],
      config(),
    );
    await store().purge({ project_path_prefix: "/work/οσ" });
    await store().purge({ project_path_prefix: "/work/STRASSE" });
    // `ẞ` folds to `ß`, then `ss`: the purge must fold it the same way.
    await store().purge({ project_path_prefix: "/work/ẞ" });
    expect(await utterances()).toEqual([]);
  });

  it("refuses bounds past year 9999", async () => {
    await expect(
      store().purge({ before: "9999-12-31T23:59:59-01:00" }),
    ).rejects.toMatchObject({ code: "CONVERSATION_PURGE_FILTER_INVALID" });
  });

  it("treats two spellings of the same instant as one filter", async () => {
    await store().purge({ before: "2026-01-01T09:00:00+09:00" });
    const again = await store().purge({ before: "2026-01-01T00:00:00.000Z" });

    expect(again).toMatchObject({ filter_added: false, filters: 1 });
    expect(await store().readPurgeFilters()).toEqual([
      { added_at: NOW.toISOString(), before: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("rewrites large files in chunks and leaves unchanged files alone", async () => {
    const big = Array.from({ length: 1_200 }, (_, index) =>
      draft({
        session_id: index % 2 === 0 ? "even" : "odd",
        text: `${String(index)} ${"w ".repeat(990)}`,
      }),
    );
    await store().saveUtterances(big, config());
    const path = join(root, "conversations", "utterances.jsonl");
    const before = await stat(path);
    expect(before.size).toBeGreaterThan(1 << 20);

    // Nothing expires: the file is not rewritten (same inode).
    await store().applyRetention(config({ retentionDays: 3650 }));
    expect((await stat(path)).ino).toBe(before.ino);

    await store().purge({ session_id: "odd" });
    const left = await utterances();
    expect(left).toHaveLength(600);
    expect(left.every((record) => record.session_id === "even")).toBe(true);
  });

  it("finishes an interrupted purge with --resume and adds no filter", async () => {
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    await expect(
      crashingStore("purge:ids-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);

    const result = await store().purge(null);

    expect(result).toMatchObject({
      filter_added: false,
      filters: 1,
      removed_utterances: 1,
      resumed_from: "ids_recorded",
    });
    expect(await utterances()).toEqual([]);
    expect((await store().status()).warnings).toEqual([]);
  });

  it("drops episodes built from utterances that expire", async () => {
    await store().saveUtterances(
      [draft({ timestamp: "2026-01-01T00:00:00.000Z" }), draft()],
      config(),
    );
    const [old, recent] = await utterances();
    const episodes = join(root, "conversations", "episodes.jsonl");
    await writeFile(
      episodes,
      `${JSON.stringify({ utterance_ids: [old!.utterance_id] })}\n${JSON.stringify({ utterance_ids: [recent!.utterance_id] })}\n`,
      { mode: 0o600 },
    );

    await expect(
      store().applyRetention(config({ retentionDays: 30 })),
    ).resolves.toMatchObject({ expired: 1, removed_episodes: 1 });
    expect(await readFile(episodes, "utf8")).not.toContain(old!.utterance_id);
  });

  it("works before anything was ingested and refuses empty criteria", async () => {
    await expect(store().purge({ source: "codex" })).resolves.toMatchObject({
      filter_added: true,
      removed_utterances: 0,
    });
    await expect(store().purge({})).rejects.toThrow(/at least one criterion/u);
  });

  const PURGE_POINTS: readonly ConversationStoreCheckpoint[] = [
    "purge:filter-appended",
    "purge:ids-recorded",
    "compaction:before-rename",
    "purge:compacted",
    "purge:evidence-withdrawn",
  ];

  it.each(PURGE_POINTS)(
    "resumes after a crash at %s with nothing left behind",
    async (point) => {
      await store().saveUtterances(
        [
          draft({ session_id: "doomed" }),
          draft({
            session_id: "doomed",
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          draft({ session_id: "kept" }),
        ],
        config(),
      );
      await store().applyRetention(config({ retentionDays: 30 }));
      const doomed = (await store().readRecords())
        .filter((r) => r.type !== "superseded" && r.session_id === "doomed")
        .map((r) => r.utterance_id)
        .sort();
      const followUp = {
        failJobsFor: vi.fn(async () => undefined),
        withdrawEvidenceFor: vi.fn(async () => undefined),
        withdrawEvidenceNotFromKey: vi.fn(async () => undefined),
      };

      await expect(
        crashingStore(point, followUp).purge({ session_id: "doomed" }),
      ).rejects.toBeInstanceOf(Crash);

      // The filter is durable at every crash point, so ingest already skips.
      await expect(
        store().saveUtterances([draft({ session_id: "doomed" })], config()),
      ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
      const status = await store().status();
      // Progress is recorded before the filter, so status always reports it.
      expect(status.warnings.map((w) => w.code)).toEqual([
        "CONVERSATION_PURGE_INCOMPLETE",
      ]);

      const resumed = await store({ followUp }).purge({ session_id: "doomed" });

      expect(resumed.filter_added).toBe(false);
      expect(resumed.resumed_from).toBe(
        {
          "compaction:before-rename": "ids_recorded",
          "purge:compacted": "compacted",
          "purge:evidence-withdrawn": "evidence_withdrawn",
          "purge:filter-appended": "filter_saved",
          "purge:ids-recorded": "ids_recorded",
        }[point as string],
      );
      const left = await store().readRecords();
      expect(
        left.filter(
          (r) => r.type !== "superseded" && r.session_id === "doomed",
        ),
      ).toEqual([]);
      expect(left).toHaveLength(1);
      expect(await rawData()).not.toContain('"doomed"');
      expect(await listDirectory()).toEqual([
        "local.key",
        "purge-filters.json",
        "utterances.jsonl",
      ]);
      // Each follow-up ran once with exactly the recorded IDs.
      expect(followUp.withdrawEvidenceFor).toHaveBeenCalledOnce();
      expect(followUp.withdrawEvidenceFor).toHaveBeenCalledWith(doomed);
      expect(followUp.failJobsFor).toHaveBeenCalledOnce();
      expect(followUp.failJobsFor).toHaveBeenCalledWith(doomed);
    },
  );
});

describe("reset-key", () => {
  async function seed() {
    await store().saveUtterances(
      [draft({ project: projectAt("/Users/alice/repo") })],
      config(),
    );
    await store().purge({ project_path_prefix: "/Users/bob/repo" });
    for (const file of [
      "episodes.jsonl",
      "checkpoints.json",
      "route-cache.json",
    ]) {
      await writeFile(join(root, "conversations", file), "{}\n", {
        mode: 0o600,
      });
    }
    return (await store().readKey())!.keyId;
  }

  it("replaces the key, discards derived data and keeps purge filters", async () => {
    const oldKeyId = await seed();
    const followUp = {
      failJobsFor: vi.fn(async () => undefined),
      withdrawEvidenceFor: vi.fn(async () => undefined),
      withdrawEvidenceNotFromKey: vi.fn(async () => undefined),
    };

    const result = await store({ followUp }).resetKey();

    expect(result.key_id).not.toBe(oldKeyId);
    expect(result).toMatchObject({
      restarted: false,
      resumed_after_stage: null,
    });
    expect([...result.discarded].sort()).toEqual([
      "checkpoints.json",
      "episodes.jsonl",
      "route-cache.json",
      "utterances.jsonl",
    ]);
    expect((await store().readKey())!.keyId).toBe(result.key_id);
    expect(followUp.withdrawEvidenceNotFromKey).toHaveBeenCalledWith(
      result.key_id,
    );
    expect(await listDirectory()).toEqual(["local.key", "purge-filters.json"]);
    expect(
      (await stat(join(root, "conversations", "local.key"))).mode & 0o777,
    ).toBe(0o600);
    // The filter survives and is matched with HMACs from the new key.
    await store().saveUtterances(
      [
        draft({ project: projectAt("/Users/bob/repo") }),
        draft({ project: projectAt("/Users/alice/repo") }),
      ],
      config(),
    );
    const [alice] = await utterances();
    const newKey = (await store().readKey())!;
    expect(alice!.project.path_prefix_hmacs).toEqual(
      newKey.pathPrefixHmacs("/Users/alice/repo"),
    );
    expect(
      await store().findMatchingIds({
        filters: [{ project_path_prefix: "/Users/alice" }],
      }),
    ).toEqual([alice!.utterance_id]);
  });

  it("refuses ingest, retention and purge while the reset is pending", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:marker-written").resetKey(),
    ).rejects.toBeInstanceOf(Crash);

    await expect(
      store().saveUtterances([draft()], config()),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET_PENDING" });
    await expect(store().saveSuperseded([])).rejects.toMatchObject({
      code: "CONVERSATION_RESET_PENDING",
    });
    await expect(
      store().applyRetention(config({ retentionDays: 1 })),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET_PENDING" });
    await expect(store().purge({ source: "codex" })).rejects.toMatchObject({
      code: "CONVERSATION_RESET_PENDING",
    });
    await expect(store().assertNoResetPending()).rejects.toThrow(
      /conversations reset-key to finish/u,
    );
  });

  const RESUMABLE: readonly ConversationStoreCheckpoint[] = [
    "reset-key:marker-written",
    "reset-key:renamed",
    "reset-key:discarded",
    "reset-key:stage-2",
    "reset-key:stage-3",
  ];

  it.each(RESUMABLE)(
    "keeps the marker's key when resumed after %s",
    async (point) => {
      await seed();
      await expect(crashingStore(point).resetKey()).rejects.toBeInstanceOf(
        Crash,
      );
      const pending = await store().readResetPending();
      expect(pending).toMatchObject({ recoverable: true });

      const result = await store().resetKey();

      expect(result.key_id).toBe(pending!.key_id);
      expect(result.resumed_after_stage).toBe(pending!.completed_stage);
      expect((await store().readKey())!.keyId).toBe(pending!.key_id);
      expect(await store().readResetPending()).toBeNull();
      expect(await listDirectory()).toEqual([
        "local.key",
        "purge-filters.json",
      ]);
    },
  );

  it("starts over when the next key was written but the marker was not", async () => {
    const oldKeyId = await seed();
    await expect(
      crashingStore("reset-key:next-key-written").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    // Nothing was changed yet: the old key and data are intact.
    expect((await store().readKey())!.keyId).toBe(oldKeyId);
    expect(await store().readResetPending()).toBeNull();
    await expect(
      store().saveUtterances([draft()], config()),
    ).resolves.toBeDefined();

    const result = await store().resetKey();

    expect(result.resumed_after_stage).toBeNull();
    expect(result.key_id).not.toBe(oldKeyId);
    expect(await listDirectory()).toEqual(["local.key", "purge-filters.json"]);
  });

  it("requires --restart when both key files were lost, then starts over", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:renamed").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    await rm(join(root, "conversations", "local.key"));

    expect(await store().readResetPending()).toMatchObject({
      recoverable: false,
    });
    await expect(store().saveUtterances([draft()], config())).rejects.toThrow(
      /reset-key --restart/u,
    );
    expect((await store().status()).warnings.map((w) => w.code)).toEqual([
      "CONVERSATION_RESET_KEY_UNRECOVERABLE",
    ]);
    await expect(store().resetKey()).rejects.toMatchObject({
      code: "CONVERSATION_RESET_KEY_UNRECOVERABLE",
    });

    const result = await store().resetKey({ restart: true });

    expect(result).toMatchObject({
      restarted: true,
      resumed_after_stage: null,
    });
    expect((await store().readKey())!.keyId).toBe(result.key_id);
    expect(await store().readResetPending()).toBeNull();
    expect(await store().readPurgeFilters()).toHaveLength(1);
  });

  it("restarts over an unreadable marker only with --restart", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:marker-written").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    await writeFile(join(root, "conversations", "reset-pending.json"), "{", {
      mode: 0o600,
    });

    await expect(store().resetKey()).rejects.toMatchObject({
      code: "CONVERSATION_RESET_KEY_UNRECOVERABLE",
    });
    await expect(store().saveUtterances([draft()], config())).rejects.toThrow(
      /reset-key --restart/u,
    );
    expect(await store().readResetPending()).toEqual({
      completed_stage: null,
      key_id: null,
      recoverable: false,
      unsafe_key: null,
    });
    expect((await store().status()).warnings.map((w) => w.remedy)).toContain(
      "repo-knowledge conversations reset-key --restart",
    );
    const result = await store().resetKey({ restart: true });

    expect(result).toMatchObject({ restarted: true });
    expect((await store().readKey())!.keyId).toBe(result.key_id);
  });

  it("finishes an interrupted purge before replacing the key", async () => {
    await seed();
    await store().saveUtterances([draft({ session_id: "doomed" })], config());
    await expect(
      crashingStore("purge:ids-recorded").purge({ session_id: "doomed" }),
    ).rejects.toBeInstanceOf(Crash);

    const result = await store().resetKey();

    expect(result.discarded).not.toContain("purge-progress.json");
    expect((await store().status()).warnings).toEqual([]);
  });

  it("keeps a purge's linked copies when reset-key interrupts it", async () => {
    await store().saveUtterances(
      [
        draft({ session_id: "real-1", text: "same" }),
        draft({
          session_id: "pseudo:x:1",
          session_kind: "pseudo",
          source_origin: "history",
          text: "same",
          timestamp: "2026-11-19T00:00:00.001Z",
        }),
      ],
      config(),
    );
    const [transcript, history] = await utterances();
    await store().saveSuperseded([
      {
        superseded_by: transcript!.utterance_id,
        utterance_id: history!.utterance_id,
      },
    ]);
    await expect(
      crashingStore("purge:filter-appended").purge({ session_id: "real-1" }),
    ).rejects.toBeInstanceOf(Crash);

    await store().resetKey();

    await expect(
      store().saveUtterances(
        [
          draft({
            session_id: "pseudo:x:1",
            session_kind: "pseudo",
            source_origin: "history",
            text: "same",
            timestamp: "2026-11-19T00:00:00.001Z",
          }),
        ],
        config(),
      ),
    ).resolves.toMatchObject({ saved: 0, skipped: { purged: 1 } });
  });

  it("keeps refusing ingest when a --restart is interrupted", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:renamed").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    await rm(join(root, "conversations", "local.key"));

    await expect(
      crashingStore("reset-key:next-key-written").resetKey({ restart: true }),
    ).rejects.toBeInstanceOf(Crash);

    expect(await store().readResetPending()).toMatchObject({
      recoverable: false,
    });
    await expect(
      store().saveUtterances([draft()], config()),
    ).rejects.toMatchObject({ code: "CONVERSATION_RESET_PENDING" });
    await expect(store().resetKey({ restart: true })).resolves.toMatchObject({
      restarted: true,
    });
  });

  it("refuses a widened new key instead of treating it as lost", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:renamed").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    const pending = (await store().readResetPending())!;
    const keyPath = join(root, "conversations", "local.key");
    await chmod(keyPath, 0o644);

    expect(pending.recoverable).toBe(true);
    const status = await store().status();
    expect(status.reset_pending).toMatchObject({
      unsafe_key: { file: "local.key", reason: "permissions" },
    });
    expect(status.warnings[0]?.remedy).toMatch(/^run chmod 600 on local\.key/u);
    await expect(store().resetKey()).rejects.toThrow(
      /run chmod 600 on local\.key/u,
    );
    // Writers blocked by the pending reset name the same first step.
    await expect(store().saveUtterances([draft()], config())).rejects.toThrow(
      /run chmod 600 on local\.key/u,
    );
    expect((await store().readResetPending())!.recoverable).toBe(true);
    await expect(store().resetKey({ restart: true })).rejects.toMatchObject({
      code: "CONVERSATION_KEY_PERMISSIONS_UNSAFE",
    });

    await chmod(keyPath, 0o600);
    await expect(store().resetKey()).resolves.toMatchObject({
      key_id: pending.key_id,
      restarted: false,
    });
  });

  it("treats a corrupted key as lost and ignores --restart while resumable", async () => {
    await seed();
    await expect(
      crashingStore("reset-key:marker-written").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    const pending = (await store().readResetPending())!;

    const resumed = await store().resetKey({ restart: true });
    expect(resumed).toMatchObject({ key_id: pending.key_id, restarted: false });

    await expect(
      crashingStore("reset-key:stage-2").resetKey(),
    ).rejects.toBeInstanceOf(Crash);
    await writeFile(join(root, "conversations", "local.key"), "garbage", {
      mode: 0o600,
    });
    expect(await store().readResetPending()).toMatchObject({
      recoverable: false,
    });
  });
});

describe("an empty or damaged data area", () => {
  it("refuses a blank storage root for reads as for writes", async () => {
    await expect(new ConversationStore("").status()).rejects.toMatchObject({
      code: "CONVERSATION_DATA_PATH_UNSAFE",
    });
    await expect(new ConversationStore("").purge(null)).rejects.toMatchObject({
      code: "CONFIG_PATH_UNSAFE",
    });
  });

  it("reads from inside the storage root", async () => {
    await store().saveUtterances([draft()], config());
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(new ConversationStore(root).status()).resolves.toMatchObject(
        { utterances: { total: 1 } },
      );
    } finally {
      process.chdir(previous);
    }
  });

  it("names chown, not chmod, for a key owned by another user", async () => {
    await store().saveUtterances([draft()], config());
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect((await store().status()).warnings[0]).toMatchObject({
        code: "CONVERSATION_KEY_OWNER_MISMATCH",
        remedy: expect.stringMatching(/^chown local\.key/u),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("warns that the key is missing even when the log is damaged", async () => {
    await store().saveUtterances([draft()], config());
    await rm(join(root, "conversations", "local.key"));
    const path = join(root, "conversations", "utterances.jsonl");
    await writeFile(path, `x\n${await readFile(path, "utf8")}`, {
      mode: 0o600,
    });

    expect((await store().status()).warnings.map((w) => w.code)).toEqual([
      "CONVERSATION_DATA_CORRUPT",
      "CONVERSATION_KEY_MISSING",
    ]);
  });

  it("reads as empty before anything was created", async () => {
    const empty = store();

    expect(await empty.readResetPending()).toBeNull();
    expect(await empty.readKey()).toBeNull();
    expect(await empty.readPurgeFilters()).toEqual([]);
    expect(await empty.readRecords()).toEqual([]);
    expect(
      await empty.findMatchingIds({ filters: [{ source: "codex" }] }),
    ).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses lines that only look like records on the fast paths", async () => {
    await store().saveUtterances([draft()], config());
    const path = join(root, "conversations", "utterances.jsonl");
    await appendFile(path, '{"type":"utterance","text":"private words"}\n');
    await expect(
      store().saveUtterances([draft()], config()),
    ).rejects.toMatchObject({ code: "CONVERSATION_DATA_CORRUPT" });

    await writeFile(
      path,
      `${JSON.stringify({ type: "utterance", utterance_id: "utt_x", timestamp: "2000-01-01T00:00:00Z" })}\n`,
    );
    await expect(
      store().applyRetention(config({ retentionDays: 1 })),
    ).rejects.toMatchObject({
      code: "CONVERSATION_DATA_CORRUPT",
      file: "utterances.jsonl",
    });
  });

  it("stores a draft that has no project path", async () => {
    await store().saveUtterances(
      [
        draft({
          project: {
            kind: "unresolved",
            name_with_owner: null,
            raw_path: null,
            repo_id: null,
          },
        }),
      ],
      config(),
    );

    expect((await utterances())[0]!.project).toMatchObject({
      path: null,
      path_prefix_hmacs: [],
    });
  });
});

describe("status", () => {
  it("reads without creating anything", async () => {
    const status = await store().status();

    expect(status).toEqual({
      data_directory: { present: false },
      key: { key_id: null, state: "missing" },
      purge: { filters: 0, in_progress: null },
      reset_pending: null,
      utterances: {
        by_source: { "claude-code": 0, codex: 0 },
        superseded: 0,
        tombstones: 0,
        total: 0,
      },
      warnings: [],
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("counts records without exposing text, sessions or paths", async () => {
    await store().saveUtterances(
      [
        draft({ session_id: "secret-session", text: "private words" }),
        draft({ source: "codex", timestamp: "2026-01-01T00:00:00.000Z" }),
      ],
      config(),
    );
    await store().applyRetention(config({ retentionDays: 30 }));
    const [kept] = await utterances();
    await store().saveSuperseded([
      {
        superseded_by: kept!.utterance_id,
        utterance_id: `utt_${"0".repeat(32)}`,
      },
    ]);

    const status = await store().status();

    expect(status.key).toMatchObject({ state: "present" });
    expect(status.utterances).toEqual({
      by_source: { "claude-code": 1, codex: 0 },
      superseded: 1,
      tombstones: 1,
      total: 1,
    });
    const serialized = JSON.stringify(status);
    for (const hidden of ["private words", "secret-session", "Users", "repo"]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});

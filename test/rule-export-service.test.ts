import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANONICAL_WRITE_LOCK_NAME,
  TRANSACTION_MANIFEST_FILE,
  TRANSACTIONS_DIRECTORY,
} from "../src/canonical-transaction-journal.js";
import {
  neutralizeExportedRuleText,
  renderRuleExport,
} from "../src/cli-render.js";
import { GLOBAL_STORE_ID } from "../src/global-always-return.js";
import {
  RuleExportError,
  RuleExportService,
  type ExportedRule,
  type RuleExportRequest,
} from "../src/rule-export-service.js";
import {
  createRuleExportHome,
  EXPORT_REPO_ID,
  EXPORT_REPOSITORY,
  EXPORT_REPOSITORY_ALIAS,
  IDS,
  RULES,
  snapshotTree,
  writeKnowledge,
  writeConfig,
  type RuleExportHome,
} from "./helpers/rule-export-fixture.js";

/**
 * Lets a test simulate a concurrent writer: every capture reports a new
 * digest, or the next captures throw as a torn read would.
 */
const capture = vi.hoisted(() => ({
  calls: 0,
  changing: false,
  failures: 0,
  onCapture: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../src/sqlite-projection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/sqlite-projection.js")>();
  return {
    ...actual,
    captureCanonicalStateReadOnly: async (root: string) => {
      capture.calls += 1;
      await capture.onCapture?.();
      if (capture.failures > 0) {
        capture.failures -= 1;
        throw new Error("torn read: incomplete JSONL line");
      }
      const result = await actual.captureCanonicalStateReadOnly(root);
      return capture.changing
        ? { ...result, canonicalDigest: `changing-${String(capture.calls)}` }
        : result;
    },
  };
});

const FAST_RETRY = { attempts: 6, delayMs: 1 };

/** A lock file as a live writer (this test process) would leave it. */
async function holdWriterLock(storeRoot: string, pid = process.pid) {
  await writeFile(
    join(storeRoot, CANONICAL_WRITE_LOCK_NAME),
    JSON.stringify({
      acquired_at: "2026-11-20T00:00:00.000Z",
      pid,
      token: "t",
    }),
  );
}

/** A prepared transaction: a journal entry with its manifest written. */
async function openJournal(storeRoot: string, name = "txn_pending") {
  const directory = join(storeRoot, TRANSACTIONS_DIRECTORY, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, TRANSACTION_MANIFEST_FILE), "{}");
}

/** A live writer in the middle of a commit: prepared journal plus its lock. */
async function startWriter(storeRoot: string) {
  await openJournal(storeRoot);
  await holdWriterLock(storeRoot);
}

/** The writer's commit completes: journal cleaned up, lock released. */
async function finishWriter(storeRoot: string) {
  await rm(join(storeRoot, TRANSACTIONS_DIRECTORY), { recursive: true });
  await rm(join(storeRoot, CANONICAL_WRITE_LOCK_NAME));
}

/** Lets a test act as a writer at a counted journal poll, not on a timer. */
const journal = vi.hoisted(() => ({
  onRead: undefined as ((root: string) => Promise<void>) | undefined,
}));

vi.mock("../src/canonical-transaction-journal.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/canonical-transaction-journal.js")
    >();
  return {
    ...actual,
    observeCanonicalWriter: async (root: string) => {
      await journal.onRead?.(root);
      return actual.observeCanonicalWriter(root);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  Object.assign(capture, {
    calls: 0,
    changing: false,
    failures: 0,
    onCapture: undefined,
  });
  journal.onRead = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

const rule = (key: keyof typeof RULES, hook = false): ExportedRule => ({
  hook,
  id: IDS[key],
  rule: RULES[key],
  scope: [],
});

const REPO_RULES = [
  rule("repoPlain"),
  rule("repoHook", true),
  rule("repoMarker"),
  rule("repoMalformedHint"),
];
const GLOBAL_RULES = [rule("globalHook", true), rule("globalManual")];

async function collect(
  home: RuleExportHome,
  request: Partial<RuleExportRequest>,
  cwd?: string,
) {
  return new RuleExportService({
    cwd: cwd ?? home.workspace,
    retry: FAST_RETRY,
    storageRoot: home.storageRoot,
  }).collect({
    origin: "all",
    store: "repository",
    ...request,
  });
}

describe("RuleExportService", () => {
  it("returns only active rules of the selected stores in a stable order", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    // Proposed, stale, rejected, deprecated, and another repository's rule
    // never appear; a string hint is not an object and so is not a hook.
    expect(await collect(home, { repo: EXPORT_REPOSITORY })).toEqual(
      REPO_RULES,
    );
    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    expect(
      await collect(home, { repo: EXPORT_REPOSITORY, store: "all" }),
    ).toEqual([...REPO_RULES, ...GLOBAL_RULES]);
  });

  it("filters on origin.source conversation and treats other shapes as not conversation", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    expect(
      await collect(home, {
        origin: "conversation",
        repo: EXPORT_REPOSITORY,
        store: "all",
      }),
    ).toEqual([
      rule("repoHook", true),
      rule("repoMarker"),
      rule("globalHook", true),
    ]);
  });

  it("matches a registered name ignoring case, as GitHub does", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    expect(
      await collect(home, { repo: EXPORT_REPOSITORY.toUpperCase() }),
    ).toEqual(REPO_RULES);
    expect(await collect(home, { repo: "OWNER/Renamed-From" })).toEqual(
      REPO_RULES,
    );
  });

  it("refuses an empty storage root but reads from a broad one, as doctor does", async () => {
    await expect(
      new RuleExportService({ storageRoot: " " }).collect({
        origin: "all",
        store: "global",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_PATH_UNSAFE" });
    // The broad-directory guard protects permission changes, not reads.
    const home = await createRuleExportHome(temporaryDirectories);
    expect(
      await new RuleExportService({
        cwd: home.storageRoot,
        storageRoot: home.storageRoot,
      }).collect({ origin: "all", store: "global" }),
    ).toEqual(GLOBAL_RULES);
  });

  it("resolves a registered alias without touching the storage", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const before = await snapshotTree(home.root);

    const result = await collect(home, {
      repo: EXPORT_REPOSITORY_ALIAS,
      store: "all",
    });

    expect(result).toEqual([...REPO_RULES, ...GLOBAL_RULES]);
    expect(await snapshotTree(home.root)).toEqual(before);
  });

  it("resolves the repository from the cwd workspace mapping before defaultRepo", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const nested = join(home.workspace, "src");
    await mkdir(nested);
    await writeConfig(home.storageRoot, {
      defaultRepo: "owner/unregistered",
      workspaceMappings: { [home.workspace]: EXPORT_REPOSITORY },
    });

    expect(await collect(home, {}, nested)).toEqual(REPO_RULES);
    // Outside the mapping, defaultRepo is used and must be registered.
    await expect(collect(home, {}, home.root)).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_NOT_REGISTERED",
      message: expect.stringContaining("owner/unregistered"),
    });
  });

  it("uses defaultRepo when no mapping is configured", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeConfig(home.storageRoot, {
      defaultRepo: EXPORT_REPOSITORY_ALIAS,
    });

    expect(await collect(home, {})).toEqual(REPO_RULES);
  });

  it("explains an unresolved repository, including an unusable cwd", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    await expect(collect(home, {})).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_UNRESOLVED",
      message: expect.stringContaining("pass --repo <owner/name>"),
    });
    await writeConfig(home.storageRoot, {
      workspaceMappings: { [home.workspace]: EXPORT_REPOSITORY },
    });
    await expect(
      collect(home, {}, join(home.root, "missing")),
    ).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_UNRESOLVED",
      message: expect.stringContaining("Workspace path cannot be resolved"),
    });
    // A global-only export needs no repository at all.
    expect(await collect(home, { store: "global" })).toHaveLength(2);
  });

  it("propagates an invalid config instead of guessing a repository", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeFile(join(home.storageRoot, "config.json"), "{");

    await expect(collect(home, {})).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("refuses an unregistered repository without creating registry state", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const before = await snapshotTree(home.root);

    await expect(
      collect(home, { repo: "owner/unknown" }),
    ).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_NOT_REGISTERED",
      message:
        "owner/unknown is not registered in this storage; run repo-knowledge setup owner/unknown first",
    });
    expect(await snapshotTree(home.root)).toEqual(before);
  });

  it("reads a missing storage root as nothing registered and creates nothing", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const storageRoot = join(home.root, "never-created");
    const exporter = new RuleExportService({ storageRoot });

    await expect(
      exporter.collect({
        origin: "all",
        repo: EXPORT_REPOSITORY,
        store: "all",
      }),
    ).rejects.toBeInstanceOf(RuleExportError);
    expect(await exporter.collect({ origin: "all", store: "global" })).toEqual(
      [],
    );
    await expect(snapshotTree(storageRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("exports nothing for a registered repository whose store does not exist yet", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await rm(home.repositoryRoot, { recursive: true });

    expect(await collect(home, { repo: EXPORT_REPOSITORY })).toEqual([]);
  });

  it("refuses a repository store that is a symbolic link", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const moved = join(home.root, "elsewhere");
    await rename(home.repositoryRoot, moved);
    await symlink(moved, home.repositoryRoot);

    await expect(
      collect(home, { repo: EXPORT_REPOSITORY }),
    ).rejects.toMatchObject({ code: "RULE_EXPORT_STORE_UNSAFE" });
  });

  it.each([
    [
      "the repos directory",
      (home: RuleExportHome) => join(home.storageRoot, "repos"),
      { repo: EXPORT_REPOSITORY },
    ],
    [
      "a repository store entry",
      (home: RuleExportHome) => join(home.repositoryRoot, "knowledge"),
      { repo: EXPORT_REPOSITORY },
    ],
    [
      "the global store",
      (home: RuleExportHome) => home.globalRoot,
      { store: "global" as const },
    ],
  ])(
    "refuses %s when it is a symbolic link out of the home",
    async (_name, target, request) => {
      const home = await createRuleExportHome(temporaryDirectories);
      const path = target(home);
      const moved = join(home.root, "outside");
      await rename(path, moved);
      await symlink(moved, path);

      await expect(collect(home, request)).rejects.toMatchObject({
        code: "RULE_EXPORT_STORE_UNSAFE",
      });
    },
  );

  it("refuses an interrupted transaction (no live lock holder) and names the recovery command", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await openJournal(home.repositoryRoot);
    await openJournal(home.globalRoot);
    // A lock left by a process that no longer exists does not count as live.
    await holdWriterLock(home.globalRoot, 2 ** 22 + 12_345);

    await expect(
      collect(home, { repo: EXPORT_REPOSITORY }),
    ).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
      message: `the store has an interrupted transaction; run repo-knowledge reindex ${EXPORT_REPOSITORY} and export again`,
    });
    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
      message: expect.stringContaining("run repo-knowledge reindex --global"),
    });
  });

  it("gives an interrupted journal first seen on the last wait its second look", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await startWriter(home.globalRoot);
    let polls = 0;
    // The writer dies (lock gone, journal left) just as the wait budget ends.
    journal.onRead = async (root) => {
      polls += 1;
      if (polls === FAST_RETRY.attempts) {
        await rm(join(root, CANONICAL_WRITE_LOCK_NAME));
      }
    };

    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
    });
  });

  it("gives a journal left during a capture its second look on the last wait", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await startWriter(home.globalRoot);
    let polls = 0;
    // The writer finishes on the last wait; a new one starts during that
    // capture and dies, leaving its journal without a live lock.
    journal.onRead = async (root) => {
      polls += 1;
      if (polls === FAST_RETRY.attempts) await finishWriter(root);
    };
    capture.onCapture = async () => {
      if (polls === FAST_RETRY.attempts) await openJournal(home.globalRoot);
    };

    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
    });
  });

  it("restarts confirmation after a writer, so a store that settles is read", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    // The first two captures disagree and use the whole confirmation
    // budget; then a writer runs, and the settled store must still be read.
    capture.changing = true;
    capture.onCapture = async () => {
      if (capture.calls === 3) capture.changing = false;
    };
    let polls = 0;
    journal.onRead = async (root) => {
      polls += 1;
      if (polls === 5) await startWriter(root);
      if (polls === 6) await finishWriter(root);
    };
    const exporter = new RuleExportService({
      retry: { attempts: 2, delayMs: 1 },
      storageRoot: home.storageRoot,
    });

    expect(await exporter.collect({ origin: "all", store: "global" })).toEqual(
      GLOBAL_RULES,
    );
    expect(capture.calls).toBe(4);
  });

  it("reads the hint with the shared schema, so a hint without rationale is prose", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const id = "kn_01ARZ3NDEKTSV4RRFFQ69G5FC2";
    await writeKnowledge(home.globalRoot, id, "active", GLOBAL_STORE_ID, {
      enforcement_hint: { kind: "hook" },
      rule: "Hook hint without rationale",
    });

    expect(await collect(home, { store: "global" })).toContainEqual({
      hook: false,
      id,
      rule: "Hook hint without rationale",
      scope: [],
    });
  });

  it("carries a rule's scope so a scoped rule is not exported as store-wide", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const id = "kn_01ARZ3NDEKTSV4RRFFQ69G5FC3";
    await writeKnowledge(home.globalRoot, id, "active", GLOBAL_STORE_ID, {
      rule: "Wrap queries in a transaction",
      scope: ["src/db/**", "lib/sql/*.ts"],
    });

    expect(await collect(home, { store: "global" })).toContainEqual({
      hook: false,
      id,
      rule: "Wrap queries in a transaction",
      // The projection sorts and deduplicates scope patterns.
      scope: ["lib/sql/*.ts", "src/db/**"],
    });
  });

  it("refuses a store whose consecutive captures never agree", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    capture.changing = true;

    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_STORE_BUSY",
    });
    // One first capture plus one confirmation per attempt of its budget.
    expect(capture.calls).toBe(FAST_RETRY.attempts + 1);
  });

  it("confirms a capture even when the store goes quiet on the last wait", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await startWriter(home.globalRoot);
    let polls = 0;
    // The writer finishes exactly when the wait budget is used up.
    journal.onRead = async (root) => {
      polls += 1;
      if (polls === FAST_RETRY.attempts) await finishWriter(root);
    };

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    expect(capture.calls).toBe(2);
  });

  it("waits for a live writer and reads the store once its commit finishes", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await startWriter(home.globalRoot);
    let polls = 0;
    let capturesWhileWriting = -1;
    journal.onRead = async (root) => {
      polls += 1;
      if (polls === 4) {
        // No capture ran while the writer held its journal.
        capturesWhileWriting = capture.calls;
        await finishWriter(root);
      }
    };

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    expect(capturesWhileWriting).toBe(0);
  });

  it("ignores a staging directory that never got a manifest, as recovery would", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    // A commit rejected by its precondition leaves only staged payloads.
    await mkdir(
      join(home.globalRoot, TRANSACTIONS_DIRECTORY, "txn_rejected", "staged"),
      { recursive: true },
    );

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
  });

  it("does not mistake back-to-back finished commits for an interrupted one", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    let polls = 0;
    // Each look catches a different commit just after it released its lock.
    journal.onRead = async (root) => {
      polls += 1;
      await rm(join(root, TRANSACTIONS_DIRECTORY), {
        force: true,
        recursive: true,
      });
      if (polls <= 3) await openJournal(root, `txn_${String(polls)}`);
    };

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
  });

  it("keeps retrying a torn capture when a writer was seen between failures", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    capture.failures = 2;
    let pollsWhileWriting = 0;
    // The first (failing) capture overlaps a writer that starts inside it.
    capture.onCapture = async () => {
      if (capture.calls === 1) await startWriter(home.globalRoot);
    };
    journal.onRead = async (root) => {
      if (capture.calls === 0) return;
      pollsWhileWriting += 1;
      if (pollsWhileWriting === 2) await finishWriter(root);
    };

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    expect(capture.calls).toBe(4);
  });

  it("reports a busy store when a live writer never finishes", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await startWriter(home.globalRoot);

    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_STORE_BUSY",
      message:
        "another repo-knowledge command kept writing to the store; export again",
    });
    expect(capture.calls).toBe(0);
  });

  it("retries a capture torn by a concurrent commit", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    capture.failures = 1;

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    expect(capture.calls).toBe(3);
  });

  it("discards a capture taken while a writer started, then reads the committed state", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    let pollsWhileWriting = 0;
    // A writer opens its journal while the first capture is running ...
    capture.onCapture = async () => {
      if (capture.calls === 1) await startWriter(home.globalRoot);
    };
    // ... and commits after export has seen its journal three times.
    journal.onRead = async (root) => {
      if (capture.calls === 0) return;
      pollsWhileWriting += 1;
      if (pollsWhileWriting === 3) await finishWriter(root);
    };

    expect(await collect(home, { store: "global" })).toEqual(GLOBAL_RULES);
    // The torn first capture is discarded; two later ones agree.
    expect(capture.calls).toBe(3);
  });

  it("fails closed on an invalid canonical knowledge document", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeKnowledge(
      home.repositoryRoot,
      "kn_01ARZ3NDEKTSV4RRFFQ69G5FC1",
      "active",
      EXPORT_REPO_ID,
      { category: "not-a-category" },
    );

    await expect(
      collect(home, { repo: EXPORT_REPOSITORY }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_STORE_INVALID" });
  });

  it("reports a capture error on a quiet store after one retry, not after waiting", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeFile(join(home.globalRoot, "events", "broken.jsonl"), "{");
    // With no writer to wait for, the retry must not sleep at all.
    const exporter = new RuleExportService({
      retry: { attempts: 3, delayMs: 60_000 },
      storageRoot: home.storageRoot,
    });

    await expect(
      exporter.collect({ origin: "all", store: "global" }),
    ).rejects.toMatchObject({ path: "events/broken.jsonl" });
    expect(capture.calls).toBe(2);
  });
});

describe("renderRuleExport", () => {
  const render = (...args: Parameters<typeof renderRuleExport>) =>
    renderRuleExport(...args).block;

  const rules: ExportedRule[] = [
    rule("repoPlain"),
    rule("repoHook", true),
    rule("globalManual"),
  ];

  it("renders the CLAUDE.md block with a hook heading", () => {
    expect(render("claude-md", "all", rules)).toBe(
      [
        "<!-- repo-knowledge:begin format=claude-md store=all -->",
        "## repo-knowledge が学習したルール",
        "",
        `- ${RULES.repoPlain}`,
        `- ${RULES.globalManual}`,
        "",
        "### hook での強制を推奨",
        "",
        `- ${RULES.repoHook}`,
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("renders the AGENTS.md block with the hook section as a note", () => {
    const claude = render("claude-md", "global", rules).split("\n");
    const agents = render("agents-md", "global", rules).split("\n");

    expect(agents).toEqual([
      "<!-- repo-knowledge:begin format=agents-md store=global -->",
      "## repo-knowledge が学習したルール",
      "",
      `- ${RULES.repoPlain}`,
      `- ${RULES.globalManual}`,
      "",
      "> 注: 次のルールは hook での強制が推奨されています。AGENTS.md からは hook を設定できないため、指示として守ってください。",
      "",
      `- ${RULES.repoHook}`,
      "<!-- repo-knowledge:end -->",
      "",
    ]);
    // Only the begin marker's format and the hook section's introduction differ.
    const differing = claude.flatMap((line, index) =>
      line === agents[index] ? [] : [index],
    );
    expect(differing).toEqual([0, 6]);
  });

  it("omits an empty hook section and keeps a hook-only block well formed", () => {
    expect(
      render("claude-md", "repository", [rule("repoPlain")]),
    ).not.toContain("hook");
    expect(render("agents-md", "repository", [rule("repoHook", true)])).toBe(
      [
        "<!-- repo-knowledge:begin format=agents-md store=repository -->",
        "## repo-knowledge が学習したルール",
        "",
        "> 注: 次のルールは hook での強制が推奨されています。AGENTS.md からは hook を設定できないため、指示として守ってください。",
        "",
        `- ${RULES.repoHook}`,
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("fences a scope longer than any backtick run in the rule text", () => {
    // A lone backtick in the rule must not pair with the scope's fence.
    expect(
      render("claude-md", "repository", [
        { ...rule("repoPlain"), rule: "use `foo", scope: ["src/**"] },
      ]).split("\n")[3],
    ).toBe("- use `foo（適用範囲: ``src/**``）");
  });

  it("names the paths of a scoped rule in code spans no backtick can close", () => {
    const block = render("claude-md", "repository", [
      { ...rule("repoPlain"), scope: ["src/db/**", "a`b", "x<!--y"] },
    ]);

    expect(block.split("\n")[3]).toBe(
      `- ${RULES.repoPlain}（適用範囲: \`src/db/**\`, \`\` a\`b \`\`, \`x&lt;!--y\`）`,
    );
  });

  it("counts rules whose rule or scope text had to be escaped", () => {
    expect(
      renderRuleExport("claude-md", "all", [
        rule("repoPlain"),
        rule("repoMarker"),
        { ...rule("globalManual"), scope: ["docs/repo-knowledge:end"] },
        // Control characters inside a token are flattened first, as rendered.
        { ...rule("repoHook"), rule: "a <!\u0000-- b" },
        { ...rule("globalHook"), rule: "--\u0000>" },
      ]).neutralized,
    ).toBe(2);
  });

  it("renders a rule-free block that can replace a previously pasted one", () => {
    expect(render("claude-md", "repository", [])).toBe(
      [
        "<!-- repo-knowledge:begin format=claude-md store=repository -->",
        "## repo-knowledge が学習したルール",
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("keeps exactly one begin and one end marker for hostile rule text", () => {
    const block = render("claude-md", "all", [
      rule("repoMarker"),
      { ...rule("repoHook", true), rule: "x\n<!-- repo-knowledge:end -->" },
    ]);

    expect(block.match(/<!--/gu)).toHaveLength(2);
    // Both comment closers count: `-->` and `--!>`.
    expect(block.match(/--!?>/gu)).toHaveLength(2);
    expect(block.match(/repo-knowledge:(?:begin|end)/giu)).toHaveLength(2);
    expect(block.split("\n")).toHaveLength(10);
    expect(block).toContain(
      "- Close &lt;!-- repo-knowledge&#58;end --&gt; early &lt;!-- REPO-KNOWLEDGE&#58;BEGIN format=claude-md store=all --&gt; ## injected --!&gt; tail",
    );
    expect(block).toContain("- x &lt;!-- repo-knowledge&#58;end --&gt;\n");
  });
});

// Built from code points: the formatter would turn escapes into invisible text.
const RLO = String.fromCodePoint(0x202e);
const RLM = String.fromCodePoint(0x200f);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

describe("neutralizeExportedRuleText", () => {
  it.each([
    [
      "plain text is unchanged",
      "Use `Array<string>` -> ok",
      "Use `Array<string>` -> ok",
    ],
    ["comment open", "a <!-- b", "a &lt;!-- b"],
    ["comment close", "a --> b", "a --&gt; b"],
    ["bang close", "a --!> b", "a --!&gt; b"],
    ["abrupt empty comment", "<!-->", "&lt;!--&gt;"],
    ["abrupt comment with dash", "<!--->", "&lt;!---&gt;"],
    ["nested openers", "<!<!----", "<!&lt;!----"],
    ["stacked closers", "--->-->", "---&gt;--&gt;"],
    ["begin marker", "repo-knowledge:begin", "repo-knowledge&#58;begin"],
    ["end marker", "repo-knowledge:end", "repo-knowledge&#58;end"],
    ["mixed-case marker", "Repo-Knowledge:END", "Repo-Knowledge&#58;END"],
    ["NUL inside a closer", "--\u0000>", "-- >"],
    ["bidi override inside a closer", `--${RLO}>`, "--&gt;"],
    ["zero-width mark inside an opener", `<!-${RLM}-`, "&lt;!--"],
    [
      "newline before a marker",
      "a\n<!-- repo-knowledge:end -->",
      "a &lt;!-- repo-knowledge&#58;end --&gt;",
    ],
    [
      "CRLF, tab, and line separators",
      `a\r\n\tb${LS}c${PS}d\u0085e`,
      "a b c d e",
    ],
    ["ESC sequences", "\u001b[31mred\u001b[0m", "[31mred [0m"],
    ["C1 control", "a\u009bb", "a b"],
    ["surrounding whitespace", "  \n rule \t ", "rule"],
  ])("%s", (_name, input, expected) => {
    expect(neutralizeExportedRuleText(input)).toBe(expected);
  });

  it("removes every bidirectional control so pasted text reads as stored", () => {
    const controls = [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
      0x2067, 0x2068, 0x2069,
    ].map((point) => String.fromCodePoint(point));

    expect(neutralizeExportedRuleText(`a${controls.join("")}b`)).toBe("ab");
  });
});

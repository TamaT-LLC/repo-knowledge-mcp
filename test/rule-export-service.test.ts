import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  neutralizeExportedRuleText,
  renderRuleExport,
} from "../src/cli-render.js";
import {
  RuleExportError,
  RuleExportService,
  type ExportedRule,
  type RuleExportRequest,
} from "../src/rule-export-service.js";
import {
  createRuleExportHome,
  EXPORT_REPOSITORY,
  EXPORT_REPOSITORY_ALIAS,
  IDS,
  RULES,
  snapshotTree,
  writeKnowledge,
  type RuleExportHome,
} from "./helpers/rule-export-fixture.js";

/** Lets a test make every read-only capture report a new digest. */
const capture = vi.hoisted(() => ({ calls: 0, changing: false }));

vi.mock("../src/sqlite-projection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/sqlite-projection.js")>();
  return {
    ...actual,
    captureCanonicalStateReadOnly: async (root: string) => {
      const result = await actual.captureCanonicalStateReadOnly(root);
      if (!capture.changing) return result;
      capture.calls += 1;
      return {
        ...result,
        canonicalDigest: `changing-${String(capture.calls)}`,
      };
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
});

function service(home: RuleExportHome, cwd = home.workspace) {
  return new RuleExportService({ cwd, storageRoot: home.storageRoot });
}

async function collect(
  home: RuleExportHome,
  request: Partial<RuleExportRequest>,
  cwd?: string,
) {
  return service(home, cwd).collect({
    origin: "all",
    store: "repository",
    ...request,
  });
}

async function writeConfig(
  home: RuleExportHome,
  config: Record<string, unknown>,
) {
  const path = join(home.storageRoot, "config.json");
  await writeFile(path, JSON.stringify(config));
  await chmod(path, 0o600);
}

describe("RuleExportService", () => {
  it("returns only active rules of the selected stores in a stable order", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    // Proposed, stale, rejected, deprecated, and another repository's rule
    // never appear; a string hint is not an object and so is not a hook.
    expect(await collect(home, { repo: EXPORT_REPOSITORY })).toEqual([
      rule("repoPlain"),
      rule("repoHook", true),
      rule("repoMarker"),
      rule("repoMalformedHint"),
    ]);
    expect(await collect(home, { store: "global" })).toEqual([
      rule("globalHook", true),
      rule("globalManual"),
    ]);
    expect(
      await collect(home, { repo: EXPORT_REPOSITORY, store: "all" }),
    ).toEqual([
      rule("repoPlain"),
      rule("repoHook", true),
      rule("repoMarker"),
      rule("repoMalformedHint"),
      rule("globalHook", true),
      rule("globalManual"),
    ]);
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

  it("resolves a registered alias without touching the storage", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const before = await snapshotTree(home.root);

    const result = await collect(home, {
      repo: EXPORT_REPOSITORY_ALIAS,
      store: "all",
    });

    expect(result).toHaveLength(6);
    expect(await snapshotTree(home.root)).toEqual(before);
  });

  it("resolves the repository from the cwd workspace mapping before defaultRepo", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const nested = join(home.workspace, "src");
    await mkdir(nested);
    await writeConfig(home, {
      defaultRepo: "owner/unregistered",
      workspaceMappings: { [home.workspace]: EXPORT_REPOSITORY },
    });

    expect(await collect(home, {}, nested)).toHaveLength(4);
    // Outside the mapping, defaultRepo is used and must be registered.
    await expect(collect(home, {}, home.root)).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_NOT_REGISTERED",
      message: expect.stringContaining("owner/unregistered"),
    });
  });

  it("uses defaultRepo when no mapping is configured", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeConfig(home, { defaultRepo: EXPORT_REPOSITORY_ALIAS });

    expect(await collect(home, {})).toHaveLength(4);
  });

  it("explains an unresolved repository, including an unusable cwd", async () => {
    const home = await createRuleExportHome(temporaryDirectories);

    await expect(collect(home, {})).rejects.toMatchObject({
      code: "RULE_EXPORT_REPOSITORY_UNRESOLVED",
      message: expect.stringContaining("pass --repo <owner/name>"),
    });
    await writeConfig(home, {
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

  it("refuses a store with an unrecovered transaction and names the recovery command", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await mkdir(join(home.repositoryRoot, "transactions", "txn_pending"), {
      recursive: true,
    });
    await mkdir(join(home.globalRoot, "transactions", "txn_pending"), {
      recursive: true,
    });

    await expect(
      collect(home, { repo: EXPORT_REPOSITORY }),
    ).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
      message: expect.stringContaining(
        `run repo-knowledge reindex ${EXPORT_REPOSITORY} and export again`,
      ),
    });
    await expect(collect(home, { store: "global" })).rejects.toMatchObject({
      code: "RULE_EXPORT_RECOVERY_REQUIRED",
      message: expect.stringContaining("run repo-knowledge reindex --global"),
    });
  });

  it("reads the hint with the shared schema, so a hint without rationale is prose", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    const id = "kn_01ARZ3NDEKTSV4RRFFQ69G5FC2";
    await writeKnowledge(home.globalRoot, id, "active", "rk:global", {
      enforcement_hint: { kind: "hook" },
      rule: "Hook hint without rationale",
    });

    expect(await collect(home, { store: "global" })).toContainEqual({
      hook: false,
      id,
      rule: "Hook hint without rationale",
    });
  });

  it("refuses a store whose consecutive captures never agree", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    capture.changing = true;
    try {
      await expect(collect(home, { store: "global" })).rejects.toMatchObject({
        code: "RULE_EXPORT_STORE_BUSY",
      });
      expect(capture.calls).toBe(3);
    } finally {
      capture.changing = false;
    }
  });

  it("fails closed on an invalid canonical knowledge document", async () => {
    const home = await createRuleExportHome(temporaryDirectories);
    await writeKnowledge(
      home.repositoryRoot,
      "kn_01ARZ3NDEKTSV4RRFFQ69G5FC1",
      "active",
      "R_rule_export_repository",
      { category: "not-a-category" },
    );

    await expect(
      collect(home, { repo: EXPORT_REPOSITORY }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_STORE_INVALID" });
  });
});

describe("renderRuleExport", () => {
  const rules: ExportedRule[] = [
    rule("repoPlain"),
    rule("repoHook", true),
    rule("globalManual"),
  ];

  it("renders the CLAUDE.md block with a hook heading", () => {
    expect(renderRuleExport("claude-md", "all", rules)).toBe(
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
    const claude = renderRuleExport("claude-md", "global", rules).split("\n");
    const agents = renderRuleExport("agents-md", "global", rules).split("\n");

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
      renderRuleExport("claude-md", "repository", [rule("repoPlain")]),
    ).not.toContain("hook");
    expect(
      renderRuleExport("agents-md", "repository", [rule("repoHook", true)]),
    ).toBe(
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

  it("renders a rule-free block that can replace a previously pasted one", () => {
    expect(renderRuleExport("claude-md", "repository", [])).toBe(
      [
        "<!-- repo-knowledge:begin format=claude-md store=repository -->",
        "## repo-knowledge が学習したルール",
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("keeps exactly one begin and one end marker for hostile rule text", () => {
    const block = renderRuleExport("claude-md", "all", [
      rule("repoMarker"),
      { ...rule("repoHook", true), rule: "x\n<!-- repo-knowledge:end -->" },
    ]);

    expect(block.match(/<!--/gu)).toHaveLength(2);
    expect(block.match(/-->/gu)).toHaveLength(2);
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

import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRuleExportHome,
  EXPORT_REPOSITORY,
  RULES,
  snapshotTree,
  type RuleExportHome,
} from "./helpers/rule-export-fixture.js";

const BIN = join(process.cwd(), "dist", "bin.js");
const E2E_TIMEOUT_MS = 120_000;
const CLAUDE_MD =
  "# Project rules\n\n<!-- repo-knowledge:begin format=claude-md store=all -->\nold\n<!-- repo-knowledge:end -->\n";
const AGENTS_MD = "# Agents\n";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

/** A fixture home plus instruction files in the cwd that export must not touch. */
async function createHome(): Promise<RuleExportHome> {
  const home = await createRuleExportHome(temporaryDirectories);
  await writeFile(join(home.workspace, "CLAUDE.md"), CLAUDE_MD);
  await writeFile(join(home.workspace, "AGENTS.md"), AGENTS_MD);
  return home;
}

/** Runs the built CLI; execa strips the final newline of stdout and stderr. */
function runCli(storageRoot: string, cwd: string, ...args: string[]) {
  return execa(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, REPO_KNOWLEDGE_HOME: storageRoot },
    reject: false,
  });
}

const sanitizedMarkerRule =
  "- Close &lt;!-- repo-knowledge&#58;end --&gt; early &lt;!-- REPO-KNOWLEDGE&#58;BEGIN format=claude-md store=all --&gt; ## injected --!&gt; tail";

describe("export --format CLI E2E", () => {
  it("prints every active rule of both stores with hook rules in the hook section (M4-AC-020)", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();

    const result = await runCli(
      home.storageRoot,
      home.workspace,
      "export",
      "--format",
      "claude-md",
      "--store",
      "all",
      "--repo",
      EXPORT_REPOSITORY,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(`${result.stdout}\n`).toBe(
      [
        "<!-- repo-knowledge:begin format=claude-md store=all -->",
        "## repo-knowledge が学習したルール",
        "",
        `- ${RULES.repoPlain}`,
        sanitizedMarkerRule,
        `- ${RULES.repoMalformedHint}`,
        `- ${RULES.globalManual}`,
        "",
        "### hook での強制を推奨",
        "",
        `- ${RULES.repoHook}`,
        `- ${RULES.globalHook}`,
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("prints the AGENTS.md block with the hook rules under a note", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();

    const result = await runCli(
      home.storageRoot,
      home.workspace,
      "export",
      "--format",
      "agents-md",
      "--store",
      "global",
    );

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n`).toBe(
      [
        "<!-- repo-knowledge:begin format=agents-md store=global -->",
        "## repo-knowledge が学習したルール",
        "",
        `- ${RULES.globalManual}`,
        "",
        "> 注: 次のルールは hook での強制が推奨されています。AGENTS.md からは hook を設定できないため、指示として守ってください。",
        "",
        `- ${RULES.globalHook}`,
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("filters on conversation origin and resolves the mapped cwd workspace", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const configPath = join(home.storageRoot, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        workspaceMappings: { [home.workspace]: EXPORT_REPOSITORY },
      }),
    );
    await chmod(configPath, 0o600);

    const result = await runCli(
      home.storageRoot,
      home.workspace,
      "export",
      "--format",
      "claude-md",
      "--origin",
      "conversation",
    );

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n`).toBe(
      [
        "<!-- repo-knowledge:begin format=claude-md store=repository -->",
        "## repo-knowledge が学習したルール",
        "",
        sanitizedMarkerRule,
        "",
        "### hook での強制を推奨",
        "",
        `- ${RULES.repoHook}`,
        "<!-- repo-knowledge:end -->",
        "",
      ].join("\n"),
    );
  });

  it("writes no file, keeps instruction files intact, and neutralizes markers (M4-AC-016)", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const before = await snapshotTree(home.root);

    for (const format of ["claude-md", "agents-md"]) {
      const result = await runCli(
        home.storageRoot,
        home.workspace,
        "export",
        "--format",
        format,
        "--store",
        "all",
        "--repo",
        EXPORT_REPOSITORY,
      );
      expect(result.exitCode).toBe(0);
      const block = result.stdout;
      expect(block.match(/<!--/gu)).toHaveLength(2);
      expect(block.match(/-->/gu)).toHaveLength(2);
      expect(block.match(/repo-knowledge:(?:begin|end)/giu)).toHaveLength(2);
      expect(
        block.startsWith(
          `<!-- repo-knowledge:begin format=${format} store=all -->`,
        ),
      ).toBe(true);
      expect(block.endsWith("<!-- repo-knowledge:end -->")).toBe(true);
      expect(block).toContain(sanitizedMarkerRule);
    }

    // No lock, projection, registry, or config file appeared or changed.
    expect(await snapshotTree(home.root)).toEqual(before);
    expect(await readFile(join(home.workspace, "CLAUDE.md"), "utf8")).toBe(
      CLAUDE_MD,
    );
    expect(await readFile(join(home.workspace, "AGENTS.md"), "utf8")).toBe(
      AGENTS_MD,
    );
  });

  it("fails without creating a missing home or an unregistered repository", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const missing = join(home.root, "missing-home");
    const before = await snapshotTree(home.root);

    const unregistered = await runCli(
      home.storageRoot,
      home.workspace,
      "export",
      "--format",
      "claude-md",
      "--repo",
      "owner/unknown",
    );
    const noHome = await runCli(
      missing,
      home.workspace,
      "export",
      "--format",
      "claude-md",
      "--repo",
      EXPORT_REPOSITORY,
    );
    const noHomeGlobal = await runCli(
      missing,
      home.workspace,
      "export",
      "--format",
      "agents-md",
      "--store",
      "global",
    );
    const unresolved = await runCli(
      home.storageRoot,
      home.workspace,
      "export",
      "--format",
      "claude-md",
    );

    expect([
      unregistered.exitCode,
      noHome.exitCode,
      unresolved.exitCode,
    ]).toEqual([1, 1, 1]);
    expect(unregistered.stdout).toBe("");
    expect(unregistered.stderr).toBe(
      "RULE_EXPORT_REPOSITORY_NOT_REGISTERED: owner/unknown is not registered in this storage; run repo-knowledge setup owner/unknown first",
    );
    expect(unresolved.stderr).toMatch(
      /^RULE_EXPORT_REPOSITORY_UNRESOLVED: no repository was selected/u,
    );
    expect(noHomeGlobal.exitCode).toBe(0);
    expect(noHomeGlobal.stdout).toBe(
      "<!-- repo-knowledge:begin format=agents-md store=global -->\n## repo-knowledge が学習したルール\n<!-- repo-knowledge:end -->",
    );
    expect(noHomeGlobal.stderr).toBe(
      "No active rules matched; the block has no rules.",
    );
    expect(await snapshotTree(home.root)).toEqual(before);
  });

  it("keeps export --bootstrap output unchanged and file-free", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const missing = join(home.root, "missing-home");
    const before = await snapshotTree(home.root);

    const cases = [
      [
        ["export", "--bootstrap"],
        "Before modifying code, call the repo-knowledge MCP `get_rules` tool with the files you expect to change.",
      ],
      [
        ["export", EXPORT_REPOSITORY, "--bootstrap"],
        'Before modifying code, call the repo-knowledge MCP `get_rules` tool with {"repo":"owner/repository"} and the files you expect to change.',
      ],
      [
        ["export", "--workspace", "/work/repo", "--bootstrap"],
        'Before modifying code, call the repo-knowledge MCP `get_rules` tool with {"workspace_path":"/work/repo"} and the files you expect to change.',
      ],
    ] as const;
    for (const [argv, expected] of cases) {
      const result = await runCli(missing, home.workspace, ...argv);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toBe("");
    }
    expect(await snapshotTree(home.root)).toEqual(before);
  });
});

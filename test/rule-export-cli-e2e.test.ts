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

function exportCli(
  storageRoot: string,
  cwd: string,
  format: string,
  ...flags: string[]
) {
  return runCli(storageRoot, cwd, "export", "--format", format, ...flags);
}

const sanitizedMarkerRule =
  "- Close &lt;!-- repo-knowledge&#58;end --&gt; early &lt;!-- REPO-KNOWLEDGE&#58;BEGIN format=claude-md store=all --&gt; ## injected --!&gt; tail";

describe("export --format CLI E2E", () => {
  it("prints hook rules in the hook section, neutralizes markers, and writes no file (M4-AC-016, M4-AC-020)", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const before = await snapshotTree(home.root);
    const flags = ["--store", "all", "--repo", EXPORT_REPOSITORY];

    const [claude, agents] = await Promise.all([
      exportCli(home.storageRoot, home.workspace, "claude-md", ...flags),
      exportCli(home.storageRoot, home.workspace, "agents-md", ...flags),
    ]);

    expect([claude.exitCode, agents.exitCode]).toEqual([0, 0]);
    expect([claude.stderr, agents.stderr]).toEqual(["", ""]);
    expect(`${claude.stdout}\n`).toBe(
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
    for (const [format, block] of [
      ["claude-md", claude.stdout],
      ["agents-md", agents.stdout],
    ] as const) {
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
      expect(block).toContain(`- ${RULES.repoHook}\n- ${RULES.globalHook}\n`);
    }

    // No lock, projection, registry, or config file appeared or changed,
    // which also covers native SQLite writes the in-process fs spy cannot see.
    expect(await snapshotTree(home.root)).toEqual(before);
    expect(await readFile(join(home.workspace, "CLAUDE.md"), "utf8")).toBe(
      CLAUDE_MD,
    );
    expect(await readFile(join(home.workspace, "AGENTS.md"), "utf8")).toBe(
      AGENTS_MD,
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

    const result = await exportCli(
      home.storageRoot,
      home.workspace,
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

  it("fails without creating a missing home or registering a repository", {
    timeout: E2E_TIMEOUT_MS,
  }, async () => {
    const home = await createHome();
    const missing = join(home.root, "missing-home");
    const before = await snapshotTree(home.root);

    const [unregistered, noHome, noHomeGlobal, unresolved] = await Promise.all([
      exportCli(
        home.storageRoot,
        home.workspace,
        "claude-md",
        "--repo",
        "owner/unknown",
      ),
      exportCli(
        missing,
        home.workspace,
        "claude-md",
        "--repo",
        EXPORT_REPOSITORY,
      ),
      exportCli(missing, home.workspace, "agents-md", "--store", "global"),
      exportCli(home.storageRoot, home.workspace, "claude-md"),
    ]);

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

    const results = await Promise.all(
      cases.map(([argv]) => runCli(missing, home.workspace, ...argv)),
    );

    expect(
      results.map(({ exitCode, stderr, stdout }) => ({
        exitCode,
        stderr,
        stdout,
      })),
    ).toEqual(cases.map(([, stdout]) => ({ exitCode: 0, stderr: "", stdout })));
    expect(await snapshotTree(home.root)).toEqual(before);
  });
});

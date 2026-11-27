import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_CONFIG_FILE_NAME,
  disabledConversationConfig,
  loadConversationDistillationConfig,
  parseConversationDistillationConfig,
} from "../src/conversation-config.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rk-conv-config-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

async function writeConfig(value: unknown, mode = 0o600): Promise<string> {
  const path = join(root, CONVERSATION_CONFIG_FILE_NAME);
  await writeFile(path, JSON.stringify(value), { mode });
  return path;
}

describe("conversation-distillation.json", () => {
  it("disables everything when the file is absent", async () => {
    const loaded = await loadConversationDistillationConfig(root);

    expect(loaded.present).toBe(false);
    expect(loaded.config).toEqual(disabledConversationConfig());
    expect(loaded.config).toMatchObject({
      enabled: false,
      sources: {
        claudeCode: { enabled: false, home: "~/.claude" },
        codex: { enabled: false, home: "~/.codex" },
      },
      provider: { allowConversationContentTransmission: false },
      hostAssisted: {
        allowConversationContentTransmission: false,
        allowGlobalStore: false,
        enabled: false,
      },
    });
  });

  it("applies the documented defaults to a minimal file", async () => {
    await writeConfig({ schemaVersion: 1 });

    const { config, present } = await loadConversationDistillationConfig(root);

    expect(present).toBe(true);
    expect(config.assistantContext).toEqual({
      enabled: true,
      maxCharacters: 500,
    });
    expect(config.retentionDays).toBeNull();
    expect(config.redactTerms).toEqual([]);
    expect(config.sdkAllowlist).toEqual([]);
    expect(config.excludeProjects).toEqual([]);
    expect(config.thresholds).toEqual({
      global: { minProjects: 2, minSessions: 3 },
      noRepository: { minSessions: 3 },
      repository: { minSessions: 2 },
    });
  });

  it("accepts the full documented shape and normalizes paths", () => {
    const config = parseConversationDistillationConfig({
      schemaVersion: 1,
      enabled: true,
      sources: { claudeCode: { enabled: true, home: "~/.claude" } },
      provider: {
        allowConversationContentTransmission: true,
        consentedMode: "anthropic",
      },
      hostAssisted: { enabled: true },
      assistantContext: { enabled: false, maxCharacters: 2000 },
      retentionDays: 30,
      redactTerms: ["Tanaka"],
      sdkAllowlist: [{ entrypoint: "sdk-ts" }, { cwdPrefix: "/srv/tools/" }],
      automationPatterns: ["^\\[bot\\]"],
      correctionKeywords: ["やめて"],
      excludeProjects: ["octo/secret", "/Users/alice/private//x/"],
      thresholds: { global: { minProjects: 3 } },
    });

    expect(config.sources.codex).toEqual({ enabled: false, home: "~/.codex" });
    expect(config.sdkAllowlist[1]).toEqual({ cwdPrefix: "/srv/tools" });
    expect(config.excludeProjects).toEqual([
      "octo/secret",
      "/Users/alice/private/x",
    ]);
    expect(config.thresholds.global).toEqual({
      minProjects: 3,
      minSessions: 3,
    });
  });

  it.each([
    ["an unknown top-level key", { schemaVersion: 1, extra: true }],
    ["an unknown nested key", { schemaVersion: 1, assistantContext: { x: 1 } }],
    ["another schema version", { schemaVersion: 2 }],
    ["a missing schema version", {}],
    ["zero retention", { schemaVersion: 1, retentionDays: 0 }],
    [
      "an oversized context",
      { schemaVersion: 1, assistantContext: { maxCharacters: 2001 } },
    ],
    ["a blank dictionary term", { schemaVersion: 1, redactTerms: ["  "] }],
    ["an empty allowlist entry", { schemaVersion: 1, sdkAllowlist: [{}] }],
    [
      "a relative allowlist cwd",
      { schemaVersion: 1, sdkAllowlist: [{ cwdPrefix: "tools" }] },
    ],
    ["an invalid pattern", { schemaVersion: 1, automationPatterns: ["("] }],
    ["a relative exclude", { schemaVersion: 1, excludeProjects: ["repo"] }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseConversationDistillationConfig(value)).toThrow(
      /CONVERSATION_CONFIG_INVALID/u,
    );
  });

  it("names the real reason a path is rejected", () => {
    expect(() =>
      parseConversationDistillationConfig({
        schemaVersion: 1,
        excludeProjects: ["/work/a\u0000b"],
      }),
    ).toThrow(/must not contain NUL/u);
  });

  it("never echoes dictionary terms or file content in errors", async () => {
    await writeConfig({ schemaVersion: 1, redactTerms: ["Secret Name", 7] });
    await expect(loadConversationDistillationConfig(root)).rejects.toThrow(
      /redactTerms\.1/u,
    );
    await expect(loadConversationDistillationConfig(root)).rejects.not.toThrow(
      /Secret Name/u,
    );

    await writeFile(
      join(root, CONVERSATION_CONFIG_FILE_NAME),
      '{"redactTerms": ["Secret Name"',
    );
    const error = await loadConversationDistillationConfig(root).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error).toMatchObject({ code: "CONVERSATION_CONFIG_INVALID" });
    expect(String(error)).not.toContain("Secret Name");
  });

  it("tightens a readable file to 0600 because it holds the dictionary", async () => {
    const path = await writeConfig({ schemaVersion: 1 }, 0o644);

    await loadConversationDistillationConfig(root);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked config", async () => {
    const target = join(root, "elsewhere.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1 }));
    await symlink(target, join(root, CONVERSATION_CONFIG_FILE_NAME));

    await expect(
      loadConversationDistillationConfig(root),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONFIG_PATH_UNSAFE" });
  });

  it("reports unreadable files as IO errors", async () => {
    await expect(
      loadConversationDistillationConfig(join(root, "missing-dir", "\0")),
    ).rejects.toMatchObject({ code: "CONVERSATION_CONFIG_IO_ERROR" });
  });

  it("does not read or change config.json", async () => {
    const legacy = join(root, "config.json");
    await writeFile(legacy, '{"legacy":true}\n');
    await writeConfig({ schemaVersion: 1, enabled: true });

    await loadConversationDistillationConfig(root);

    expect(await readFile(legacy, "utf8")).toBe('{"legacy":true}\n');
  });
});

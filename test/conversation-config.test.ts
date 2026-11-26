import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeStorage } from "../src/config.js";
import {
  CONVERSATION_CONFIG_FILE_NAME,
  loadConversationConfig,
} from "../src/conversation-config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })));
});

/** The file holds redactTerms, so it must be private (0600). */
async function writeConfig(root: string, contents: string): Promise<void> {
  const path = join(root, CONVERSATION_CONFIG_FILE_NAME);
  await writeFile(path, contents);
  await chmod(path, 0o600);
}

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rk-conversation-config-"));
  roots.push(root);
  return root;
}

describe("conversation-distillation.json", () => {
  it("disables everything when the file is missing and never creates it", async () => {
    const root = await home();
    const config = await loadConversationConfig(root);
    expect(config).toMatchObject({
      enabled: false,
      sources: {
        claudeCode: { enabled: false, home: "~/.claude" },
        codex: { enabled: false, home: "~/.codex" },
      },
      provider: {
        allowConversationContentTransmission: false,
        consentedMode: null,
      },
      hostAssisted: { enabled: false, allowGlobalStore: false },
      assistantContext: { enabled: true, maxCharacters: 500 },
      retentionDays: null,
      redactTerms: [],
      sdkAllowlist: [],
      excludeProjects: [],
      thresholds: {
        repository: { minSessions: 2 },
        global: { minProjects: 2, minSessions: 3 },
        noRepository: { minSessions: 3 },
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("reads settings without touching config.json", async () => {
    const root = await home();
    const { configPath } = await initializeStorage(root);
    const before = await readFile(configPath);
    await writeConfig(
      root,
      JSON.stringify({
        schemaVersion: 1,
        retentionDays: 30,
        redactTerms: ["Tanaka"],
        assistantContext: { enabled: false },
        sdkAllowlist: [{ cwdPrefix: "/work" }],
        excludeProjects: ["owner/name", "/Users/alice/private"],
      }),
    );
    const config = await loadConversationConfig(root);
    expect(config.retentionDays).toBe(30);
    expect(config.redactTerms).toEqual(["Tanaka"]);
    expect(config.assistantContext).toEqual({
      enabled: false,
      maxCharacters: 500,
    });
    expect(await readFile(configPath)).toEqual(before);
  });

  it.each([
    ["unknown root key", { schemaVersion: 1, extra: true }],
    ["unknown nested key", { schemaVersion: 1, provider: { other: 1 } }],
    ["wrong version", { schemaVersion: 2 }],
    ["relative exclude", { schemaVersion: 1, excludeProjects: ["repo"] }],
    ["empty allowlist entry", { schemaVersion: 1, sdkAllowlist: [{}] }],
    ["bad pattern", { schemaVersion: 1, automationPatterns: ["("] }],
    ["zero retention", { schemaVersion: 1, retentionDays: 0 }],
  ])("rejects %s", async (_name, value) => {
    const root = await home();
    await writeConfig(root, JSON.stringify(value));
    await expect(loadConversationConfig(root)).rejects.toThrow(
      "CONFIG_INVALID",
    );
  });

  it("refuses a config file readable by group or others", async () => {
    const root = await home();
    await writeConfig(root, JSON.stringify({ schemaVersion: 1 }));
    await chmod(join(root, CONVERSATION_CONFIG_FILE_NAME), 0o644);
    await expect(loadConversationConfig(root)).rejects.toThrow(
      "CONFIG_PATH_UNSAFE",
    );
    await chmod(join(root, CONVERSATION_CONFIG_FILE_NAME), 0o600);
    await expect(loadConversationConfig(root)).resolves.toMatchObject({
      enabled: false,
    });
  });

  it("rejects invalid JSON", async () => {
    const root = await home();
    await writeConfig(root, "{");
    await expect(loadConversationConfig(root)).rejects.toThrow(
      "CONFIG_INVALID",
    );
  });
});

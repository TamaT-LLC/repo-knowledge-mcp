import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION,
  REPO_KNOWLEDGE_CLI_HELP,
  runDefaultRepoKnowledgeCli,
  type RepoKnowledgeCliIo,
} from "../src/index.js";
import { WireClient, readTools } from "./support/mcp-test-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("default CLI runtime", () => {
  it("keeps help and bootstrap output side-effect free", async () => {
    const parent = await temporaryDirectory();
    const storageRoot = join(parent, "not-created");
    const help = output({ stdinIsTTY: true, stdoutIsTTY: true });

    await expect(
      runDefaultRepoKnowledgeCli({ argv: [], io: help.io, storageRoot }),
    ).resolves.toBe(0);
    expect(help.stdout()).toBe(REPO_KNOWLEDGE_CLI_HELP);
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const bootstrap = output({ stdinIsTTY: false, stdoutIsTTY: false });
    await expect(
      runDefaultRepoKnowledgeCli({
        argv: ["export", "owner/repository", "--bootstrap"],
        io: bootstrap.io,
        storageRoot,
      }),
    ).resolves.toBe(0);
    expect(bootstrap.stdout()).toBe(
      `${REPO_KNOWLEDGE_BOOTSTRAP_INSTRUCTION}\n`,
    );
    await expect(access(storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts the real MCP stdio server for an argument-free pipe", async () => {
    const storageRoot = join(await temporaryDirectory(), "storage");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new WireClient(clientTransport);
    const captured = output({ stdinIsTTY: false, stdoutIsTTY: false });
    await client.start();
    try {
      await expect(
        runDefaultRepoKnowledgeCli({
          argv: [],
          io: captured.io,
          storageRoot,
          transport: serverTransport,
        }),
      ).resolves.toBe(0);
      const initialized = await client.request("initialize", {
        capabilities: {},
        clientInfo: { name: "cli-runtime-test", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      });
      expect(initialized).not.toHaveProperty("error");
      await client.notify("notifications/initialized", {});

      const tools = readTools(await client.request("tools/list", {}));
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "add_knowledge",
        "get_knowledge",
        "get_rules",
        "ingest_pr",
        "prepare_distillation",
        "search_knowledge",
        "submit_distillation",
        "update_knowledge",
      ]);
      expect(captured.stdout()).toBe("");
      expect(captured.stderr()).toBe("");
    } finally {
      await client.close();
    }
  });
});

function output(tty: {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: RepoKnowledgeCliIo = {
    ...tty,
    writeStderr: (value) => stderr.push(value),
    writeStdout: (value) => stdout.push(value),
  };
  return {
    io,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rkm-cli-runtime-"));
  temporaryDirectories.push(path);
  return path;
}

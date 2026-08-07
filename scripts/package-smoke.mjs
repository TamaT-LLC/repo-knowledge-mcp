/* global URL, clearTimeout, process, setTimeout */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedTools = [
  "add_knowledge",
  "get_knowledge",
  "get_rules",
  "ingest_pr",
  "prepare_distillation",
  "search_knowledge",
  "submit_distillation",
  "update_knowledge",
];

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rkm-package-smoke-"));
  try {
    const packDirectory = join(temporaryRoot, "pack");
    const installDirectory = join(temporaryRoot, "install");
    const runtimeDirectory = join(temporaryRoot, "runtime");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
    ]);

    const packed = await runNpm(
      ["pack", "--json", "--pack-destination", packDirectory],
      repositoryRoot,
    );
    const packResult = parsePackResult(packed.stdout);
    verifyPackageContents(packResult.files);
    const tarball = join(packDirectory, basename(packResult.filename));
    await access(tarball, constants.R_OK);

    await writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "repo-knowledge-package-smoke", private: true })}\n`,
      "utf8",
    );
    await runNpm(
      ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball],
      installDirectory,
    );

    const installedPackagePath = join(
      installDirectory,
      "node_modules",
      "repo-knowledge-mcp",
      "package.json",
    );
    const installedPackage = JSON.parse(
      await readFile(installedPackagePath, "utf8"),
    );
    assert(
      installedPackage.mcpName === "io.github.tamat-llc/repo-knowledge",
      "installed package lost mcpName",
    );
    assert(
      JSON.stringify(installedPackage.mcpProtocolVersions) ===
        JSON.stringify(["2025-11-25", "2026-07-28"]),
      "installed package has unexpected MCP protocol metadata",
    );

    const executable = join(
      installDirectory,
      "node_modules",
      ".bin",
      "repo-knowledge",
    );
    await access(executable, constants.X_OK);
    const environment = {
      ...process.env,
      REPO_KNOWLEDGE_HOME: join(runtimeDirectory, ".repo-knowledge"),
    };
    const help = await run(executable, ["--help"], {
      cwd: installDirectory,
      env: environment,
    });
    assert(help.stderr === "", "CLI help wrote to stderr");
    assert(
      help.stdout.startsWith("Usage: repo-knowledge <command> [options]"),
      "installed CLI help was not available",
    );

    const client = new JsonRpcProcess(
      executable,
      installDirectory,
      environment,
    );
    await client.start();
    try {
      const initialized = await client.request("initialize", {
        capabilities: {},
        clientInfo: { name: "package-smoke", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      });
      assert(
        initialized.error === undefined,
        "installed MCP initialize failed",
      );
      assert(
        asRecord(asRecord(initialized.result).serverInfo).name ===
          "repo-knowledge",
        "installed MCP returned unexpected serverInfo",
      );
      client.notify("notifications/initialized", {});
      const listed = await client.request("tools/list", {});
      assert(listed.error === undefined, "installed MCP tools/list failed");
      const tools = asRecord(listed.result).tools;
      assert(
        Array.isArray(tools),
        "installed MCP tools/list returned no tools",
      );
      const toolNames = tools.map((tool) => String(asRecord(tool).name)).sort();
      assert(
        JSON.stringify(toolNames) === JSON.stringify(expectedTools),
        "installed MCP exposed an unexpected tool set",
      );
    } finally {
      await client.close();
    }
    assert(
      client.invalidStdout.length === 0,
      "MCP stdout contained non-JSON data",
    );
    assert(client.stderr === "", "MCP server wrote unexpected startup stderr");
    await access(
      join(runtimeDirectory, ".repo-knowledge", "config.json"),
      constants.R_OK,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          cli_help: true,
          mcp_tools: expectedTools.length,
          package: `${packResult.name}@${packResult.version}`,
          package_files: packResult.files.length,
          stdio_json_rpc: true,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`PACKAGE_SMOKE_FAILED: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function parsePackResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error("npm pack did not emit machine-readable JSON", {
      cause: error,
    });
  }
  const result = Array.isArray(value) ? value[0] : undefined;
  if (
    result === undefined ||
    typeof result.filename !== "string" ||
    typeof result.name !== "string" ||
    typeof result.version !== "string" ||
    !Array.isArray(result.files)
  ) {
    throw new TypeError("npm pack returned an invalid result envelope");
  }
  return result;
}

function verifyPackageContents(files) {
  const entries = new Map(
    files.map((entry) => [String(asRecord(entry).path), asRecord(entry)]),
  );
  for (const path of [
    "README.md",
    "SECURITY.md",
    "dist/bin.js",
    "dist/index.d.ts",
    "dist/index.js",
    "package.json",
    "prompts/distill.md",
  ]) {
    assert(entries.has(path), `packed artifact is missing ${path}`);
  }
  for (const path of entries.keys()) {
    assert(
      path.startsWith("dist/") ||
        path.startsWith("prompts/") ||
        [
          "LICENSE",
          "LICENSE.md",
          "README.md",
          "SECURITY.md",
          "package.json",
        ].includes(path),
      `packed artifact contains unexpected path ${path}`,
    );
  }
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run("npm", args, { cwd, env: process.env })
    : run(process.execPath, [npmExecPath, ...args], {
        cwd,
        env: process.env,
      });
}

function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stderr, stdout });
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed (${String(code)}, ${String(signal)}): ${stderr.trim()}`,
        ),
      );
    });
  });
}

class JsonRpcProcess {
  invalidStdout = [];
  stderr = "";

  #child;
  #nextId = 0;
  #pending = new Map();
  #stdoutBuffer = "";

  constructor(command, cwd, env) {
    this.#child = spawn(command, [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    this.#child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.#child.once("exit", (code, signal) => {
      const error = new Error(
        `installed MCP exited (${String(code)}, ${String(signal)})`,
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  start() {
    if (this.#child.pid !== undefined) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      this.#child.once("spawn", resolvePromise);
      this.#child.once("error", rejectPromise);
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  request(method, params) {
    const id = ++this.#nextId;
    const result = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`timed out waiting for ${method}`));
      }, 10_000);
      this.#pending.set(id, {
        reject: rejectPromise,
        resolve: resolvePromise,
        timer,
      });
    });
    this.#send({ id, jsonrpc: "2.0", method, params });
    return result;
  }

  close() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.resolve();
    }
    this.#child.stdin.end();
    return new Promise((resolvePromise) => {
      let forceTimer;
      const terminateTimer = setTimeout(() => {
        this.#child.kill("SIGTERM");
        forceTimer = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
      }, 2_000);
      this.#child.once("close", () => {
        clearTimeout(terminateTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        resolvePromise();
      });
    });
  }

  #send(message) {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consumeStdout(chunk) {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        this.invalidStdout.push(line);
        continue;
      }
      const id = message.id;
      if (typeof id !== "number") continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.resolve(message);
    }
  }
}

function asRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main();

/* global URL, clearTimeout, process, setTimeout */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_PACKAGE_NAME,
  createPackageArtifact,
  scanPackageSourceFiles,
  validatePackageManifest,
  validatePublicApiManifest,
  validateRootDeclaration,
} from "./package-artifact-gate.mjs";
import { STABLE_ROOT_RUNTIME_EXPORTS } from "./public-api-inventory.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const smokeRepository = "owner/repository";
const expectedTools = [
  "add_knowledge",
  "get_knowledge",
  "get_rules",
  "ingest_pr",
  "prepare_distillation",
  "record_outcome",
  "search_knowledge",
  "stats",
  "submit_distillation",
  "sync_repo",
  "update_knowledge",
];
// M2 commands the installed CLI help must document for cron operators.
const expectedHelpCommands = ["sync [repo]", "stats [repo]", "distill [repo]"];

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rkm-package-smoke-"));
  try {
    const packDirectory = join(temporaryRoot, "pack");
    const installDirectory = join(temporaryRoot, "install");
    const runtimeDirectory = join(temporaryRoot, "runtime");
    const binDirectory = join(temporaryRoot, "bin");
    const workspaceDirectory = join(temporaryRoot, "workspace");
    const setupRunnerPath = join(installDirectory, "setup-runner.mjs");
    const typeSmokePath = join(installDirectory, "public-api-smoke.mts");
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
      mkdir(binDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
    ]);
    const fakeGhPath = join(binDirectory, "gh");
    await writeFile(fakeGhPath, fakeGhSource(), "utf8");
    await chmod(fakeGhPath, 0o755);

    let installSpec;
    let packageSource;
    let expectedName = options.expectedName ?? EXPECTED_PACKAGE_NAME;
    let expectedVersion = options.expectedVersion;
    if (options.tarball !== undefined) {
      installSpec = resolve(options.tarball);
      packageSource = "tarball";
      await access(installSpec, constants.R_OK);
    } else if (options.packageSpec !== undefined) {
      installSpec = options.packageSpec;
      packageSource = "registry";
    } else {
      const artifact = await createPackageArtifact({
        cwd: repositoryRoot,
        packDestination: packDirectory,
      });
      installSpec = artifact.tarball;
      packageSource = "local-pack";
      expectedName = artifact.packResult.name;
      expectedVersion = artifact.packResult.version;
    }

    await writeFile(
      join(installDirectory, "package.json"),
      `${JSON.stringify({ name: "repo-knowledge-package-smoke", private: true })}\n`,
      "utf8",
    );
    await runNpm(
      ["install", "--no-audit", "--no-fund", "--loglevel=error", installSpec],
      installDirectory,
    );

    const installedPackagePath = join(
      installDirectory,
      "node_modules",
      expectedName,
      "package.json",
    );
    const installedPackage = JSON.parse(
      await readFile(installedPackagePath, "utf8"),
    );
    assert(
      installedPackage.name === expectedName,
      `installed package name was ${String(installedPackage.name)}, expected ${expectedName}`,
    );
    if (expectedVersion !== undefined) {
      assert(
        installedPackage.version === expectedVersion,
        `installed package version was ${String(installedPackage.version)}, expected ${expectedVersion}`,
      );
    }
    const installedPackageRoot = join(
      installDirectory,
      "node_modules",
      expectedName,
    );
    validatePublicApiManifest(installedPackage);
    validateRootDeclaration(
      await readFile(join(installedPackageRoot, "dist", "index.d.ts"), "utf8"),
    );
    await writeFile(setupRunnerPath, setupRunnerSource(expectedName), "utf8");
    await writeFile(
      typeSmokePath,
      publicApiTypeSmokeSource(expectedName),
      "utf8",
    );
    const installedFiles = await collectPackageFiles(installedPackageRoot);
    validatePackageManifest({
      files: installedFiles,
      name: installedPackage.name,
      version: installedPackage.version,
    });
    await scanPackageSourceFiles(installedPackageRoot, installedFiles);
    assert(
      installedPackage.mcpName === "io.github.tamat-llc/repo-knowledge",
      "installed package lost mcpName",
    );
    assert(
      JSON.stringify(installedPackage.mcpProtocolVersions) ===
        JSON.stringify(["2025-11-25", "2026-07-28"]),
      "installed package has unexpected MCP protocol metadata",
    );
    await run(
      process.execPath,
      [
        join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--target",
        "ES2022",
        typeSmokePath,
      ],
      { cwd: installDirectory, env: process.env },
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
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
      REPO_KNOWLEDGE_HOME: join(runtimeDirectory, ".repo-knowledge"),
    };
    const help = await run(executable, ["--help"], {
      cwd: workspaceDirectory,
      env: environment,
    });
    assert(help.stderr === "", "CLI help wrote to stderr");
    assert(
      help.stdout.startsWith("Usage: repo-knowledge <command> [options]"),
      "installed CLI help was not available",
    );
    for (const command of expectedHelpCommands) {
      assert(
        help.stdout.includes(command),
        `installed CLI help does not document ${command}`,
      );
    }
    const setupHelp = await run(executable, ["setup", "--help"], {
      cwd: workspaceDirectory,
      env: environment,
    });
    assert(
      setupHelp.stderr === "" && setupHelp.stdout.includes("setup [repo]"),
      "installed guided setup help was not available",
    );
    const reviewHelp = await run(executable, ["review", "--help"], {
      cwd: workspaceDirectory,
      env: environment,
    });
    assert(
      reviewHelp.stderr === "" && reviewHelp.stdout.includes("review [repo]"),
      "installed batch review help was not available",
    );

    const humanSetup = await run(process.execPath, [setupRunnerPath], {
      cwd: workspaceDirectory,
      env: {
        ...environment,
        REPO_KNOWLEDGE_HOME: join(runtimeDirectory, ".repo-knowledge-human"),
        RKM_SETUP_OUTPUT: "human",
      },
    });
    assert(humanSetup.stderr === "", "installed guided setup wrote to stderr");
    assert(
      humanSetup.stdout.includes("Setup complete") &&
        humanSetup.stdout.includes(`Repository  ${smokeRepository}`) &&
        humanSetup.stdout.includes("provider off · host-assisted off") &&
        humanSetup.stdout.includes("Next"),
      `installed guided setup returned no human summary: ${humanSetup.stdout}`,
    );

    const setup = await run(process.execPath, [setupRunnerPath], {
      cwd: workspaceDirectory,
      env: {
        ...environment,
        RKM_SETUP_OUTPUT: "json",
      },
    });
    assert(setup.stderr === "", "installed guided setup wrote to stderr");
    assert(
      setup.stdout.trim().split("\n").length === 1 &&
        setup.stdout.startsWith('{"config_path":'),
      `installed guided setup returned no result document: ${setup.stdout}`,
    );
    const setupResult = asRecord(JSON.parse(setup.stdout.trim()));
    const setupTransmission = asRecord(setupResult.transmission);
    const setupSync = asRecord(asRecord(setupResult.initial_sync).summary);
    assert(
      asRecord(setupResult.repository).name === smokeRepository &&
        setupTransmission.provider === false &&
        setupTransmission.host_assisted === false &&
        setupSync.jobs_created === 1,
      "installed guided setup did not complete with safe transmission defaults",
    );

    const client = new JsonRpcProcess(
      executable,
      workspaceDirectory,
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

      // The M2 surfaces stay callable end to end through the packaged
      // artifact: sync_repo resolves the repository through the local gh
      // stand-in, and stats plus get_rules read the freshly created store.
      const synced = await callTool(client, "sync_repo", {
        repo: smokeRepository,
      });
      const syncStructured = asRecord(synced.structuredContent);
      assert(
        syncStructured.ok === true &&
          asRecord(syncStructured.result).discovered === 0,
        "installed sync_repo did not report an empty incremental window",
      );
      const stats = await callTool(client, "stats", { repo: smokeRepository });
      const statsStructured = asRecord(stats.structuredContent);
      assert(
        statsStructured.stats_schema_version === 1 &&
          asRecord(statsStructured.knowledge).total === 0 &&
          asRecord(statsStructured.outcomes).total === 0,
        "installed stats did not return versioned zero aggregates",
      );
      const rules = await callTool(client, "get_rules", {
        file_paths: ["src/index.ts"],
        repo: smokeRepository,
      });
      const rulesStructured = asRecord(rules.structuredContent);
      const readiness = asRecord(rulesStructured.readiness);
      assert(
        rulesStructured.matched_count === 0 &&
          Array.isArray(rulesStructured.rules) &&
          rulesStructured.rules.length === 0 &&
          readiness.state === "learning" &&
          typeof readiness.next_action === "string" &&
          readiness.next_action.length > 0,
        "installed get_rules did not report the initialized learning state",
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
    await assertPathMissing(join(workspaceDirectory, ".repo-knowledge"));

    process.stdout.write(
      `${JSON.stringify(
        {
          cli_help: true,
          guided_setup: true,
          guided_setup_help: true,
          guided_setup_human_summary: true,
          guided_setup_json: true,
          m3_readiness: "learning",
          m2_tool_calls: ["sync_repo", "stats", "get_rules"],
          mcp_tools: expectedTools.length,
          node_api_import: true,
          node_api_types: true,
          package: `${String(installedPackage.name)}@${String(installedPackage.version)}`,
          package_files: installedFiles.length,
          package_source: packageSource,
          review_help: true,
          stdio_json_rpc: true,
          workspace_clean: true,
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

async function callTool(client, name, toolArguments) {
  const reply = await client.request("tools/call", {
    arguments: toolArguments,
    name,
  });
  assert(reply.error === undefined, `installed MCP ${name} call failed`);
  const result = asRecord(reply.result);
  assert(result.isError !== true, `installed MCP ${name} returned an error`);
  return result;
}

/**
 * Deterministic `gh` stand-in for the packaged smoke: it resolves the smoke
 * repository and reports an empty updated-PR window, so the M2 tool calls
 * complete without any network access or GitHub credential.
 */
function fakeGhSource() {
  return `#!/usr/bin/env node
const REPOSITORY = ${JSON.stringify(smokeRepository)};
const REPO_ID = "R_package_smoke_repository";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 0.0.0-package-smoke\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.exit(0);
}
if (args[0] !== "api" || args[1] !== "graphql") {
  process.stderr.write("fake gh: unsupported invocation\\n");
  process.exit(1);
}
let query = "";
for (let index = 2; index < args.length; index += 1) {
  const flag = args[index];
  if (flag !== "-f" && flag !== "-F") continue;
  const pair = args[index + 1] ?? "";
  index += 1;
  if (pair.startsWith("query=")) query = pair.slice("query=".length);
}
const closedPage = { endCursor: null, hasNextPage: false };
const pullRequest = {
  baseRefOid: "base-package-smoke",
  headRefOid: "head-package-smoke",
  id: "PR_package_smoke",
  mergedAt: "2026-08-08T01:00:00.000Z",
  number: 1,
  title: "Package smoke review",
  updatedAt: "2026-08-08T00:00:00.000Z",
};
let data;
if (query.includes("query RepoKnowledgeDoctor")) {
  data = { viewer: { login: "package-smoke" } };
} else if (query.includes("query ResolveRepository")) {
  data = { repository: { id: REPO_ID, nameWithOwner: REPOSITORY } };
} else if (query.includes("query ListUpdatedPullRequests")) {
  data = {
    repository: {
      id: REPO_ID,
      nameWithOwner: REPOSITORY,
      pullRequests: {
        nodes: [
          {
            id: pullRequest.id,
            number: pullRequest.number,
            updatedAt: pullRequest.updatedAt,
          },
        ],
        pageInfo: closedPage,
      },
    },
  };
} else if (query.includes("query FetchPullRequestSnapshot")) {
  data = {
    repository: {
      id: REPO_ID,
      nameWithOwner: REPOSITORY,
      pullRequest: {
        ...pullRequest,
        reviewThreads: {
          nodes: [
            {
              comments: {
                nodes: [
                  {
                    author: {
                      __typename: "User",
                      id: "U_package_smoke_reviewer",
                      login: "package-smoke-reviewer",
                    },
                    authorAssociation: "MEMBER",
                    body: "Validate input before using the repository helper.",
                    createdAt: pullRequest.updatedAt,
                    diffHunk: "@@ -1 +1 @@",
                    id: "C_package_smoke_review",
                    updatedAt: pullRequest.updatedAt,
                    url: "https://github.com/" + REPOSITORY + "/pull/1#discussion_r1",
                  },
                ],
                pageInfo: closedPage,
              },
              id: "RT_package_smoke",
              isOutdated: false,
              isResolved: true,
              path: "src/index.ts",
            },
          ],
          pageInfo: closedPage,
        },
        reviews: { nodes: [], pageInfo: closedPage },
      },
    },
  };
} else if (query.includes("query ValidatePullRequestSnapshot")) {
  data = {
    nodes: [
      {
        __typename: "PullRequestReviewThread",
        comments: { totalCount: 1 },
        id: "RT_package_smoke",
        isOutdated: false,
        isResolved: true,
        path: "src/index.ts",
      },
    ],
    repository: {
      id: REPO_ID,
      pullRequest: {
        ...pullRequest,
        reviewThreads: { totalCount: 1 },
        reviews: { totalCount: 0 },
      },
    },
  };
} else {
  process.stderr.write("fake gh: unsupported query\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ data }) + "\\n");
`;
}

function setupRunnerSource(packageName) {
  return `import * as experimentalApi from ${JSON.stringify(`${packageName}/experimental`)};
import * as stableApi from ${JSON.stringify(packageName)};

const actualRootExports = Object.keys(stableApi).sort();
const expectedRootExports = ${JSON.stringify([...STABLE_ROOT_RUNTIME_EXPORTS].sort())};
if (JSON.stringify(actualRootExports) !== JSON.stringify(expectedRootExports)) {
  throw new Error("packed root API does not match the reviewed runtime inventory");
}
if (typeof experimentalApi.CanonicalTransactionStore !== "function") {
  throw new Error("packed experimental compatibility subpath is unavailable");
}
const { runDefaultRepoKnowledgeCli } = stableApi;

const confirmations = [];
const jsonOutput = process.env.RKM_SETUP_OUTPUT === "json";
const exitCode = await runDefaultRepoKnowledgeCli({
  argv: [
    "setup",
    ${JSON.stringify(smokeRepository)},
    ...(jsonOutput ? ["--json"] : []),
    "--since",
    "2026-01-01T00:00:00Z",
  ],
  io: {
    close() {},
    async confirm(request) {
      if (request.defaultValue !== false) {
        throw new Error("package smoke only accepts safe-default setup prompts");
      }
      confirmations.push(request.id);
      return false;
    },
    async input() {
      throw new Error("safe-default setup must not request text input");
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    writeStderr(value) {
      process.stderr.write(value);
    },
    writeStdout(value) {
      process.stdout.write(value);
    },
  },
});
if (exitCode !== 0 || confirmations.length < 2) process.exitCode = 1;
`;
}

function publicApiTypeSmokeSource(packageName) {
  return `import {
  runDefaultRepoKnowledgeCli,
  type RunDefaultRepoKnowledgeCliOptions,
} from ${JSON.stringify(packageName)};
import type {
  CanonicalTransactionStore as ExperimentalCanonicalTransactionStore,
} from ${JSON.stringify(`${packageName}/experimental`)};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type RootModule = typeof import(${JSON.stringify(packageName)});
type RootRuntimeExportsAreExact = Assert<
  Equal<keyof RootModule, "runDefaultRepoKnowledgeCli">
>;

const options: RunDefaultRepoKnowledgeCliOptions = { argv: ["--help"] };
const exitCode: Promise<number> = runDefaultRepoKnowledgeCli(options);
declare const experimentalStore: ExperimentalCanonicalTransactionStore;
void exitCode;
void experimentalStore;
type KeepExactAssertion = RootRuntimeExportsAreExact;

// @ts-expect-error Internal implementation symbols are not stable root API.
import type { CanonicalTransactionStore } from ${JSON.stringify(packageName)};
`;
}

async function collectPackageFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split("\\").join("/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      assert(
        entry.isFile(),
        `installed package contains non-file entry ${path}`,
      );
      const metadata = await lstat(absolutePath);
      files.push({ mode: metadata.mode & 0o777, path, size: metadata.size });
    }
  }
  await visit(root);
  return files;
}

async function assertPathMissing(path) {
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if (asErrorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error(`package smoke created forbidden workspace data at ${path}`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--tarball" && value !== undefined) {
      options.tarball = value;
      index += 1;
    } else if (argument === "--package-spec" && value !== undefined) {
      options.packageSpec = value;
      index += 1;
    } else if (argument === "--expected-name" && value !== undefined) {
      options.expectedName = value;
      index += 1;
    } else if (argument === "--expected-version" && value !== undefined) {
      options.expectedVersion = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${String(argument)}`);
    }
  }
  assert(
    options.tarball === undefined || options.packageSpec === undefined,
    "choose either --tarball or --package-spec",
  );
  return options;
}

function asErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
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
          `${command} ${args.join(" ")} failed (${String(code)}, ${String(signal)}): stdout=${stdout.trim()} stderr=${stderr.trim()}`,
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

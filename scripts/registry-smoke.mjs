/* global URL, process, setTimeout */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_PACKAGE_NAME } from "./package-artifact-gate.mjs";

export const REGISTRY_SMOKE_REPORT_KIND = "repo_knowledge_npm_registry_smoke";
export const REGISTRY_SMOKE_REPORT_SCHEMA_VERSION = 1;

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stableVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function validateRegistrySmokeRequest(input) {
  if (input.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`registry smoke package must be ${EXPECTED_PACKAGE_NAME}`);
  }
  if (!stableVersionPattern.test(input.version)) {
    throw new Error("registry smoke requires an exact stable version");
  }
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new Error("registry smoke attempts must be a positive integer");
  }
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 0) {
    throw new Error("registry smoke interval must be a non-negative integer");
  }
  return input;
}

export function parsePublishedVersion(stdout) {
  const value = JSON.parse(stdout);
  if (typeof value !== "string" || !stableVersionPattern.test(value)) {
    throw new TypeError("npm view returned an invalid published version");
  }
  return value;
}

async function runRegistrySmoke(input) {
  const request = validateRegistrySmokeRequest(input);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rkm-registry-smoke-"));
  const environment = {
    ...process.env,
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  };
  try {
    const observedVersion = await waitForPublishedVersion(request, environment);
    if (observedVersion !== request.version) {
      throw new Error(
        `registry returned ${observedVersion}, expected ${request.version}`,
      );
    }
    const packageSpec = `${request.name}@${request.version}`;
    const npx = await run(
      "npx",
      ["--yes", `--package=${packageSpec}`, "--", "repo-knowledge", "--help"],
      { cwd: repositoryRoot, env: environment },
    );
    if (
      npx.stderr !== "" ||
      !npx.stdout.startsWith("Usage: repo-knowledge <command> [options]")
    ) {
      throw new Error("exact-version npx CLI help failed");
    }
    const packageSmoke = await run(
      process.execPath,
      [
        join(repositoryRoot, "scripts", "package-smoke.mjs"),
        "--package-spec",
        packageSpec,
        "--expected-name",
        request.name,
        "--expected-version",
        request.version,
      ],
      { cwd: repositoryRoot, env: environment },
    );
    const smokeReport = JSON.parse(packageSmoke.stdout);
    if (
      smokeReport.package !== packageSpec ||
      smokeReport.package_source !== "registry" ||
      smokeReport.stdio_json_rpc !== true ||
      smokeReport.workspace_clean !== true
    ) {
      throw new Error("registry package smoke returned an invalid report");
    }
    return {
      exact_version_npx: true,
      name: request.name,
      package_smoke: true,
      report_kind: REGISTRY_SMOKE_REPORT_KIND,
      schema_version: REGISTRY_SMOKE_REPORT_SCHEMA_VERSION,
      status: "pass",
      version: request.version,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function waitForPublishedVersion(request, environment) {
  let lastDiagnostics = "not queried";
  for (let attempt = 1; attempt <= request.attempts; attempt += 1) {
    const result = await runNpmAllowFailure(
      ["view", `${request.name}@${request.version}`, "version", "--json"],
      repositoryRoot,
      environment,
    );
    if (result.code === 0) return parsePublishedVersion(result.stdout);
    lastDiagnostics = `${result.stdout}\n${result.stderr}`.trim();
    if (!/\bE404\b|\b404 Not Found\b/u.test(lastDiagnostics)) {
      throw new Error(
        `npm view failed (${String(result.code)}): ${lastDiagnostics}`,
      );
    }
    if (attempt < request.attempts) await delay(request.intervalMs);
  }
  throw new Error(
    `package did not become visible after ${String(request.attempts)} attempts: ${lastDiagnostics}`,
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function parseArguments(argv) {
  const options = { attempts: 18, intervalMs: 10_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--name" && value !== undefined) {
      options.name = value;
      index += 1;
    } else if (argument === "--version" && value !== undefined) {
      options.version = value;
      index += 1;
    } else if (argument === "--attempts" && value !== undefined) {
      options.attempts = Number(value);
      index += 1;
    } else if (argument === "--interval-ms" && value !== undefined) {
      options.intervalMs = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${String(argument)}`);
    }
  }
  if (options.name === undefined || options.version === undefined) {
    throw new Error("--name and --version are required");
  }
  return options;
}

function runNpmAllowFailure(args, cwd, environment) {
  const npmExecPath = environment.npm_execpath;
  return npmExecPath === undefined
    ? runAllowFailure("npm", args, { cwd, env: environment })
    : runAllowFailure(process.execPath, [npmExecPath, ...args], {
        cwd,
        env: environment,
      });
}

async function run(command, args, options) {
  const result = await runAllowFailure(command, args, options);
  if (result.code === 0) return result;
  throw new Error(
    `${command} ${args.join(" ")} failed (${String(result.code)}, ${String(result.signal)}): ${result.stderr.trim()}`,
  );
}

function runAllowFailure(command, args, options) {
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
      resolvePromise({ code, signal, stderr, stdout });
    });
  });
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const report = await runRegistrySmoke(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          failures: [message],
          report_kind: REGISTRY_SMOKE_REPORT_KIND,
          schema_version: REGISTRY_SMOKE_REPORT_SCHEMA_VERSION,
          status: "fail",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

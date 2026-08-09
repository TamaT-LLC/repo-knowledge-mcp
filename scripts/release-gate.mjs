/* global URL, process */

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_PACKAGE_NAME } from "./package-artifact-gate.mjs";

export const RELEASE_GATE_REPORT_KIND = "repo_knowledge_npm_release_gate";
export const RELEASE_GATE_REPORT_SCHEMA_VERSION = 2;
export const EXPECTED_REPOSITORY_URL =
  "git+https://github.com/TamaT-LLC/repo-knowledge-mcp.git";
export const EXPECTED_REGISTRY = "https://registry.npmjs.org/";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stableVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

export function validateReleaseMetadata(input) {
  const failures = [];
  const packageDocument = input.packageDocument;
  const repository = asRecord(packageDocument.repository);
  const publishConfig = asRecord(packageDocument.publishConfig);

  check(
    packageDocument.name === EXPECTED_PACKAGE_NAME,
    `package name must be ${EXPECTED_PACKAGE_NAME}`,
    failures,
  );
  check(
    typeof packageDocument.version === "string" &&
      stableVersionPattern.test(packageDocument.version),
    "package version must be a stable SemVer triplet",
    failures,
  );
  const version =
    typeof packageDocument.version === "string"
      ? packageDocument.version
      : "<invalid>";
  check(
    input.tag === `v${version}`,
    `release tag must be v${version}`,
    failures,
  );
  check(
    commitPattern.test(input.expectedCommit),
    "expected commit must be a full SHA",
    failures,
  );
  check(
    input.headCommit === input.expectedCommit,
    "HEAD does not match the release commit",
    failures,
  );
  check(
    input.tagCommit === input.expectedCommit,
    "tag does not resolve to the release commit",
    failures,
  );
  check(
    input.mainContainsCommit,
    "release commit is not reachable from origin/main",
    failures,
  );
  check(input.worktreeClean, "release worktree is not clean", failures);
  check(
    packageDocument.private !== true,
    "package must not be private",
    failures,
  );
  check(
    isPublishableLicense(packageDocument.license),
    "package.json license must be an explicit publishable license value",
    failures,
  );
  check(
    input.licenseFile === "LICENSE" || input.licenseFile === "LICENSE.md",
    "release commit must contain a non-empty regular LICENSE or LICENSE.md file",
    failures,
  );
  check(
    repository.type === "git" && repository.url === EXPECTED_REPOSITORY_URL,
    `package repository must be ${EXPECTED_REPOSITORY_URL}`,
    failures,
  );
  check(
    input.repositoryVisibility === "public",
    "repository must be public for npm provenance",
    failures,
  );
  check(
    publishConfig.access === "public",
    "publishConfig.access must be public",
    failures,
  );
  check(
    publishConfig.registry === EXPECTED_REGISTRY,
    `publishConfig.registry must be ${EXPECTED_REGISTRY}`,
    failures,
  );
  check(
    isSupportedReleaseNode(input.nodeVersion),
    "release Node must be 22.14.0+ or 24+",
    failures,
  );
  check(
    compareVersions(input.npmVersion, "11.5.1") >= 0,
    "trusted publishing requires npm 11.5.1+",
    failures,
  );
  check(
    input.registryVersion === null,
    `${EXPECTED_PACKAGE_NAME}@${version} is already present in the registry`,
    failures,
  );

  return {
    commit: input.expectedCommit,
    failures,
    license:
      typeof packageDocument.license === "string"
        ? packageDocument.license
        : null,
    license_file: input.licenseFile ?? null,
    name: EXPECTED_PACKAGE_NAME,
    node_version: input.nodeVersion,
    npm_version: input.npmVersion,
    registry_status: input.registryVersion === null ? "available" : "published",
    report_kind: RELEASE_GATE_REPORT_KIND,
    repository_visibility: input.repositoryVisibility,
    schema_version: RELEASE_GATE_REPORT_SCHEMA_VERSION,
    status: failures.length === 0 ? "pass" : "fail",
    tag: input.tag,
    version,
  };
}

export function isPublishableLicense(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized === value &&
    normalized.toUpperCase() !== "UNLICENSED"
  );
}

export async function findReleaseLicenseFile(cwd) {
  for (const name of ["LICENSE", "LICENSE.md"]) {
    try {
      const metadata = await lstat(join(cwd, name));
      if (metadata.isFile() && metadata.size > 0) return name;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

export function isSupportedReleaseNode(value) {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const parsed = parseVersion(normalized);
  if (parsed === null) return false;
  if (parsed.major === 22) {
    return parsed.minor > 14 || (parsed.minor === 14 && parsed.patch >= 0);
  }
  return parsed.major >= 24;
}

export function compareVersions(left, right) {
  const first = parseVersion(left);
  const second = parseVersion(right);
  if (first === null || second === null) return Number.NaN;
  return (
    first.major - second.major ||
    first.minor - second.minor ||
    first.patch - second.patch
  );
}

export function parseRegistryVersion(stdout) {
  const value = JSON.parse(stdout);
  if (typeof value === "string") return value;
  throw new TypeError("npm view returned an invalid version");
}

async function inspectRelease(options) {
  const packageDocument = JSON.parse(
    await readFile(resolve(options.cwd, "package.json"), "utf8"),
  );
  const head = await run("git", ["rev-parse", "HEAD"], options.cwd);
  const tag = await run(
    "git",
    ["rev-list", "-n", "1", options.tag],
    options.cwd,
  );
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    options.cwd,
  );
  const ancestor = await runAllowFailure(
    "git",
    ["merge-base", "--is-ancestor", head.stdout.trim(), options.mainRef],
    options.cwd,
  );
  const npmVersion = await runNpm(["--version"], options.cwd);
  const registryVersion = await readRegistryVersion(
    String(packageDocument.name),
    String(packageDocument.version),
    options.cwd,
  );
  const licenseFile = await findReleaseLicenseFile(options.cwd);
  return validateReleaseMetadata({
    expectedCommit: options.commit,
    headCommit: head.stdout.trim(),
    licenseFile,
    mainContainsCommit: ancestor.code === 0,
    nodeVersion: process.version,
    npmVersion: npmVersion.stdout.trim(),
    packageDocument,
    registryVersion,
    repositoryVisibility: options.repositoryVisibility,
    tag: options.tag,
    tagCommit: tag.stdout.trim(),
    worktreeClean: status.stdout.trim().length === 0,
  });
}

async function readRegistryVersion(name, version, cwd) {
  const result = await runNpmAllowFailure(
    ["view", `${name}@${version}`, "version", "--json"],
    cwd,
  );
  if (result.code === 0) return parseRegistryVersion(result.stdout);
  const diagnostics = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b|\b404 Not Found\b/u.test(diagnostics)) return null;
  throw new Error(
    `npm registry availability check failed (${String(result.code)}): ${diagnostics.trim()}`,
  );
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function parseArguments(argv) {
  const options = { cwd: repositoryRoot, mainRef: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--tag" && value !== undefined) {
      options.tag = value;
      index += 1;
    } else if (argument === "--commit" && value !== undefined) {
      options.commit = value;
      index += 1;
    } else if (argument === "--main-ref" && value !== undefined) {
      options.mainRef = value;
      index += 1;
    } else if (argument === "--repository-visibility" && value !== undefined) {
      options.repositoryVisibility = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${String(argument)}`);
    }
  }
  if (
    options.tag === undefined ||
    options.commit === undefined ||
    options.repositoryVisibility === undefined
  ) {
    throw new Error(
      "--tag, --commit, and --repository-visibility are required",
    );
  }
  return options;
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run("npm", args, cwd)
    : run(process.execPath, [npmExecPath, ...args], cwd);
}

function runNpmAllowFailure(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? runAllowFailure("npm", args, cwd)
    : runAllowFailure(process.execPath, [npmExecPath, ...args], cwd);
}

async function run(command, args, cwd) {
  const result = await runAllowFailure(command, args, cwd);
  if (result.code === 0) return result;
  throw new Error(
    `${command} ${args.join(" ")} failed (${String(result.code)}, ${String(result.signal)}): ${result.stderr.trim()}`,
  );
}

function runAllowFailure(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function check(condition, message, failures) {
  if (!condition) failures.push(message);
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const report = await inspectRelease(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          failures: [message],
          report_kind: RELEASE_GATE_REPORT_KIND,
          schema_version: RELEASE_GATE_REPORT_SCHEMA_VERSION,
          status: "fail",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

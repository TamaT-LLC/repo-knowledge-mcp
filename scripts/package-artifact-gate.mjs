/* global TextDecoder, URL, process */

import { spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ARTIFACT_REPORT_KIND =
  "repo_knowledge_npm_package_artifact_gate";
export const PACKAGE_ARTIFACT_REPORT_SCHEMA_VERSION = 1;
export const EXPECTED_PACKAGE_NAME = "repo-knowledge-mcp";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requiredPackagePaths = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/bin.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/stdio-bin.js",
  "package.json",
  "prompts/distill.md",
];
const allowedRootPaths = new Set([
  "LICENSE",
  "LICENSE.md",
  "README.md",
  "SECURITY.md",
  "package.json",
  "prompts/distill.md",
]);
const forbiddenSegments = new Set([
  ".env",
  ".git",
  ".repo-knowledge",
  "coverage",
  "events",
  "fixtures",
  "knowledge",
  "node_modules",
  "raw",
  "test",
  "tests",
  "transactions",
]);
const forbiddenBasenames = [
  /^\.npmrc$/u,
  /(?:^|\.)index\.sqlite(?:$|\.)/u,
  /\.(?:db|key|p12|pfx|pem|sqlite|sqlite3)$/u,
];
const secretPatterns = [
  {
    name: "private_key",
    pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  },
  {
    name: "npm_auth_token_config",
    pattern: /(?:^|\n)\s*(?:\/\/registry\.npmjs\.org\/)?\s*:_authToken\s*=/u,
  },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/u },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];

export async function createPackageArtifact(options = {}) {
  const cwd = resolve(options.cwd ?? repositoryRoot);
  const packDestination = resolve(
    options.packDestination ?? join(cwd, "release-artifacts"),
  );
  await mkdir(packDestination, { recursive: true });

  const dryRun = parsePackResult(
    (
      await runNpm(
        ["pack", "--dry-run", "--json"],
        cwd,
        options.environment ?? process.env,
      )
    ).stdout,
  );
  validatePackageManifest(dryRun);
  await scanPackageSourceFiles(cwd, dryRun.files);

  const packed = parsePackResult(
    (
      await runNpm(
        ["pack", "--json", "--pack-destination", packDestination],
        cwd,
        options.environment ?? process.env,
      )
    ).stdout,
  );
  validatePackageManifest(packed);
  assertEquivalentManifests(dryRun, packed);

  const tarball = join(packDestination, basename(packed.filename));
  const report = {
    entry_count: packed.files.length,
    file_allowlist: "dist-js-dts-plus-explicit-root-files-v1",
    integrity: packed.integrity,
    name: packed.name,
    report_kind: PACKAGE_ARTIFACT_REPORT_KIND,
    schema_version: PACKAGE_ARTIFACT_REPORT_SCHEMA_VERSION,
    secret_patterns_checked: secretPatterns.map((entry) => entry.name),
    shasum: packed.shasum,
    status: "pass",
    tarball,
    version: packed.version,
  };
  if (options.reportPath !== undefined) {
    const reportPath = resolve(options.reportPath);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (options.githubOutputPath !== undefined) {
    await appendFile(
      options.githubOutputPath,
      [
        `name=${packed.name}`,
        `report=${resolve(options.reportPath ?? "")}`,
        `tarball=${tarball}`,
        `version=${packed.version}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  return { packResult: packed, report, tarball };
}

export function parsePackResult(stdout) {
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
    typeof result.integrity !== "string" ||
    typeof result.name !== "string" ||
    typeof result.shasum !== "string" ||
    typeof result.version !== "string" ||
    !Array.isArray(result.files)
  ) {
    throw new TypeError("npm pack returned an invalid result envelope");
  }
  return {
    filename: result.filename,
    files: result.files.map((entry) => {
      const record = asRecord(entry);
      if (
        typeof record.path !== "string" ||
        typeof record.size !== "number" ||
        typeof record.mode !== "number"
      ) {
        throw new TypeError("npm pack returned an invalid file entry");
      }
      return { mode: record.mode, path: record.path, size: record.size };
    }),
    integrity: result.integrity,
    name: result.name,
    shasum: result.shasum,
    version: result.version,
  };
}

export function validatePackageManifest(result) {
  if (result.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`unexpected package name ${result.name}`);
  }
  const paths = result.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("packed artifact contains duplicate paths");
  }
  for (const path of requiredPackagePaths) {
    assert(paths.includes(path), `packed artifact is missing ${path}`);
  }
  for (const path of paths) validatePackagePath(path);
}

export function validatePackagePath(path) {
  assert(path.length > 0, "packed artifact contains an empty path");
  assert(!isAbsolute(path), `packed artifact contains absolute path ${path}`);
  assert(!path.includes("\\"), `packed artifact path is not POSIX: ${path}`);
  const segments = path.split("/");
  assert(
    !segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ),
    `packed artifact contains unsafe path ${path}`,
  );
  assert(
    !segments.some((segment) => forbiddenSegments.has(segment)),
    `packed artifact contains forbidden local-data path ${path}`,
  );
  const fileName = segments.at(-1) ?? "";
  assert(
    !forbiddenBasenames.some((pattern) => pattern.test(fileName)),
    `packed artifact contains forbidden file ${path}`,
  );
  const allowed =
    allowedRootPaths.has(path) ||
    /^dist\/[a-z0-9-]+(?:\.d\.ts|\.js)$/u.test(path);
  assert(allowed, `packed artifact contains unexpected path ${path}`);
}

export function findSecretPattern(text) {
  return secretPatterns.find((entry) => entry.pattern.test(text))?.name ?? null;
}

export async function scanPackageSourceFiles(root, files) {
  const absoluteRoot = resolve(root);
  for (const entry of files) {
    validatePackagePath(entry.path);
    const absolutePath = resolve(absoluteRoot, entry.path);
    const relativePath = relative(absoluteRoot, absolutePath);
    assert(
      relativePath !== "" &&
        !relativePath.startsWith("..") &&
        !isAbsolute(relativePath),
      `packed artifact path escapes repository root: ${entry.path}`,
    );
    const metadata = await lstat(absolutePath);
    assert(
      metadata.isFile(),
      `packed artifact source is not a regular file: ${entry.path}`,
    );
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(absolutePath),
    );
    const finding = findSecretPattern(content);
    assert(
      finding === null,
      `packed artifact file ${entry.path} matched secret pattern ${String(finding)}`,
    );
  }
}

export function assertEquivalentManifests(dryRun, packed) {
  const fields = ["name", "version", "shasum", "integrity"];
  for (const field of fields) {
    assert(
      dryRun[field] === packed[field],
      `npm pack dry-run and tarball disagree on ${field}`,
    );
  }
  const normalize = (files) =>
    [...files].sort((left, right) => left.path.localeCompare(right.path));
  assert(
    JSON.stringify(normalize(dryRun.files)) ===
      JSON.stringify(normalize(packed.files)),
    "npm pack dry-run and tarball file manifests differ",
  );
}

function runNpm(args, cwd, environment) {
  const npmExecPath = environment.npm_execpath;
  return npmExecPath === undefined
    ? run("npm", args, { cwd, env: environment })
    : run(process.execPath, [npmExecPath, ...args], {
        cwd,
        env: environment,
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

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--pack-destination" && value !== undefined) {
      options.packDestination = value;
      index += 1;
    } else if (argument === "--report" && value !== undefined) {
      options.reportPath = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument ${String(argument)}`);
    }
  }
  return options;
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

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await createPackageArtifact({
      ...options,
      ...(process.env.GITHUB_OUTPUT === undefined
        ? {}
        : { githubOutputPath: process.env.GITHUB_OUTPUT }),
    });
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          failures: [message],
          report_kind: PACKAGE_ARTIFACT_REPORT_KIND,
          schema_version: PACKAGE_ARTIFACT_REPORT_SCHEMA_VERSION,
          status: "fail",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

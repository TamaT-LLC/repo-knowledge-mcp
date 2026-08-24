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
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXPECTED_PACKAGE_EXPORTS,
  STABLE_ROOT_API,
  STABLE_ROOT_RUNTIME_EXPORTS,
} from "./public-api-inventory.mjs";

export const PACKAGE_ARTIFACT_REPORT_KIND =
  "repo_knowledge_npm_package_artifact_gate";
export const PACKAGE_ARTIFACT_REPORT_SCHEMA_VERSION = 2;
export const EXPECTED_PACKAGE_NAME = "@tamat-llc/repo-knowledge-mcp";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requiredPackagePaths = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/bin.js",
  "dist/experimental.d.ts",
  "dist/experimental.js",
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
  await validatePublicApiArtifact(cwd);
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
    file_allowlist: "dist-js-dts-plus-explicit-root-files-v3",
    integrity: packed.integrity,
    name: packed.name,
    report_kind: PACKAGE_ARTIFACT_REPORT_KIND,
    schema_version: PACKAGE_ARTIFACT_REPORT_SCHEMA_VERSION,
    secret_patterns_checked: secretPatterns.map((entry) => entry.name),
    shasum: packed.shasum,
    stable_root_runtime_exports: STABLE_ROOT_RUNTIME_EXPORTS,
    stable_root_type_exports: STABLE_ROOT_API.filter(
      ({ kind }) => kind === "type",
    ).map(({ name }) => name),
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

export async function validatePublicApiArtifact(root) {
  const absoluteRoot = resolve(root);
  const packageDocument = JSON.parse(
    await readFile(join(absoluteRoot, "package.json"), "utf8"),
  );
  validatePublicApiManifest(packageDocument);

  const declaration = await readFile(
    join(absoluteRoot, "dist", "index.d.ts"),
    "utf8",
  );
  validateRootDeclaration(declaration);

  const rootModuleUrl = pathToFileURL(join(absoluteRoot, "dist", "index.js"));
  rootModuleUrl.searchParams.set(
    "artifact-gate",
    `${String(process.pid)}-${String(Date.now())}`,
  );
  const rootModule = await import(rootModuleUrl.href);
  validateRootRuntimeExports(Object.keys(rootModule));
}

export function validatePublicApiManifest(packageDocument) {
  const document = asRecord(packageDocument);
  assert(
    document.main === "./dist/index.js",
    "package main must target the stable root JavaScript declaration",
  );
  assert(
    document.types === "./dist/index.d.ts",
    "package types must target the stable root type declaration",
  );
  assert(
    canonicalJson(document.exports) === canonicalJson(EXPECTED_PACKAGE_EXPORTS),
    "package exports do not match the reviewed public API inventory",
  );
}

export function parseRootDeclaration(declaration) {
  assert(typeof declaration === "string", "root declaration must be text");
  const exportPattern = /export\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";/gu;
  const entries = [];
  for (const match of declaration.matchAll(exportPattern)) {
    entries.push(...parseRootExportMatch(match));
  }
  const remainder = declaration
    .replace(exportPattern, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .trim();
  assert(
    remainder.length === 0,
    "root declaration contains an unreviewed declaration or export form",
  );
  return entries;
}

export function validateRootDeclaration(declaration) {
  const actual = parseRootDeclaration(declaration)
    .map(publicApiEntryKey)
    .sort();
  const expected = STABLE_ROOT_API.map(publicApiEntryKey).sort();
  assert(
    canonicalJson(actual) === canonicalJson(expected),
    `root declaration exports ${actual.join(", ")}, expected ${expected.join(", ")}`,
  );
}

export function validateRootRuntimeExports(exports) {
  assert(Array.isArray(exports), "root runtime exports must be an array");
  const actual = [...exports].sort();
  const expected = [...STABLE_ROOT_RUNTIME_EXPORTS].sort();
  assert(
    canonicalJson(actual) === canonicalJson(expected),
    `root runtime exports ${actual.join(", ")}, expected ${expected.join(", ")}`,
  );
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
    /^dist\/(?:[a-z0-9-]+\/)?[a-z0-9-]+(?:\.d\.ts|\.js)$/u.test(path);
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

function publicApiEntryKey({ kind, name, source }) {
  return `${kind}:${name}:${source}`;
}

function parseRootExportMatch(match) {
  const source = match[2];
  assert(source !== undefined, "root declaration export lost its source");
  return (match[1] ?? "")
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .map((token) => parseRootExportSpecifier(token, source));
}

function parseRootExportSpecifier(token, source) {
  const kind = token.startsWith("type ") ? "type" : "value";
  const name = token.replace(/^type\s+/u, "");
  assert(
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name),
    `unsupported root declaration export ${name}`,
  );
  return { kind, name, source };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(sortJsonValue));
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

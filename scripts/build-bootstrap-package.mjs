#!/usr/bin/env node

/* global URL, process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EXPECTED_PACKAGE_NAME } from "./package-artifact-gate.mjs";

export const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
export const BOOTSTRAP_TAG = "bootstrap";
export const BOOTSTRAP_INVENTORY_SCHEMA =
  "repo-knowledge-npm-bootstrap-package-v1";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repository = Object.freeze({
  type: "git",
  url: "git+https://github.com/TamaT-LLC/repo-knowledge-mcp.git",
});
const expectedFiles = new Set(["LICENSE", "README.md", "package.json"]);

export function createBootstrapManifest(name) {
  if (name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(`unexpected bootstrap package name: ${name}`);
  }
  return {
    name,
    version: BOOTSTRAP_VERSION,
    description:
      "Inert bootstrap placeholder for the official repo-knowledge-mcp npm distribution",
    files: ["LICENSE", "README.md"],
    license: "MIT",
    repository,
    homepage: "https://github.com/TamaT-LLC/repo-knowledge-mcp#readme",
    bugs: {
      url: "https://github.com/TamaT-LLC/repo-knowledge-mcp/issues",
    },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
      tag: BOOTSTRAP_TAG,
    },
  };
}

export async function buildBootstrapPackage(options) {
  const outputPath = resolve(options.output);
  await assertPathMissing(outputPath);

  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".repo-knowledge-bootstrap-"));
  const staging = join(temporary, "staging");
  const resultDirectory = join(temporary, "result");
  await mkdir(staging);
  await mkdir(resultDirectory);

  try {
    await writeFile(
      join(staging, "package.json"),
      `${JSON.stringify(createBootstrapManifest(EXPECTED_PACKAGE_NAME), null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(staging, "README.md"), bootstrapReadme(), "utf8");
    await copyFile(join(repositoryRoot, "LICENSE"), join(staging, "LICENSE"));

    const packed = parsePackResult(
      runNpm([
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        resultDirectory,
        staging,
      ]),
    );
    assertPackResult(packed);
    const tarballPath = join(resultDirectory, packed.filename);
    const inventory = {
      schema_version: BOOTSTRAP_INVENTORY_SCHEMA,
      repository: "TamaT-LLC/repo-knowledge-mcp",
      npm_tag: BOOTSTRAP_TAG,
      package: {
        file_count: packed.entryCount,
        integrity: packed.integrity,
        name: packed.name,
        sha256: await sha256(tarballPath),
        shasum: packed.shasum,
        size: packed.size,
        tarball: packed.filename,
        unpacked_size: packed.unpackedSize,
        version: packed.version,
      },
      version: BOOTSTRAP_VERSION,
    };
    await writeFile(
      join(resultDirectory, "npm-bootstrap-package.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
      "utf8",
    );
    await assertOutputClosure(resultDirectory, packed.filename);
    await rename(resultDirectory, outputPath);
    return inventory;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

function bootstrapReadme() {
  return `# ${EXPECTED_PACKAGE_NAME}\n\nThis inert package reserves the official npm name for repo-knowledge-mcp.\nIt contains no executable, dependency, or lifecycle script and is not a supported release.\nInstall an exact stable version of [${EXPECTED_PACKAGE_NAME}](https://www.npmjs.com/package/${EXPECTED_PACKAGE_NAME}) after it is published.\n`;
}

function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--output" ||
    argv[1].length === 0 ||
    argv[1].startsWith("--")
  ) {
    throw new Error("usage: build-bootstrap-package.mjs --output <directory>");
  }
  return { output: argv[1] };
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const commandArguments =
    npmExecPath === undefined ? args : [npmExecPath, ...args];
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArguments.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function parsePackResult(stdout) {
  const results = JSON.parse(stdout);
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error("npm pack returned an invalid result envelope");
  }
  return results[0];
}

function assertPackResult(result) {
  if (
    result.name !== EXPECTED_PACKAGE_NAME ||
    result.version !== BOOTSTRAP_VERSION ||
    typeof result.filename !== "string" ||
    typeof result.integrity !== "string" ||
    typeof result.shasum !== "string" ||
    typeof result.size !== "number" ||
    typeof result.unpackedSize !== "number" ||
    typeof result.entryCount !== "number" ||
    !Array.isArray(result.files)
  ) {
    throw new Error("npm pack returned invalid bootstrap metadata");
  }
  const actualFiles = new Set(result.files.map((entry) => entry.path));
  if (
    result.files.length !== expectedFiles.size ||
    actualFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !actualFiles.has(file))
  ) {
    throw new Error("bootstrap tarball contains an unexpected file closure");
  }
}

async function assertPathMissing(path) {
  try {
    await lstat(path);
    throw new Error(`npm bootstrap output already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertOutputClosure(output, tarball) {
  const actualFiles = new Set(await readdir(output));
  const outputFiles = new Set(["npm-bootstrap-package.json", tarball]);
  if (
    actualFiles.size !== outputFiles.size ||
    [...outputFiles].some((file) => !actualFiles.has(file))
  ) {
    throw new Error("npm bootstrap output contains an unexpected file closure");
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", rejectPromise);
    input.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  try {
    const inventory = await buildBootstrapPackage(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(
      `built inert bootstrap package ${inventory.package.name}@${inventory.package.version}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`npm bootstrap package build failed: ${message}\n`);
    process.exitCode = 1;
  }
}

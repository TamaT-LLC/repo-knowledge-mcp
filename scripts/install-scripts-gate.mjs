#!/usr/bin/env node

/* global URL, process */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function validateInstallScriptApprovals(packageDocument, lockDocument) {
  const packageRecord = asRecord(packageDocument, "package.json");
  const lockRecord = asRecord(lockDocument, "package-lock.json");
  const approvals = asRecord(packageRecord.allowScripts, "allowScripts");
  const lockedPackages = asRecord(lockRecord.packages, "package-lock packages");
  const installScripts = [];

  for (const [path, value] of Object.entries(lockedPackages)) {
    const metadata = asRecord(value, `lockfile entry ${path || "<root>"}`);
    if (metadata.hasInstallScript !== true) continue;
    if (typeof metadata.version !== "string") {
      throw new TypeError(
        `install-script package ${path} has no exact version`,
      );
    }
    installScripts.push({
      name:
        typeof metadata.name === "string"
          ? metadata.name
          : packageNameFromLockPath(path),
      version: metadata.version,
    });
  }

  const approved = [];
  const denied = [];
  const failures = [];
  for (const dependency of installScripts) {
    const exact = `${dependency.name}@${dependency.version}`;
    if (approvals[exact] === true) {
      approved.push(exact);
    } else if (approvals[dependency.name] === false) {
      denied.push(dependency.name);
    } else {
      failures.push(`missing decision for ${exact}`);
    }
  }

  const installedExact = new Set(
    installScripts.map(({ name, version }) => `${name}@${version}`),
  );
  const installedNames = new Set(installScripts.map(({ name }) => name));
  for (const [key, decision] of Object.entries(approvals)) {
    if (decision === true) {
      if (!installedExact.has(key)) {
        failures.push(`stale or unpinned approval ${key}`);
      }
    } else if (decision === false) {
      if (!installedNames.has(key)) failures.push(`stale denial ${key}`);
    } else {
      failures.push(`decision for ${key} must be boolean`);
    }
  }

  if (failures.length !== 0) {
    throw new Error(
      `install-script approval gate failed:\n${[...new Set(failures)]
        .sort()
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    );
  }
  return {
    approved: [...new Set(approved)].sort(),
    denied: [...new Set(denied)].sort(),
  };
}

function packageNameFromLockPath(path) {
  const marker = "node_modules/";
  const markerIndex = path.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new TypeError(
      `cannot derive package name from lockfile path ${path}`,
    );
  }
  const segments = path.slice(markerIndex + marker.length).split("/");
  const name = segments[0]?.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  if (name === undefined || name === "" || name === "@") {
    throw new TypeError(
      `cannot derive package name from lockfile path ${path}`,
    );
  }
  return name;
}

function asRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

async function run() {
  const [packageDocument, lockDocument] = await Promise.all([
    readFile(resolve(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(repositoryRoot, "package-lock.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const result = validateInstallScriptApprovals(packageDocument, lockDocument);
  process.stdout.write(
    `install-script decisions verified: ${result.approved.length} approved, ${result.denied.length} denied\n`,
  );
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

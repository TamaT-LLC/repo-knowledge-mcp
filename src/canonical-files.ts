import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { compareCodeUnits } from "./canonical.js";
import { KnowledgeStoreInvalidError } from "./knowledge-document.js";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  "coverage",
  "dist",
  "knowledge",
  "node_modules",
  "transactions",
]);

/** Finds every canonical JSONL file while excluding journals and projections. */
export async function findCanonicalJsonlPaths(
  repositoryRoot: string,
  directory = repositoryRoot,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries.sort((a, b) =>
    compareCodeUnits(a.name, b.name),
  )) {
    if (
      directory === repositoryRoot &&
      SKIPPED_DIRECTORY_NAMES.has(entry.name)
    ) {
      continue;
    }
    if (
      entry.name === "index.sqlite" ||
      entry.name.startsWith("index.sqlite-")
    ) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(
        ...(await findCanonicalJsonlPaths(repositoryRoot, absolutePath)),
      );
      continue;
    }
    if (entry.name.endsWith(".jsonl")) {
      const targetPath = toPosixRelative(repositoryRoot, absolutePath);
      if (!entry.isFile()) {
        throw new KnowledgeStoreInvalidError(
          targetPath,
          "canonical JSONL entries must be regular files",
        );
      }
      result.push(targetPath);
    }
  }

  return result.sort(compareCodeUnits);
}

function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

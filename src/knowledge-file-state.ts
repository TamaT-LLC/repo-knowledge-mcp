import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { compareCodeUnits, sha256Jcs } from "./canonical.js";

export interface KnowledgeFileHash {
  readonly path: string;
  readonly sha256: string;
}

export interface KnowledgeFileState {
  readonly files: readonly KnowledgeFileHash[];
  readonly stateSha256: string;
}

export interface KnowledgeFile {
  readonly content: string;
  readonly path: string;
}

export interface KnowledgeSnapshot {
  readonly files: readonly KnowledgeFile[];
  readonly state: KnowledgeFileState;
}

export interface KnowledgeProjection<T> {
  readonly knowledgeFileState: KnowledgeFileState;
  readonly value: T;
}

export type KnowledgeProjectionBuilder<T> = (
  files: readonly KnowledgeFile[],
  state: KnowledgeFileState,
) => Promise<T> | T;

/** Raised when the files backing a projection no longer match its snapshot. */
export class ProjectionStaleError extends Error {
  readonly code = "PROJECTION_STALE";

  constructor(
    readonly expected: KnowledgeFileState,
    readonly actual: KnowledgeFileState,
  ) {
    super("The knowledge projection is stale");
    this.name = "ProjectionStaleError";
  }
}

/**
 * Reads every knowledge/*.md file as bytes, hashes the complete set, and only
 * then exposes decoded Markdown to callers. The hashes and projection content
 * therefore describe the same captured bytes without relying on file stats.
 */
export async function readKnowledgeSnapshot(
  repositoryRoot: string,
): Promise<KnowledgeSnapshot> {
  const rawFiles = await readAllKnowledgeMarkdownBytes(repositoryRoot);
  const state = createKnowledgeFileState(rawFiles);
  const files = rawFiles.map(({ bytes, path }) => ({
    content: bytes.toString("utf8"),
    path,
  }));

  return { files, state };
}

/** Computes knowledge_file_state from the content of every knowledge/*.md. */
export async function computeKnowledgeFileState(
  repositoryRoot: string,
): Promise<KnowledgeFileState> {
  return createKnowledgeFileState(
    await readAllKnowledgeMarkdownBytes(repositoryRoot),
  );
}

/** Builds a projection only after the complete pre-read hash set is known. */
export async function buildKnowledgeProjection<T>(
  repositoryRoot: string,
  builder: KnowledgeProjectionBuilder<T>,
): Promise<KnowledgeProjection<T>> {
  const snapshot = await readKnowledgeSnapshot(repositoryRoot);
  const value = await builder(snapshot.files, snapshot.state);

  return { knowledgeFileState: snapshot.state, value };
}

/** Checks projection currency using full content hashes, never stat metadata. */
export async function isProjectionCurrent(
  repositoryRoot: string,
  expected: KnowledgeFileState,
): Promise<boolean> {
  const actual = await computeKnowledgeFileState(repositoryRoot);
  return actual.stateSha256 === expected.stateSha256;
}

/** Ensures a projection is current and returns the newly verified state. */
export async function ensureProjectionCurrent(
  repositoryRoot: string,
  expected: KnowledgeFileState,
): Promise<KnowledgeFileState> {
  const actual = await computeKnowledgeFileState(repositoryRoot);
  if (actual.stateSha256 !== expected.stateSha256) {
    throw new ProjectionStaleError(expected, actual);
  }

  return actual;
}

interface RawKnowledgeFile {
  readonly bytes: Buffer;
  readonly path: string;
}

async function readAllKnowledgeMarkdownBytes(
  repositoryRoot: string,
): Promise<RawKnowledgeFile[]> {
  const absoluteRoot = resolve(repositoryRoot);
  const knowledgeDirectory = join(absoluteRoot, "knowledge");
  let entries;

  try {
    entries = await readdir(knowledgeDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const markdownPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(knowledgeDirectory, entry.name))
    .sort(compareCodeUnits);

  return Promise.all(
    markdownPaths.map(async (absolutePath) => ({
      bytes: await readFile(absolutePath),
      path: toPosixPath(relative(absoluteRoot, absolutePath)),
    })),
  );
}

function createKnowledgeFileState(
  rawFiles: readonly RawKnowledgeFile[],
): KnowledgeFileState {
  const files = rawFiles.map(({ bytes, path }) => ({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));

  return {
    files,
    stateSha256: sha256Jcs(files),
  };
}

function toPosixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

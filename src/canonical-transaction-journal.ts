import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { compareCodeUnits } from "./canonical.js";
import { pathExists } from "./durable-fs.js";
import { isPosixFileLockHeld } from "./posix-file-lock.js";

/** Journal layout shared by CanonicalTransactionStore and read-only observers. */
export const TRANSACTIONS_DIRECTORY = "transactions";
export const TRANSACTION_MANIFEST_FILE = "manifest.json";
export const TRANSACTION_COMMITTED_FILE = "COMMITTED";
/** The repository writer lock every canonical commit and recovery holds. */
export const CANONICAL_WRITE_LOCK_NAME = ".write.lock";

/**
 * Lists the transaction journal without recovering it. An entry is a commit
 * that is in progress, was interrupted, or was rejected before its manifest
 * (see observeCanonicalWriter). A missing journal is empty.
 */
export async function readTransactionJournal(
  repositoryRoot: string,
): Promise<Dirent[]> {
  try {
    return await readdir(join(repositoryRoot, TRANSACTIONS_DIRECTORY), {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface CanonicalWriterObservation {
  /** Journal entries recovery would apply or refuse, sorted. */
  readonly prepared: readonly string[];
  /**
   * Whether recovery can resolve every prepared entry by itself: each is a
   * directory with a manifest. A stray file or a COMMITTED marker without a
   * manifest makes recovery refuse with UNRECOVERABLE_TRANSACTION.
   */
  readonly recoverable: boolean;
  /**
   * `idle`: nothing prepared, so canonical files are safe to read.
   * `writing`: prepared entries under a live writer lock.
   * `abandoned`: prepared entries with the lock free or its owner dead.
   */
  readonly state: "abandoned" | "idle" | "writing";
}

/**
 * Read-only view of the store's commit protocol: a commit holds the writer
 * lock from staging through cleanup and applies canonical files only after
 * its manifest exists. A staging directory without a manifest or COMMITTED
 * marker was never applied (a commit rejected by its precondition leaves
 * one), and recovery deletes it, so it is not prepared. Anything else in the
 * journal, including a non-directory, is.
 */
export async function observeCanonicalWriter(
  repositoryRoot: string,
): Promise<CanonicalWriterObservation> {
  const prepared: string[] = [];
  let recoverable = true;
  for (const entry of await readTransactionJournal(repositoryRoot)) {
    if (!entry.isDirectory()) {
      prepared.push(entry.name);
      recoverable = false;
      continue;
    }
    const directory = join(repositoryRoot, TRANSACTIONS_DIRECTORY, entry.name);
    const manifest = await pathExists(
      join(directory, TRANSACTION_MANIFEST_FILE),
    );
    if (
      manifest ||
      (await pathExists(join(directory, TRANSACTION_COMMITTED_FILE)))
    ) {
      prepared.push(entry.name);
      recoverable &&= manifest;
    }
  }
  if (prepared.length === 0) return { prepared, recoverable, state: "idle" };
  const held = await isPosixFileLockHeld(
    join(repositoryRoot, CANONICAL_WRITE_LOCK_NAME),
  );
  return {
    prepared: prepared.sort(compareCodeUnits),
    recoverable,
    state: held ? "writing" : "abandoned",
  };
}

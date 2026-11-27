import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import { constants, type Stats } from "node:fs";

import { CanonicalStoreError } from "./canonical-path-validation.js";
import { computeByteSha256 } from "./knowledge-document.js";

export async function writeDurable(
  path: string,
  bytes: Uint8Array,
  flags: "wx",
): Promise<void> {
  const handle = await open(path, flags, 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendDurable(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error("write() made no progress");
    }
    offset += bytesWritten;
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function hashFileOrNull(path: string): Promise<string | null> {
  try {
    return computeByteSha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function assertRegularFileOrMissing(
  path: string,
  displayPath: string,
): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) {
      throw new CanonicalStoreError(
        "CANONICAL_LOG_CORRUPT",
        `${displayPath}.corrupt must be a regular file`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * `lstat` that never follows a symlink: `null` when the path is missing, its
 * stats when it is a real file or directory of the expected kind, and
 * `unsafe()` thrown for a symlink or any other type.
 */
export async function lstatNoFollow(
  path: string,
  kind: "directory" | "file",
  unsafe: () => Error,
): Promise<Stats | null> {
  let status: Stats;
  try {
    status = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // lstat reports a symlink as neither a file nor a directory.
  if (!(kind === "file" ? status.isFile() : status.isDirectory())) {
    throw unsafe();
  }
  return status;
}

/**
 * Opens a regular file for reading without following a symlink, so checks
 * on the returned stats and the reads that follow see the same file.
 * O_NONBLOCK keeps a FIFO in its place from blocking the open. `null` when
 * the file is missing; `unsafe()` for a symlink or any other type. The
 * caller closes the handle.
 */
export async function openRegularFileNoFollow(
  path: string,
  unsafe: () => Error,
): Promise<{ readonly handle: FileHandle; readonly status: Stats } | null> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw unsafe();
    throw error;
  }
  const status = await handle.stat();
  if (!status.isFile()) {
    await handle.close();
    throw unsafe();
  }
  return { handle, status };
}

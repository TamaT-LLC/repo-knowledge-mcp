import { lstat, open, readFile } from "node:fs/promises";

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

import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { canonicalizeJson } from "./canonical.js";

interface LockContents {
  readonly acquired_at: string;
  readonly pid: number;
  readonly token: string;
}

export class FileLockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT";

  constructor(readonly lockPath: string) {
    super(`Timed out waiting for ${lockPath}`);
    this.name = "FileLockTimeoutError";
  }
}

/** Runs a callback while holding a durable, stale-PID-aware POSIX lock file. */
export async function withPosixFileLock<T>(
  lockPath: string,
  timeoutMs: number,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(lockPath, timeoutMs);
  try {
    return await callback();
  } finally {
    await releaseLock(lockPath, lock);
  }
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
): Promise<LockContents> {
  const deadline = Date.now() + timeoutMs;
  const contents: LockContents = {
    acquired_at: new Date().toISOString(),
    pid: process.pid,
    token: randomUUID(),
  };
  const bytes = Buffer.from(`${canonicalizeJson(contents)}\n`, "utf8");

  for (;;) {
    try {
      await writeLockFile(lockPath, bytes);
      await syncDirectory(dirname(lockPath));
      return contents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await lockOwnerIsDead(lockPath)) {
      try {
        await unlink(lockPath);
        await syncDirectory(dirname(lockPath));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath);
    await delay(10);
  }
}

async function releaseLock(
  lockPath: string,
  expected: LockContents,
): Promise<void> {
  try {
    const actual = JSON.parse(
      decodeUtf8(lockPath, await readFile(lockPath)),
    ) as Partial<LockContents>;
    if (actual.token !== expected.token) return;
    await unlink(lockPath);
    await syncDirectory(dirname(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function lockOwnerIsDead(lockPath: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(
      decodeUtf8(lockPath, await readFile(lockPath)),
    ) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;
  const pid = value.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function writeLockFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesWritten <= 0) throw new Error("write() made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function decodeUtf8(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson } from "./canonical.js";
import { IsoDateTimeSchema } from "./domain-schemas.js";
import { SyncCursorSchema } from "./sync-cursor.js";

export const SYNC_CHECKPOINT_SCHEMA_VERSION = 1;
export const SYNC_CHECKPOINT_DIRECTORY = "sync";
export const SYNC_CHECKPOINT_FILE_NAME = "checkpoint.json";

/**
 * Durable per-repository resume point for incremental sync. The envelope is
 * versioned independently of the cursor so either layer can migrate.
 */
export const SyncCheckpointSchema = z
  .object({
    cursor: SyncCursorSchema,
    schema_version: z.literal(SYNC_CHECKPOINT_SCHEMA_VERSION),
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export type SyncCheckpoint = z.infer<typeof SyncCheckpointSchema>;

export type SyncCheckpointErrorCode =
  | "SYNC_CHECKPOINT_INVALID"
  | "SYNC_CHECKPOINT_VERSION_UNSUPPORTED";

export class SyncCheckpointError extends Error {
  constructor(
    readonly code: SyncCheckpointErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SyncCheckpointError";
  }
}

/**
 * Persists the sync checkpoint as repository-local state via atomic replace
 * (temporary file, fsync, rename, directory fsync). Callers serialize access
 * through the repository sync lock; the checkpoint is never derived state, so
 * a reader always observes either the previous or the next committed boundary.
 */
export class SyncCheckpointStore {
  readonly checkpointPath: string;

  private readonly directoryPath: string;

  constructor(repositoryRoot: string) {
    this.directoryPath = join(
      resolve(repositoryRoot),
      SYNC_CHECKPOINT_DIRECTORY,
    );
    this.checkpointPath = join(this.directoryPath, SYNC_CHECKPOINT_FILE_NAME);
  }

  async read(): Promise<SyncCheckpoint | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.checkpointPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(this.checkpointPath, bytes)) as unknown;
    } catch (error) {
      throw new SyncCheckpointError(
        "SYNC_CHECKPOINT_INVALID",
        `${this.checkpointPath} is not valid JSON`,
        { cause: error },
      );
    }
    if (
      isRecord(value) &&
      "schema_version" in value &&
      value.schema_version !== SYNC_CHECKPOINT_SCHEMA_VERSION
    ) {
      throw new SyncCheckpointError(
        "SYNC_CHECKPOINT_VERSION_UNSUPPORTED",
        `sync checkpoint schema_version must be ${String(SYNC_CHECKPOINT_SCHEMA_VERSION)}`,
      );
    }
    const parsed = SyncCheckpointSchema.safeParse(value);
    if (!parsed.success) {
      throw new SyncCheckpointError(
        "SYNC_CHECKPOINT_INVALID",
        parsed.error.message,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async write(checkpoint: SyncCheckpoint): Promise<SyncCheckpoint> {
    const parsed = SyncCheckpointSchema.parse(checkpoint);
    await mkdir(this.directoryPath, { mode: 0o700, recursive: true });
    const bytes = Buffer.from(`${canonicalizeJson(parsed)}\n`, "utf8");
    const temporaryPath = `${this.checkpointPath}.tmp`;
    await unlinkIfPresent(temporaryPath);
    await writeDurable(temporaryPath, bytes);
    await rename(temporaryPath, this.checkpointPath);
    await fsyncDirectory(this.directoryPath);
    return parsed;
  }
}

async function writeDurable(path: string, bytes: Uint8Array): Promise<void> {
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

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function decodeUtf8(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SyncCheckpointError(
      "SYNC_CHECKPOINT_INVALID",
      `${path} is not valid UTF-8`,
      { cause: error },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

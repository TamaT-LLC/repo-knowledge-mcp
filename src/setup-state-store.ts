import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson } from "./canonical.js";
import {
  IsoDateTimeSchema,
  RepositoryIdSchema,
  RepositoryNameSchema,
} from "./domain-schemas.js";
import { createDomainId } from "./ids.js";
import { withPosixFileLock } from "./posix-file-lock.js";

export const SetupPhaseSchema = z.enum([
  "configured",
  "synced",
  "trust-configured",
  "complete",
]);

export const SetupStateSchema = z
  .object({
    created_at: IsoDateTimeSchema,
    initial_since: IsoDateTimeSchema.nullable(),
    phase: SetupPhaseSchema,
    repo_id: RepositoryIdSchema,
    repository: RepositoryNameSchema,
    schema_version: z.literal(1),
    updated_at: IsoDateTimeSchema,
    workspace_path: z.string().min(1).nullable(),
  })
  .strict();

export type SetupState = z.infer<typeof SetupStateSchema>;

export type SetupStateStoreErrorCode =
  "SETUP_STATE_INVALID" | "SETUP_STATE_IO_ERROR" | "SETUP_STATE_PATH_UNSAFE";

export class SetupStateStoreError extends Error {
  constructor(
    readonly code: SetupStateStoreErrorCode,
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${path}: ${message}`, options);
    this.name = "SetupStateStoreError";
  }
}

/** Durable per-repository setup checkpoint used to resume interrupted setup. */
export class SetupStateStore {
  readonly path: string;

  constructor(
    repositoryRoot: string,
    private readonly lockTimeoutMs = 5_000,
  ) {
    this.path = join(resolve(repositoryRoot), "setup-state.json");
  }

  async read(): Promise<SetupState | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
      await assertRegularFile(this.path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      if (error instanceof SetupStateStoreError) throw error;
      throw ioError(this.path, error);
    }

    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch (error) {
      throw new SetupStateStoreError(
        "SETUP_STATE_INVALID",
        this.path,
        "state must be valid UTF-8 JSON",
        { cause: error },
      );
    }
    const parsed = SetupStateSchema.safeParse(value);
    if (!parsed.success) {
      throw new SetupStateStoreError(
        "SETUP_STATE_INVALID",
        this.path,
        parsed.error.message,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  async write(state: SetupState): Promise<SetupState> {
    const parsed = SetupStateSchema.parse(state);
    return withPosixFileLock(
      `${this.path}.lock`,
      this.lockTimeoutMs,
      async () => {
        const temporaryPath = join(
          dirname(this.path),
          `.${basename(this.path)}.${createDomainId("transaction")}.tmp`,
        );
        const bytes = Buffer.from(`${canonicalizeJson(parsed)}\n`, "utf8");
        try {
          await assertExistingTargetSafe(this.path);
          const handle = await open(temporaryPath, "wx", 0o600);
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporaryPath, this.path);
          await chmod(this.path, 0o600);
          await syncDirectory(dirname(this.path));
        } catch (error) {
          if (error instanceof SetupStateStoreError) throw error;
          throw ioError(this.path, error);
        } finally {
          await unlink(temporaryPath).catch((error: unknown) => {
            if (!hasErrorCode(error, "ENOENT")) throw error;
          });
        }
        return parsed;
      },
    );
  }
}

async function assertExistingTargetSafe(path: string): Promise<void> {
  try {
    await assertRegularFile(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SetupStateStoreError(
      "SETUP_STATE_PATH_UNSAFE",
      path,
      "setup state must be a regular file, not a symlink",
    );
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

function ioError(path: string, error: unknown): SetupStateStoreError {
  return new SetupStateStoreError(
    "SETUP_STATE_IO_ERROR",
    path,
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

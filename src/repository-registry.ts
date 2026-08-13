import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import { RepositoryNameSchema } from "./domain-schemas.js";
import { computeByteSha256 } from "./knowledge-document.js";
import { withPosixFileLock } from "./posix-file-lock.js";

export interface RepositoryRegistryEntry {
  readonly aliases: readonly string[];
  readonly currentName: string;
  readonly path: string;
}

export interface ResolvedRepository extends RepositoryRegistryEntry {
  readonly absolutePath: string;
  readonly repoId: string;
}

export interface RegisterRepositoryRequest {
  readonly aliases?: readonly string[];
  readonly currentName: string;
  readonly repoId: string;
}

interface RepositoryRegistryDocument {
  readonly repositories: Readonly<Record<string, RepositoryRegistryEntry>>;
}

interface RegistrySnapshot {
  readonly bytes: Buffer | null;
  readonly document: RepositoryRegistryDocument;
}

export type RepositoryRegistryErrorCode =
  | "INVALID_REPOSITORY_REGISTRY"
  | "REGISTRY_CONFLICT"
  | "REPOSITORY_NAME_AMBIGUOUS";

export class RepositoryRegistryError extends Error {
  constructor(
    readonly code: RepositoryRegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryRegistryError";
  }
}

export interface RepositoryRegistryOptions {
  readonly lockTimeoutMs?: number;
}

/** Rename-stable repo ID registry protected by one global writer lock. */
export class RepositoryRegistry {
  readonly registryRoot: string;

  private readonly lockTimeoutMs: number;

  constructor(registryRoot: string, options: RepositoryRegistryOptions = {}) {
    this.registryRoot = resolve(registryRoot);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async register(
    request: RegisterRepositoryRequest,
  ): Promise<ResolvedRepository> {
    validateRepositoryIdentity(request.repoId, request.currentName);
    validateRepositoryAliases(request.aliases ?? []);
    await this.ensureLayout();
    return withPosixFileLock(
      join(this.registryRoot, ".registry.lock"),
      this.lockTimeoutMs,
      async () => {
        const snapshot = await this.readSnapshot();
        const previous = findRepositoryEntry(
          snapshot.document.repositories,
          request.repoId,
        );
        const aliases = sortAndDedupeStrings([
          ...(previous?.aliases ?? []),
          ...(request.aliases ?? []),
          ...(previous && previous.currentName !== request.currentName
            ? [previous.currentName]
            : []),
        ]).filter((name) => name !== request.currentName);
        const entry: RepositoryRegistryEntry = {
          aliases,
          currentName: request.currentName,
          path: repositoryStoragePath(request.repoId),
        };

        await mkdir(join(this.registryRoot, entry.path), {
          mode: 0o700,
          recursive: true,
        });
        await syncDirectory(join(this.registryRoot, "repos"));

        if (!registryEntriesEqual(previous, entry)) {
          const repositories = Object.fromEntries([
            ...Object.entries(snapshot.document.repositories),
            [request.repoId, entry],
          ]);
          await this.writeDocument({ repositories }, snapshot.bytes);
        }
        return toResolvedRepository(this.registryRoot, request.repoId, entry);
      },
    );
  }

  async resolveById(repoId: string): Promise<ResolvedRepository | null> {
    validateRepositoryId(repoId);
    await this.ensureLayout();
    return withPosixFileLock(
      join(this.registryRoot, ".registry.lock"),
      this.lockTimeoutMs,
      async () => {
        const entry = findRepositoryEntry(
          (await this.readSnapshot()).document.repositories,
          repoId,
        );
        return entry
          ? toResolvedRepository(this.registryRoot, repoId, entry)
          : null;
      },
    );
  }

  async resolveByName(name: string): Promise<ResolvedRepository | null> {
    if (!RepositoryNameSchema.safeParse(name).success) {
      throw new RepositoryRegistryError(
        "INVALID_REPOSITORY_REGISTRY",
        "Repository name must use owner/name form",
      );
    }
    await this.ensureLayout();
    return withPosixFileLock(
      join(this.registryRoot, ".registry.lock"),
      this.lockTimeoutMs,
      async () => {
        const repositories = (await this.readSnapshot()).document.repositories;
        const matches = Object.entries(repositories)
          .filter(
            ([, entry]) =>
              entry.currentName === name || entry.aliases.includes(name),
          )
          .sort(([a], [b]) => compareCodeUnits(a, b));
        if (matches.length > 1) {
          throw new RepositoryRegistryError(
            "REPOSITORY_NAME_AMBIGUOUS",
            `Repository name ${name} resolves to multiple repo IDs`,
          );
        }
        const match = matches[0];
        return match
          ? toResolvedRepository(this.registryRoot, match[0], match[1])
          : null;
      },
    );
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.registryRoot, { mode: 0o700, recursive: true });
    await chmod(this.registryRoot, 0o700);
    await mkdir(join(this.registryRoot, "repos"), {
      mode: 0o700,
      recursive: true,
    });
  }

  private async readSnapshot(): Promise<RegistrySnapshot> {
    const registryPath = join(this.registryRoot, "repositories.json");
    let bytes: Buffer;
    try {
      bytes = await readFile(registryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          bytes: null,
          document: { repositories: Object.create(null) },
        };
      }
      throw error;
    }
    return { bytes, document: parseRegistryDocument(bytes) };
  }

  private async assertUnchanged(expected: Buffer | null): Promise<void> {
    const registryPath = join(this.registryRoot, "repositories.json");
    let actual: Buffer | null;
    try {
      actual = await readFile(registryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      actual = null;
    }
    const expectedHash = expected === null ? null : computeByteSha256(expected);
    const actualHash = actual === null ? null : computeByteSha256(actual);
    if (actualHash !== expectedHash) {
      throw new RepositoryRegistryError(
        "REGISTRY_CONFLICT",
        "repositories.json changed after it was read",
      );
    }
  }

  private async writeDocument(
    document: RepositoryRegistryDocument,
    expectedBytes: Buffer | null,
  ): Promise<void> {
    const temporaryPath = join(this.registryRoot, "repositories.json.tmp");
    const targetPath = join(this.registryRoot, "repositories.json");
    const bytes = Buffer.from(`${canonicalizeJson(document)}\n`, "utf8");
    await removeRegularTemporaryFile(temporaryPath);
    await writeDurable(temporaryPath, bytes);
    await this.assertUnchanged(expectedBytes);
    await rename(temporaryPath, targetPath);
    await syncDirectory(this.registryRoot);
  }
}

/** Uses 128 bits of SHA-256 as required by the v0.2.2 storage-id erratum. */
export function repositoryStorageId(repoId: string): string {
  if (repoId.length === 0) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "Repository ID must not be empty",
    );
  }
  return createHash("sha256").update(repoId, "utf8").digest("hex").slice(0, 32);
}

function repositoryStoragePath(repoId: string): string {
  return `repos/${repositoryStorageId(repoId)}`;
}

function parseRegistryDocument(bytes: Buffer): RepositoryRegistryDocument {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "repositories.json is not valid UTF-8 JSON",
      { cause: error },
    );
  }
  if (!isRecord(value) || !isRecord(value.repositories)) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "repositories.json must contain a repositories object",
    );
  }

  const entries: Array<[string, RepositoryRegistryEntry]> = [];
  for (const [repoId, rawEntry] of Object.entries(value.repositories)) {
    if (
      !isRecord(rawEntry) ||
      typeof rawEntry.path !== "string" ||
      typeof rawEntry.currentName !== "string" ||
      !Array.isArray(rawEntry.aliases) ||
      !rawEntry.aliases.every((alias) => typeof alias === "string") ||
      rawEntry.path !== repositoryStoragePath(repoId)
    ) {
      throw new RepositoryRegistryError(
        "INVALID_REPOSITORY_REGISTRY",
        `Invalid registry entry for ${repoId}`,
      );
    }
    validateRepositoryIdentity(repoId, rawEntry.currentName);
    validateRepositoryAliases(rawEntry.aliases);
    entries.push([
      repoId,
      {
        aliases: sortAndDedupeStrings(rawEntry.aliases).filter(
          (alias) => alias !== rawEntry.currentName,
        ),
        currentName: rawEntry.currentName,
        path: rawEntry.path,
      },
    ]);
  }
  return { repositories: Object.fromEntries(entries) };
}

function validateRepositoryIdentity(repoId: string, currentName: string): void {
  validateRepositoryId(repoId);
  if (!RepositoryNameSchema.safeParse(currentName).success) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "Repository current name must use owner/name form",
    );
  }
}

function validateRepositoryId(repoId: string): void {
  if (repoId.length === 0) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "Repository ID must not be empty",
    );
  }
}

function validateRepositoryAliases(aliases: readonly string[]): void {
  if (aliases.some((alias) => !RepositoryNameSchema.safeParse(alias).success)) {
    throw new RepositoryRegistryError(
      "INVALID_REPOSITORY_REGISTRY",
      "Repository aliases must use owner/name form",
    );
  }
}

function registryEntriesEqual(
  left: RepositoryRegistryEntry | undefined,
  right: RepositoryRegistryEntry,
): boolean {
  return (
    left !== undefined &&
    left.path === right.path &&
    left.currentName === right.currentName &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((value, index) => value === right.aliases[index])
  );
}

function findRepositoryEntry(
  repositories: Readonly<Record<string, RepositoryRegistryEntry>>,
  repoId: string,
): RepositoryRegistryEntry | undefined {
  return Object.entries(repositories).find(
    ([candidate]) => candidate === repoId,
  )?.[1];
}

function toResolvedRepository(
  registryRoot: string,
  repoId: string,
  entry: RepositoryRegistryEntry,
): ResolvedRepository {
  return {
    ...entry,
    absolutePath: join(registryRoot, entry.path),
    repoId,
  };
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

async function removeRegularTemporaryFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new RepositoryRegistryError(
        "INVALID_REPOSITORY_REGISTRY",
        `${path} must be a regular temporary file`,
      );
    }
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

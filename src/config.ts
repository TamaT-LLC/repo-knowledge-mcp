import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { sha256Jcs, sha256NormalizedJcs } from "./canonical.js";
import {
  RepoKnowledgeConfigSchema,
  RepositoryNameSchema,
  TrustConfigSchema,
  type RepoKnowledgeConfig,
  type TrustConfig,
} from "./domain-schemas.js";
import { createDomainId } from "./ids.js";

export const DEFAULT_CONFIG_FILE_NAME = "config.json";

export type ConfigErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_IO_ERROR"
  | "CONFIG_PATH_UNSAFE"
  | "UNSUPPORTED_PLATFORM";

export class RepoKnowledgeConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${path}: ${message}`, options);
    this.name = "RepoKnowledgeConfigError";
  }
}

export interface EffectiveRepositoryPolicy {
  readonly allowCloudTransmission: boolean;
}

export interface InitializedStorage {
  readonly config: RepoKnowledgeConfig;
  readonly configPath: string;
  readonly rootPath: string;
}

/** Validates unknown JSON-compatible input and applies all safe defaults. */
export function parseRepoKnowledgeConfig(
  value: unknown,
  path = "<config>",
): RepoKnowledgeConfig {
  const result = RepoKnowledgeConfigSchema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => {
      const location =
        issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${location}: ${issue.message}`;
    })
    .join("; ");
  throw new RepoKnowledgeConfigError("CONFIG_INVALID", path, details, {
    cause: result.error,
  });
}

/** Loads and strictly validates a UTF-8 JSON config file. */
export async function loadRepoKnowledgeConfig(
  configPath: string,
): Promise<RepoKnowledgeConfig> {
  const absolutePath = resolve(configPath);
  let bytes: Buffer;
  try {
    await assertRegularFile(absolutePath);
    bytes = await readFile(absolutePath);
  } catch (error) {
    if (error instanceof RepoKnowledgeConfigError) throw error;
    throw new RepoKnowledgeConfigError(
      "CONFIG_IO_ERROR",
      absolutePath,
      errorMessage(error),
      { cause: error },
    );
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_INVALID",
      absolutePath,
      "file is not valid UTF-8",
      { cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_INVALID",
      absolutePath,
      "file is not valid JSON",
      { cause: error },
    );
  }

  return parseRepoKnowledgeConfig(value, absolutePath);
}

/** Computes the repository-specific cloud transmission policy. */
export function resolveRepositoryPolicy(
  config: RepoKnowledgeConfig,
  repository: string,
): EffectiveRepositoryPolicy {
  const normalizedConfig = RepoKnowledgeConfigSchema.parse(config);
  const normalizedRepository = RepositoryNameSchema.parse(repository);
  return {
    allowCloudTransmission:
      normalizedConfig.repoPolicies[normalizedRepository]
        ?.allowCloudTransmission ?? normalizedConfig.llm.allowCloudTransmission,
  };
}

/** Hashes the exact prompt bytes using the persistent hash notation. */
export function computePromptDigest(value: Uint8Array | string): string {
  return prefixedSha256(value);
}

/** Hashes a JSON schema using RFC 8785 canonical JSON. */
export function computeOutputSchemaDigest(value: unknown): string {
  return `sha256:${sha256Jcs(value)}`;
}

/** Hashes a normalized effective trust policy independent of set order. */
export function computeTrustPolicyDigest(value: TrustConfig): string {
  const trust = TrustConfigSchema.parse(value);
  return `sha256:${sha256NormalizedJcs(trust)}`;
}

/**
 * Creates the private storage root and an atomic default config when absent.
 * Existing config bytes are never overwritten; permissions are tightened.
 */
export async function initializeStorage(
  storageRoot: string,
  initialConfig: unknown = {},
): Promise<InitializedStorage> {
  assertSupportedPlatform();
  if (storageRoot.trim().length === 0) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_PATH_UNSAFE",
      storageRoot,
      "storage root must be explicit",
    );
  }
  const rootPath = resolve(storageRoot);
  assertSafeStorageRoot(rootPath);
  const configPath = join(rootPath, DEFAULT_CONFIG_FILE_NAME);
  const config = parseRepoKnowledgeConfig(initialConfig, configPath);

  await ensurePrivateDirectory(rootPath);
  await createPrivateFileIfMissing(configPath, serializeConfig(config));
  await assertRegularFile(configPath);
  await chmod(configPath, 0o600);

  return {
    config: await loadRepoKnowledgeConfig(configPath),
    configPath,
    rootPath,
  };
}

function serializeConfig(config: RepoKnowledgeConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function prefixedSha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new RepoKnowledgeConfigError(
      "UNSUPPORTED_PLATFORM",
      process.platform,
      "M1 storage supports macOS and Linux",
    );
  }
}

function assertSafeStorageRoot(path: string): void {
  const forbiddenRoots = new Set([
    parse(path).root,
    resolve(homedir()),
    resolve(process.cwd()),
  ]);
  if (forbiddenRoots.has(path)) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_PATH_UNSAFE",
      path,
      "refusing to change permissions on a broad directory",
    );
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700, recursive: true });
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new RepoKnowledgeConfigError(
        "CONFIG_PATH_UNSAFE",
        path,
        "storage root must be a real directory",
      );
    }
    await chmod(path, 0o700);
  } catch (error) {
    if (error instanceof RepoKnowledgeConfigError) throw error;
    throw new RepoKnowledgeConfigError(
      "CONFIG_IO_ERROR",
      path,
      errorMessage(error),
      { cause: error },
    );
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_PATH_UNSAFE",
      path,
      "config must be a regular file, not a symlink",
    );
  }
}

async function createPrivateFileIfMissing(
  targetPath: string,
  content: Uint8Array,
): Promise<void> {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${basename(targetPath)}.${createDomainId("transaction")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    await unlink(temporaryPath);
    await syncDirectory(directory);
  } catch (error) {
    throw new RepoKnowledgeConfigError(
      "CONFIG_IO_ERROR",
      targetPath,
      errorMessage(error),
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    });
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

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

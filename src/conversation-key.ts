import { createHmac, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";

import { canonicalizeJson } from "./canonical.js";
import { openRegularFileNoFollow } from "./durable-fs.js";
import {
  projectPathMatchKey,
  projectPathPrefixes,
} from "./conversation-paths.js";

export type ConversationStoreErrorCode =
  | "CONVERSATION_DATA_CORRUPT"
  | "CONVERSATION_DATA_PATH_UNSAFE"
  | "CONVERSATION_KEY_CORRUPT"
  | "CONVERSATION_KEY_MISSING"
  | "CONVERSATION_KEY_OWNER_MISMATCH"
  | "CONVERSATION_KEY_PERMISSIONS_UNSAFE"
  | "CONVERSATION_PURGE_FILTER_INVALID"
  | "CONVERSATION_RESET_KEY_UNRECOVERABLE"
  | "CONVERSATION_RESET_PENDING";

/** Content-free error: messages name files and codes, never stored text. */
export class ConversationStoreError extends Error {
  /** The data-area file at fault, when there is one (e.g. corruption). */
  readonly file: string | undefined;

  constructor(
    readonly code: ConversationStoreErrorCode,
    message: string,
    options?: ErrorOptions & { readonly file?: string },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ConversationStoreError";
    this.file = options?.file;
  }
}

const CONVERSATION_KEY_BYTES = 32;
const KEY_FILE_PATTERN = /^([0-9a-f]{64})\n?$/u;

/** A fresh 32-byte HMAC key. */
export function generateConversationKeyBytes(): Buffer {
  return randomBytes(CONVERSATION_KEY_BYTES);
}

/** Lowercase hex: a key of the wrong length or alphabet is detected. */
export function encodeConversationKeyFile(key: Uint8Array): Buffer {
  return Buffer.from(`${Buffer.from(key).toString("hex")}\n`, "utf8");
}

/**
 * Reads a key file, or `null` when it is absent. A symlink, a file readable
 * by group or others, a file owned by someone else, or malformed contents are
 * refused rather than used.
 */
export async function readConversationKeyFile(
  path: string,
  options: {
    /**
     * Only for telling which generation a file holds (reset-key resume): the
     * key is identified but must not be used until its permissions are safe.
     */
    readonly identifyOnly?: boolean;
  } = {},
): Promise<ConversationKey | null> {
  // Checks and read go through one handle opened without following links,
  // so the file cannot be swapped for a symlink between them.
  const opened = await openRegularFileNoFollow(path, () => unsafeKeyPath(path));
  if (opened === null) return null;
  let bytes: Buffer;
  try {
    if (options.identifyOnly !== true)
      assertPrivateKeyFile(path, opened.status);
    bytes = await opened.handle.readFile();
  } finally {
    await opened.handle.close();
  }
  const match = KEY_FILE_PATTERN.exec(bytes.toString("latin1"));
  if (match === null) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_CORRUPT",
      `${path} is not a 32-byte hex key; run repo-knowledge conversations reset-key`,
    );
  }
  return new ConversationKey(Buffer.from(match[1]!, "hex"));
}

function unsafeKeyPath(path: string): ConversationStoreError {
  return new ConversationStoreError(
    "CONVERSATION_DATA_PATH_UNSAFE",
    `${path} must be a regular file, not a symlink`,
  );
}

/** Mode and owner checks: a key anyone else could read is never used. */
function assertPrivateKeyFile(path: string, status: Stats): void {
  if ((status.mode & 0o077) !== 0) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_PERMISSIONS_UNSAFE",
      `${path} is accessible by group or others (mode ${(status.mode & 0o777).toString(8)}); it was not used. Run chmod 600 on it after confirming nobody else read it, or run repo-knowledge conversations reset-key`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && status.uid !== uid) {
    throw new ConversationStoreError(
      "CONVERSATION_KEY_OWNER_MISMATCH",
      `${path} is owned by another user (created with sudo?); it was not used. Run chown on it to your user, or run repo-knowledge conversations reset-key`,
    );
  }
}

export interface UtteranceIdInput {
  readonly masked_text_digest: string;
  readonly session_id: string;
  readonly source: string;
  readonly source_message_id: string | null;
  readonly timestamp: string;
}

/**
 * The local HMAC key and every identifier derived from it. Identifiers are
 * keyed so that a guessed short utterance, session ID, or path cannot be
 * confirmed by hashing the guess.
 */
export class ConversationKey {
  readonly keyId: string;
  readonly #bytes: Buffer;
  /** Per instance: a key is read once per operation, so this stays small. */
  readonly #prefixHmacs = new Map<string, string>();

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength !== CONVERSATION_KEY_BYTES) {
      throw new TypeError("conversation key must be 32 bytes");
    }
    this.#bytes = Buffer.from(bytes);
    this.keyId = this.#hmac("repo-knowledge/key-id").slice(0, 16);
  }

  /** Raw bytes for HMAC consumers such as the masking version. */
  get bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  /** `utt_` + the first 32 hex digits of HMAC(key, JCS(input)). */
  utteranceId(input: UtteranceIdInput): string {
    const value = canonicalizeJson({
      masked_text_digest: input.masked_text_digest,
      session_id: input.session_id,
      source: input.source,
      source_message_id: input.source_message_id,
      timestamp: input.timestamp,
    });
    return `utt_${this.#hmac(value).slice(0, 32)}`;
  }

  /** Keyed session identifier for canonical records. */
  sessionKey(source: string, sessionId: string): string {
    const value = canonicalizeJson({
      kind: "session",
      session_id: sessionId,
      source,
    });
    return `ses_${this.#hmac(value).slice(0, 32)}`;
  }

  /** Keyed identifier of a project path without a registered repository. */
  projectKey(path: string): string {
    const value = canonicalizeJson({
      kind: "project",
      path: projectPathMatchKey(path),
    });
    return `prj_${this.#hmac(value).slice(0, 32)}`;
  }

  /** HMAC of one normalized path prefix (a purge or exclude target). */
  pathPrefixHmac(prefix: string): string {
    const path = projectPathMatchKey(prefix);
    let hmac = this.#prefixHmacs.get(path);
    if (hmac === undefined) {
      hmac = this.#hmac(canonicalizeJson({ kind: "path_prefix", path })).slice(
        0,
        32,
      );
      this.#prefixHmacs.set(path, hmac);
    }
    return hmac;
  }

  /**
   * HMACs of every component prefix of the path, root included, with no
   * depth cap; sorted so the order does not reveal which prefix is deepest.
   */
  pathPrefixHmacs(path: string): string[] {
    return projectPathPrefixes(path)
      .map((prefix) => this.pathPrefixHmac(prefix))
      .sort();
  }

  #hmac(value: string): string {
    return createHmac("sha256", this.#bytes)
      .update(value, "utf8")
      .digest("hex");
  }
}

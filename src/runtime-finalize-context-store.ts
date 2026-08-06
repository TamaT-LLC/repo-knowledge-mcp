import { createHash, randomBytes } from "node:crypto";

import {
  IsoDateTimeSchema,
  JobIdSchema,
  Sha256DigestSchema,
  SnapshotIdSchema,
} from "./domain-schemas.js";
import type { FinalizeContext } from "./finalize-guard.js";
import {
  computeMatchSetDigest,
  normalizePossibleMatchBindings,
  type PossibleMatchBinding,
} from "./possible-match.js";

export interface RuntimeFinalizeContextInput {
  readonly candidate_set_sha256: string;
  readonly content_fingerprint: string;
  readonly distillation_key: string;
  readonly expires_at: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly match_set_digest: string;
  readonly possible_matches: readonly PossibleMatchBinding[];
  readonly source_snapshot_id: string;
}

export interface RuntimeFinalizeHandle {
  readonly expires_at: string;
  readonly finalize_token: string;
  readonly lease_generation: number;
}

export interface IssuedRuntimeFinalizeContext {
  readonly context: FinalizeContext;
  readonly handle: RuntimeFinalizeHandle;
}

export interface RuntimeFinalizeContextStoreOptions {
  /** Test seam. Production callers should use the cryptographic default. */
  readonly nextToken?: () => string;
  readonly now?: () => Date;
}

export type RuntimeFinalizeContextStoreErrorCode =
  | "FINALIZE_CONTEXT_EXPIRED"
  | "FINALIZE_CONTEXT_INVALID"
  | "FINALIZE_TOKEN_COLLISION";

export class RuntimeFinalizeContextStoreError extends Error {
  constructor(
    readonly code: RuntimeFinalizeContextStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "RuntimeFinalizeContextStoreError";
  }
}

/**
 * Keeps finalize authorization in process memory only. The map is keyed by a
 * SHA-256 digest, so the plaintext token exists only in the returned handle.
 */
export class RuntimeFinalizeContextStore {
  readonly #contexts = new Map<string, FinalizeContext>();
  readonly #issuedTokenHashes = new Set<string>();
  readonly #nextToken: () => string;
  readonly #now: () => Date;

  constructor(options: RuntimeFinalizeContextStoreOptions = {}) {
    this.#nextToken =
      options.nextToken ?? (() => randomBytes(32).toString("base64url"));
    this.#now = options.now ?? (() => new Date());
  }

  issue(input: RuntimeFinalizeContextInput): IssuedRuntimeFinalizeContext {
    const now = this.operationTimestamp();
    this.deleteExpired(now);
    const contextInput = validateContextInput(input);
    if (Date.parse(contextInput.expires_at) <= now) {
      throw contextError(
        "FINALIZE_CONTEXT_EXPIRED",
        "cannot issue a finalize token for an expired lease",
      );
    }

    const finalizeToken = this.#nextToken();
    if (typeof finalizeToken !== "string" || finalizeToken.length === 0) {
      throw contextError(
        "FINALIZE_CONTEXT_INVALID",
        "finalize token generator returned an empty token",
      );
    }
    const tokenHash = hashFinalizeToken(finalizeToken);
    if (this.#issuedTokenHashes.has(tokenHash)) {
      throw contextError(
        "FINALIZE_TOKEN_COLLISION",
        "finalize token generator reused a token in this process",
      );
    }

    const context = freezeContext({
      ...contextInput,
      token_hash: tokenHash,
    });
    this.#contexts.set(tokenHash, context);
    this.#issuedTokenHashes.add(tokenHash);
    return {
      context,
      handle: {
        expires_at: context.expires_at,
        finalize_token: finalizeToken,
        lease_generation: context.lease_generation,
      },
    };
  }

  /** Returns an active context without exposing or retaining its token. */
  find(finalizeToken: string): FinalizeContext | undefined {
    if (typeof finalizeToken !== "string" || finalizeToken.length === 0) {
      return undefined;
    }
    const now = this.operationTimestamp();
    this.deleteExpired(now);
    return this.#contexts.get(hashFinalizeToken(finalizeToken));
  }

  /** Invalidates a handle after a successful non-replay finalize commit. */
  remove(finalizeToken: string): boolean {
    if (typeof finalizeToken !== "string" || finalizeToken.length === 0) {
      return false;
    }
    return this.#contexts.delete(hashFinalizeToken(finalizeToken));
  }

  get size(): number {
    this.deleteExpired(this.operationTimestamp());
    return this.#contexts.size;
  }

  private operationTimestamp(): number {
    const timestamp = this.#now().getTime();
    if (!Number.isFinite(timestamp)) {
      throw contextError(
        "FINALIZE_CONTEXT_INVALID",
        "now() returned an invalid Date",
      );
    }
    return timestamp;
  }

  private deleteExpired(timestamp: number): void {
    for (const [tokenHash, context] of this.#contexts) {
      if (Date.parse(context.expires_at) <= timestamp) {
        this.#contexts.delete(tokenHash);
      }
    }
  }
}

/** Hashes a finalize token before it enters any retained runtime state. */
export function hashFinalizeToken(finalizeToken: string): string {
  if (typeof finalizeToken !== "string" || finalizeToken.length === 0) {
    throw contextError(
      "FINALIZE_CONTEXT_INVALID",
      "finalize token must not be empty",
    );
  }
  return Sha256DigestSchema.parse(
    `sha256:${createHash("sha256")
      .update(finalizeToken, "utf8")
      .digest("hex")}`,
  );
}

function validateContextInput(
  input: RuntimeFinalizeContextInput,
): RuntimeFinalizeContextInput {
  const possibleMatches = normalizePossibleMatchBindings(
    input.possible_matches,
  );
  const matchSetDigest = rawSha256(input.match_set_digest, "match_set_digest");
  if (computeMatchSetDigest(possibleMatches) !== matchSetDigest) {
    throw contextError(
      "FINALIZE_CONTEXT_INVALID",
      "match_set_digest does not match possible_matches",
    );
  }
  if (
    !Number.isSafeInteger(input.lease_generation) ||
    input.lease_generation < 1
  ) {
    throw contextError(
      "FINALIZE_CONTEXT_INVALID",
      "lease_generation must be a positive safe integer",
    );
  }

  try {
    return {
      candidate_set_sha256: rawSha256(
        input.candidate_set_sha256,
        "candidate_set_sha256",
      ),
      content_fingerprint: Sha256DigestSchema.parse(input.content_fingerprint),
      distillation_key: Sha256DigestSchema.parse(input.distillation_key),
      expires_at: IsoDateTimeSchema.parse(input.expires_at),
      job_id: JobIdSchema.parse(input.job_id),
      lease_generation: input.lease_generation,
      match_set_digest: matchSetDigest,
      possible_matches: possibleMatches,
      source_snapshot_id: SnapshotIdSchema.parse(input.source_snapshot_id),
    };
  } catch (error) {
    if (error instanceof RuntimeFinalizeContextStoreError) throw error;
    throw contextError(
      "FINALIZE_CONTEXT_INVALID",
      "finalize context fields are invalid",
      error,
    );
  }
}

function freezeContext(context: FinalizeContext): FinalizeContext {
  const possibleMatches = context.possible_matches.map((set) =>
    Object.freeze({
      candidate_id: set.candidate_id,
      possible_matches: Object.freeze(
        set.possible_matches.map((match) => Object.freeze({ ...match })),
      ),
    }),
  );
  return Object.freeze({
    ...context,
    possible_matches: Object.freeze(possibleMatches),
  });
}

function rawSha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw contextError(
      "FINALIZE_CONTEXT_INVALID",
      `${field} must be a lowercase hexadecimal SHA-256`,
    );
  }
  return value;
}

function contextError(
  code: RuntimeFinalizeContextStoreErrorCode,
  message: string,
  cause?: unknown,
): RuntimeFinalizeContextStoreError {
  return new RuntimeFinalizeContextStoreError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

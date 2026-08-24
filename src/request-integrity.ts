import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  canonicalizeJson,
  compareCodeUnits,
  normalizeSetArrays,
  sha256Jcs,
} from "./canonical.js";

export interface ExtractRequest {
  readonly candidates: readonly unknown[];
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token: string;
  readonly phase: "extract";
  readonly request_schema_version: 1;
  readonly skip_reason: string | null;
  readonly submission_id: string;
  readonly thread_fingerprint: string;
}

export interface FinalizeRequest {
  readonly candidate_set_sha256: string;
  readonly decisions: readonly unknown[];
  readonly finalize_token: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token: string;
  readonly phase: "finalize";
  readonly request_schema_version: 1;
  readonly submission_id: string;
}

export type PhaseRequest = ExtractRequest | FinalizeRequest;

export interface ExtractRequestHashPayload {
  readonly candidates: readonly unknown[];
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token_hash: string;
  readonly phase: "extract";
  readonly request_schema_version: number;
  readonly skip_reason: string | null;
  readonly thread_fingerprint: string;
}

export interface FinalizeRequestHashPayload {
  readonly candidate_set_sha256: string;
  readonly decisions: readonly unknown[];
  readonly finalize_token_hash: string;
  readonly job_id: string;
  readonly lease_generation: number;
  readonly lease_token_hash: string;
  readonly phase: "finalize";
  readonly request_schema_version: number;
}

export type RequestHashPayload =
  | ExtractRequestHashPayload
  | FinalizeRequestHashPayload;

/**
 * Builds the complete JCS input for a phase request. submission_id and the
 * plaintext tokens are deliberately absent; their SHA-256 values are included.
 */
export function buildRequestHashPayload(
  request: PhaseRequest,
): RequestHashPayload {
  const common = {
    job_id: request.job_id,
    lease_generation: request.lease_generation,
    request_schema_version: request.request_schema_version as number,
  };

  if (request.phase === "extract") {
    return {
      ...common,
      candidates: normalizeUnorderedObjects(request.candidates),
      lease_token_hash: sha256Text(request.lease_token),
      phase: "extract" as const,
      skip_reason: request.skip_reason,
      thread_fingerprint: request.thread_fingerprint,
    };
  }

  return {
    ...common,
    candidate_set_sha256: request.candidate_set_sha256,
    decisions: normalizeUnorderedObjects(request.decisions),
    finalize_token_hash: sha256Text(request.finalize_token),
    lease_token_hash: sha256Text(request.lease_token),
    phase: "finalize" as const,
  };
}

/** Computes the request SHA-256 over the normalized RFC 8785 JCS payload. */
export function computeRequestSha256(request: PhaseRequest): string {
  return sha256Jcs(buildRequestHashPayload(request));
}

export type RequestBoundTokenKind = "finalize" | "lease";

export interface RequestBoundTokenClaims {
  readonly kind: RequestBoundTokenKind;
  readonly request_sha256: string;
  readonly token_id: string;
  readonly token_schema_version: 1;
}

export interface IssueRequestBoundTokenInput {
  readonly kind: RequestBoundTokenKind;
  readonly requestSha256: string;
  readonly tokenId: string;
}

export interface ExpectedRequestBoundToken {
  readonly kind: RequestBoundTokenKind;
  readonly requestSha256: string;
}

export type RequestIntegrityErrorCode =
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_TOKEN"
  | "TOKEN_KIND_MISMATCH"
  | "TOKEN_REQUEST_MISMATCH";

export class RequestIntegrityError extends Error {
  constructor(
    readonly code: RequestIntegrityErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RequestIntegrityError";
  }
}

/** Issues a compact HMAC-authenticated token containing request_sha256. */
export function issueRequestBoundToken(
  input: IssueRequestBoundTokenInput,
  secret: Uint8Array,
): string {
  assertTokenSecret(secret);
  assertSha256(input.requestSha256, "requestSha256");
  if (input.tokenId.length === 0) {
    throw new TypeError("tokenId must not be empty");
  }

  const claims: RequestBoundTokenClaims = {
    kind: input.kind,
    request_sha256: input.requestSha256,
    token_id: input.tokenId,
    token_schema_version: 1,
  };
  const encodedClaims = Buffer.from(canonicalizeJson(claims), "utf8").toString(
    "base64url",
  );
  const signature = signTokenPayload(encodedClaims, secret);

  return `${encodedClaims}.${signature}`;
}

/** Authenticates a token and validates its phase kind and request binding. */
export function verifyRequestBoundToken(
  token: string,
  expected: ExpectedRequestBoundToken,
  secret: Uint8Array,
): RequestBoundTokenClaims {
  assertTokenSecret(secret);
  const segments = token.split(".");
  if (
    segments.length !== 2 ||
    segments[0]?.length === 0 ||
    segments[1]?.length === 0
  ) {
    throw integrityError("INVALID_TOKEN", "Malformed compact token");
  }

  const [encodedClaims, encodedSignature] = segments as [string, string];
  assertCanonicalBase64Url(encodedClaims);
  assertCanonicalBase64Url(encodedSignature);
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = Buffer.from(
    signTokenPayload(encodedClaims, secret),
    "base64url",
  );
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw integrityError("INVALID_TOKEN", "Token signature does not match");
  }

  const claims = parseTokenClaims(encodedClaims);
  if (claims.kind !== expected.kind) {
    throw integrityError("TOKEN_KIND_MISMATCH", "Token kind does not match");
  }
  if (claims.request_sha256 !== expected.requestSha256) {
    throw integrityError(
      "TOKEN_REQUEST_MISMATCH",
      "Token is bound to a different request",
    );
  }

  return claims;
}

export interface AcceptedSubmissionRegistration {
  readonly requestSha256: string;
  readonly state: "accepted";
}

export interface ReplaySubmissionRegistration {
  readonly originalSubmissionId: string;
  readonly requestSha256: string;
  readonly state: "replay";
}

export type SubmissionRegistration =
  | AcceptedSubmissionRegistration
  | ReplaySubmissionRegistration;

interface StoredSubmission {
  readonly originalSubmissionId: string;
  readonly requestSha256: string;
}

/**
 * Tracks phase-scoped submissions. Equivalent requests with new submission IDs
 * replay; reusing an ID for changed request bytes is always rejected.
 */
export class SubmissionIdempotencyStore {
  readonly #byRequest = new Map<string, StoredSubmission>();
  readonly #bySubmission = new Map<string, StoredSubmission>();

  register(request: PhaseRequest): SubmissionRegistration {
    if (request.submission_id.length === 0) {
      throw new TypeError("submission_id must not be empty");
    }

    const requestSha256 = computeRequestSha256(request);
    const submissionKey = compositeKey(request.phase, request.submission_id);
    const existingSubmission = this.#bySubmission.get(submissionKey);
    if (existingSubmission !== undefined) {
      if (existingSubmission.requestSha256 !== requestSha256) {
        throw integrityError(
          "IDEMPOTENCY_KEY_REUSED",
          "submission_id was already used for a different request",
        );
      }

      return {
        originalSubmissionId: existingSubmission.originalSubmissionId,
        requestSha256,
        state: "replay",
      };
    }

    const requestKey = compositeKey(request.phase, requestSha256);
    const equivalentRequest = this.#byRequest.get(requestKey);
    const stored: StoredSubmission = {
      originalSubmissionId:
        equivalentRequest?.originalSubmissionId ?? request.submission_id,
      requestSha256,
    };
    this.#bySubmission.set(submissionKey, stored);

    if (equivalentRequest !== undefined) {
      return {
        originalSubmissionId: equivalentRequest.originalSubmissionId,
        requestSha256,
        state: "replay",
      };
    }

    this.#byRequest.set(requestKey, stored);
    return { requestSha256, state: "accepted" };
  }
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Normalizes set-valued members and the order of an object-valued set. */
function normalizeUnorderedObjects(values: readonly unknown[]): unknown[] {
  return values
    .map((value) => normalizeSetArrays(value))
    .sort((left, right) =>
      compareCodeUnits(canonicalizeJson(left), canonicalizeJson(right)),
    );
}

function signTokenPayload(encodedClaims: string, secret: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(encodedClaims, "ascii")
    .digest("base64url");
}

function parseTokenClaims(encodedClaims: string): RequestBoundTokenClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedClaims, "base64url").toString("utf8"),
    );
  } catch {
    throw integrityError("INVALID_TOKEN", "Token claims are not valid JSON");
  }

  if (!isRecord(parsed)) {
    throw integrityError("INVALID_TOKEN", "Token claims must be an object");
  }
  if (parsed.token_schema_version !== 1) {
    throw integrityError("INVALID_TOKEN", "Unsupported token schema version");
  }
  if (parsed.kind !== "lease" && parsed.kind !== "finalize") {
    throw integrityError("INVALID_TOKEN", "Unsupported token kind");
  }
  if (typeof parsed.request_sha256 !== "string") {
    throw integrityError("INVALID_TOKEN", "request_sha256 is missing");
  }
  try {
    assertSha256(parsed.request_sha256, "request_sha256");
  } catch {
    throw integrityError("INVALID_TOKEN", "request_sha256 is malformed");
  }
  if (typeof parsed.token_id !== "string" || parsed.token_id.length === 0) {
    throw integrityError("INVALID_TOKEN", "token_id is missing");
  }

  return {
    kind: parsed.kind,
    request_sha256: parsed.request_sha256,
    token_id: parsed.token_id,
    token_schema_version: 1,
  };
}

function assertCanonicalBase64Url(value: string): void {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw integrityError("INVALID_TOKEN", "Token encoding is malformed");
  }
}

function assertTokenSecret(secret: Uint8Array): void {
  if (secret.byteLength < 32) {
    throw new TypeError("Token secret must contain at least 32 bytes");
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a lowercase hexadecimal SHA-256`);
  }
}

function integrityError(
  code: RequestIntegrityErrorCode,
  message: string,
): RequestIntegrityError {
  return new RequestIntegrityError(code, message);
}

function compositeKey(phase: PhaseRequest["phase"], value: string): string {
  return `${phase}\u0000${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

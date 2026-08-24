import { z } from "zod";

export const SENSITIVE_CONTENT_DETECTED = "SENSITIVE_CONTENT_DETECTED";

export const SensitiveContentBoundarySchema = z.enum([
  "host_assisted_payload",
  "provider_distillation_payload",
  "provider_merge_payload",
]);

export const SensitiveContentKindSchema = z.enum([
  "authorization_header",
  "aws_access_key_id",
  "email_address",
  "generic_secret_assignment",
  "github_token",
  "google_api_key",
  "private_key_block",
  "provider_api_key",
  "slack_token",
]);

const SensitiveContentPathSchema = z
  .string()
  .regex(
    /^\$(?:(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}|\.\*)|\[(?:0|[1-9][0-9]*)\])*$/u,
    "path must contain only scanner-generated field names and indexes",
  );

export const SensitiveContentFindingSchema = z
  .object({
    kind: SensitiveContentKindSchema,
    path: SensitiveContentPathSchema,
  })
  .strict();

export type SensitiveContentBoundary = z.infer<
  typeof SensitiveContentBoundarySchema
>;
export type SensitiveContentKind = z.infer<typeof SensitiveContentKindSchema>;
export type SensitiveContentFinding = z.infer<
  typeof SensitiveContentFindingSchema
>;

interface SensitivePattern {
  readonly kind: SensitiveContentKind;
  readonly pattern: RegExp;
}

/**
 * Deny-list for credentials and non-anonymized identities. Patterns are
 * deliberately conservative because every caller is an external boundary.
 */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  // Generic `sk-` covers Anthropic, OpenAI, and other provider key formats.
  { kind: "provider_api_key", pattern: /\bsk-[A-Za-z0-9_-]{10,}/u },
  {
    kind: "github_token",
    pattern:
      /\b(?:gh[oprsu]|ghp)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/u,
  },
  { kind: "slack_token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/u },
  { kind: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/u },
  {
    kind: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    kind: "authorization_header",
    pattern: /\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/iu,
  },
  {
    kind: "generic_secret_assignment",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|token|password|credential)s?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/iu,
  },
  {
    kind: "email_address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u,
  },
];

/** Scans every string value while returning only safe kind/path metadata. */
export function findSensitiveContent(
  value: unknown,
  path = "$",
): SensitiveContentFinding[] {
  return scanSensitiveContent(value, SensitiveContentPathSchema.parse(path));
}

function scanSensitiveContent(
  value: unknown,
  path: string,
): SensitiveContentFinding[] {
  if (typeof value === "string") {
    return matchingKinds(value).map((kind) => ({ kind, path }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      scanSensitiveContent(entry, `${path}[${String(index)}]`),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      scanSensitiveContent(entry, fieldPath(path, key)),
    );
  }
  return [];
}

/** A content-free rejection shared by every runtime transmission boundary. */
export class SensitiveContentTransmissionError extends Error {
  readonly code = SENSITIVE_CONTENT_DETECTED;
  readonly findings: readonly SensitiveContentFinding[];

  constructor(
    readonly boundary: SensitiveContentBoundary,
    findings: readonly SensitiveContentFinding[],
  ) {
    const parsed = z
      .array(SensitiveContentFindingSchema)
      .min(1)
      .parse(findings);
    super(
      `${SENSITIVE_CONTENT_DETECTED}: ${boundary} contains ${String(
        parsed.length,
      )} sensitive field(s): ${parsed
        .map((finding) => `${finding.kind} at ${finding.path}`)
        .join("; ")}`,
    );
    this.name = "SensitiveContentTransmissionError";
    this.findings = parsed;
  }
}

/** Throws before transmission without retaining or echoing matched values. */
export function assertNoSensitiveContent(
  value: unknown,
  boundary: SensitiveContentBoundary,
): void {
  const findings = findSensitiveContent(value);
  if (findings.length > 0) {
    throw new SensitiveContentTransmissionError(boundary, findings);
  }
}

function matchingKinds(value: string): SensitiveContentKind[] {
  return SENSITIVE_PATTERNS.filter((entry) => entry.pattern.test(value)).map(
    (entry) => entry.kind,
  );
}

function fieldPath(parent: string, key: string): string {
  const safeKey = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(key);
  return safeKey && matchingKinds(key).length === 0
    ? `${parent}.${key}`
    : `${parent}.*`;
}

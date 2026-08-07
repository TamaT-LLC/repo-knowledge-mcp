import { z } from "zod";

import {
  ActorKindSchema,
  IsoDateTimeSchema,
  KnowledgeCategorySchema,
  NonEmptyStringSchema,
  SeveritySchema,
  SourceProviderSchema,
  TrustLevelSchema,
} from "./domain-schemas.js";

/** Design §18.3 quality gate floor: the corpus must hold 50+ threads. */
export const MINIMUM_QUALITY_GATE_THREADS = 50;

export const ANONYMIZED_THREAD_CORPUS_KIND = "anonymized_thread_corpus";

const CorpusActorSchema = z
  .object({
    actor_kind: ActorKindSchema,
    provider: SourceProviderSchema,
    role: NonEmptyStringSchema.regex(
      /^[a-z][a-z0-9-]*$/u,
      "role must be an anonymized lowercase label such as reviewer-1",
    ),
    trust: TrustLevelSchema,
  })
  .strict();

const CorpusCommentSchema = z
  .object({
    actor: CorpusActorSchema,
    body: NonEmptyStringSchema,
    created_at: IsoDateTimeSchema,
    diff_hunk: NonEmptyStringSchema.optional(),
    id: NonEmptyStringSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

const CorpusExpectedSchema = z
  .object({
    category: KnowledgeCategorySchema.nullable(),
    is_knowledge: z.boolean(),
    merge_group: NonEmptyStringSchema.nullable(),
    scope: z.array(z.string()),
    severity: SeveritySchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.is_knowledge &&
      (value.category === null || value.severity === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "knowledge threads require expected category and severity",
      });
    }
    if (!value.is_knowledge && value.merge_group !== null) {
      context.addIssue({
        code: "custom",
        message: "non-knowledge threads cannot belong to a merge group",
      });
    }
  });

const CorpusThreadSchema = z
  .object({
    comments: z.array(CorpusCommentSchema).min(1),
    expected: CorpusExpectedSchema,
    id: NonEmptyStringSchema,
    path: NonEmptyStringSchema.nullable(),
    scope_checks: z.array(
      z
        .object({
          matches: z.boolean(),
          path: NonEmptyStringSchema,
        })
        .strict(),
    ),
    tags: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, comment] of value.comments.entries()) {
      if (seen.has(comment.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate comment id ${comment.id}`,
          path: ["comments", index, "id"],
        });
      }
      seen.add(comment.id);
    }
  });

const CorpusSearchSchema = z
  .object({
    id: NonEmptyStringSchema,
    query: NonEmptyStringSchema,
    relevance: z.record(NonEmptyStringSchema, z.number().int().nonnegative()),
  })
  .strict();

export const AnonymizedThreadCorpusSchema = z
  .object({
    anonymization_policy_version: NonEmptyStringSchema,
    corpus_id: NonEmptyStringSchema,
    corpus_kind: z.literal(ANONYMIZED_THREAD_CORPUS_KIND),
    schema_version: z.literal(1),
    searches: z.array(CorpusSearchSchema).min(1),
    threads: z.array(CorpusThreadSchema).min(MINIMUM_QUALITY_GATE_THREADS),
  })
  .strict()
  .superRefine((value, context) => {
    const threadIds = new Set<string>();
    for (const [index, thread] of value.threads.entries()) {
      if (threadIds.has(thread.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate thread id ${thread.id}`,
          path: ["threads", index, "id"],
        });
      }
      threadIds.add(thread.id);
    }
    const searchIds = new Set<string>();
    for (const [index, search] of value.searches.entries()) {
      if (searchIds.has(search.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate search id ${search.id}`,
          path: ["searches", index, "id"],
        });
      }
      searchIds.add(search.id);
      for (const id of Object.keys(search.relevance)) {
        if (!threadIds.has(id)) {
          context.addIssue({
            code: "custom",
            message: `relevance id ${id} is not a corpus thread`,
            path: ["searches", index, "relevance"],
          });
        }
      }
    }
  });

export type AnonymizedThreadCorpus = z.infer<
  typeof AnonymizedThreadCorpusSchema
>;
export type AnonymizedCorpusThread = AnonymizedThreadCorpus["threads"][number];
export type AnonymizedCorpusSearch = AnonymizedThreadCorpus["searches"][number];

export type SensitiveContentKind =
  | "authorization_header"
  | "aws_access_key_id"
  | "email_address"
  | "generic_secret_assignment"
  | "github_token"
  | "google_api_key"
  | "private_key_block"
  | "provider_api_key"
  | "slack_token";

export interface SensitiveContentFinding {
  readonly kind: SensitiveContentKind;
  readonly path: string;
}

interface SensitivePattern {
  readonly kind: SensitiveContentKind;
  readonly pattern: RegExp;
}

/**
 * Deny-list for anything that must never be transmitted to a provider or
 * persisted in a baseline artifact: raw credentials, tokens, and
 * non-anonymized identities (email addresses). Findings intentionally carry
 * only the JSON path and pattern kind, never the matched text.
 */
const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  // Generic `sk-` prefix covers Anthropic (sk-ant-*), OpenAI (sk-*,
  // sk-proj-*), and other providers that adopted the same convention.
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
    // Assignment-shaped secrets such as `api_key = "abcd…"`. Deliberately
    // broad: a false positive fails closed and only costs an anonymization
    // pass, while a false negative would transmit a credential.
    kind: "generic_secret_assignment",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|token|password|credential)s?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/iu,
  },
  {
    kind: "email_address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u,
  },
];

/** Scans every string in a JSON value; findings never echo the match. */
export function findSensitiveContent(
  value: unknown,
  path = "$",
): SensitiveContentFinding[] {
  if (typeof value === "string") {
    return SENSITIVE_PATTERNS.filter((entry) => entry.pattern.test(value)).map(
      (entry) => ({ kind: entry.kind, path }),
    );
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findSensitiveContent(entry, `${path}[${String(index)}]`),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      findSensitiveContent(entry, `${path}.${key}`),
    );
  }
  return [];
}

export class SensitiveContentError extends Error {
  readonly code = "BASELINE_SENSITIVE_CONTENT";

  constructor(
    readonly subject: string,
    readonly findings: readonly SensitiveContentFinding[],
  ) {
    super(
      `BASELINE_SENSITIVE_CONTENT: ${subject} contains ${String(
        findings.length,
      )} sensitive value(s): ${findings
        .map((finding) => `${finding.kind} at ${finding.path}`)
        .join("; ")}`,
    );
    this.name = "SensitiveContentError";
  }
}

/**
 * Parses and validates an anonymized corpus before any provider transmission.
 * Rejection lists only JSON paths and pattern kinds so the error itself can
 * never leak the offending secret.
 */
export function parseAnonymizedThreadCorpus(
  input: unknown,
): AnonymizedThreadCorpus {
  const corpus = AnonymizedThreadCorpusSchema.parse(input);
  const findings = findSensitiveContent(corpus);
  if (findings.length > 0) {
    throw new SensitiveContentError("anonymized corpus", findings);
  }
  return corpus;
}

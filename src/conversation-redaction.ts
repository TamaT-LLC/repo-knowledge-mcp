import { createHmac } from "node:crypto";

import { z } from "zod";

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import {
  SENSITIVE_PATTERNS,
  SensitiveContentKindSchema,
} from "./sensitive-content.js";

export const REDACTED = "[REDACTED]";
const MASKING_RULES_VERSION = "conv-mask-v1";

const ConversationRedactionKindSchema = z.enum([
  ...SensitiveContentKindSchema.options,
  "bearer_token",
  "connection_credentials",
  "home_path",
  "jwt",
  "long_token",
  "redact_term",
]);
type ConversationRedactionKind = z.infer<
  typeof ConversationRedactionKindSchema
>;

export const ConversationRedactionSchema = z
  .object({
    kind: ConversationRedactionKindSchema,
    count: z.number().int().positive(),
  })
  .strict();
type ConversationRedaction = z.infer<typeof ConversationRedactionSchema>;

type Replacer = (match: string, group: string) => string;

interface Rule {
  readonly kind: ConversationRedactionKind;
  readonly pattern: RegExp;
  readonly replace: Replacer;
}

const whole: Replacer = () => REDACTED;

/** A run with letters and digits; one right after `/` is a path segment. */
const LONG_TOKEN =
  /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/gu;

const SHARED_RULES: readonly Rule[] = SENSITIVE_PATTERNS.map(
  ({ kind, pattern }): Rule => {
    if (kind === "authorization_header") {
      // Keeping `Bearer [REDACTED]` would be re-detected before sending.
      return {
        kind,
        pattern: global(pattern),
        replace: () => `Authorization: ${REDACTED}`,
      };
    }
    if (kind === "generic_secret_assignment") {
      // The shared match stops at `+/=.`; extend it to the end of the value
      // and keep the key name.
      return {
        kind,
        pattern: global(
          new RegExp(`(?:${pattern.source})[^\\s"']*`, pattern.flags),
        ),
        replace: (match) =>
          match.replace(/([:=]\s*["']?).*$/su, `$1${REDACTED}`),
      };
    }
    return { kind, pattern: global(pattern), replace: whole };
  },
);
const isSecretAssignment = (rule: Rule) =>
  rule.kind === "generic_secret_assignment";
const isAuthorizationHeader = (rule: Rule) =>
  rule.kind === "authorization_header";

/**
 * Order matters: wider rules run before the ones that would cut them short.
 * A secret assignment, an Authorization header and a bearer token run before
 * the other shared patterns so that a key inside them cannot leave the rest
 * of the value behind (`secret=AKIA...+tail`, `Bearer sk-...tail`); a
 * connection string's
 * `pass@host` looks like an email, and a JWT outside an assignment would
 * otherwise stop at its first dot.
 */
const RULES: readonly Rule[] = [
  {
    kind: "private_key_block",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
    replace: whole,
  },
  ...SHARED_RULES.filter(isSecretAssignment),
  {
    kind: "connection_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/]*@/giu,
    replace: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  // The header keeps its whole value replaced, before the bare bearer rule.
  ...SHARED_RULES.filter(isAuthorizationHeader),
  {
    // Before the shared patterns: a key inside the token (`sk-...`) would
    // otherwise be replaced alone and leave the rest of the token behind.
    // A short token counts when it has a digit; prose such as "bearer of"
    // does not.
    kind: "bearer_token",
    pattern:
      /\bbearer\s+(?:(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]+|[A-Za-z0-9._~+/=-]{16,})/giu,
    replace: whole,
  },
  {
    // The payload and signature may be empty (`e30`, unsigned tokens).
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/gu,
    replace: whole,
  },
  ...SHARED_RULES.filter(
    (rule) => !isSecretAssignment(rule) && !isAuthorizationHeader(rule),
  ),
  {
    kind: "long_token",
    pattern: /\S+/gu,
    replace: (token) =>
      token.replace(LONG_TOKEN, (run: string, offset: number) =>
        // Only the preceding `/` counts, so truncating after the run cannot
        // change the decision on a second pass.
        !token.includes("://") && token[offset - 1] === "/" ? run : REDACTED,
      ),
  },
  {
    kind: "home_path",
    // `]` keeps a redacted term before `/home/...` stable on a second pass.
    pattern: /(?<![A-Za-z0-9._~\]-])\/(?:Users|home)\/[^/\s"'`:,)]+/gu,
    replace: () => "~",
  },
];

/**
 * Masks one utterance or context before it is persisted. The text is NFKC
 * normalized first so dictionary terms match regardless of full/half width.
 * Callers must redact before truncating so a cut token cannot slip below a
 * length threshold, and must truncate with `truncateRedactedText`.
 */
export function redactConversationText(
  text: string,
  options: { readonly redactTerms?: readonly string[] } = {},
): { text: string; redactions: ConversationRedaction[] } {
  const counts = new Map<ConversationRedactionKind, number>();
  const apply = (input: string, rule: Rule): string =>
    input.replace(rule.pattern, (match: string, group: unknown) => {
      const replaced = rule.replace(match, String(group));
      if (replaced !== match) {
        // A rule may redact several spans in one match (long_token).
        const added = Math.max(
          1,
          replaced.split(REDACTED).length - match.split(REDACTED).length,
        );
        counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + added);
      }
      return replaced;
    });

  let result = RULES.reduce(apply, text.normalize("NFKC"));
  const pattern = termPattern(options.redactTerms ?? []);
  if (pattern !== null) {
    const termRule: Rule = { kind: "redact_term", pattern, replace: whole };
    // Split on markers so a short term cannot corrupt `[REDACTED]` itself.
    result = result
      .split(REDACTED)
      .map((segment) => apply(segment, termRule))
      .join(REDACTED);
  }
  return {
    text: result,
    redactions: [...counts]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => compareCodeUnits(a.kind, b.kind)),
  };
}

/**
 * Truncates already-masked text to `maxCharacters` code points so that the
 * result stays masked: it never cuts inside `[REDACTED]` (a fragment such as
 * `[REDACTED` can match a dictionary term like "ted"), and it masks the cut
 * text again because a cut can complete a pattern that a word boundary had
 * blocked (`AKIA` + 17 characters cut to 16). The result fits and masking
 * it again changes nothing.
 */
export function truncateRedactedText(
  text: string,
  maxCharacters: number,
  options: { readonly redactTerms?: readonly string[] } = {},
): string {
  let result = text;
  // Masking keeps or shortens a cut; the bound only guards NFKC expansions.
  for (let pass = 0; pass < 3; pass += 1) {
    const codePoints = Array.from(result);
    if (codePoints.length <= maxCharacters) return result;
    let cut = codePoints.slice(0, maxCharacters).join("");
    const marker = result.lastIndexOf(REDACTED, cut.length - 1);
    if (marker >= 0 && marker + REDACTED.length > cut.length) {
      cut = cut.slice(0, marker);
    }
    result = redactConversationText(cut, options).text;
  }
  return Array.from(result).slice(0, maxCharacters).join("");
}

/** Versions the rules and the dictionary without revealing its terms. */
export function conversationMaskingVersion(
  key: Uint8Array,
  redactTerms: readonly string[],
): string {
  const digest = hmacHex(
    key,
    canonicalizeJson([
      "repo-knowledge/redact-terms",
      normalizedTerms(redactTerms),
    ]),
  );
  return `${MASKING_RULES_VERSION}+${digest.slice(0, 16)}`;
}

export function hmacHex(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

let cachedTerms: {
  readonly source: readonly string[] | null;
  readonly key: string;
  readonly pattern: RegExp | null;
} = { source: null, key: "[]", pattern: null };

/** One alternation, longest term first; compiled once per term list. */
function termPattern(redactTerms: readonly string[]): RegExp | null {
  if (cachedTerms.source === redactTerms) return cachedTerms.pattern;
  const terms = normalizedTerms(redactTerms);
  const key = JSON.stringify(terms);
  const pattern =
    key === cachedTerms.key
      ? cachedTerms.pattern
      : terms.length === 0
        ? null
        : new RegExp(
            terms
              .sort((x, y) => y.length - x.length)
              .map(escapeRegExp)
              .join("|"),
            "giu",
          );
  cachedTerms = { source: redactTerms, key, pattern };
  return pattern;
}

function normalizedTerms(terms: readonly string[]): string[] {
  return sortAndDedupeStrings(
    terms
      .map((term) => term.normalize("NFKC").trim().toLowerCase())
      .filter((term) => term.length > 0),
  );
}

function global(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags}g`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

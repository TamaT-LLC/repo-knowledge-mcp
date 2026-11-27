import { createHmac } from "node:crypto";

import { z } from "zod";

import {
  canonicalizeJson,
  compareCodeUnits,
  sortAndDedupeStrings,
} from "./canonical.js";
import { computeByteSha256 } from "./knowledge-document.js";
import {
  SENSITIVE_PATTERNS,
  SensitiveContentKindSchema,
  type SensitiveContentKind,
  type SensitivePattern,
} from "./sensitive-content.js";

const PLACEHOLDER = "[REDACTED]";

/** Shared detector kinds plus the rules that apply to conversations only. */
const ConversationRedactionKindSchema = z.enum([
  ...SensitiveContentKindSchema.options,
  "basic_credentials",
  "bearer_token",
  "connection_string_credentials",
  "home_directory_path",
  "jwt",
  "long_token",
  "redact_term",
]);
export type ConversationRedactionKind = z.infer<
  typeof ConversationRedactionKindSchema
>;

export const ConversationRedactionCountSchema = z
  .object({
    count: z.number().int().positive(),
    kind: ConversationRedactionKindSchema,
  })
  .strict();
export type ConversationRedactionCount = z.infer<
  typeof ConversationRedactionCountSchema
>;

export interface ConversationRedactionResult {
  /** Kind and count only; matched values are never retained. */
  readonly redactions: readonly ConversationRedactionCount[];
  readonly text: string;
}

export interface ConversationRedactionOptions {
  /** User dictionary (`redactTerms`); matched after NFKC and case folding. */
  readonly redactTerms?: readonly string[];
}

type NamedGroups = Readonly<Record<string, string>>;

interface RedactionRule {
  readonly kind: ConversationRedactionKind;
  /** Global pattern. */
  readonly pattern: RegExp;
  /**
   * What replaces a match: the placeholder (default), the placeholder after
   * the kept `prefix` group (a key, header name or URL scheme), or `~`.
   * Declarative so `CONVERSATION_MASKING_RULES_VERSION` can digest it.
   */
  readonly replacement?: "home" | "keep_prefix";
  /**
   * Match across placeholders instead of between them. Only for a rule whose
   * value cannot contain `[`, so a placeholder is never re-masked.
   */
  readonly wholeText?: true;
}

function replace(rule: RedactionRule, groups: NamedGroups): string {
  switch (rule.replacement) {
    case "home":
      return "~";
    case "keep_prefix":
      return `${groups.prefix!}${PLACEHOLDER}`;
    default:
      return PLACEHOLDER;
  }
}

/**
 * `/Users/<name>`, `/home/<name>` (any case: macOS paths are
 * case-insensitive; also under WSL's `/mnt/<drive>`, Fedora Atomic's
 * `/var/home`, `/export/home`, `/private/var` and macOS volumes, and right
 * after a flag such as `-I`) and `C:\Users\<name>`; a chain such as
 * `/home/a/home/b` is one match, so masking stays linear;
 * the account name is the part to remove; a sentence's closing period is
 * not part of it (`/home/bob.` leaves the `.`). A POSIX form must start a path,
 * so `https://host/users/42` or `/srv/home/app` is left alone. A Windows
 * account name may contain spaces when a backslash follows it
 * (`C:\Users\John Smith\x`); otherwise it ends at whitespace, so the prose
 * after `C:\Users\bob and …` is kept. Escaped separators (`C:\\Users\\bob`
 * in JSON or a string literal) are matched too.
 */
const HOME_DIRECTORY_PATH_SOURCE = String.raw`(?:(?<![\w.-])|(?<=(?:^|\s)-[A-Za-z]))(?:(?:/mnt/[a-z]|/var|/export|/private/var|/private|/System/Volumes/Data|/Volumes/[^/\s"'\x60]+)?/(?:users|home)/[^/\\\s"'\x60<>()[\]{}|;:,]+?)+(?=$|[/\\\s"'\x60<>()[\]{}|;:,]|[.!?](?:$|\s))|(?:[a-z]:)?\\+users\\+(?:[^\\\s"'\x60<>|*?]+(?: [^\\\s"'\x60<>|*?]+)*(?=\\)|[^\\\s"'\x60<>|*?]+)`;

// A web route such as `/users/42` at the start of a path is masked too: it
// cannot be told from a home directory, and masking is the safe side.
// Repeated quantifiers in the rules are bounded where a rule can start at
// many positions of one run, so masking stays linear in the text length.

/** A value runs until whitespace, a quote, or a list/statement separator. */
const VALUE_TAIL = String.raw`[^\s"'\x60,;]*`;

const SHARED = new Map(
  SENSITIVE_PATTERNS.map((entry) => [entry.kind, entry.pattern]),
);

/**
 * A shared detector extended through the rest of its value. The detector
 * only needs a prefix of a secret; masking must cover all of it.
 */
function sharedRule(
  { kind, pattern }: SensitivePattern,
  tail = VALUE_TAIL,
): RedactionRule {
  return {
    kind,
    pattern: new RegExp(`(?:${pattern.source})${tail}`, `${pattern.flags}g`),
  };
}

const HOME_RULE: RedactionRule = {
  // First, on the original text: `/Users/<name>` and `/home/<name>` become
  // `~` wherever they appear, before any token rule can swallow part of
  // the path.
  kind: "home_directory_path",
  pattern: new RegExp(HOME_DIRECTORY_PATH_SOURCE, "giu"),
  replacement: "home",
};

/** Shared kinds whose conversation rule must run before the token rules. */
const EARLY_SHARED_KINDS: ReadonlySet<SensitiveContentKind> = new Set([
  "authorization_header",
  "private_key_block",
]);

/** Conversation rules that replace a shared detector in its position. */
const WIDER_SHARED_RULES: Partial<Record<SensitiveContentKind, RedactionRule>> =
  {
    // The address is the whole secret: a value tail would also swallow
    // `:owner/repo.git` after `git@github.com`.
    email_address: sharedRule(
      { kind: "email_address", pattern: SHARED.get("email_address")! },
      "",
    ),
    generic_secret_assignment: {
      // Wider than the shared detector (which it fully covers): the key may
      // carry a prefix or suffix (`DB_PASSWORD`, `AWS_SECRET_ACCESS_KEY`) or a
      // closing quote, and the value may contain `/ + . =`. The key name is
      // kept. A value written right after a placeholder already in the text
      // (`password: [REDACTED]abc…`) is masked too.
      kind: "generic_secret_assignment",
      pattern:
        /\b(?<prefix>[A-Za-z0-9_-]{0,64}(?:api[_-]?key|apikey|secret|token|password|passwd|credential)[A-Za-z0-9_-]{0,64}["'\x60]?\s*[:=]\s*["'\x60]?(?:\[REDACTED\])*)[A-Za-z0-9_\-/+.=~]{16,}[^\s"'\x60,;[]*/giu,
      replacement: "keep_prefix",
      wholeText: true,
    },
  };

/**
 * Ordered rules. Earlier rules see the original text; later rules only see
 * the spans between placeholders, so a placeholder is never re-masked and
 * redaction is idempotent.
 */
const RULES: readonly RedactionRule[] = [
  HOME_RULE,
  {
    // The shared detector only sees the BEGIN line; mask through END so the
    // key body never survives. A paste cut before END (PEM headers, blank
    // lines and all) is masked to the end of the text.
    kind: "private_key_block",
    pattern: new RegExp(
      `${SHARED.get("private_key_block")!.source}(?:[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\\s\\S]*)`,
      "gu",
    ),
  },
  {
    // Replace the whole header value. Leaving `Bearer [REDACTED]` would make
    // the shared detector match `[REDACTED]` as a credential again. Quoted
    // names (`"Authorization": "Basic …"`), quoted values and a value on the
    // next line are covered too. After a known scheme, whatever follows is
    // the value (`Bearer abc123`, `Bearer $TOKEN`): the rule must cover all
    // the shared detector flags, even at the cost of masking prose such as
    // "Authorization: Bearer header must be set". A scheme that ends its
    // segment is followed by a placeholder (`Bearer [REDACTED]` pasted from
    // a scrubbed log) or by the end of the text, and is masked as well. This is wider than the shared detector on
    // purpose: the design keeps PR-path detection unchanged, and masking
    // can only over-cover.
    kind: "authorization_header",
    pattern:
      /\b(?<prefix>authorization["'\x60]?\s*[:=]\s*["'\x60]?)(?:(?:bearer|basic|digest|token|negotiate|ntlm|apikey|aws4-hmac-sha256)(?:\s+["'\x60]?\S[^\r\n"'\x60]*|\s*$)|[A-Za-z0-9._~+/=-]{16,}[^\r\n"'\x60]*)/giu,
    replacement: "keep_prefix",
  },
  {
    // Before email: `user:pass@host.example` would otherwise leave `user:`.
    // `user:pass` (or `:pass`) is replaced and the `@host` part is kept. The
    // password runs to the `@` the host follows, so a raw `@` or `/` in it
    // is covered (`admin:p@ss@localhost/db`).
    kind: "connection_string_credentials",
    pattern:
      /\b(?<prefix>[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{0,256}:\S{1,512}?(?=@[^\s@/?#]+(?:[/?#\s]|$))/giu,
    replacement: "keep_prefix",
  },
  {
    // A token is 8+ token characters with a digit or symbol, so prose such as
    // "the bearer token" is left alone.
    kind: "bearer_token",
    pattern:
      /\bbearer\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/giu,
  },
  {
    // `Basic <base64>` outside a header: whole base64 quads (padding
    // allowed) with an uppercase letter after the first character, a digit
    // or a symbol, so prose such as "Basic JavaScript" is left alone.
    kind: "basic_credentials",
    pattern:
      /\b(?:[Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]+[A-Z0-9+/])(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/=])/gu,
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu,
  },
  // Every other shared detector, in its own order, so a kind added to the
  // shared list is masked here too. Wider conversation rules replace some.
  ...SENSITIVE_PATTERNS.filter(
    (entry) => !EARLY_SHARED_KINDS.has(entry.kind),
  ).map((entry) => WIDER_SHARED_RULES[entry.kind] ?? sharedRule(entry)),
  {
    // 32+ alphanumerics with at least one letter and one digit. A run that
    // touches a path separator is a path component (e.g. a commit URL), so it
    // is kept, as the design specifies ("パスの一部は除く"); credentials in
    // a URL path are left to the rules that know their shape.
    kind: "long_token",
    pattern:
      /(?<![A-Za-z0-9/\\])(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}(?![A-Za-z0-9/\\])/gu,
  },
];

/**
 * Which rules produced a stored text. The suffix is a digest of the compiled
 * rules (kind, pattern, flags, replacement), so any change to a local rule
 * or to a shared detector it is built from changes the version by itself.
 */
export const CONVERSATION_MASKING_RULES_VERSION = `conversation-mask-v1.${computeByteSha256(
  canonicalizeJson(
    RULES.map((rule) => [
      rule.kind,
      rule.pattern.source,
      rule.pattern.flags,
      rule.replacement ?? "placeholder",
      rule.wholeText ?? false,
    ]),
  ),
).slice(0, 12)}`;

/**
 * Masks secrets, home-directory account names, and user dictionary terms in
 * conversation text before it is stored. Only kinds and counts are returned.
 */
export function redactConversationText(
  text: string,
  options: ConversationRedactionOptions = {},
): ConversationRedactionResult {
  const found: ConversationRedactionCount[] = [];
  const count = (kind: ConversationRedactionKind, amount: number): void => {
    if (amount > 0) found.push({ count: amount, kind });
  };
  const applyTo = (segment: string, rule: RedactionRule): string => {
    let replaced = 0;
    const next = segment.replace(rule.pattern, (...args: unknown[]) => {
      replaced += 1;
      // With named groups the last argument is the groups object.
      const last = args.at(-1);
      return replace(
        rule,
        typeof last === "object" ? (last as NamedGroups) : {},
      );
    });
    count(rule.kind, replaced);
    return next;
  };
  const apply = (value: string, rule: RedactionRule): string =>
    rule.wholeText
      ? applyTo(value, rule)
      : mapOutsidePlaceholders(value, (segment) => applyTo(segment, rule));
  const terms = normalizeRedactTerms(options.redactTerms ?? []);
  // Rules, then dictionary terms, until nothing changes. A mask can expose a
  // match a word boundary or lookbehind hid (`/Users/bob/home/alice`, a term
  // right before `sk-…`). Each pass only adds placeholders, which are never
  // re-masked, or shortens a home path to `~`, so the loop ends.
  const termFree = new Set<string>();
  let current = text;
  for (let previous: string | undefined; previous !== current; ) {
    previous = current;
    current = RULES.reduce(apply, current);
    if (terms.length > 0) {
      current = mapOutsidePlaceholders(current, (segment) => {
        // A segment that held no term is not folded again on the next pass.
        if (termFree.has(segment)) return segment;
        const result = redactTermsInSegment(segment, terms);
        if (result.count === 0) termFree.add(segment);
        count("redact_term", result.count);
        return result.text;
      });
    }
  }
  return { redactions: mergeRedactionCounts(found), text: current };
}

/**
 * Cuts masked text to at most `limit` UTF-16 units without splitting a
 * surrogate pair or a placeholder: a placeholder fragment would no longer be
 * skipped by masking, so a dictionary term could match inside it.
 */
export function truncateMaskedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = limit;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) end -= 1;
  const placeholder = value.lastIndexOf(PLACEHOLDER, end - 1);
  if (placeholder >= 0 && placeholder + PLACEHOLDER.length > end) {
    end = placeholder;
  }
  return value.slice(0, end);
}

/** Sums counts per kind, in code-unit order of the kind. */
export function mergeRedactionCounts(
  ...lists: (readonly ConversationRedactionCount[])[]
): ConversationRedactionCount[] {
  const totals = new Map<ConversationRedactionKind, number>();
  for (const { count, kind } of lists.flat()) {
    totals.set(kind, (totals.get(kind) ?? 0) + count);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([kind, count]) => ({ count, kind }));
}

/**
 * Masking version recorded on each utterance. The dictionary is represented
 * by a keyed HMAC of its normalized terms, so no term appears in plain text
 * and a short term cannot be confirmed by hashing a guess without the key.
 */
export function computeConversationMaskingVersion(
  key: Uint8Array,
  redactTerms: readonly string[],
): string {
  const digest = createHmac("sha256", key)
    .update("repo-knowledge/redact-terms\0", "utf8")
    .update(canonicalizeJson(normalizeRedactTerms(redactTerms)), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${CONVERSATION_MASKING_RULES_VERSION}+terms.${digest}`;
}

const normalizedTerms = new WeakMap<readonly string[], readonly string[]>();

/**
 * NFKC, case-folded, trimmed, deduplicated, code-unit ordered terms. The
 * result is cached per list, since one ingest masks many texts with the same
 * configured dictionary.
 */
export function normalizeRedactTerms(
  terms: readonly string[],
): readonly string[] {
  const cached = normalizedTerms.get(terms);
  if (cached !== undefined) return cached;
  const result = Object.freeze(
    sortAndDedupeStrings(
      terms
        .map((term) => foldSegment(term).folded.trim())
        .filter((term) => term.length > 0),
    ),
  );
  normalizedTerms.set(terms, result);
  return result;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Any character outside the ranges that NFKC leaves alone and that never
 * combine with a neighbour. Sound marks (U+3099-U+309C), the ideographic
 * space, half-width forms and compatibility ideographs are left out.
 */
const ONE_TO_ONE_FOLD =
  /[^\x20-\x7e\t\n\r\u3041-\u3096\u30a1-\u30fa\u30fc\u4e00-\u9fff\u3001\u3002\u300c-\u300f]/u;

function mapOutsidePlaceholders(
  text: string,
  transform: (segment: string) => string,
): string {
  if (!text.includes(PLACEHOLDER)) return transform(text);
  return text
    .split(PLACEHOLDER)
    .map((segment) => (segment.length === 0 ? segment : transform(segment)))
    .join(PLACEHOLDER);
}

interface FoldedSegment {
  /** Folded text of each original cluster, concatenated. */
  readonly folded: string;
  /** For each cluster: original [start, end) and folded [start, end). */
  readonly clusters: readonly {
    readonly foldedEnd: number;
    readonly foldedStart: number;
    readonly originalEnd: number;
    readonly originalStart: number;
  }[];
}

/**
 * Folds (NFKC, lowercase) one grapheme cluster at a time, so a folded match
 * maps back to whole original characters. Clusters keep half-width kana with
 * their sound marks and decomposed Hangul together, so they compose as NFKC
 * composes them. Terms are folded the same way, so per-cluster lowercasing
 * (e.g. Greek final sigma) agrees on both sides.
 */
function foldSegment(segment: string): FoldedSegment {
  const clusters: {
    foldedEnd: number;
    foldedStart: number;
    originalEnd: number;
    originalStart: number;
  }[] = [];
  let folded = "";
  for (const { index, segment: cluster } of GRAPHEMES.segment(segment)) {
    const foldedStart = folded.length;
    // Lowercasing plus final sigma: the case folding NFKC + toLowerCase
    // leaves out for the scripts a name list is likely to use.
    folded += cluster.normalize("NFKC").toLowerCase().replaceAll("ς", "σ");
    clusters.push({
      foldedEnd: folded.length,
      foldedStart,
      originalEnd: index + cluster.length,
      originalStart: index,
    });
  }
  return { clusters, folded };
}

/** Index of the first cluster whose folded text ends after `position`. */
function clusterAt(
  clusters: FoldedSegment["clusters"],
  position: number,
): number {
  let low = 0;
  let high = clusters.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (clusters[middle]!.foldedEnd > position) high = middle;
    else low = middle + 1;
  }
  return low;
}

function redactTermsInSegment(
  segment: string,
  terms: readonly string[],
): { readonly count: number; readonly text: string } {
  const ranges: [number, number][] = [];
  if (!ONE_TO_ONE_FOLD.test(segment)) {
    // Only characters whose fold is themselves (or their ASCII lowercase),
    // each its own grapheme: the folded text keeps every index, so the
    // grapheme map is not needed. This covers ASCII and ordinary Japanese
    // (kana without separate sound marks, kanji, 、。「」『』).
    const folded = segment.toLowerCase();
    for (const term of terms) {
      for (
        let found = folded.indexOf(term);
        found >= 0;
        found = folded.indexOf(term, found + term.length)
      ) {
        ranges.push([found, found + term.length]);
      }
    }
    return replaceRanges(segment, ranges);
  }
  const { clusters, folded } = foldSegment(segment);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const found = folded.indexOf(term, from);
      if (found < 0) break;
      const end = found + term.length;
      // Widen to whole original clusters: over-masking is the safe side.
      const first = clusterAt(clusters, found);
      const last = clusterAt(clusters, end - 1);
      ranges.push([
        clusters[first]!.originalStart,
        clusters[last]!.originalEnd,
      ]);
      from = end;
    }
  }
  return replaceRanges(segment, ranges);
}

/** Replaces the merged ranges with one placeholder each. */
function replaceRanges(
  segment: string,
  ranges: [number, number][],
): { readonly count: number; readonly text: string } {
  if (ranges.length === 0) return { count: 0, text: segment };
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range[0] < previous[1]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }
  let text = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    text += segment.slice(cursor, start) + PLACEHOLDER;
    cursor = end;
  }
  return { count: merged.length, text: text + segment.slice(cursor) };
}

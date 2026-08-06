import { compareCodeUnits, sha256Jcs } from "./canonical.js";
import {
  CandidateIdSchema,
  KnowledgeIdSchema,
  type KnowledgeCategory,
  type KnowledgeStatus,
  type Severity,
} from "./domain-schemas.js";

export type PossibleMatchStatus = Extract<
  KnowledgeStatus,
  "active" | "proposed" | "stale"
>;

/** Mutable knowledge fields that a finalize token must bind exactly. */
export interface PossibleKnowledgeMatchBinding {
  readonly etag: string;
  readonly knowledge_id: string;
  readonly revision: number;
  readonly status: PossibleMatchStatus;
}

/** Provider/host-facing summary plus the fields used by the match-set digest. */
export interface PossibleKnowledgeMatch extends PossibleKnowledgeMatchBinding {
  readonly category: KnowledgeCategory;
  readonly detail: string;
  readonly rule: string;
  readonly scope: readonly string[];
  readonly severity: Severity;
}

export interface PossibleMatchSet<
  TMatch extends PossibleKnowledgeMatchBinding = PossibleKnowledgeMatchBinding,
> {
  readonly candidate_id: string;
  readonly possible_matches: readonly TMatch[];
}

/** Historical name retained for finalize and receipt integration. */
export type PossibleMatchBinding = PossibleMatchSet;

/** Sorts candidate and knowledge sets while rejecting duplicate bindings. */
export function normalizePossibleMatchSets<
  TMatch extends PossibleKnowledgeMatchBinding,
>(sets: readonly PossibleMatchSet<TMatch>[]): PossibleMatchSet<TMatch>[] {
  const normalized = sets
    .map((set) => ({
      candidate_id: CandidateIdSchema.parse(set.candidate_id),
      possible_matches: set.possible_matches
        .map((match) => {
          validatePossibleKnowledgeMatchBinding(match);
          return { ...match };
        })
        .sort((left, right) =>
          compareCodeUnits(left.knowledge_id, right.knowledge_id),
        ),
    }))
    .sort((left, right) =>
      compareCodeUnits(left.candidate_id, right.candidate_id),
    );

  assertUniqueBindings(normalized);
  return normalized;
}

/** Drops display text so only write-relevant generations enter the digest. */
export function normalizePossibleMatchBindings(
  sets: readonly PossibleMatchSet[],
): PossibleMatchBinding[] {
  return normalizePossibleMatchSets(
    sets.map((set) => ({
      candidate_id: set.candidate_id,
      possible_matches: set.possible_matches.map((match) => ({
        etag: match.etag,
        knowledge_id: match.knowledge_id,
        revision: match.revision,
        status: match.status,
      })),
    })),
  );
}

/** Computes a locale-independent digest over ID, revision, byte ETag, and status. */
export function computeMatchSetDigest(
  sets: readonly PossibleMatchSet[],
): string {
  return sha256Jcs(normalizePossibleMatchBindings(sets));
}

function validatePossibleKnowledgeMatchBinding(
  match: PossibleKnowledgeMatchBinding,
): void {
  KnowledgeIdSchema.parse(match.knowledge_id);
  if (!(["active", "proposed", "stale"] as const).includes(match.status)) {
    throw new TypeError("possible match status is not merge-eligible");
  }
  if (!Number.isSafeInteger(match.revision) || match.revision < 1) {
    throw new TypeError(
      "possible match revision must be a positive safe integer",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(match.etag)) {
    throw new TypeError(
      "possible match etag must be the lowercase SHA-256 of the exact Markdown bytes",
    );
  }
}

function assertUniqueBindings<TMatch extends PossibleKnowledgeMatchBinding>(
  sets: readonly PossibleMatchSet<TMatch>[],
): void {
  for (let setIndex = 0; setIndex < sets.length; setIndex += 1) {
    const set = sets[setIndex]!;
    if (setIndex > 0 && sets[setIndex - 1]!.candidate_id === set.candidate_id) {
      throw new TypeError(
        `Duplicate possible-match candidate: ${set.candidate_id}`,
      );
    }
    for (
      let matchIndex = 1;
      matchIndex < set.possible_matches.length;
      matchIndex += 1
    ) {
      const previous = set.possible_matches[matchIndex - 1]!;
      const current = set.possible_matches[matchIndex]!;
      if (previous.knowledge_id === current.knowledge_id) {
        throw new TypeError(
          `Duplicate possible match ${current.knowledge_id} for ${set.candidate_id}`,
        );
      }
    }
  }
}

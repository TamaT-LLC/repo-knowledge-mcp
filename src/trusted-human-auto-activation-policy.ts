import { computeTrustPolicyDigest } from "./config.js";
import {
  RepoKnowledgeConfigSchema,
  Sha256DigestSchema,
  type CommentObservation,
  type DistilledCandidate,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";

export type TrustedHumanAutoActivationBlockReason =
  | "eligibility_missing"
  | "fixture_replay_baseline"
  | "m2_pilot_not_go"
  | "operator_opt_in_disabled"
  | "originator_not_trusted_human"
  | "quality_gate_not_pass"
  | "severity_must"
  | "thread_not_all_trusted_human"
  | "trust_policy_digest_mismatch";

export interface TrustedHumanAutoActivationRequest {
  readonly candidate: Pick<DistilledCandidate, "severity">;
  readonly comments: readonly CommentObservation[];
  readonly provenanceTrustPolicyDigest: string;
}

export interface TrustedHumanAutoActivationDecision {
  readonly reasons: readonly TrustedHumanAutoActivationBlockReason[];
  readonly status: "active" | "proposed";
}

export interface TrustedHumanAutoActivationPolicyLike {
  evaluate(
    request: TrustedHumanAutoActivationRequest,
  ): TrustedHumanAutoActivationDecision;
}

export interface TrustedHumanAutoActivationPolicyOptions {
  readonly config: RepoKnowledgeConfig;
}

/**
 * Decides the initial status only after the final candidate severity and the
 * complete current thread are available. Every missing or stale prerequisite
 * keeps the candidate proposed; this policy never mutates existing knowledge.
 */
export class TrustedHumanAutoActivationPolicy implements TrustedHumanAutoActivationPolicyLike {
  private readonly config: RepoKnowledgeConfig;
  private readonly currentTrustPolicyDigest: string;

  constructor(options: TrustedHumanAutoActivationPolicyOptions) {
    this.config = RepoKnowledgeConfigSchema.parse(options.config);
    this.currentTrustPolicyDigest = computeTrustPolicyDigest(this.config.trust);
  }

  evaluate(
    request: TrustedHumanAutoActivationRequest,
  ): TrustedHumanAutoActivationDecision {
    const provenanceTrustPolicyDigest = Sha256DigestSchema.parse(
      request.provenanceTrustPolicyDigest,
    );
    const reasons: TrustedHumanAutoActivationBlockReason[] = [];
    const eligibility = this.config.trustedHumanAutoActivationEligibility;

    if (!this.config.trust.autoActivateTrustedHuman) {
      reasons.push("operator_opt_in_disabled");
    }
    if (eligibility === undefined) {
      reasons.push("eligibility_missing");
    } else {
      if (eligibility.m2Pilot.decision !== "go") {
        reasons.push("m2_pilot_not_go");
      }
      if (eligibility.qualityGate.source !== "live_measurement") {
        reasons.push("fixture_replay_baseline");
      }
      if (eligibility.qualityGate.status !== "pass") {
        reasons.push("quality_gate_not_pass");
      }
      if (
        eligibility.qualityGate.trustPolicyDigest !==
          this.currentTrustPolicyDigest ||
        provenanceTrustPolicyDigest !== this.currentTrustPolicyDigest
      ) {
        reasons.push("trust_policy_digest_mismatch");
      }
    }
    if (request.candidate.severity === "must") {
      reasons.push("severity_must");
    }

    const originator = findOriginator(request.comments);
    if (originator === undefined || !isTrustedHuman(originator)) {
      reasons.push("originator_not_trusted_human");
    }
    if (
      request.comments.length === 0 ||
      request.comments.some((comment) => !isTrustedHuman(comment))
    ) {
      reasons.push("thread_not_all_trusted_human");
    }

    return {
      reasons,
      status: reasons.length === 0 ? "active" : "proposed",
    };
  }
}

function isTrustedHuman(comment: CommentObservation): boolean {
  const actor = comment.actor;
  return (
    actor.actor_kind === "user" &&
    actor.provider === "human" &&
    actor.trust === "trusted" &&
    isInternalAssociation(actor.author_association)
  );
}

function findOriginator(
  comments: readonly CommentObservation[],
): CommentObservation | undefined {
  return comments.reduce<CommentObservation | undefined>(
    (earliest, current) => {
      if (earliest === undefined) return current;
      if (current.created_at < earliest.created_at) return current;
      if (
        current.created_at === earliest.created_at &&
        current.comment_id < earliest.comment_id
      ) {
        return current;
      }
      return earliest;
    },
    undefined,
  );
}

function isInternalAssociation(value: string | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

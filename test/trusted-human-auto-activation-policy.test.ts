import { describe, expect, it } from "vitest";

import {
  TrustedHumanAutoActivationPolicy,
  computeTrustPolicyDigest,
  parseRepoKnowledgeConfig,
  type CommentObservation,
  type RepoKnowledgeConfig,
} from "../src/experimental.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("TrustedHumanAutoActivationPolicy", () => {
  it.each(["should", "consider"] as const)(
    "activates an eligible trusted-human %s candidate only after final severity is known",
    (severity) => {
      const config = eligibleConfig();
      const policy = new TrustedHumanAutoActivationPolicy({ config });

      expect(
        policy.evaluate({
          candidate: { severity },
          // Deliberately reversed: the policy derives the chronological originator.
          comments: [trustedHumanComment(2), trustedHumanComment(1)],
          provenanceTrustPolicyDigest: computeTrustPolicyDigest(config.trust),
        }),
      ).toEqual({ reasons: [], status: "active" });
    },
  );

  it.each([
    {
      expectedReason: "severity_must",
      name: "must severity",
      request: { severity: "must" as const },
    },
    {
      config: { optIn: false },
      expectedReason: "operator_opt_in_disabled",
      name: "operator opt-in disabled",
    },
    {
      config: { pilotDecision: "no-go" as const },
      expectedReason: "m2_pilot_not_go",
      name: "M2 pilot no-go",
    },
    {
      config: { gateSource: "fixture_replay" as const },
      expectedReason: "fixture_replay_baseline",
      name: "fixture replay baseline",
    },
    {
      config: { gateStatus: "metric_failure" as const },
      expectedReason: "quality_gate_not_pass",
      name: "quality metric failure",
    },
    {
      config: { gateStatus: "integrity_failure" as const },
      expectedReason: "quality_gate_not_pass",
      name: "quality integrity failure",
    },
    {
      config: { gateTrustPolicyDigest: HASH_B },
      expectedReason: "trust_policy_digest_mismatch",
      name: "quality gate trust generation drift",
    },
  ])(
    "keeps $name proposed",
    ({ config: configOptions, expectedReason, request }) => {
      const config = eligibleConfig(configOptions);
      const policy = new TrustedHumanAutoActivationPolicy({ config });
      const result = policy.evaluate({
        candidate: { severity: request?.severity ?? "should" },
        comments: [trustedHumanComment(1)],
        provenanceTrustPolicyDigest: computeTrustPolicyDigest(config.trust),
      });

      expect(result.status).toBe("proposed");
      expect(result.reasons).toContain(expectedReason);
    },
  );

  it("fails closed when eligibility is absent or distillation provenance uses another trust generation", () => {
    const withoutEligibility = parseRepoKnowledgeConfig({
      trust: {
        autoActivateTrustedHuman: true,
        trustedActorIds: ["actor-alice"],
      },
    });
    expect(
      new TrustedHumanAutoActivationPolicy({
        config: withoutEligibility,
      }).evaluate({
        candidate: { severity: "should" },
        comments: [trustedHumanComment(1)],
        provenanceTrustPolicyDigest: computeTrustPolicyDigest(
          withoutEligibility.trust,
        ),
      }),
    ).toMatchObject({
      reasons: expect.arrayContaining(["eligibility_missing"]),
      status: "proposed",
    });

    const config = eligibleConfig();
    expect(
      new TrustedHumanAutoActivationPolicy({ config }).evaluate({
        candidate: { severity: "should" },
        comments: [trustedHumanComment(1)],
        provenanceTrustPolicyDigest: HASH_B,
      }),
    ).toMatchObject({
      reasons: expect.arrayContaining(["trust_policy_digest_mismatch"]),
      status: "proposed",
    });
  });

  it.each([
    {
      comments: [
        trustedHumanComment(1, {
          actor_kind: "bot",
          author_association: "NONE",
          provider: "greptile",
          trust: "trusted",
        }),
      ],
      name: "configured AI originator",
      reason: "originator_not_trusted_human",
    },
    {
      comments: [
        trustedHumanComment(1),
        trustedHumanComment(2, {
          actor_kind: "bot",
          author_association: "NONE",
          provider: "greptile",
          trust: "trusted",
        }),
      ],
      name: "configured AI reply classified as trusted",
      reason: "thread_not_all_trusted_human",
    },
    {
      comments: [
        trustedHumanComment(1),
        trustedHumanComment(2, {
          actor_kind: "bot",
          author_association: "NONE",
          provider: "other",
          trust: "unknown",
        }),
      ],
      name: "unknown bot reply",
      reason: "thread_not_all_trusted_human",
    },
    {
      comments: [
        trustedHumanComment(1, {
          author_association: "CONTRIBUTOR",
          trust: "trusted",
        }),
      ],
      name: "explicitly trusted external originator",
      reason: "originator_not_trusted_human",
    },
    {
      comments: [
        trustedHumanComment(1),
        trustedHumanComment(2, { trust: "untrusted" }),
      ],
      name: "mixed trusted and untrusted humans",
      reason: "thread_not_all_trusted_human",
    },
    {
      comments: [],
      name: "empty thread",
      reason: "originator_not_trusted_human",
    },
  ])("keeps $name proposed", ({ comments, reason }) => {
    const config = eligibleConfig();
    const result = new TrustedHumanAutoActivationPolicy({ config }).evaluate({
      candidate: { severity: "should" },
      comments,
      provenanceTrustPolicyDigest: computeTrustPolicyDigest(config.trust),
    });

    expect(result.status).toBe("proposed");
    expect(result.reasons).toContain(reason);
  });
});

interface EligibleConfigOptions {
  readonly gateSource?: "fixture_replay" | "live_measurement";
  readonly gateStatus?: "integrity_failure" | "metric_failure" | "pass";
  readonly gateTrustPolicyDigest?: string;
  readonly optIn?: boolean;
  readonly pilotDecision?: "go" | "no-go";
}

function eligibleConfig(
  options: EligibleConfigOptions = {},
): RepoKnowledgeConfig {
  const base = parseRepoKnowledgeConfig({
    trust: {
      autoActivateTrustedHuman: options.optIn ?? true,
      trustedActorIds: ["actor-alice"],
    },
  });
  const trustPolicyDigest = computeTrustPolicyDigest(base.trust);
  return parseRepoKnowledgeConfig({
    trust: base.trust,
    trustedHumanAutoActivationEligibility: {
      m2Pilot: {
        completedAt: "2026-08-23T00:20:00.000Z",
        decision: options.pilotDecision ?? "go",
        reportDigest: HASH_A,
      },
      qualityGate: {
        baselineArtifactDigest: HASH_A,
        reportDigest: HASH_A,
        source: options.gateSource ?? "live_measurement",
        status: options.gateStatus ?? "pass",
        thresholdsVersion: "m2-live-thresholds-v1",
        trustPolicyDigest: options.gateTrustPolicyDigest ?? trustPolicyDigest,
      },
      schemaVersion: 1,
    },
  });
}

function trustedHumanComment(
  sequence: number,
  actorOverrides: Partial<CommentObservation["actor"]> = {},
): CommentObservation {
  const suffix = String(sequence);
  const at = `2026-08-23T00:0${suffix}:00.000Z`;
  return {
    actor: {
      actor_id: "actor-alice",
      actor_kind: "user",
      author_association: "MEMBER",
      login: "alice",
      provider: "human",
      trust: "trusted",
      ...actorOverrides,
    },
    body: `comment ${suffix}`,
    comment_id: `comment-${suffix}`,
    created_at: at,
    observation_id: `observation-${suffix}`,
    observation_type: "comment",
    observed_at: at,
    snapshot_id: "snap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    thread_id: "thread-auto-activation",
    updated_at: at,
    url: `https://github.com/owner/repo/pull/1#discussion_r${suffix}`,
  };
}

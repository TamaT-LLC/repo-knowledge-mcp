import { resolveRepositoryPolicy } from "./config.js";
import {
  RepoKnowledgeConfigSchema,
  RepositoryNameSchema,
  type RepoKnowledgeConfig,
} from "./domain-schemas.js";
import type { EnabledLlmProviderMode } from "./llm-provider-config.js";

export type ProviderTransmissionDeniedReason =
  | "cloud_transmission_disabled"
  | "mode_disabled"
  | "repository_policy_denied";

export type ProviderTransmissionDecision =
  | {
      readonly allowed: false;
      readonly reason: ProviderTransmissionDeniedReason;
    }
  | {
      readonly allowed: true;
      readonly mode: EnabledLlmProviderMode;
      readonly model: string | null;
    };

/** Evaluates mode and the effective per-repository transmission opt-in. */
export function evaluateProviderTransmission(
  config: RepoKnowledgeConfig,
  repository: string,
): ProviderTransmissionDecision {
  const parsed = RepoKnowledgeConfigSchema.parse(config);
  const normalizedRepository = RepositoryNameSchema.parse(repository);
  if (parsed.llm.mode === "disabled") {
    return { allowed: false, reason: "mode_disabled" };
  }
  const policy = resolveRepositoryPolicy(parsed, normalizedRepository);
  if (!policy.allowCloudTransmission) {
    return {
      allowed: false,
      reason:
        parsed.repoPolicies[normalizedRepository]?.allowCloudTransmission ===
        false
          ? "repository_policy_denied"
          : "cloud_transmission_disabled",
    };
  }
  return {
    allowed: true,
    mode: parsed.llm.mode,
    model: parsed.llm.model,
  };
}

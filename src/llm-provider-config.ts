export const ENABLED_LLM_PROVIDER_MODES = [
  "anthropic",
  "openai",
  "xai",
] as const;
export const LLM_PROVIDER_MODES = [
  "disabled",
  ...ENABLED_LLM_PROVIDER_MODES,
] as const;

export type EnabledLlmProviderMode =
  (typeof ENABLED_LLM_PROVIDER_MODES)[number];
export type LlmProviderMode = (typeof LLM_PROVIDER_MODES)[number];

export interface LlmProviderDefinition {
  readonly cliExecutable: string;
  readonly displayName: string;
  readonly loginCommand: string;
  readonly mode: EnabledLlmProviderMode;
}

const PROVIDER_DEFINITIONS: Readonly<
  Record<EnabledLlmProviderMode, LlmProviderDefinition>
> = Object.freeze({
  anthropic: Object.freeze({
    cliExecutable: "claude",
    displayName: "Anthropic (Claude Code)",
    loginCommand: "claude auth login",
    mode: "anthropic",
  }),
  openai: Object.freeze({
    cliExecutable: "codex",
    displayName: "OpenAI (Codex)",
    loginCommand: "codex login",
    mode: "openai",
  }),
  xai: Object.freeze({
    cliExecutable: "grok",
    displayName: "xAI (Grok CLI)",
    loginCommand: "grok login",
    mode: "xai",
  }),
});

export function getLlmProviderDefinition(
  mode: EnabledLlmProviderMode,
): LlmProviderDefinition {
  return PROVIDER_DEFINITIONS[mode];
}

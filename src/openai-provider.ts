import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  SubscriptionCliOutputError,
  SubscriptionCliProviderAdapter,
  writePrivateSubscriptionFile,
  type SubscriptionCliProviderAdapterOptions,
  type SubscriptionCliProviderDefinition,
} from "./subscription-cli-provider.js";

export const OPENAI_PROVIDER = "openai";
export const DEFAULT_OPENAI_CLI_EXECUTABLE = "codex";

export type OpenAiProviderAdapterOptions =
  SubscriptionCliProviderAdapterOptions;

const DISABLED_CODEX_TOOL_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "hooks",
  "image_generation",
  "multi_agent",
  "plugins",
  "shell_tool",
  "skill_search",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

const DEFINITION: SubscriptionCliProviderDefinition = {
  cliExecutable: DEFAULT_OPENAI_CLI_EXECUTABLE,
  async createInvocation(context) {
    const schemaPath = await writePrivateSubscriptionFile(
      context.temporaryDirectory,
      "output-schema.json",
      JSON.stringify(context.request.jsonSchema),
    );
    const outputPath = join(context.temporaryDirectory, "last-message.json");
    await writePrivateSubscriptionFile(
      context.temporaryDirectory,
      "AGENTS.md",
      `${context.request.system.trim()}\n`,
    );
    return {
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--skip-git-repo-check",
        ...DISABLED_CODEX_TOOL_FEATURES.flatMap((feature) => [
          "--disable",
          feature,
        ]),
        "--config",
        'approval_policy="never"',
        "--config",
        'shell_environment_policy.inherit="none"',
        "--config",
        'web_search="disabled"',
        "--sandbox",
        "read-only",
        "--cd",
        context.temporaryDirectory,
        "--model",
        context.model,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      input: context.request.input,
      async parseOutput() {
        let outputText: string;
        try {
          outputText = await readFile(outputPath, "utf8");
        } catch (error) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_INVALID",
            `Codex did not write its structured result (${errorCode(error)})`,
          );
        }
        if (outputText.trim().length === 0) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_INVALID",
            "Codex wrote an empty structured result",
          );
        }
        return { outputText };
      },
    };
  },
  displayName: "Codex",
  provider: OPENAI_PROVIDER,
};

/** Codex CLI adapter that uses the locally logged-in ChatGPT subscription. */
export class OpenAiProviderAdapter extends SubscriptionCliProviderAdapter {
  constructor(options: OpenAiProviderAdapterOptions = {}) {
    super(DEFINITION, options);
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | null | undefined)?.code ?? "UNKNOWN";
}

import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  SubscriptionCliOutputError,
  SubscriptionCliProviderAdapter,
  writePrivateSubscriptionFile,
  type SubscriptionCliProviderAdapterOptions,
  type SubscriptionCliProviderDefinition,
} from "./subscription-cli-provider.js";

export const XAI_PROVIDER = "xai";
export const DEFAULT_XAI_CLI_EXECUTABLE = "grok";

const GrokCliResultSchema = z.looseObject({
  modelUsage: z.record(z.string(), z.looseObject({})).optional(),
  requestId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  stopReason: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  text: z.string().optional(),
});

export type XaiProviderAdapterOptions = SubscriptionCliProviderAdapterOptions;

const DEFINITION: SubscriptionCliProviderDefinition = {
  cliExecutable: DEFAULT_XAI_CLI_EXECUTABLE,
  async createInvocation(context) {
    // Keep the cached OAuth credential, but isolate user MCP/plugin config so
    // a repo-knowledge MCP process cannot recursively launch itself.
    const sourceHome =
      context.environment.GROK_HOME?.trim() ||
      join(context.environment.HOME?.trim() || homedir(), ".grok");
    const authPath =
      context.environment.GROK_AUTH_PATH?.trim() ||
      join(sourceHome, "auth.json");
    const promptPath = await writePrivateSubscriptionFile(
      context.temporaryDirectory,
      "prompt.txt",
      context.request.input,
    );
    return {
      args: [
        "--oauth",
        "--prompt-file",
        promptPath,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(context.request.jsonSchema),
        "--model",
        context.model,
        "--system-prompt-override",
        context.request.system,
        "--tools",
        "",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--no-plan",
        "--no-subagents",
        "--no-memory",
        "--disable-web-search",
        "--verbatim",
        "--cwd",
        context.temporaryDirectory,
      ],
      environment: {
        GROK_CLAUDE_AGENTS_ENABLED: "0",
        GROK_CLAUDE_HOOKS_ENABLED: "0",
        GROK_CLAUDE_MCPS_ENABLED: "0",
        GROK_CLAUDE_RULES_ENABLED: "0",
        GROK_CLAUDE_SKILLS_ENABLED: "0",
        GROK_CODEX_AGENTS_ENABLED: "0",
        GROK_CODEX_HOOKS_ENABLED: "0",
        GROK_CODEX_MCPS_ENABLED: "0",
        GROK_CODEX_RULES_ENABLED: "0",
        GROK_CODEX_SKILLS_ENABLED: "0",
        GROK_CURSOR_AGENTS_ENABLED: "0",
        GROK_CURSOR_HOOKS_ENABLED: "0",
        GROK_CURSOR_MCPS_ENABLED: "0",
        GROK_CURSOR_RULES_ENABLED: "0",
        GROK_CURSOR_SKILLS_ENABLED: "0",
        GROK_DISABLE_API_KEY_AUTH: "1",
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_AUTH_PATH: authPath,
        GROK_HOME: context.temporaryDirectory,
        GROK_MANAGED_MCPS_ENABLED: "0",
      },
      async parseOutput(result) {
        const parsed = GrokCliResultSchema.safeParse(
          JSON.parse(result.stdout) as unknown,
        );
        if (!parsed.success) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_INVALID",
            "Grok CLI returned an invalid JSON result envelope",
          );
        }
        if (
          parsed.data.stopReason === "max_tokens" ||
          parsed.data.stopReason === "max_turns"
        ) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_TRUNCATED",
            "Grok CLI truncated the structured response",
          );
        }
        const outputText = structuredOutputText(
          parsed.data.structuredOutput,
          parsed.data.text,
        );
        const resolvedModel = Object.keys(parsed.data.modelUsage ?? {})[0];
        const responseId = parsed.data.requestId ?? parsed.data.sessionId;
        return {
          ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
          outputText,
          ...(responseId === undefined ? {} : { responseId }),
        };
      },
    };
  },
  displayName: "Grok CLI",
  provider: XAI_PROVIDER,
};

/** Grok CLI adapter that requires the locally cached OAuth login session. */
export class XaiProviderAdapter extends SubscriptionCliProviderAdapter {
  constructor(options: XaiProviderAdapterOptions = {}) {
    super(DEFINITION, options);
  }
}

function structuredOutputText(
  structuredOutput: unknown,
  fallback: string | undefined,
): string {
  if (structuredOutput !== undefined) {
    return typeof structuredOutput === "string"
      ? structuredOutput
      : JSON.stringify(structuredOutput);
  }
  if (fallback !== undefined && fallback.trim().length > 0) return fallback;
  throw new SubscriptionCliOutputError(
    "PROVIDER_RESPONSE_INVALID",
    "Grok CLI result did not contain structured output",
  );
}

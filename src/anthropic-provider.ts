import { z } from "zod";

import {
  SubscriptionCliOutputError,
  SubscriptionCliProviderAdapter,
  type SubscriptionCliProviderAdapterOptions,
  type SubscriptionCliProviderDefinition,
} from "./subscription-cli-provider.js";

export const ANTHROPIC_PROVIDER = "anthropic";
export const DEFAULT_ANTHROPIC_CLI_EXECUTABLE = "claude";

const ClaudeCliResultSchema = z
  .object({
    is_error: z.boolean().optional(),
    modelUsage: z
      .record(
        z.string(),
        z
          .object({
            canonicalModel: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .optional(),
    result: z.string().optional(),
    session_id: z.string().min(1).optional(),
    stop_reason: z.string().nullable().optional(),
    structured_output: z.unknown().optional(),
    subtype: z.string().optional(),
    type: z.string().optional(),
    uuid: z.string().min(1).optional(),
  })
  .passthrough();

export type AnthropicProviderAdapterOptions =
  SubscriptionCliProviderAdapterOptions;

const DEFINITION: SubscriptionCliProviderDefinition = {
  cliExecutable: DEFAULT_ANTHROPIC_CLI_EXECUTABLE,
  async createInvocation(context) {
    return {
      args: [
        "--print",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(context.request.jsonSchema),
        "--model",
        context.model,
        "--system-prompt",
        context.request.system,
        "--tools",
        "",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--safe-mode",
      ],
      input: context.request.input,
      async parseOutput(result) {
        const parsed = ClaudeCliResultSchema.safeParse(
          JSON.parse(result.stdout) as unknown,
        );
        if (!parsed.success) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_INVALID",
            "Claude Code returned an invalid JSON result envelope",
          );
        }
        if (
          parsed.data.is_error === true ||
          (parsed.data.subtype !== undefined &&
            parsed.data.subtype !== "success")
        ) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_INVALID",
            "Claude Code did not complete the structured response",
          );
        }
        if (
          parsed.data.stop_reason === "max_tokens" ||
          parsed.data.stop_reason === "max_turns"
        ) {
          throw new SubscriptionCliOutputError(
            "PROVIDER_RESPONSE_TRUNCATED",
            "Claude Code truncated the structured response",
          );
        }
        const outputText = structuredOutputText(
          parsed.data.structured_output,
          parsed.data.result,
        );
        const resolvedModel = Object.values(parsed.data.modelUsage ?? {})
          .map((usage) => usage.canonicalModel)
          .find((value): value is string => value !== undefined);
        const responseId = parsed.data.uuid ?? parsed.data.session_id;
        return {
          ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
          outputText,
          ...(responseId === undefined ? {} : { responseId }),
        };
      },
    };
  },
  displayName: "Claude Code",
  provider: ANTHROPIC_PROVIDER,
};

/** Claude Code adapter that uses the locally logged-in Claude subscription. */
export class AnthropicProviderAdapter extends SubscriptionCliProviderAdapter {
  constructor(options: AnthropicProviderAdapterOptions = {}) {
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
    "Claude Code result did not contain structured output",
  );
}

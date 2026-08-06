import { z } from "zod";

import {
  LlmProviderError,
  type LlmProviderAdapter,
  type StructuredCompletionRequest,
  type StructuredCompletionResponse,
} from "./llm-provider.js";

export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MESSAGES_ENDPOINT =
  "https://api.anthropic.com/v1/messages";
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4_096;

const AnthropicMessageResponseSchema = z
  .object({
    content: z.array(
      z
        .object({
          text: z.string().optional(),
          type: z.string(),
        })
        .passthrough(),
    ),
    id: z.string().min(1),
    model: z.string().min(1),
    stop_reason: z.string().nullable(),
  })
  .passthrough();

export interface AnthropicProviderAdapterOptions {
  readonly apiKey?: string | (() => string | undefined);
  readonly defaultModel?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxTokens?: number;
}

/** Minimal Messages API adapter with no provider SDK lock-in. */
export class AnthropicProviderAdapter implements LlmProviderAdapter {
  readonly provider = ANTHROPIC_PROVIDER;

  private readonly apiKey: () => string | undefined;
  private readonly defaultModel: string | undefined;
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxTokens: number;

  constructor(options: AnthropicProviderAdapterOptions = {}) {
    this.apiKey = apiKeyReader(options.apiKey);
    this.defaultModel = optionalNonEmpty(options.defaultModel, "defaultModel");
    this.endpoint = options.endpoint ?? DEFAULT_ANTHROPIC_MESSAGES_ENDPOINT;
    assertHttpUrl(this.endpoint);
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw providerError(
        "INVALID_CONFIGURATION",
        "system",
        "global fetch is unavailable",
      );
    }
    this.maxTokens = positiveInteger(
      options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      "maxTokens",
    );
  }

  async completeStructured(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResponse> {
    const key = this.apiKey()?.trim();
    if (key === undefined || key.length === 0) {
      throw providerError(
        "AUTHENTICATION_MISSING",
        "system",
        "ANTHROPIC_API_KEY is required after cloud transmission is enabled",
      );
    }
    const model = optionalNonEmpty(request.model, "model") ?? this.defaultModel;
    if (model === undefined) {
      throw providerError(
        "INVALID_CONFIGURATION",
        "system",
        "an Anthropic model must be configured",
      );
    }

    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        body: JSON.stringify({
          max_tokens: this.maxTokens,
          messages: [{ content: request.input, role: "user" }],
          model,
          output_config: {
            format: {
              schema: request.jsonSchema,
              type: "json_schema",
            },
          },
          system: request.system,
        }),
        headers: {
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
          "x-api-key": key,
        },
        method: "POST",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      throw providerError(
        "PROVIDER_REQUEST_FAILED",
        "system",
        "Anthropic request could not be completed",
        undefined,
        undefined,
        error,
      );
    }

    const requestId = response.headers.get("request-id") ?? undefined;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw providerError(
        "PROVIDER_REQUEST_FAILED",
        "model",
        `Anthropic returned HTTP ${String(response.status)}`,
        response.status,
        requestId,
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw providerError(
        "PROVIDER_RESPONSE_INVALID",
        "model",
        "Anthropic returned a non-JSON response envelope",
        response.status,
        requestId,
        error,
      );
    }
    const parsed = AnthropicMessageResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw providerError(
        "PROVIDER_RESPONSE_INVALID",
        "model",
        "Anthropic response envelope did not match the Messages API",
        response.status,
        requestId,
      );
    }
    if (
      parsed.data.stop_reason === "max_tokens" ||
      parsed.data.stop_reason === "refusal"
    ) {
      throw providerError(
        "PROVIDER_RESPONSE_TRUNCATED",
        "model",
        `Anthropic stopped with ${parsed.data.stop_reason}`,
        response.status,
        requestId,
      );
    }
    const outputText = parsed.data.content
      .filter(
        (block): block is typeof block & { readonly text: string } =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    if (outputText.length === 0) {
      throw providerError(
        "PROVIDER_RESPONSE_INVALID",
        "model",
        "Anthropic response did not contain a text output block",
        response.status,
        requestId,
      );
    }

    return {
      model: parsed.data.model,
      outputText,
      provider: ANTHROPIC_PROVIDER,
      responseId: parsed.data.id,
    };
  }
}

function apiKeyReader(
  value: AnthropicProviderAdapterOptions["apiKey"],
): () => string | undefined {
  if (typeof value === "function") return value;
  if (typeof value === "string") return () => value;
  return () => process.env.ANTHROPIC_API_KEY;
}

function optionalNonEmpty(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw providerError(
      "INVALID_CONFIGURATION",
      "system",
      `${field} must not be empty`,
    );
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw providerError(
      "INVALID_CONFIGURATION",
      "system",
      `${field} must be a positive safe integer`,
    );
  }
  return value;
}

function assertHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw providerError(
      "INVALID_CONFIGURATION",
      "system",
      "endpoint must be an absolute HTTP(S) URL",
      undefined,
      undefined,
      error,
    );
  }
  if (parsed.protocol !== "https:") {
    throw providerError(
      "INVALID_CONFIGURATION",
      "system",
      "endpoint must be an absolute HTTPS URL",
    );
  }
}

function providerError(
  code: ConstructorParameters<typeof LlmProviderError>[0],
  failureKind: ConstructorParameters<typeof LlmProviderError>[1],
  message: string,
  status?: number,
  requestId?: string,
  cause?: unknown,
): LlmProviderError {
  return new LlmProviderError(
    code,
    failureKind,
    ANTHROPIC_PROVIDER,
    message,
    status,
    requestId,
    cause === undefined ? undefined : { cause },
  );
}

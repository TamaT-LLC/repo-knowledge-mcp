export type LlmProviderFailureKind = "model" | "system";

export interface StructuredCompletionRequest {
  readonly input: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly system: string;
}

export interface StructuredCompletionResponse {
  readonly model: string;
  readonly outputText: string;
  readonly provider: string;
  readonly responseId?: string;
}

/** Provider-neutral boundary shared by extraction and later classifiers. */
export interface LlmProviderAdapter {
  readonly provider: string;

  completeStructured(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResponse>;
}

export type LlmProviderErrorCode =
  | "AUTHENTICATION_MISSING"
  | "INVALID_CONFIGURATION"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_TRUNCATED";

/** A content-free provider error that is safe to surface in diagnostics. */
export class LlmProviderError extends Error {
  constructor(
    readonly code: LlmProviderErrorCode,
    readonly failureKind: LlmProviderFailureKind,
    readonly provider: string,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "LlmProviderError";
  }
}

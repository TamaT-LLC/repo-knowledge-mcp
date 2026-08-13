import { describe, expect, it, vi } from "vitest";

import {
  ANTHROPIC_API_VERSION,
  AnthropicProviderAdapter,
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  LlmProviderError,
} from "../src/index.js";

describe("AnthropicProviderAdapter", () => {
  it("uses the current Messages API structured-output contract", async () => {
    let captured: { readonly init?: RequestInit; readonly url: string } | null =
      null;
    const fakeFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = {
        ...(init === undefined ? {} : { init }),
        url: String(input),
      };
      return new Response(
        JSON.stringify({
          content: [
            {
              text: JSON.stringify({
                candidates: [],
                skip_reason: "pr_specific",
              }),
              type: "text",
            },
          ],
          id: "msg_123",
          model: "claude-test-resolved",
          stop_reason: "end_turn",
          type: "message",
        }),
        { headers: { "request-id": "req_123" }, status: 200 },
      );
    };
    const adapter = new AnthropicProviderAdapter({
      apiKey: "secret-api-key",
      defaultModel: "claude-test",
      fetch: fakeFetch,
    });

    const result = await adapter.completeStructured({
      input: "untrusted review data",
      jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
      system: "system prompt",
    });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(captured!.init!.headers);
    expect(headers.get("anthropic-version")).toBe(ANTHROPIC_API_VERSION);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-api-key")).toBe("secret-api-key");
    expect(captured!.init!.redirect).toBe("error");
    const body = JSON.parse(String(captured!.init!.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      max_tokens: 4096,
      messages: [{ content: "untrusted review data", role: "user" }],
      model: "claude-test",
      output_config: {
        format: {
          schema: DISTILLATION_OUTPUT_JSON_SCHEMA,
          type: "json_schema",
        },
      },
      system: "system prompt",
    });
    expect(result).toEqual({
      model: "claude-test-resolved",
      outputText: '{"candidates":[],"skip_reason":"pr_specific"}',
      provider: "anthropic",
      responseId: "msg_123",
    });
  });

  it("rejects custom endpoints containing URL credentials", () => {
    expect(
      () =>
        new AnthropicProviderAdapter({
          apiKey: "secret-api-key",
          defaultModel: "claude-test",
          endpoint: "https://user:password@example.test/v1/messages",
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message: expect.stringContaining("credentials"),
      }),
    );
  });

  it("does not make a request without an API key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = new AnthropicProviderAdapter({
      apiKey: () => undefined,
      defaultModel: "claude-test",
      fetch,
    });

    await expect(
      adapter.completeStructured({
        input: "private review text",
        jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
        system: "system prompt",
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_MISSING" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects plaintext custom endpoints before handling credentials", () => {
    expect(
      () =>
        new AnthropicProviderAdapter({
          apiKey: "secret-api-key",
          defaultModel: "claude-test",
          endpoint: "http://example.test/v1/messages",
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message: expect.stringContaining("HTTPS"),
      }),
    );
  });

  it("surfaces HTTP failures without echoing response or review content", async () => {
    const adapter = new AnthropicProviderAdapter({
      apiKey: "secret-api-key",
      defaultModel: "claude-test",
      fetch: async () =>
        new Response("private-review-secret", {
          headers: { "request-id": "req_failure" },
          status: 400,
        }),
    });

    const error = await adapter
      .completeStructured({
        input: "private-review-secret",
        jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
        system: "system prompt",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      code: "PROVIDER_REQUEST_FAILED",
      requestId: "req_failure",
      status: 400,
    });
    expect(String(error)).not.toContain("private-review-secret");
  });
});

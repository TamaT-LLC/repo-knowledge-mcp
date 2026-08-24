import { access } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  AnthropicProviderAdapter,
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  LlmProviderError,
  type BufferedCommandExecutor,
  type BufferedCommandRequest,
  type BufferedCommandResult,
} from "../src/experimental.js";

describe("AnthropicProviderAdapter", () => {
  it("uses Claude Code structured output through subscription login", async () => {
    let captured: BufferedCommandRequest | undefined;
    const executor: BufferedCommandExecutor = async (request) => {
      captured = request;
      return succeeded(
        JSON.stringify({
          is_error: false,
          modelUsage: {
            "claude-test-resolved": {
              canonicalModel: "claude-test-resolved",
            },
          },
          session_id: "session_123",
          stop_reason: "tool_use",
          structured_output: {
            candidates: [],
            skip_reason: "pr_specific",
          },
          subtype: "success",
          type: "result",
          uuid: "response_123",
        }),
      );
    };
    const adapter = new AnthropicProviderAdapter({
      defaultModel: "sonnet",
      environment: {
        ANTHROPIC_API_KEY: "must-not-be-forwarded",
        ANTHROPIC_AUTH_TOKEN: "must-not-be-forwarded",
        PATH: process.env.PATH,
      },
      executor,
    });

    const result = await adapter.completeStructured({
      input: "untrusted review data",
      jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
      system: "system prompt",
    });

    expect(captured).toBeDefined();
    expect(captured!.executable).toBe("claude");
    expect(captured!.input).toBe("untrusted review data");
    expect(captured!.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(captured!.environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(captured!.args).toEqual(
      expect.arrayContaining([
        "--print",
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--tools",
        "",
        "--no-session-persistence",
        "--safe-mode",
      ]),
    );
    const schemaIndex = captured!.args.indexOf("--json-schema");
    expect(JSON.parse(captured!.args[schemaIndex + 1]!)).toEqual(
      DISTILLATION_OUTPUT_JSON_SCHEMA,
    );
    expect(result).toEqual({
      model: "claude-test-resolved",
      outputText: '{"candidates":[],"skip_reason":"pr_specific"}',
      provider: "anthropic",
      responseId: "response_123",
    });
    await expect(access(captured!.cwd!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("maps a missing Claude subscription login without exposing CLI output", async () => {
    const executor = vi.fn<BufferedCommandExecutor>(async () =>
      failed("Run `claude auth login`; private-review-secret"),
    );
    const adapter = new AnthropicProviderAdapter({
      defaultModel: "sonnet",
      executor,
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
      code: "AUTHENTICATION_MISSING",
      provider: "anthropic",
    });
    expect(String(error)).not.toContain("private-review-secret");
  });

  it("rejects malformed CLI envelopes", async () => {
    const adapter = new AnthropicProviderAdapter({
      defaultModel: "sonnet",
      executor: async () => succeeded("{}"),
    });

    await expect(
      adapter.completeStructured({
        input: "review",
        jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
        system: "system prompt",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });
});

function succeeded(stdout: string): BufferedCommandResult {
  return {
    exitCode: 0,
    failed: false,
    isMaxBuffer: false,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

function failed(stderr: string): BufferedCommandResult {
  return {
    exitCode: 1,
    failed: true,
    isMaxBuffer: false,
    stderr,
    stdout: "",
    timedOut: false,
  };
}

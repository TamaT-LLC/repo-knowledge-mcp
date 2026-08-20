import { access, readFile, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  CliLlmSubscriptionInspector,
  DISTILLATION_OUTPUT_JSON_SCHEMA,
  OpenAiProviderAdapter,
  XaiProviderAdapter,
  subscriptionOnlyEnvironment,
  type BufferedCommandExecutor,
  type BufferedCommandRequest,
  type BufferedCommandResult,
} from "../src/index.js";

describe("OpenAiProviderAdapter", () => {
  it("runs Codex exec with ChatGPT login and private schema files", async () => {
    let captured: BufferedCommandRequest | undefined;
    let capturedSchema: unknown;
    let capturedInstructions: string | undefined;
    const executor: BufferedCommandExecutor = async (request) => {
      captured = request;
      const schemaPath = argumentValue(request.args, "--output-schema");
      const outputPath = argumentValue(request.args, "--output-last-message");
      capturedSchema = JSON.parse(
        await readFile(schemaPath, "utf8"),
      ) as unknown;
      capturedInstructions = await readFile(
        `${request.cwd!}/AGENTS.md`,
        "utf8",
      );
      await writeFile(
        outputPath,
        '{"candidates":[],"skip_reason":"pr_specific"}',
        { mode: 0o600 },
      );
      return succeeded("");
    };
    const adapter = new OpenAiProviderAdapter({
      defaultModel: "gpt-test",
      environment: {
        OPENAI_API_KEY: "must-not-be-forwarded",
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
    expect(captured!.executable).toBe("codex");
    expect(captured!.input).toBe("untrusted review data");
    expect(captured!.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-test",
      ]),
    );
    expect(captured!.args).not.toContain("untrusted review data");
    expect(captured!.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(capturedSchema).toEqual(DISTILLATION_OUTPUT_JSON_SCHEMA);
    expect(capturedInstructions).toBe("system prompt\n");
    expect(result).toEqual({
      model: "gpt-test",
      outputText: '{"candidates":[],"skip_reason":"pr_specific"}',
      provider: "openai",
    });
    await expect(access(captured!.cwd!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("XaiProviderAdapter", () => {
  it("runs Grok in OAuth-only structured headless mode", async () => {
    let captured: BufferedCommandRequest | undefined;
    let capturedPrompt: string | undefined;
    const executor: BufferedCommandExecutor = async (request) => {
      captured = request;
      capturedPrompt = await readFile(
        argumentValue(request.args, "--prompt-file"),
        "utf8",
      );
      return succeeded(
        JSON.stringify({
          modelUsage: { "grok-test-resolved": {} },
          requestId: "request_123",
          sessionId: "session_123",
          stopReason: "end_turn",
          structuredOutput: {
            candidates: [],
            skip_reason: "pr_specific",
          },
          text: '{"candidates":[],"skip_reason":"pr_specific"}',
        }),
      );
    };
    const adapter = new XaiProviderAdapter({
      defaultModel: "grok-test",
      environment: {
        PATH: process.env.PATH,
        XAI_API_KEY: "must-not-be-forwarded",
      },
      executor,
    });

    const result = await adapter.completeStructured({
      input: "untrusted review data",
      jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
      system: "system prompt",
    });

    expect(captured).toBeDefined();
    expect(captured!.executable).toBe("grok");
    expect(captured!.args).toEqual(
      expect.arrayContaining([
        "--oauth",
        "--output-format",
        "json",
        "--model",
        "grok-test",
        "--tools",
        "",
        "--no-subagents",
        "--no-memory",
      ]),
    );
    expect(captured!.args).not.toContain("untrusted review data");
    expect(capturedPrompt).toBe("untrusted review data");
    expect(captured!.environment).not.toHaveProperty("XAI_API_KEY");
    expect(captured!.environment).toMatchObject({
      GROK_DISABLE_API_KEY_AUTH: "1",
    });
    expect(result).toEqual({
      model: "grok-test-resolved",
      outputText: '{"candidates":[],"skip_reason":"pr_specific"}',
      provider: "xai",
      responseId: "request_123",
    });
    await expect(access(captured!.cwd!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("CliLlmSubscriptionInspector", () => {
  it.each([
    {
      executable: "claude",
      mode: "anthropic" as const,
      stdout: JSON.stringify({
        apiProvider: "firstParty",
        authMethod: "claude.ai",
        loggedIn: true,
        subscriptionType: "pro",
      }),
    },
    {
      executable: "codex",
      mode: "openai" as const,
      stdout: "Logged in using ChatGPT\n",
    },
    {
      executable: "grok",
      mode: "xai" as const,
      stdout: "You are logged in with grok.com.\n",
    },
  ])("accepts the $mode subscription login", async (fixture) => {
    let captured: BufferedCommandRequest | undefined;
    const inspector = new CliLlmSubscriptionInspector({
      environment: {
        ANTHROPIC_API_KEY: "not-forwarded",
        OPENAI_API_KEY: "not-forwarded",
        PATH: process.env.PATH,
        XAI_API_KEY: "not-forwarded",
      },
      executor: async (request) => {
        captured = request;
        return succeeded(fixture.stdout);
      },
    });

    await expect(inspector.inspect(fixture.mode)).resolves.toMatchObject({
      authenticated: true,
      cliAvailable: true,
    });
    expect(captured!.executable).toBe(fixture.executable);
    expect(captured!.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(captured!.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(captured!.environment).not.toHaveProperty("XAI_API_KEY");
  });

  it("rejects API-key Codex login status", async () => {
    const inspector = new CliLlmSubscriptionInspector({
      executor: async () => succeeded("Logged in using an API key\n"),
    });

    await expect(inspector.inspect("openai")).resolves.toEqual({
      authenticated: false,
      cliAvailable: true,
    });
  });

  it("distinguishes a missing CLI", async () => {
    const inspector = new CliLlmSubscriptionInspector({
      executor: vi.fn(async () => ({ ...failed(""), code: "ENOENT" })),
    });

    await expect(inspector.inspect("xai")).resolves.toEqual({
      authenticated: false,
      cliAvailable: false,
    });
  });
});

describe("subscriptionOnlyEnvironment", () => {
  it("strips direct and alternate provider credentials", () => {
    expect(
      subscriptionOnlyEnvironment({
        ANTHROPIC_API_KEY: "a",
        ANTHROPIC_AUTH_TOKEN: "b",
        CLAUDE_CODE_USE_BEDROCK: "1",
        GROK_CODE_XAI_API_KEY: "c",
        OPENAI_API_KEY: "d",
        PATH: "/bin",
        XAI_API_KEY: "e",
      }),
    ).toEqual({ PATH: "/bin" });
  });
});

function argumentValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined) {
    throw new TypeError(`missing ${name}`);
  }
  return value;
}

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

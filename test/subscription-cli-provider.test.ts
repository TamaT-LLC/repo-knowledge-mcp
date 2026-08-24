import { access, readFile, rm, writeFile } from "node:fs/promises";

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
        AWS_ACCESS_KEY_ID: "must-not-be-forwarded",
        CODEX_HOME: "/home/test/.codex-custom",
        GH_TOKEN: "must-not-be-forwarded",
        GITHUB_TOKEN: "must-not-be-forwarded",
        HOME: "/home/test",
        LANG: "ja_JP.UTF-8",
        OPENAI_API_KEY: "must-not-be-forwarded",
        PATH: "/usr/bin:/bin",
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
        "--ignore-rules",
        "--strict-config",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-test",
      ]),
    );
    expect(argumentValues(captured!.args, "--disable")).toEqual([
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
    ]);
    expect(argumentValues(captured!.args, "--config")).toEqual([
      'approval_policy="never"',
      'shell_environment_policy.inherit="none"',
      'web_search="disabled"',
    ]);
    expect(captured!.args).not.toContain("untrusted review data");
    expect(captured!.environment).toEqual({
      CODEX_HOME: "/home/test/.codex-custom",
      HOME: "/home/test",
      LANG: "ja_JP.UTF-8",
      PATH: "/usr/bin:/bin",
    });
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

  it("preserves the provider error when temporary cleanup also fails", async () => {
    const adapter = new OpenAiProviderAdapter({
      defaultModel: "gpt-test",
      executor: async () => failed("Run `codex login`"),
      removeTemporaryDirectory: async (path) => {
        await rm(path, { force: true, recursive: true });
        throw new Error("simulated cleanup failure");
      },
    });

    await expect(
      adapter.completeStructured({
        input: "untrusted review data",
        jsonSchema: DISTILLATION_OUTPUT_JSON_SCHEMA,
        system: "system prompt",
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_MISSING" });
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
        AWS_SECRET_ACCESS_KEY: "not-forwarded",
        GH_TOKEN: "not-forwarded",
        GITHUB_TOKEN: "not-forwarded",
        HOME: "/home/test",
        OPENAI_API_KEY: "not-forwarded",
        PATH: "/usr/bin:/bin",
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
    expect(captured!.environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(captured!.environment).not.toHaveProperty("GH_TOKEN");
    expect(captured!.environment).not.toHaveProperty("GITHUB_TOKEN");
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
  it("allows only runtime, locale, and selected provider variables", () => {
    expect(
      subscriptionOnlyEnvironment(
        {
          ANTHROPIC_API_KEY: "a",
          AWS_ACCESS_KEY_ID: "b",
          CODEX_HOME: "/home/test/.codex",
          CUSTOM_SECRET: "c",
          GH_TOKEN: "d",
          GITHUB_TOKEN: "e",
          GROK_HOME: "/home/test/.grok",
          HOME: "/home/test",
          LANG: "ja_JP.UTF-8",
          OPENAI_API_KEY: "f",
          PATH: "/bin",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          XAI_API_KEY: "g",
        },
        {},
        "openai",
      ),
    ).toEqual({
      CODEX_HOME: "/home/test/.codex",
      HOME: "/home/test",
      LANG: "ja_JP.UTF-8",
      PATH: "/bin",
    });
  });

  it("keeps provider-specific variables isolated to that provider", () => {
    const base = {
      CLAUDE_CONFIG_DIR: "/home/test/.claude-custom",
      CODEX_HOME: "/home/test/.codex-custom",
      GROK_AUTH_PATH: "/home/test/.grok/auth.json",
      GROK_HOME: "/home/test/.grok",
      HOME: "/home/test",
    };

    expect(subscriptionOnlyEnvironment(base, {}, "anthropic")).toEqual({
      CLAUDE_CONFIG_DIR: "/home/test/.claude-custom",
      HOME: "/home/test",
    });
    expect(subscriptionOnlyEnvironment(base, {}, "openai")).toEqual({
      CODEX_HOME: "/home/test/.codex-custom",
      HOME: "/home/test",
    });
    expect(subscriptionOnlyEnvironment(base, {}, "xai")).toEqual({
      GROK_AUTH_PATH: "/home/test/.grok/auth.json",
      GROK_HOME: "/home/test/.grok",
      HOME: "/home/test",
    });
  });

  it("copies only safe names without dynamic object property writes", () => {
    const base = Object.assign(Object.create(null) as Record<string, string>, {
      CODEX_HOME: "/home/test/.codex",
      PATH: "/bin",
      REMOVE_ME: "old",
      openai_api_key: "lowercase-secret",
    });
    Object.defineProperty(base, "__proto__", {
      enumerable: true,
      value: "polluted",
    });

    expect(
      subscriptionOnlyEnvironment(
        base,
        {
          ADDED: "yes",
          PATH: "/usr/bin",
          REMOVE_ME: undefined,
        },
        "openai",
      ),
    ).toEqual({
      CODEX_HOME: "/home/test/.codex",
      PATH: "/usr/bin",
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
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

function argumentValues(args: readonly string[], name: string): string[] {
  return args.flatMap((argument, index) =>
    argument === name && args[index + 1] !== undefined
      ? [args[index + 1]!]
      : [],
  );
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
